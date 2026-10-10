package glue

import (
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/room"
)

func roomExists(h *Hub, code string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.rooms[code]
	return ok
}

// waitForMatch 等待异步装配发布（launcher 在后台 goroutine 组装）。
func waitForMatch(t *testing.T, rc *RoomConn) *Match {
	t.Helper()
	for i := 0; i < 200; i++ {
		if m := rc.currentMatch(); m != nil {
			return m
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("match did not publish in time")
	return nil
}

// startTestWarmup 走真实状态机进入 Warmup（Room.state=Warmup + 异步发布对局），
// 而非直接塞 rc.match——清道夫的状态转换（EndWarmup）依赖真实 Warmup 态。
func startTestWarmup(t *testing.T, rc *RoomConn, host *Session) *Match {
	t.Helper()
	rc.EnsureLauncher()
	if err := rc.Room.HostCommand(host.playerID, room.ActionWarmup); err != nil {
		t.Fatal(err)
	}
	return waitForMatch(t, rc)
}

// 审计 S-26：空置房间的 warmup 对局被停局、房间转 Ended，且在保留窗口内不逐出；
// 回到房间的 host 可从 Ended 直接重开热身。
func TestJanitorStopsIdleWarmupKeepsRoom(t *testing.T) {
	h := NewHub()
	h.warmupIdleStop = time.Nanosecond
	h.roomEvictAfter = time.Hour
	rc := h.EnsureRoom("KEEPZR")
	player, _ := bindLogged(t, h, rc, "alice")
	m := startTestWarmup(t, rc, player)
	t.Cleanup(func() { stopTestMatch(t, m) })

	h.Unregister(player)
	rc.mu.Lock()
	rc.emptySince = time.Now().Add(-time.Minute) // 模拟空置已久
	rc.mu.Unlock()
	h.janitorSweep()

	select {
	case <-m.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("idle warmup match was not stopped")
	}
	rc.mu.Lock()
	closed, state := rc.closed, rc.Room.State()
	rc.mu.Unlock()
	if closed || state != room.Ended {
		t.Fatalf("room should stay open in Ended: closed=%v state=%v", closed, state)
	}
	if !roomExists(h, "KEEPZR") {
		t.Fatal("room should be retained within the evict window")
	}
	// Ended → WARMUP 合法：回来的人（空置停局后重开）不被状态机卡住。
	if err := rc.Room.HostCommand(player.playerID, room.ActionWarmup); err != nil {
		t.Fatalf("warmup from Ended: %v", err)
	}
	stopTestMatch(t, waitForMatch(t, rc))
}

// 审计 S-26：空置超过逐出窗口的房间被关停并从 rooms 移除。
func TestJanitorEvictsEmptyRoom(t *testing.T) {
	h := NewHub()
	h.warmupIdleStop = time.Hour
	h.roomEvictAfter = time.Nanosecond
	rc := h.EnsureRoom("EVICTR")
	player, _ := bindLogged(t, h, rc, "alice")
	m := startTestWarmup(t, rc, player)
	t.Cleanup(func() { stopTestMatch(t, m) })

	h.Unregister(player)
	rc.mu.Lock()
	rc.emptySince = time.Now().Add(-time.Minute)
	rc.mu.Unlock()
	h.janitorSweep()

	select {
	case <-m.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("match in evicted room was not stopped")
	}
	if roomExists(h, "EVICTR") {
		t.Fatal("empty room was not evicted")
	}
	// 逐出后的房间拒绝新绑定（publish 侧由 TestPublishRefusesClosedRoom 覆盖）。
	l := &messageLog{}
	s := NewSession(l.send(true), l.send(false))
	h.Register(s)
	if err := rc.Bind(s, "bob", "red"); err == nil {
		t.Fatal("bind to closed room should fail")
	}
}

// 审计 S-26：房间被逐出后在途装配不得再发布（孤儿对局会重新永久运行）。
func TestPublishRefusesClosedRoom(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("CLOSED1")
	player, _ := bindLogged(t, h, rc, "alice")
	players := map[uint64]SessionInfo{player.playerID: {PlayerID: player.playerID, Nick: player.nick, Color: player.color}}
	m, err := NewMatch(rc, 42, 1, players, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })

	rc.mu.Lock()
	rc.closed = true
	rc.mu.Unlock()
	a := &asyncHandle{}
	rc.launch.Store(a)
	(&launcherAdapter{rc: rc}).publish(a, m)

	select {
	case <-m.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("match was published to a closed room")
	}
}

// 审计 S-27：局中加入的非花名册成员不得收到 MapBootstrap（否则客户端
// awaitingFull 死等）；花名册成员的 bootstrap 路径不受影响。
func TestBindMidMatchNonRosterGetsNoBootstrap(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("MIDJOYN")
	alice, alog := bindLogged(t, h, rc, "alice")
	players := map[uint64]SessionInfo{alice.playerID: {PlayerID: alice.playerID, Nick: alice.nick, Color: alice.color}}
	addSoloBots(players, 3)
	m, err := NewMatch(rc, 42, 1, players, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()

	_, blog := bindLogged(t, h, rc, "bob")
	for _, msg := range blog.take() {
		if msg.msg.GetEvent().GetMapBootstrap() != nil {
			t.Fatal("non-roster joiner received map bootstrap")
		}
	}

	// 对照：花名册成员（alice）走 publish/bind 语义仍要收到 bootstrap。
	rc.mu.Lock()
	m.bootstrapLocked(alice)
	rc.mu.Unlock()
	found := false
	for _, msg := range alog.take() {
		if msg.msg.GetEvent().GetMapBootstrap() != nil {
			found = true
		}
	}
	if !found {
		t.Fatal("roster member should receive map bootstrap")
	}
}
