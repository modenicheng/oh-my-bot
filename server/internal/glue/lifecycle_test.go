package glue

import (
	"sync"
	"testing"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/room"
)

type sentMessage struct {
	msg      *ombv1.ServerMsg
	reliable bool
}
type messageLog struct {
	mu       sync.Mutex
	messages []sentMessage
}

func (l *messageLog) send(reliable bool) func(*ombv1.ServerMsg) {
	return func(m *ombv1.ServerMsg) {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.messages = append(l.messages, sentMessage{m, reliable})
	}
}
func (l *messageLog) take() []sentMessage {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := l.messages
	l.messages = nil
	return out
}
func bindLogged(t *testing.T, h *Hub, rc *RoomConn, nick string) (*Session, *messageLog) {
	t.Helper()
	l := &messageLog{}
	s := NewSession(l.send(true), l.send(false))
	h.Register(s)
	if err := rc.Bind(s, nick, "red"); err != nil {
		t.Fatal(err)
	}
	return s, l
}
func stopTestMatch(t *testing.T, m *Match) {
	t.Helper()
	m.Stop()
	select {
	case <-m.Done():
	case <-time.After(5 * time.Second):
		t.Error("match did not terminate")
	}
}
func assembledTestMatch(t *testing.T, rc *RoomConn, s *Session) *Match {
	t.Helper()
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{s.playerID: {PlayerID: s.playerID, Nick: s.nick, Color: s.color}}, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	return m
}
func lastSnapshot(t *testing.T, msgs []sentMessage) *ombv1.SnapshotDelta {
	t.Helper()
	for i := len(msgs) - 1; i >= 0; i-- {
		if s := msgs[i].msg.GetSnapshot(); s != nil {
			return s
		}
	}
	t.Fatal("no snapshot")
	return nil
}

func TestReconnectPreservesRobotAndConsumedSequence(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("sequence")
	old, oldLog := bindLogged(t, h, rc, "host")
	m := assembledTestMatch(t, rc, old)
	rc.mu.Lock()
	rc.match = m
	m.bootstrapLocked(old)
	rc.mu.Unlock()
	m.step()
	initial := lastSnapshot(t, oldLog.take())
	old.RouteInput(&ombv1.ClientInput{Seq: 400}) // deliberately still pending when takeover occurs
	current, currentLog := bindLogged(t, h, rc, "host")
	old.RouteInput(&ombv1.ClientInput{Seq: 900})
	old.HostCommand(ombv1.RoomAction_WARMUP)
	if rc.Room.State() != room.Idle {
		t.Fatal("superseded connection retained host authority")
	}
	old.LeaveRoom()
	h.Unregister(old)
	m.step()
	msgs := currentLog.take()
	if len(msgs) == 0 || msgs[0].msg.GetEvent().GetMapBootstrap() == nil {
		t.Fatal("bootstrap must precede restored snapshots")
	}
	restored := lastSnapshot(t, msgs)
	if !restored.Full || restored.AckSeq != 400 || restored.GetSelf().GetRobotId() != initial.GetSelf().GetRobotId() || restored.Tick <= initial.Tick {
		t.Fatalf("invalid restored snapshot: %v", restored)
	}
	for _, msg := range msgs {
		if msg.msg.GetSnapshot() != nil && !msg.reliable {
			t.Fatal("restored full must be reliable")
		}
	}
	if len(oldLog.take()) != 0 {
		t.Fatal("superseded session still received broadcasts")
	}
	if m != rc.currentMatch() || len(m.robotOf) != 1 || rc.Room.HostID() != current.playerID {
		t.Fatal("reconnect rebuilt robot mapping/host")
	}
	current.RouteInput(&ombv1.ClientInput{Seq: restored.AckSeq + 1})
	m.step()
	if got := lastSnapshot(t, currentLog.take()).AckSeq; got != 401 {
		t.Fatalf("continued input ack=%d", got)
	}
	current.LeaveRoom()
	if rc.Room.MemberCount() != 0 {
		t.Fatal("explicit leave did not release seat")
	}
	fresh, _ := bindLogged(t, h, rc, "host")
	if fresh.playerID == current.playerID {
		t.Fatal("explicit leave retained recovery identity")
	}
}

