package glue

import (
	"os"
	"path/filepath"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"

	"github.com/modenicheng/oh-my-bot/server/internal/snippet"
)

// Snippet 房间配置 glue（v0.3 §9-2）。
//
// 覆盖：
//   - 坏配置（未知 kind/重复/越界）整单拒绝且保旧（runtime 与房间保存值不动）；
//   - warmup→running / Restart 边界保存配置并应用到新 runtime；
//   - reconnect/bootstrap 补发现役配置回执；
//   - 观战者结构性无权配置；
//   - snippet-only 玩家（无玩家源码）获得 runtime 并产出 N 归因命令。

// snipCfgUp 构造上行 SnippetConfig。
func snipCfgUp(entries ...*ombv1.SnippetSetting) *ombv1.SnippetConfig {
	return &ombv1.SnippetConfig{Snippets: entries}
}

func snipEntry(kind ombv1.SnippetKind, enabled bool, p1 float64, s1 string) *ombv1.SnippetSetting {
	return &ombv1.SnippetSetting{Kind: kind, Enabled: enabled, P1: p1, S1: s1}
}

// lastSnippetResult 取最后一条 SnippetResult 回执。
func lastSnippetResult(t *testing.T, msgs []sentMessage) *ombv1.EvSnippetResult {
	t.Helper()
	for i := len(msgs) - 1; i >= 0; i-- {
		if r := msgs[i].msg.GetEvent().GetSnippetResult(); r != nil {
			return r
		}
	}
	t.Fatal("no SnippetResult in session messages")
	return nil
}

func snippetMatch(t *testing.T) (*Hub, *RoomConn, *Session, *messageLog, *Match) {
	t.Helper()
	h := NewHub()
	rc := h.EnsureRoom("SNIP")
	p, log := bindLogged(t, h, rc, "pilot")
	m := assembledTestMatch(t, rc, p) // warmup 组装
	rc.mu.Lock()
	rc.match = m
	m.bootstrapLocked(p)
	rc.mu.Unlock()
	return h, rc, p, log, m
}

func appliedKinds(r *ombv1.EvSnippetResult) []ombv1.SnippetKind {
	out := make([]ombv1.SnippetKind, 0, len(r.Applied))
	for _, a := range r.Applied {
		out = append(out, a.Kind)
	}
	return out
}

// ---- 0. Warmup 异步装配窗口：无 Match 也必须保存并回执 ----

func TestConfigureSnippetsBeforeMatchPublishesStillAcks(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("SNIP-PENDING")
	p, log := bindLogged(t, h, rc, "pilot")
	p.ConfigureSnippets(snipCfgUp(snipEntry(ombv1.SnippetKind_SNIPPET_EMERGENCY_SHIELD, true, 40, "")))
	r := lastSnippetResult(t, log.take())
	if !r.Ok || r.ScriptRev != 0 || len(r.Sources) != len(snippet.Catalog()) {
		t.Fatalf("pending-match ack = %+v", r)
	}
	rc.mu.Lock()
	saved := append([]snippet.Setting{}, rc.snippets[p.playerID]...)
	rc.mu.Unlock()
	if len(saved) != 1 || saved[0].Kind != snippet.EmergencyShield || saved[0].P1 != 40 {
		t.Fatalf("saved pending-match config = %+v", saved)
	}
}

// ---- 1. 好配置：应用成功 + 回执 + 房间保存 ----

func TestConfigureSnippetsAppliesAndAcks(t *testing.T) {
	_, rc, p, log, m := snippetMatch(t)

	p.ConfigureSnippets(snipCfgUp(
		snipEntry(ombv1.SnippetKind_SNIPPET_AUTO_AIM, true, 0, ""),
		snipEntry(ombv1.SnippetKind_SNIPPET_EMERGENCY_SHIELD, true, 40, ""),
	))
	r := lastSnippetResult(t, log.take())
	if !r.Ok || r.Error != "" {
		t.Fatalf("valid config rejected: %v", r.Error)
	}
	if kinds := appliedKinds(r); len(kinds) != 2 || kinds[0] != ombv1.SnippetKind_SNIPPET_AUTO_AIM || kinds[1] != ombv1.SnippetKind_SNIPPET_EMERGENCY_SHIELD {
		t.Fatalf("applied kinds = %v", kinds)
	}
	if r.ScriptRev == 0 {
		t.Fatal("ack must carry runtime rev")
	}
	if len(r.Sources) != len(snippet.Catalog()) {
		t.Fatalf("official source views = %d, want %d", len(r.Sources), len(snippet.Catalog()))
	}
	for _, sv := range r.Sources {
		if sv.Source == "" || sv.Title == "" {
			t.Fatalf("source view incomplete: %+v", sv)
		}
	}

	rc.mu.Lock()
	saved := rc.snippets[p.playerID]
	rid := m.robotOf[p.playerID]
	rt := m.scriptPool.RuntimeOf(rid)
	rc.mu.Unlock()
	if len(saved) != 2 || saved[0].Kind != snippet.AutoAim {
		t.Fatalf("room-saved snippets = %+v", saved)
	}
	if rt == nil || len(rt.Snippets()) != 2 {
		t.Fatal("runtime did not receive the config")
	}
	if rt.Rev() != r.ScriptRev {
		t.Fatalf("ack rev %d != runtime rev %d", r.ScriptRev, rt.Rev())
	}
}

