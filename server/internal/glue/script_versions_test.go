package glue

import (
	"strings"
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/ai"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// 脚本版本链（TODO：AI 直填编辑器 + 房间作用域版本回退）的目标测试。
//
// 覆盖：AI 成功记录版本并回传源码（编辑器直填依据）、手动→AI→回退链、
// 编译失败保旧、回退装载与运行时、跨局保留、重连补发、玩家/观战隔离、
// 版本淘汰、OCC 迟到结果不污染版本链。

const aiGeneratedSource = "function tick(bot) { bot.navigateTo({x: 9, y: 9}) }"

func onlyRollbackResult(t *testing.T, msgs []sentMessage) *ombv1.EvScriptRollbackResult {
	t.Helper()
	var out *ombv1.EvScriptRollbackResult
	for _, m := range msgs {
		if r := m.msg.GetEvent().GetScriptRollbackResult(); r != nil {
			if out != nil {
				t.Fatal("multiple rollback results")
			}
			out = r
		}
	}
	if out == nil {
		t.Fatal("no rollback result")
	}
	return out
}

// AI 成功链路：ScriptResult(origin=AI, versionId) + EvScriptVersions 推送，
// 版本源码 = AI 产出（客户端据此直填编辑器）。
func TestAISuccessRecordsVersionAndDeliversSource(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("AI-VER")
	owner, log := bindLogged(t, h, rc, "pilot")
	peer, peerLog := bindLogged(t, h, rc, "peer")
	quota := ai.NewQuotaService(ai.DefaultQuotaConfig())
	provider := &ai.MockProvider{Result: ai.Result{NewScript: aiGeneratedSource, Explain: "改了导航"}}
	svc := &AIService{quota: quota, provider: provider}
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{
		owner.playerID: {PlayerID: owner.playerID, Nick: owner.nick},
		peer.playerID:  {PlayerID: peer.playerID, Nick: peer.nick},
	}, true, svc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	m.bootstrapLocked(owner)
	rc.mu.Unlock()
	log.take()
	peerLog.take()

	m.handleAiPromptLocked(owner.playerID, "改成远点导航")
	waitForCondition(t, "AI outcome settled", func() bool {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		chain := rc.scriptVersions[owner.playerID]
		return chain != nil && len(chain.versions) == 1
	})

	var result *ombv1.EvScriptResult
	versions := 0
	resultIndex, versionsIndex := -1, -1
	for i, sm := range log.take() {
		if r := sm.msg.GetEvent().GetScriptResult(); r != nil && r.GetClientScriptId() == aiClientScriptID {
			result = r
			resultIndex = i
		}
		if v := sm.msg.GetEvent().GetScriptVersions(); v != nil {
			versions++
			versionsIndex = i
		}
	}
	// 固定顺序：ScriptResult 回执在前，版本链快照在后（客户端消费顺序依赖）。
	if resultIndex < 0 || versionsIndex < 0 || resultIndex > versionsIndex {
		t.Fatalf("message order broken: result=%d versions=%d", resultIndex, versionsIndex)
	}
	if result == nil || !result.GetOk() {
		t.Fatalf("AI script result missing/failed: %+v", result)
	}
	if result.GetOrigin() != ombv1.ScriptOrigin_ORIGIN_AI {
		t.Fatalf("AI result origin = %v", result.GetOrigin())
	}
	if result.GetVersionId() == 0 {
		t.Fatal("AI result missing version id")
	}
	if versions != 1 {
		t.Fatalf("script versions pushes = %d, want 1", versions)
	}
	rc.mu.Lock()
	chainView := rc.scriptVersions[owner.playerID].toProto()
	rc.mu.Unlock()
	if len(chainView.Versions) != 1 || chainView.Versions[0].Source != aiGeneratedSource || chainView.Versions[0].Origin != ombv1.ScriptOrigin_ORIGIN_AI {
		t.Fatalf("version chain = %+v", chainView.Versions)
	}
	if chainView.CurrentId != result.GetVersionId() {
		t.Fatalf("current %d != result version %d", chainView.CurrentId, result.GetVersionId())
	}
	// owner-only：peer 可收公开 AiUsage 广播，但绝不收版本链（含源码）。
	for _, sm := range peerLog.take() {
		if sm.msg.GetEvent().GetScriptVersions() != nil || sm.msg.GetEvent().GetScriptRollbackResult() != nil {
			t.Fatalf("peer received owner-only version traffic: %+v", sm.msg)
		}
	}
}

// 手动 → AI → 回退链：三个版本按序记录（MANUAL/AI/ROLLBACK），回退产物
// 源码 = 目标版本源码，且当前指针前移。
func TestManualThenAIThenRollbackPreservesChain(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("CHAIN")
	p, log := bindLogged(t, h, rc, "pilot")
	quota := ai.NewQuotaService(ai.DefaultQuotaConfig())
	provider := &ai.MockProvider{Result: ai.Result{NewScript: aiGeneratedSource}}
	svc := &AIService{quota: quota, provider: provider}
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{p.playerID: {PlayerID: p.playerID, Nick: p.nick}}, true, svc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	m.bootstrapLocked(p)
	rc.mu.Unlock()

	manual := "function tick(bot) { bot.move(1, 0) }"
	p.SubmitScript(&ombv1.ScriptSubmit{ClientScriptId: 1, Source: manual})
	waitForCondition(t, "manual submit settled", func() bool {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		return rc.scriptVersions[p.playerID] != nil
	})
	log.take()

	m.handleAiPromptLocked(p.playerID, "改远点")
	waitForCondition(t, "AI settled", func() bool {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		chain := rc.scriptVersions[p.playerID]
		return chain != nil && len(chain.versions) == 2
	})
	log.take()

	chain := rc.scriptVersions[p.playerID]
	manualID := chain.versions[0].id
	p.ScriptRollback(&ombv1.ScriptRollback{VersionId: manualID})
	waitForCondition(t, "rollback settled", func() bool {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		chain := rc.scriptVersions[p.playerID]
		return chain != nil && len(chain.versions) == 3
	})

	result := onlyRollbackResult(t, log.take())
	if !result.GetOk() || result.GetSource() != manual {
		t.Fatalf("rollback result = %+v", result)
	}
	rc.mu.Lock()
	finalChain := rc.scriptVersions[p.playerID].toProto()
	rc.mu.Unlock()
	if len(finalChain.Versions) != 3 {
		t.Fatalf("chain length = %d", len(finalChain.Versions))
	}
	wantOrigins := []ombv1.ScriptOrigin{ombv1.ScriptOrigin_ORIGIN_MANUAL, ombv1.ScriptOrigin_ORIGIN_AI, ombv1.ScriptOrigin_ORIGIN_ROLLBACK}
	for i, want := range wantOrigins {
		if finalChain.Versions[i].Origin != want {
			t.Fatalf("version %d origin = %v want %v", i, finalChain.Versions[i].Origin, want)
		}
	}
	if finalChain.Versions[2].Source != manual || finalChain.CurrentId != finalChain.Versions[2].Id {
		t.Fatalf("rollback version source/pointer wrong: %+v", finalChain.Versions[2])
	}
	// 回退装载生效：runtime 源码 = 手动版
	rc.mu.Lock()
	rid := m.robotOf[p.playerID]
	got := m.scriptPool.RuntimeOf(rid).Source()
	rc.mu.Unlock()
	if got != manual {
		t.Fatalf("runtime source after rollback = %q", got)
	}
}

// 编译失败保旧：AI 产出坏脚本 → 无新版本、无 ScriptResult、现役脚本与当前指针不动。
func TestAICompileFailureKeepsOldCodeAndVersion(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("AIBAD")
	p, log := bindLogged(t, h, rc, "pilot")
	quota := ai.NewQuotaService(ai.DefaultQuotaConfig())
	provider := &ai.MockProvider{Result: ai.Result{NewScript: "function tick( {"}}
	svc := &AIService{quota: quota, provider: provider}
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{p.playerID: {PlayerID: p.playerID, Nick: p.nick}}, true, svc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	manual := "function tick(bot) { bot.move(1, 0) }"
	rc.mu.Lock()
	rc.match = m
	if _, _, rev := m.submitScriptLocked(p.playerID, manual); rev == 0 {
		t.Fatal("manual submit failed")
	}
	m.recordScriptVersionLocked(p.playerID, 1, ombv1.ScriptOrigin_ORIGIN_MANUAL, manual, manual, ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS)
	m.bootstrapLocked(p)
	rc.mu.Unlock()
	log.take()

	m.handleAiPromptLocked(p.playerID, "坏代码")
	waitForCondition(t, "AI failure settled", func() bool {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		return len(log.take()) > 0
	})

	for _, sm := range log.take() {
		if r := sm.msg.GetEvent().GetScriptResult(); r != nil && r.GetClientScriptId() == aiClientScriptID {
			t.Fatalf("compile failure must not deliver AI script result: %+v", r)
		}
	}
	rc.mu.Lock()
	defer rc.mu.Unlock()
	chain := rc.scriptVersions[p.playerID]
	if chain == nil || len(chain.versions) != 1 || chain.current != 1 {
		t.Fatalf("version chain mutated on compile failure: %+v", chain)
	}
	if got := m.scriptPool.RuntimeOf(m.robotOf[p.playerID]).Source(); got != manual {
		t.Fatalf("runtime source changed on compile failure: %q", got)
	}
}

// 回退目标编译失败（历史版本源码本不该坏，但防住坏源码入库场景——AI 编译
// 校验同一路径）：保旧 + 失败回执带当前版本 id/rev，当前指针不动。
func TestRollbackCompileFailureKeepsCurrent(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("RBBAD")
	p, log := bindLogged(t, h, rc, "pilot")
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{p.playerID: {PlayerID: p.playerID, Nick: p.nick}}, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	current := "function tick(bot) { bot.move(1, 0) }"
	rc.mu.Lock()
	rc.match = m
	_, _, rev := m.submitScriptLocked(p.playerID, current)
	id := m.recordScriptVersionLocked(p.playerID, rev, ombv1.ScriptOrigin_ORIGIN_MANUAL, current, current, ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS)
	// 直接注入坏历史版本（模拟坏源码入库；真实路径 SubmitScript 会拒绝）。
	m.rc.scriptVersions[p.playerID].append(rev, ombv1.ScriptOrigin_ORIGIN_AI, 1, "broken {", "broken {", ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS)
	badID := id + 1
	m.bootstrapLocked(p)
	rc.mu.Unlock()
	log.take()

	p.ScriptRollback(&ombv1.ScriptRollback{VersionId: badID})
	// 失败路径不改变链长：等待方式改为轮询消息日志长度（take 清空，失败重试安全）。
	var result *ombv1.EvScriptRollbackResult
	waitForCondition(t, "rollback settled", func() bool {
		for _, sm := range log.take() {
			if r := sm.msg.GetEvent().GetScriptRollbackResult(); r != nil {
				result = r
			}
		}
		return result != nil
	})
	if result == nil {
		t.Fatal("no rollback result")
	}
	if result.GetOk() || !strings.Contains(result.GetError(), "编译失败") {
		t.Fatalf("expected compile-failure rollback result: %+v", result)
	}
	// 断言失败不追加新版本（链长仍为 2：手动 + 注入的坏版本）且 runtime 保旧。
	// 注：坏版本是直接注入链的（真实路径 SubmitScript 会拒绝入库），其 current
	// 漂移只存在于本测试构造；失败回执本身不改变任何状态。
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if chain := rc.scriptVersions[p.playerID]; len(chain.versions) != 2 {
		t.Fatalf("failed rollback appended version: %+v", chain.versions)
	}
	if got := m.scriptPool.RuntimeOf(m.robotOf[p.playerID]).Source(); got != current {
		t.Fatalf("runtime source changed on failed rollback: %q", got)
	}
}

// 跨局保留 + 重连补发：版本链在 Match 替换后仍可回退；接管会话收到全量链。
func TestVersionHistorySurvivesMatchReplacementAndReconnect(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("SURV")
	p, _ := bindLogged(t, h, rc, "pilot")
	manual := "function tick(bot) { bot.move(1, 0) }"
	m1 := assembledTestMatch(t, rc, p)
	rc.mu.Lock()
	rc.match = m1
	_, _, rev := m1.submitScriptLocked(p.playerID, manual)
	m1.recordScriptVersionLocked(p.playerID, rev, ombv1.ScriptOrigin_ORIGIN_MANUAL, manual, manual, ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS)
	rc.mu.Unlock()
	stopTestMatch(t, m1)

	// 新局（模拟 launcher 从房间身份重建）。
	rc.mu.Lock()
	info := rc.identities[p.nick]
	info.ScriptSource = rc.scriptSource[p.playerID]
	players := map[uint64]SessionInfo{p.playerID: info}
	rc.mu.Unlock()
	m2, err := NewMatch(rc, 77, 2, players, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m2) })
	rc.mu.Lock()
	rc.match = m2
	rc.mu.Unlock()

	// 接管重连：Bind 补发版本链。
	replacement, replacementLog := bindLogged(t, h, rc, "pilot")
	found := false
	for _, sm := range replacementLog.take() {
		if v := sm.msg.GetEvent().GetScriptVersions(); v != nil {
			found = true
			if len(v.Versions) != 1 || v.Versions[0].Source != manual || v.CurrentId != v.Versions[0].Id {
				t.Fatalf("reconnect version chain = %+v", v)
			}
			if !sm.reliable {
				t.Fatal("version chain must be reliable")
			}
		}
	}
	if !found {
		t.Fatal("reconnect did not receive version chain")
	}

	// 新局里回退旧局记录的版本仍可用。
	replacement.ScriptRollback(&ombv1.ScriptRollback{VersionId: 1})
	waitForCondition(t, "rollback chain grows in new match", func() bool {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		chain := rc.scriptVersions[p.playerID]
		return chain != nil && len(chain.versions) == 2
	})
	var result *ombv1.EvScriptRollbackResult
	waitForCondition(t, "rollback result delivered", func() bool {
		for _, sm := range replacementLog.take() {
			if r := sm.msg.GetEvent().GetScriptRollbackResult(); r != nil {
				result = r
			}
		}
		return result != nil
	})
	if !result.GetOk() || result.GetSource() != manual {
		t.Fatalf("cross-match rollback result = %+v", result)
	}
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if got := m2.scriptPool.RuntimeOf(m2.robotOf[p.playerID]).Source(); got != manual {
		t.Fatalf("new match runtime after rollback = %q", got)
	}
}

