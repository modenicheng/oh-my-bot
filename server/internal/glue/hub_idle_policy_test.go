package glue

// 空房间清道夫的产品语义冻结（审计 S-26 后续）。四条语义逐条钉死：
//  1. 正式局自然终局后，房间只要还有人（玩家或观战者），等多久都不逐出、
//     不踢人；从 Ended 重开（RESTART/WARMUP）装配的新对局同样免疫。
//  2. 房间非空时清道夫不得停任何对局（非空先重置 emptySince，强制置旧无效）。
//  3. 两个阈值确实可配置（自定义阈值分拍验证停局/逐出时机）。
//  4. 观战者在线同样保持房间。

import (
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/room"
)

// forceIdle 把 emptySince 拨到很久以前，模拟「空置已久」。若房间其实非空，
// sweep 必须先把它重置为零——测试靠这个差异区分「非空免疫」与「恰好没到阈值」。
func forceIdle(t *testing.T, rc *RoomConn, idle time.Duration) {
	t.Helper()
	rc.mu.Lock()
	rc.emptySince = time.Now().Add(-idle)
	rc.mu.Unlock()
}

// assertRoomIntact 断言房间仍在 hub 注册表里、绑定原样保持（没被踢）。
// 玩家查 sessions、观战者查 spectators（观战者结构性不在 sessions 里）。
func assertRoomIntact(t *testing.T, h *Hub, rc *RoomConn, s *Session) {
	t.Helper()
	if !roomExists(h, rc.Code) {
		t.Fatal("room was evicted from the hub")
	}
	rc.mu.Lock()
	var bound bool
	if s.IsSpectator() {
		bound = rc.spectators[s.playerID] == s
	} else {
		bound = rc.sessions[s.playerID] == s
	}
	rc.mu.Unlock()
	if !bound {
		t.Fatal("session binding was dropped")
	}
}

// sweepOccupiedRoom 跑一轮清道夫并断言非空房间免疫：emptySince 被重置、
// 房间在册、绑定保持。对局存活状态由调用方按阶段自行断言。
func sweepOccupiedRoom(t *testing.T, h *Hub, rc *RoomConn, s *Session) {
	t.Helper()
	forceIdle(t, rc, time.Hour)
	h.janitorSweep()
	rc.mu.Lock()
	emptySince := rc.emptySince
	rc.mu.Unlock()
	if !emptySince.IsZero() {
		t.Fatalf("non-empty room must reset emptySince, got %v", emptySince)
	}
	assertRoomIntact(t, h, rc, s)
}

// 语义 1：正式局自然终局（finish() 的效果，等价 m.Stop()+Room.EndMatch()）后，
// 房间里有已连接玩家时用极小阈值跑多轮清道夫：房间不逐出、不踢人、对局
// goroutine 保持退出态；从 Ended 发 RESTART 正常装配新对局，新对局存在期间
// 房间同样免疫清道夫。
func TestFinishedFormalMatchSurvivesJanitorWhileOccupied(t *testing.T) {
	t.Chdir(t.TempDir()) // 正式局写匹配事件日志
	h := NewHub()
	h.SetWarmupIdleStop(time.Nanosecond)
	h.SetRoomEvictAfter(time.Nanosecond)
	rc := h.EnsureRoom("OCCUPY")
	player, _ := bindLogged(t, h, rc, "alice")
	rc.EnsureLauncher()
	if err := rc.Room.HostCommand(player.playerID, room.ActionStart); err != nil {
		t.Fatal(err)
	}
	m := waitPublished(t, rc, nil)
	// 自然终局路径的等价效果（finish() 的两个动作；Room 处于 Running）。
	m.Stop()
	rc.Room.EndMatch()
	select {
	case <-m.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("formal match did not terminate")
	}
	rc.mu.Lock()
	if state := rc.Room.State(); state != room.Ended {
		t.Fatalf("room state after natural end = %s, want Ended", state)
	}
	rc.mu.Unlock()

	for i := 0; i < 3; i++ {
		sweepOccupiedRoom(t, h, rc, player)
	}
	select {
	case <-m.Done():
	default:
		t.Fatal("finished match goroutine did not stay exited")
	}

	// Ended → RESTART 合法：局散房不散，玩家可直接重开。
	if err := rc.Room.HostCommand(player.playerID, room.ActionRestart); err != nil {
		t.Fatalf("restart from Ended: %v", err)
	}
	m2 := waitPublished(t, rc, m)
	rc.mu.Lock()
	warm, state := m2.warmup, rc.Room.State()
	rc.mu.Unlock()
	if !warm || state != room.Warmup {
		t.Fatalf("restart did not assemble a warmup: warmup=%v state=%s", warm, state)
	}
	t.Cleanup(func() { stopTestMatch(t, m2) })

	// 新对局存在期间房间同样免疫：sweep 不停局、不换局、不逐出。
	sweepOccupiedRoom(t, h, rc, player)
	rc.mu.Lock()
	same := rc.match == m2 && m2.activeLocked()
	rc.mu.Unlock()
	if !same {
		t.Fatal("janitor disturbed the restarted warmup match")
	}
	select {
	case <-m2.Done():
		t.Fatal("restarted warmup was stopped by the janitor")
	default:
	}
}

