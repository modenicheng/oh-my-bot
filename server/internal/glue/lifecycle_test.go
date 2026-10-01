package glue

import (
	"bytes"
	"sync"
	"testing"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/room"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
	"github.com/modenicheng/oh-my-bot/server/internal/stats"
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

func TestMultiSinkForwardsControlsAndCheckpoints(t *testing.T) {
	var buf bytes.Buffer
	primary, err := sim.NewMatchEventLogWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	projector := stats.NewProjector()
	sink := multiSink{primary: primary, secondary: projector}
	initial := sim.Checkpoint{Tick: 0, Robots: []sim.Robot{{ID: 1}}, Walls: []sim.Wall{}}
	sink.OnMatchInit(initial)
	sink.OnControl(1, 1, sim.ControlRecord{Toggles: 1, Say: "hello"})
	sink.OnCheckpoint(sim.Checkpoint{Tick: sim.CheckpointInterval, Robots: []sim.Robot{{ID: 1, Position: sim.Vec2{X: 4}}}, Walls: []sim.Wall{}})
	if err := primary.Close(); err != nil {
		t.Fatal(err)
	}
	records, err := sim.ReadMatchEventLog(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	foundControl := false
	for _, record := range records {
		if record.Type == "control" && record.Control != nil && record.Control.Say == "hello" {
			foundControl = true
		}
	}
	if !foundControl {
		t.Fatal("production multiSink dropped control record")
	}
	if projector.Live().Tick != sim.CheckpointInterval {
		t.Fatalf("projector did not receive checkpoint: tick=%d", projector.Live().Tick)
	}
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

func TestDisconnectReleasesOnlyCurrentHumanControls(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("release")
	old, oldLog := bindLogged(t, h, rc, "pilot")
	m := assembledTestMatch(t, rc, old)
	rc.mu.Lock()
	rc.match = m
	m.bootstrapLocked(old)
	rc.mu.Unlock()
	m.step()
	rid := lastSnapshot(t, oldLog.take()).Self.RobotId
	old.RouteInput(&ombv1.ClientInput{Seq: 5, AxisMask: 13, MoveX: 1000, Fire: true, Interact: true})
	h.Unregister(old) // Pending controls must be stopped before they can become held.
	m.step()
	r, _ := m.sim.Robot(rid)
	if r.Control.Output.Move.X != 0 || r.Control.Output.Fire || r.Control.Output.Interact || r.ConsumedSeq != 6 {
		t.Fatalf("disconnected input remained held: %+v", r.Control.Output)
	}
	current, log := bindLogged(t, h, rc, "pilot")
	m.step()
	full := lastSnapshot(t, log.take())
	if !full.Full || full.AckSeq != 6 {
		t.Fatalf("stop sequence not acknowledged: %v", full)
	}
	current.RouteInput(&ombv1.ClientInput{Seq: 7, AxisMask: 1, MoveY: 1000})
	h.Unregister(old) // A late close from the old transport cannot stop its replacement.
	m.step()
	r, _ = m.sim.Robot(rid)
	if r.Control.Output.Move.Y != 1 || r.ConsumedSeq != 7 {
		t.Fatal("stale transport stopped replacement")
	}
	current.LeaveRoom()
	m.step()
	r, _ = m.sim.Robot(rid)
	if r.Control.Output.Move.Y != 0 {
		t.Fatal("explicit leave left movement held")
	}
}

func TestSkillStateAndConfirmedShotSurviveReconnect(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("skills")
	s, log := bindLogged(t, h, rc, "pilot")
	m := assembledTestMatch(t, rc, s)
	rc.mu.Lock()
	rc.match = m
	m.bootstrapLocked(s)
	rc.mu.Unlock()
	m.step()
	initial := lastSnapshot(t, log.take())
	if initial.Self.AssistOn == nil || initial.Self.GetAssistOn() {
		t.Fatal("new matches must start with assistance off")
	}
	rid := initial.Self.RobotId
	s.RouteInput(&ombv1.ClientInput{Seq: 1, AxisMask: 15, Aim: 1.25, Fire: true, Dash: true})
	m.step()
	msgs := log.take()
	snap := lastSnapshot(t, msgs)
	if snap.Self.GetDashReadyTick() <= snap.Tick || snap.Self.GetFireReadyTick() <= snap.Tick {
		t.Fatalf("accepted skills missing authoritative cooldown: %v", snap.Self)
	}
	shot := false
	for _, msg := range msgs {
		if ev := msg.msg.GetEvent().GetShot(); ev != nil && ev.Owner == rid {
			shot = true
		}
	}
	if !shot {
		t.Fatal("accepted shot missing reliable feedback event")
	}
	s.ToggleAssist()
	m.step()
	replacement, restoredLog := bindLogged(t, h, rc, "pilot")
	m.step()
	restored := lastSnapshot(t, restoredLog.take())
	if !restored.Full || !restored.Self.GetAssistOn() || restored.Self.GetDashReadyTick() != snap.Self.GetDashReadyTick() {
		t.Fatalf("reconnect lost private skill state: %v", restored.Self)
	}
	s.ToggleAssist() // superseded sessions cannot change current controls
	m.step()
	if !lastSnapshot(t, restoredLog.take()).Self.GetAssistOn() {
		t.Fatal("superseded session changed assist state")
	}
	replacement.ToggleAssist()
	m.step()
	if lastSnapshot(t, restoredLog.take()).Self.GetAssistOn() {
		t.Fatal("current session could not disable assist")
	}
	h.Unregister(s)
	h.Unregister(replacement)
}

func TestManualSayUsesCurrentSessionAndReliableBroadcast(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("say")
	old, _ := bindLogged(t, h, rc, "pilot")
	old.Say("no match")
	m := assembledTestMatch(t, rc, old)
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()
	current, log := bindLogged(t, h, rc, "pilot")
	observer, observerLog := bindLogged(t, h, rc, "viewer")
	old.Say("superseded")
	current.Say("hello")
	current.Say("flood")
	for _, msg := range log.take() {
		if msg.msg.GetEvent().GetSay() != nil {
			t.Fatal("say broadcast before Tick")
		}
	}
	m.step()
	for _, msgs := range [][]sentMessage{log.take(), observerLog.take()} {
		count := 0
		for _, msg := range msgs {
			if ev := msg.msg.GetEvent().GetSay(); ev != nil {
				count++
				if ev.Robot != m.robotOf[current.playerID] || ev.Text != "hello" || !msg.reliable {
					t.Fatalf("invalid say broadcast: %v", msg)
				}
			}
		}
		if count != 1 {
			t.Fatalf("expected one reliable say, got %d", count)
		}
	}
	rc.mu.Lock()
	for i := 0; i < 179; i++ {
		m.sim.Tick()
	}
	rc.mu.Unlock()
	current.LeaveRoom()
	current.Say("left")
	h.Unregister(old)
	old.Say("stale close")
	log.take()
	observerLog.take()
	m.step()
	for _, msg := range observerLog.take() {
		if msg.msg.GetEvent().GetSay() != nil {
			t.Fatal("detached session spoke after leaving")
		}
	}
	h.Unregister(observer)
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