// ---- 2. 坏配置：整单拒绝保旧 ----

func TestConfigureSnippetsBadConfigKeepsOld(t *testing.T) {
	_, _, p, log, m := snippetMatch(t)

	p.ConfigureSnippets(snipCfgUp(snipEntry(ombv1.SnippetKind_SNIPPET_AUTO_AIM, true, 0, "")))
	if r := lastSnippetResult(t, log.take()); !r.Ok {
		t.Fatal("seed config failed")
	}
	rcMu := m.rc
	rcMu.mu.Lock()
	oldRev := m.scriptPool.RuntimeOf(m.robotOf[p.playerID]).Rev()
	rcMu.mu.Unlock()

	cases := []struct {
		name string
		cfg  *ombv1.SnippetConfig
	}{
		{"unknown kind", snipCfgUp(snipEntry(ombv1.SnippetKind(99), true, 1, ""))},
		{"unspecified kind", snipCfgUp(snipEntry(ombv1.SnippetKind_SNIPPET_UNSPECIFIED, true, 1, ""))},
		{"duplicate kind", snipCfgUp(
			snipEntry(ombv1.SnippetKind_SNIPPET_AUTO_AIM, true, 0, ""),
			snipEntry(ombv1.SnippetKind_SNIPPET_AUTO_AIM, true, 0, ""))},
		{"removed kind 2 (auto_fire)", snipCfgUp(snipEntry(ombv1.SnippetKind(2), true, 10, ""))},
		{"removed kind 3 (auto_pickup)", snipCfgUp(snipEntry(ombv1.SnippetKind(3), true, 5, ""))},
		{"out of range param", snipCfgUp(snipEntry(ombv1.SnippetKind_SNIPPET_EMERGENCY_SHIELD, true, 999, ""))},
		{"bad waypoints", snipCfgUp(snipEntry(ombv1.SnippetKind_SNIPPET_PATROL, true, 0, "500,500"))},
		{"too many entries", snipCfgUp(
			snipEntry(ombv1.SnippetKind_SNIPPET_AUTO_AIM, true, 0, ""),
			snipEntry(ombv1.SnippetKind_SNIPPET_EMERGENCY_SHIELD, true, 40, ""),
			snipEntry(ombv1.SnippetKind_SNIPPET_DANGER_AVOID, true, 8, ""),
			snipEntry(ombv1.SnippetKind_SNIPPET_PATROL, true, 0, "1,1"),
			snipEntry(ombv1.SnippetKind_SNIPPET_GLOBAL_CORE, true, 0, ""),
			snipEntry(ombv1.SnippetKind_SNIPPET_LOW_HP_HEALTH_PACK, true, 40, ""),
			snipEntry(ombv1.SnippetKind_SNIPPET_AUTO_AIM, false, 0, ""))},
	}
	for _, tc := range cases {
		p.ConfigureSnippets(tc.cfg)
		r := lastSnippetResult(t, log.take())
		if r.Ok {
			t.Errorf("%s: bad config accepted", tc.name)
		}
		if r.Error == "" {
			t.Errorf("%s: rejection must explain", tc.name)
		}
		// 保旧：回执携带旧配置；runtime rev 不动。
		if kinds := appliedKinds(r); len(kinds) != 1 || kinds[0] != ombv1.SnippetKind_SNIPPET_AUTO_AIM {
			t.Errorf("%s: failure ack must carry old config, got %v", tc.name, kinds)
		}
		rcMu.mu.Lock()
		rev := m.scriptPool.RuntimeOf(m.robotOf[p.playerID]).Rev()
		saved := len(m.rc.snippets[p.playerID])
		rcMu.mu.Unlock()
		if rev != oldRev {
			t.Errorf("%s: runtime rev advanced %d → %d", tc.name, oldRev, rev)
		}
		if saved != 1 {
			t.Errorf("%s: room-saved config mutated (%d)", tc.name, saved)
		}
	}
}

