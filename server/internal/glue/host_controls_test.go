package glue

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/room"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// startScoredMatchViaHost 走真实链路（HostCommand START）发布一个正式局。
func startScoredMatchViaHost(t *testing.T, h *Hub, rc *RoomConn, s *Session) *Match {
	t.Helper()
	rc.EnsureLauncher()
	s.HostCommand(ombv1.RoomAction_START)
	m := waitPublished(t, rc, nil)
	t.Cleanup(func() { stopTestMatch(t, m) })
	if m.warmup {
		t.Fatal("START published a warmup match")
	}
	return m
}

func lastRoomState(t *testing.T, msgs []sentMessage) *ombv1.EvRoomState {
	t.Helper()
	for i := len(msgs) - 1; i >= 0; i-- {
		if rs := msgs[i].msg.GetEvent().GetRoomState(); rs != nil {
			return rs
		}
	}
	t.Fatal("no room state broadcast")
	return nil
}

func TestHostPauseFreezesAndResumeContinues(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("PAUSE1")
	host, hostLog := bindLogged(t, h, rc, "host")
	m := startScoredMatchViaHost(t, h, rc, host)
	m.step()
	rc.mu.Lock()
	before := m.tick
	rc.mu.Unlock()

	// 非房主不可暂停。
	guest, guestLog := bindLogged(t, h, rc, "guest")
	guest.HostCommand(ombv1.RoomAction_PAUSE)
	rc.mu.Lock()
	paused := rc.paused
	rc.mu.Unlock()
	if paused {
		t.Fatal("non-host paused the match")
	}
	for _, sent := range guestLog.take() {
		if say := sent.msg.GetEvent().GetSay(); say != nil && say.Text != "" {
			// 拒绝回执（say 通道）存在即可。
			break
		}
	}

	host.HostCommand(ombv1.RoomAction_PAUSE)
	rc.mu.Lock()
	paused = rc.paused
	rc.mu.Unlock()
	if !paused {
		t.Fatal("host pause did not take effect")
	}
	if rs := lastRoomState(t, hostLog.take()); !rs.GetPaused() {
		t.Fatalf("room state broadcast missing paused flag: %+v", rs)
	}

	// 暂停期间 step 冻结权威时钟。
	for i := 0; i < 5; i++ {
		m.step()
	}
	rc.mu.Lock()
	frozen := m.tick == before
	rc.mu.Unlock()
	if !frozen {
		t.Fatal("paused match advanced")
	}

	// 暂停期间接入的观战者：没有下一 tick 可出帧，step 须经 flushPausedResyncs
	// 直接补一帧可靠全量，而不是挂黑屏到恢复为止。
	specLog := &messageLog{}
	spec := NewSession(specLog.send(true), specLog.send(false), nil)
	h.Register(spec)
	if err := rc.BindSpectator(spec); err != nil {
		t.Fatal(err)
	}
	m.step()
	fullSeen := false
	for _, sent := range specLog.take() {
		if snap := sent.msg.GetSnapshot(); snap != nil && snap.Full && sent.reliable {
			fullSeen = true
		}
	}
	if !fullSeen {
		t.Fatal("spectator joining during pause did not receive a full frame")
	}

	// RESUME：恢复推进，广播清除暂停位。
	host.HostCommand(ombv1.RoomAction_RESUME)
	rc.mu.Lock()
	paused = rc.paused
	rc.mu.Unlock()
	if paused {
		t.Fatal("resume did not clear pause")
	}
	if rs := lastRoomState(t, hostLog.take()); rs.GetPaused() {
		t.Fatalf("room state still paused after resume: %+v", rs)
	}
	m.step()
	rc.mu.Lock()
	advanced := m.tick > before
	rc.mu.Unlock()
	if !advanced {
		t.Fatal("resumed match did not advance")
	}
}

func TestHostPauseRejectedOutsideScoredMatch(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("PAUSE2")
	s, _ := bindLogged(t, h, rc, "host")
	// 无对局：拒绝且不置位。
	s.HostCommand(ombv1.RoomAction_PAUSE)
	rc.mu.Lock()
	paused := rc.paused
	rc.mu.Unlock()
	if paused {
		t.Fatal("pause accepted without a match")
	}
	// 热身场：拒绝。
	rc.EnsureLauncher()
	s.HostCommand(ombv1.RoomAction_WARMUP)
	warm := waitPublished(t, rc, nil)
	defer stopTestMatch(t, warm)
	s.HostCommand(ombv1.RoomAction_PAUSE)
	rc.mu.Lock()
	paused = rc.paused
	rc.mu.Unlock()
	if paused {
		t.Fatal("pause accepted on warmup")
	}
}