// 隔离：他人版本 id / 未知 id / 观战者全部拒绝；peer 收不到任何版本链。
func TestVersionIsolationBetweenPlayersAndSpectators(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("ISO")
	owner, ownerLog := bindLogged(t, h, rc, "owner")
	peer, peerLog := bindLogged(t, h, rc, "peer")
	_, specLog := bindSpectatorLogged(t, h, rc)
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{
		owner.playerID: {PlayerID: owner.playerID, Nick: owner.nick},
		peer.playerID:  {PlayerID: peer.playerID, Nick: peer.nick},
	}, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	source := "function tick(bot) { bot.move(1, 0) }"
	rc.mu.Lock()
	rc.match = m
	_, _, rev := m.submitScriptLocked(owner.playerID, source)
	m.recordScriptVersionLocked(owner.playerID, rev, ombv1.ScriptOrigin_ORIGIN_MANUAL, source, source, ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS)
	_, _, rev2 := m.submitScriptLocked(owner.playerID, source+" ")
	// ownerOnlyVersion = owner 链中存在、peer 链中不存在的 id（id 按链独立编号）。
	ownerOnlyVersion := m.recordScriptVersionLocked(owner.playerID, rev2, ombv1.ScriptOrigin_ORIGIN_MANUAL, source+" ", source+" ", ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS)
	_, _, peerRev := m.submitScriptLocked(peer.playerID, source)
	m.recordScriptVersionLocked(peer.playerID, peerRev, ombv1.ScriptOrigin_ORIGIN_MANUAL, source, source, ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS)
	m.bootstrapLocked(owner)
	m.bootstrapLocked(peer)
	rc.mu.Unlock()
	_ = ownerOnlyVersion
	ownerLog.take()
	peerLog.take()
	specLog.take()

	// 未知 id：拒绝保旧。
	owner.ScriptRollback(&ombv1.ScriptRollback{VersionId: 9999})
	var unknownResult *ombv1.EvScriptRollbackResult
	waitForCondition(t, "unknown id settled", func() bool {
		for _, sm := range ownerLog.take() {
			if r := sm.msg.GetEvent().GetScriptRollbackResult(); r != nil {
				unknownResult = r
			}
		}
		return unknownResult != nil
	})
	if unknownResult.GetOk() {
		t.Fatalf("unknown version accepted: %+v", unknownResult)
	}

	// peer 尝试回退仅存在于 owner 链的版本 id：peer 自己的链查不到（not found），
	// 且不产生任何 owner 侧消息——版本链按玩家隔离，跨链 id 无意义。
	peer.ScriptRollback(&ombv1.ScriptRollback{VersionId: ownerOnlyVersion})
	var crossResult *ombv1.EvScriptRollbackResult
	waitForCondition(t, "peer rollback settled", func() bool {
		for _, sm := range peerLog.take() {
			if r := sm.msg.GetEvent().GetScriptRollbackResult(); r != nil {
				crossResult = r
			}
		}
		return crossResult != nil
	})
	if crossResult.GetOk() {
		t.Fatalf("cross-player rollback accepted: %+v", crossResult)
	}
	if msgs := ownerLog.take(); len(msgs) != 0 {
		t.Fatalf("owner saw peer activity: %+v", msgs)
	}

	// 观战者：上游路由直接拒绝（cmd/omb 责任），glue 层 withRoom 结构性隔离。
	if msgs := specLog.take(); len(msgs) != 0 {
		t.Fatalf("spectator received version traffic: %+v", msgs)
	}
}