// 语义 2：房间非空时清道夫不得停任何对局——有人在场的 idle warmup 跑了
// 「很久」（emptySince 强制置旧也无效：非空先重置 emptySince，这正是要
// 冻结的行为），多轮 sweep 后对局仍活跃、房间仍是 Warmup。
func TestJanitorNeverStopsMatchesInOccupiedRoom(t *testing.T) {
	h := NewHub()
	h.SetWarmupIdleStop(time.Nanosecond)
	h.SetRoomEvictAfter(time.Nanosecond)
	rc := h.EnsureRoom("BUSYWU")
	player, _ := bindLogged(t, h, rc, "alice")
	m := startTestWarmup(t, rc, player)
	t.Cleanup(func() { stopTestMatch(t, m) })

	for i := 0; i < 3; i++ {
		sweepOccupiedRoom(t, h, rc, player)
	}
	rc.mu.Lock()
	active, state := m.activeLocked(), rc.Room.State()
	rc.mu.Unlock()
	if !active || state != room.Warmup {
		t.Fatalf("janitor touched an occupied idle warmup: active=%v state=%s", active, state)
	}
	select {
	case <-m.Done():
		t.Fatal("occupied idle warmup was stopped")
	default:
	}
}

// 语义 3：阈值确实可配置——自定义阈值（1m/2m，而非默认 15s/5m）分两拍验证：
// 空房间在 warmupIdleStop 之前 sweep 不停局、超过才停（且未到 roomEvictAfter
// 不逐出）；空置更久超过 roomEvictAfter 才逐出。
func TestJanitorThresholdsAreConfigurable(t *testing.T) {
	h := NewHub()
	h.SetWarmupIdleStop(time.Minute)
	h.SetRoomEvictAfter(2 * time.Minute)
	if h.warmupIdleStop != time.Minute || h.roomEvictAfter != 2*time.Minute {
		t.Fatal("janitor threshold setters did not take effect")
	}
	rc := h.EnsureRoom("TUNING")
	player, _ := bindLogged(t, h, rc, "alice")
	m := startTestWarmup(t, rc, player)
	t.Cleanup(func() { stopTestMatch(t, m) })
	h.Unregister(player)

	// 第一拍：空置 30s < warmupIdleStop —— 不停局、不逐出。
	forceIdle(t, rc, 30*time.Second)
	h.janitorSweep()
	select {
	case <-m.Done():
		t.Fatal("idle warmup stopped before warmupIdleStop")
	default:
	}
	if !roomExists(h, "TUNING") {
		t.Fatal("room evicted before roomEvictAfter")
	}

	// 第二拍：空置 90s ≥ warmupIdleStop 且 < roomEvictAfter —— 停局转
	// Ended，但房间保留。
	forceIdle(t, rc, 90*time.Second)
	h.janitorSweep()
	select {
	case <-m.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("idle warmup not stopped at warmupIdleStop")
	}
	rc.mu.Lock()
	state, closed := rc.Room.State(), rc.closed
	rc.mu.Unlock()
	if state != room.Ended || closed {
		t.Fatalf("after idle stop: state=%s closed=%v", state, closed)
	}
	if !roomExists(h, "TUNING") {
		t.Fatal("room evicted before roomEvictAfter")
	}

	// 第三拍：空置 3m ≥ roomEvictAfter —— 逐出。
	forceIdle(t, rc, 3*time.Minute)
	h.janitorSweep()
	if roomExists(h, "TUNING") {
		t.Fatal("room not evicted after roomEvictAfter")
	}
}

// 语义 4：观战者在线同样保持房间——只剩观战者的 idle warmup 不被停局、
// 房间不被逐出；观战者也离开后（对照组）空房间立刻进入清道夫射程。
func TestSpectatorKeepsRoomAndWarmupAlive(t *testing.T) {
	h := NewHub()
	h.SetWarmupIdleStop(time.Nanosecond)
	h.SetRoomEvictAfter(time.Nanosecond)
	rc := h.EnsureRoom("SPECFREE")
	player, _ := bindLogged(t, h, rc, "alice")
	m := startTestWarmup(t, rc, player)
	t.Cleanup(func() { stopTestMatch(t, m) })
	spec, _ := bindSpectator(t, h, rc)

	h.Unregister(player)
	for i := 0; i < 3; i++ {
		forceIdle(t, rc, time.Hour)
		h.janitorSweep()
	}
	rc.mu.Lock()
	emptySince, state, active := rc.emptySince, rc.Room.State(), m.activeLocked()
	rc.mu.Unlock()
	if !emptySince.IsZero() || state != room.Warmup || !active {
		t.Fatalf("spectator did not keep the room: emptySinceZero=%v state=%s active=%v", emptySince.IsZero(), state, active)
	}
	assertRoomIntact(t, h, rc, spec)

	// 对照组：观战者也离开 → 空置房间立刻被停局并逐出。
	h.Unregister(spec)
	forceIdle(t, rc, time.Hour)
	h.janitorSweep()
	select {
	case <-m.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("empty room warmup was not stopped after the spectator left")
	}
	if roomExists(h, "SPECFREE") {
		t.Fatal("empty room was not evicted after the spectator left")
	}
}

// setter 语义：合法值生效；非正值拒绝并保留当前值（默认不被清零覆盖）。
func TestJanitorThresholdSetters(t *testing.T) {
	h := NewHub()
	if h.warmupIdleStop != defaultWarmupIdleStop || h.roomEvictAfter != defaultRoomEvictAfter {
		t.Fatal("hub janitor defaults drifted")
	}
	h.SetWarmupIdleStop(0)
	h.SetRoomEvictAfter(-time.Second)
	if h.warmupIdleStop != defaultWarmupIdleStop || h.roomEvictAfter != defaultRoomEvictAfter {
		t.Fatal("non-positive thresholds must be rejected")
	}
	h.SetWarmupIdleStop(17 * time.Second)
	h.SetRoomEvictAfter(9 * time.Minute)
	if h.warmupIdleStop != 17*time.Second || h.roomEvictAfter != 9*time.Minute {
		t.Fatal("valid thresholds were not applied")
	}
	h.SetWarmupIdleStop(0)
	if h.warmupIdleStop != 17*time.Second {
		t.Fatal("rejection must keep the currently applied value")
	}
}