// ---- 3. warmup→running 保存并重新应用 ----

func TestSnippetsPersistAcrossWarmupToRunningAndRestart(t *testing.T) {
	h := NewHub()
	const roomCode = "SNIP-PERSIST"
	logPath := filepath.Join("data", "matches", roomCode+"-2.jsonl")
	_ = os.Remove(logPath)
	t.Cleanup(func() { _ = os.Remove(logPath) })
	rc := h.EnsureRoom(roomCode)
	rc.EnsureLauncher()
	p1, log1 := bindLogged(t, h, rc, "host")

	// warmup 局
	rc.mu.Lock()
	m1, err := NewMatch(rc, 10, 1, map[uint64]SessionInfo{p1.playerID: {PlayerID: p1.playerID, Nick: "host"}}, true, nil)
	if err != nil {
		rc.mu.Unlock()
		t.Fatal(err)
	}
	rc.match = m1
	m1.bootstrapLocked(p1)
	rc.mu.Unlock()
	t.Cleanup(func() { stopTestMatch(t, m1) })

	p1.ConfigureSnippets(snipCfgUp(snipEntry(ombv1.SnippetKind_SNIPPET_PATROL, true, 0, "10,0;0,10")))
	if r := lastSnippetResult(t, log1.take()); !r.Ok {
		t.Fatalf("warmup config rejected: %s", r.Error)
	}

	// 正式局：直接装配非热身局验证 applySavedSnippets（与 launcher 同链路）。
	// （NewMatch 落盘目录依赖 cwd；用例聚焦 snippet 保存，无需走 room 状态机。）
	rc.mu.Lock()
	saved := append([]snippet.Setting{}, rc.snippets[p1.playerID]...)
	m2, err := NewMatch(rc, 11, 2, map[uint64]SessionInfo{p1.playerID: {PlayerID: p1.playerID, Nick: "host", Snippets: saved}}, false, nil)
	if err != nil {
		rc.mu.Unlock()
		t.Fatal(err)
	}
	rc.mu.Unlock()
	t.Cleanup(func() {
		m2.Stop()
		<-m2.Done()
	})

	// NewMatch must consume only the immutable launch snapshot. Later mutations
	// of either the caller slice or the live room map cannot affect the runtime.
	saved[0].S1 = "99,99"
	rc.mu.Lock()
	rc.snippets[p1.playerID][0].S1 = "-99,-99"
	rc.mu.Unlock()

	rc.mu.Lock()
	rid := m2.robotOf[p1.playerID]
	rt := m2.scriptPool.RuntimeOf(rid)
	rc.mu.Unlock()
	if rt == nil {
		t.Fatal("saved snippet config did not provision a runtime in the new match")
	}
	snips := rt.Snippets()
	if len(snips) != 1 || snips[0].Kind != snippet.Patrol || snips[0].S1 != "10,0;0,10" {
		t.Fatalf("new match runtime snippets = %+v", snips)
	}
	if rt.Rev() == 0 {
		t.Fatal("applied config must advance rev")
	}
}

// ---- 4. reconnect bootstrap 回执 ----

func TestReconnectBootstrapResendsSnippetState(t *testing.T) {
	h, rc, old, oldLog, m := snippetMatch(t)

	old.ConfigureSnippets(snipCfgUp(snipEntry(ombv1.SnippetKind_SNIPPET_EMERGENCY_SHIELD, true, 45, "")))
	if r := lastSnippetResult(t, oldLog.take()); !r.Ok {
		t.Fatal("seed failed")
	}

	// 重连（同昵称 takeover）：bootstrap 必须补发 SnippetResult（ok + 现役配置）。
	fresh, freshLog := bindLogged(t, h, rc, "pilot")
	msgs := freshLog.take()
	found := false
	for _, msg := range msgs {
		if r := msg.msg.GetEvent().GetSnippetResult(); r != nil {
			found = true
			if !r.Ok || r.Error != "" {
				t.Fatalf("bootstrap state must be ok, got %q", r.Error)
			}
			if kinds := appliedKinds(r); len(kinds) != 1 || kinds[0] != ombv1.SnippetKind_SNIPPET_EMERGENCY_SHIELD {
				t.Fatalf("bootstrap applied = %v", kinds)
			}
			if len(r.Sources) != len(snippet.Catalog()) {
				t.Fatalf("bootstrap source views = %d, want %d", len(r.Sources), len(snippet.Catalog()))
			}
		}
	}
	if !found {
		t.Fatal("reconnect bootstrap did not resend snippet state")
	}

	// 现役配置在 runtime 与房间保存中都对。
	rc.mu.Lock()
	rt := m.scriptPool.RuntimeOf(m.robotOf[fresh.playerID])
	saved := rc.snippets[fresh.playerID]
	rc.mu.Unlock()
	if rt == nil || len(rt.Snippets()) != 1 || rt.Snippets()[0].P1 != 45 {
		t.Fatalf("runtime lost config across reconnect: %+v", rt.Snippets())
	}
	if len(saved) != 1 || saved[0].P1 != 45 {
		t.Fatalf("room-saved config lost across reconnect: %+v", saved)
	}
}