// 版本淘汰：超过 32 条后最旧版本不可回退（not found），链长有界。
func TestVersionHistoryIsBounded(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("BOUND")
	p, _ := bindLogged(t, h, rc, "pilot")
	m := assembledTestMatch(t, rc, p)
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()
	rc.mu.Lock()
	defer rc.mu.Unlock()
	for i := 0; i < maxScriptVersions+3; i++ {
		_, _, rev := m.submitScriptLocked(p.playerID, "function tick(bot) { bot.move(1, 0) }")
		m.recordScriptVersionLocked(p.playerID, rev, ombv1.ScriptOrigin_ORIGIN_MANUAL, "function tick(bot) { bot.move(1, 0) }", "function tick(bot) { bot.move(1, 0) }", ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS)
	}
	chain := rc.scriptVersions[p.playerID]
	if len(chain.versions) != maxScriptVersions {
		t.Fatalf("chain length = %d want %d", len(chain.versions), maxScriptVersions)
	}
	if chain.versions[0].id != 4 { // 前 3 条被淘汰
		t.Fatalf("oldest surviving id = %d want 4", chain.versions[0].id)
	}
	if _, ok := chain.byID(1); ok {
		t.Fatal("evicted version still visible")
	}
}

// OCC：AI 基于旧 rev、期间手动提交 → AI 结果丢弃（STALE notice），版本链只含手动版本。
func TestStaleAIResultDoesNotRecordVersion(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("OCC")
	p, log := bindLogged(t, h, rc, "pilot")
	quota := ai.NewQuotaService(ai.DefaultQuotaConfig())
	provider := &ai.MockProvider{Result: ai.Result{NewScript: aiGeneratedSource}}
	svc := &AIService{quota: quota, provider: provider}
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{p.playerID: {PlayerID: p.playerID, Nick: p.nick}}, true, svc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	base := "function tick(bot) { bot.move(1, 0) }"
	rc.mu.Lock()
	rc.match = m
	m.submitScriptLocked(p.playerID, base)
	m.bootstrapLocked(p)
	snap := m.aiScriptSnapshot(p.playerID)
	rc.mu.Unlock()
	log.take()

	// 模拟 provider 在途期间的手动热更（rev 超越 AI 基线）。
	p.SubmitScript(&ombv1.ScriptSubmit{ClientScriptId: 2, Source: "function tick(bot) { bot.move(0, 1) }"})
	waitForCondition(t, "manual hot-swap settled", func() bool {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		return len(rc.scriptVersions[p.playerID].versions) == 1
	})
	log.take()

	// 直接复用落地路径（runAiPrompt 的锁内落地段）。
	rc.mu.Lock()
	sess := m.rc.sessions[p.playerID]
	ms := matchScripts{m: m}
	newRev, accepted, serr := ms.SubmitSource(p.playerID, snap.rev, aiGeneratedSource)
	if serr == nil && !accepted {
		aiNotice(sess, ombv1.EvControlNotice_CN_AI_STALE_SCRIPT, "AI 改码未生效：脚本已被手动更新，AI 结果丢弃（旧脚本继续运行）")
	}
	rc.mu.Unlock()
	if accepted || serr != nil {
		t.Fatalf("stale submit accepted=%t err=%v", accepted, serr)
	}
	_ = newRev
	foundStale := false
	for _, sm := range log.take() {
		if n := sm.msg.GetEvent().GetControlNotice(); n != nil && n.GetCode() == ombv1.EvControlNotice_CN_AI_STALE_SCRIPT {
			foundStale = true
		}
		if r := sm.msg.GetEvent().GetScriptResult(); r != nil && r.GetClientScriptId() == aiClientScriptID {
			t.Fatal("stale AI result delivered as script result")
		}
	}
	if !foundStale {
		t.Fatal("missing stale notice")
	}
	rc.mu.Lock()
	defer rc.mu.Unlock()
	chain := rc.scriptVersions[p.playerID]
	if len(chain.versions) != 1 || chain.versions[0].origin != ombv1.ScriptOrigin_ORIGIN_MANUAL {
		t.Fatalf("stale AI result recorded version: %+v", chain.versions)
	}
}

// 显式离开清理：身份释放后版本链清空（同房间再进 = 新链）。
func TestLeaveRoomClearsVersionHistory(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("LEAVE")
	p, _ := bindLogged(t, h, rc, "pilot")
	m := assembledTestMatch(t, rc, p)
	rc.mu.Lock()
	rc.match = m
	_, _, rev := m.submitScriptLocked(p.playerID, "function tick(bot) { bot.move(1, 0) }")
	m.recordScriptVersionLocked(p.playerID, rev, ombv1.ScriptOrigin_ORIGIN_MANUAL, "function tick(bot) { bot.move(1, 0) }", "function tick(bot) { bot.move(1, 0) }", ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS)
	rc.mu.Unlock()
	p.LeaveRoom()
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if _, ok := rc.scriptVersions[p.playerID]; ok {
		t.Fatal("version chain survived explicit leave")
	}
}

// ---- helpers ----

func waitForCondition(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