func TestHostFinishSettlesEarly(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("FINISH1")
	host, hostLog := bindLogged(t, h, rc, "host")
	m := startScoredMatchViaHost(t, h, rc, host)
	// waitPublished 后后台循环已在走，tick 非确定；只要求对局确实进行中。
	rc.mu.Lock()
	tick := m.tick
	rc.mu.Unlock()
	if tick == 0 {
		t.Fatal("match did not start")
	}

	host.HostCommand(ombv1.RoomAction_FINISH)
	m.step()
	select {
	case <-m.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("finished match loop did not terminate")
	}
	if rc.Room.State() != room.Ended {
		t.Fatalf("room state = %v, want Ended", rc.Room.State())
	}
	var end *ombv1.EvMatchEnd
	for _, sent := range hostLog.take() {
		if e := sent.msg.GetEvent().GetMatchEnd(); e != nil {
			if end != nil {
				t.Fatal("settlement broadcast more than once")
			}
			end = e
		}
	}
	if end == nil {
		t.Fatal("early finish did not broadcast settlement")
	}
	if len(end.Scores) != 1 {
		t.Fatalf("settlement rows = %d, want 1", len(end.Scores))
	}
	if rows := rc.Room.SessionScores(); len(rows) != 1 || rows[0].PlayerID != host.playerID {
		t.Fatalf("session scores not accumulated: %+v", rows)
	}
	// 提前结算的事件日志必须干净可回读：终局 checkpoint 在任意 tick 落盘
	//（非 CheckpointInterval 整数倍），读取侧不得判其为损坏。
	<-m.Done()
	if err := m.log.Err(); err != nil {
		t.Fatalf("early-finished log has sticky error: %v", err)
	}
	records, err := sim.ReadMatchEventLog(m.logReader(t))
	if err != nil {
		t.Fatalf("early-finished log unreadable: %v", err)
	}
	sawEnd := false
	for _, record := range records {
		if record.Event != nil && record.Event.GetMatchEnd() != nil {
			sawEnd = true
		}
	}
	if !sawEnd {
		t.Fatal("early-finished log missing match end record")
	}
}

// logReader 打开本局事件日志文件（matchID 由 NewMatch 以 房码-序号 命名）。
func (m *Match) logReader(t *testing.T) *os.File {
	t.Helper()
	// matchSeq 由 launchSync 以 seed 低 32 位传入，这里直接从日志对象反查不可行；
	// 用房码前缀扫描目录找到唯一文件。
	entries, err := os.ReadDir(filepath.Join("data", "matches"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), rcPrefixOf(t, m)) && strings.HasSuffix(e.Name(), ".jsonl") {
			f, err := os.Open(filepath.Join("data", "matches", e.Name()))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = f.Close() })
			return f
		}
	}
	t.Fatal("match log not found")
	return nil
}

func rcPrefixOf(t *testing.T, m *Match) string {
	t.Helper()
	m.rc.mu.Lock()
	defer m.rc.mu.Unlock()
	return m.rc.Code + "-"
}

func TestStartFromEndedLaunchesNextScoredMatch(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("NEXT1")
	host, _ := bindLogged(t, h, rc, "host")
	first := startScoredMatchViaHost(t, h, rc, host)
	// 用提前结算把房间送到 Ended（与自然到点等价的终局路径）。
	host.HostCommand(ombv1.RoomAction_FINISH)
	first.step()
	<-first.Done()
	if rc.Room.State() != room.Ended {
		t.Fatalf("state = %v, want Ended", rc.Room.State())
	}
	// Ended 直接 START：发布第二个正式局（不经过热身）。
	host.HostCommand(ombv1.RoomAction_START)
	next := waitPublished(t, rc, first)
	defer stopTestMatch(t, next)
	if next.warmup || next == first {
		t.Fatal("START from Ended did not publish a fresh scored match")
	}
	if rc.Room.SessionSeq() != 2 {
		t.Fatalf("SessionSeq = %d, want 2", rc.Room.SessionSeq())
	}
}

func TestRoomDurationConfigFlowsIntoMatch(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("DURAT1")
	// 建房时序：配置须在首个成员入座前生效。
	rc.Room.SetDurationConfig(3*60*uint32(sim.TickRate), 60*uint32(sim.TickRate))
	s, _ := bindLogged(t, h, rc, "host")
	m := startScoredMatchViaHost(t, h, rc, s)
	rc.mu.Lock()
	mt, ct := m.sim.MatchTickLimit(), m.sim.CoreOpenAt()
	rc.mu.Unlock()
	if mt != 3*60*uint32(sim.TickRate) || ct != 60*uint32(sim.TickRate) {
		t.Fatalf("match durations = %d/%d, want 10800/3600", mt, ct)
	}
	// 热身场不消费该配置。
	s.HostCommand(ombv1.RoomAction_FINISH)
	m.step()
	<-m.Done()
	s.HostCommand(ombv1.RoomAction_WARMUP)
	warm := waitPublished(t, rc, m)
	defer stopTestMatch(t, warm)
	rc.mu.Lock()
	wmt := warm.sim.MatchTickLimit()
	rc.mu.Unlock()
	if wmt != sim.WarmupTicks {
		t.Fatalf("warmup match ticks = %d, want WarmupTicks", wmt)
	}
}