// ---- 5. 观战者无权 ----

func TestSpectatorCannotConfigureSnippets(t *testing.T) {
	h, rc, p, plog, _ := snippetMatch(t)
	p.ConfigureSnippets(snipCfgUp(snipEntry(ombv1.SnippetKind_SNIPPET_AUTO_AIM, true, 1, "")))
	if r := lastSnippetResult(t, plog.take()); !r.Ok {
		t.Fatal("seed failed")
	}

	spec, slog := bindSpectator(t, h, rc)
	spec.ConfigureSnippets(snipCfgUp(snipEntry(ombv1.SnippetKind_SNIPPET_EMERGENCY_SHIELD, true, 50, "")))
	for _, msg := range slog.take() {
		if r := msg.msg.GetEvent().GetSnippetResult(); r != nil {
			t.Fatalf("spectator received snippet ack: %+v", r)
		}
	}
	// 玩家现役配置未被观战请求污染：玩家会话不应再收到任何 SnippetResult。
	for _, msg := range plog.take() {
		if r := msg.msg.GetEvent().GetSnippetResult(); r != nil {
			t.Fatalf("player session received unexpected ack: %+v", r)
		}
	}
}

// ---- 6. snippet-only runtime：无玩家源码也产出 N 归因 ----

func TestSnippetOnlyRuntimeProducesAttributedCommands(t *testing.T) {
	_, _, p, log, m := snippetMatch(t)

	p.ConfigureSnippets(snipCfgUp(snipEntry(ombv1.SnippetKind_SNIPPET_AUTO_AIM, true, 0, "")))
	if r := lastSnippetResult(t, log.take()); !r.Ok {
		t.Fatal("snippet-only config rejected")
	}

	// 没有玩家源码（Source()==""），runtime 仍注册并运行。
	rcMu := m.rc
	rcMu.mu.Lock()
	rid := m.robotOf[p.playerID]
	rt := m.scriptPool.RuntimeOf(rid)
	rcMu.mu.Unlock()
	if rt == nil {
		t.Fatal("snippet-only player has no runtime")
	}
	if src := rt.Source(); src != "" {
		t.Fatalf("snippet-only Source must be empty, got %q", src)
	}

	// 一步对局：runScripts 应产出 N 归因命令进入 sim（assist 需开启）。
	m.sim.AssistToggle(rid)
	m.step()
	// patrol/auto_aim 依赖观察；auto_aim 需可见敌人——这里只验证不崩溃
	// 且 runtime 未被清除；具体归因在 sim 层测试覆盖。
	rcMu.mu.Lock()
	rt2 := m.scriptPool.RuntimeOf(rid)
	rcMu.mu.Unlock()
	if rt2 == nil || rt2.Rev() == 0 {
		t.Fatal("runtime dropped after first step")
	}

	// 清空 snippet（snippet-only → 空）：runtime 注销（无玩家源码时不留空转 VM）。
	p.ConfigureSnippets(snipCfgUp())
	r := lastSnippetResult(t, log.take())
	if !r.Ok || len(r.Applied) != 0 {
		t.Fatalf("clear config rejected: %+v", r)
	}
	rcMu.mu.Lock()
	rt3 := m.scriptPool.RuntimeOf(rid)
	rcMu.mu.Unlock()
	if rt3 != nil {
		t.Fatal("snippet-only clear must unregister the runtime")
	}
	if m.scriptPool.RuntimeOf(rid) != nil {
		t.Fatal("match pool still holds cleared runtime")
	}
}