func TestCancelledAndSupersededLaunchCannotPublish(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{false: "superseded", true: "aborted"}[cancelled], func(t *testing.T) {
			h := NewHub()
			rc := h.EnsureRoom("publish")
			s, l := bindLogged(t, h, rc, "host")
			stale := assembledTestMatch(t, rc, s)
			a := &asyncHandle{}
			rc.launch.Store(a)
			var current *Match
			if cancelled {
				a.Abort()
			} else {
				current = assembledTestMatch(t, rc, s)
				b := &asyncHandle{}
				rc.launch.Store(b)
				(&launcherAdapter{rc}).publish(b, current)
			}
			(&launcherAdapter{rc}).publish(a, stale)
			select {
			case <-stale.Done():
			case <-time.After(5 * time.Second):
				t.Fatal("stale assembly did not close")
			}
			if rc.currentMatch() != current {
				t.Fatal("stale launch replaced current match")
			}
			if current != nil {
				stopTestMatch(t, current)
			}
			bootstraps := 0
			for _, msg := range l.take() {
				if msg.msg.GetEvent().GetMapBootstrap() != nil {
					bootstraps++
				}
			}
			want := 0
			if current != nil {
				want = 1
			}
			if bootstraps != want {
				t.Fatalf("got %d bootstraps, want %d", bootstraps, want)
			}
		})
	}
}

func TestWarmupStartStopsPreviousClock(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("clocks")
	s, l := bindLogged(t, h, rc, "host")
	rc.EnsureLauncher()
	s.HostCommand(ombv1.RoomAction_WARMUP)
	warm := waitPublished(t, rc, nil)
	defer stopTestMatch(t, warm)
	s.HostCommand(ombv1.RoomAction_START)
	select {
	case <-warm.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("warmup loop survived START")
	}
	running := waitPublished(t, rc, warm)
	defer stopTestMatch(t, running)
	if !warm.warmup || running.warmup {
		t.Fatal("wrong warmup flags")
	}
	rc.mu.Lock()
	frozen := warm.tick
	rc.mu.Unlock()
	warm.step()
	rc.mu.Lock()
	unchanged := warm.tick == frozen
	rc.mu.Unlock()
	if !unchanged {
		t.Fatal("stopped clock advanced")
	}
	s.HostCommand(ombv1.RoomAction_ABORT)
	stopTestMatch(t, running)
	lastTick := uint32(0)
	seenMap := false
	first := false
	maps := 0
	for _, msg := range l.take() {
		if msg.msg.GetEvent().GetMapBootstrap() != nil {
			seenMap = true
			first = true
			lastTick = 0
			maps++
		}
		if snap := msg.msg.GetSnapshot(); snap != nil {
			if !seenMap || snap.Tick <= lastTick {
				t.Fatalf("snapshot clock order broken: tick %d after %d", snap.Tick, lastTick)
			}
			if first && (!snap.Full || !msg.reliable) {
				t.Fatal("first snapshot after map must be reliable full")
			}
			first = false
			lastTick = snap.Tick
		}
	}
	if maps != 2 {
		t.Fatalf("maps=%d", maps)
	}
}
func waitPublished(t *testing.T, rc *RoomConn, previous *Match) *Match {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(time.Millisecond)
	defer poll.Stop()
	for {
		rc.mu.Lock()
		m := rc.match
		ready := m != nil && m != previous && m.tick > 0
		rc.mu.Unlock()
		if ready {
			return m
		}
		select {
		case <-deadline.C:
			t.Fatal("match publication timed out")
		case <-poll.C:
		}
	}
}

func TestConcurrentInputResyncTakeoverAndTick(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("race")
	discard := func(*ombv1.ServerMsg) {}
	s := joinTestSession(t, h, rc, "host", discard)
	m := assembledTestMatch(t, rc, s)
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()
	var wg sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 1; i <= 80; i++ {
				switch worker {
				case 0:
					s.RouteInput(&ombv1.ClientInput{Seq: uint32(i)})
				case 1:
					m.ForceResync(s.playerID)
					s.Resync()
				case 2:
					m.step()
				case 3:
					next := NewSession(discard, discard)
					h.Register(next)
					if err := rc.Bind(next, "host", "red"); err != nil {
						t.Error(err)
						return
					}
					h.Unregister(next)
				}
			}
		}(worker)
	}
	wg.Wait()
}
