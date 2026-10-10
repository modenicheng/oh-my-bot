package glue

import (
	"reflect"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func bindSpectator(t *testing.T, h *Hub, rc *RoomConn) (*Session, *messageLog) {
	t.Helper()
	log := &messageLog{}
	s := NewSession(log.send(true), log.send(false))
	h.Register(s)
	if err := rc.BindSpectator(s); err != nil {
		t.Fatal(err)
	}
	return s, log
}

func spectatorMatch(t *testing.T, warmup bool) (*Hub, *RoomConn, *Session, *messageLog, *Match) {
	t.Helper()
	if !warmup {
		t.Chdir(t.TempDir())
	}
	h := NewHub()
	rc := h.EnsureRoom("SPECTR")
	player, log := bindLogged(t, h, rc, "alice")
	players := map[uint64]SessionInfo{player.playerID: {PlayerID: player.playerID, Nick: player.nick, Color: player.color}}
	addSoloBots(players, 3)
	m, err := NewMatch(rc, 42, 1, players, warmup, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	m.bootstrapLocked(player)
	rc.mu.Unlock()
	m.step()
	log.take()
	return h, rc, player, log, m
}

func spectatorFull(t *testing.T, msgs []sentMessage, tick uint32) *ombv1.SnapshotDelta {
	t.Helper()
	for _, msg := range msgs {
		if snap := msg.msg.GetSnapshot(); snap != nil && snap.Full && snap.Tick == tick {
			if !msg.reliable || snap.Self != nil || len(snap.Robots) != 4 {
				t.Fatalf("invalid spectator full: reliable=%v self=%v robots=%d", msg.reliable, snap.Self, len(snap.Robots))
			}
			return snap
		}
	}
	t.Fatalf("no reliable full at tick %d", tick)
	return nil
}

func TestSpectatorBindHasNoRoomSideEffects(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("SPECTR")
	player, _ := bindLogged(t, h, rc, "alice")
	spec, log := bindSpectator(t, h, rc)
	if !spec.IsSpectator() || rc.Room.MemberCount() != 1 || rc.Room.HostID() != player.playerID || len(rc.identities) != 1 || len(rc.sessions) != 1 {
		t.Fatal("spectator changed player membership or identity")
	}
	for _, msg := range log.take() {
		if state := msg.msg.GetEvent().GetRoomState(); state != nil {
			if state.RobotsOnline != 1 || state.HostNick != "alice" {
				t.Fatalf("spectator changed room broadcast: %v", state)
			}
			return
		}
	}
	t.Fatal("missing room state")
}

func TestSpectatorMidMatchJoinAndResync(t *testing.T) {
	h, rc, player, plog, m := spectatorMatch(t, true)
	spec, log := bindSpectator(t, h, rc)
	m.step()
	msgs := log.take()
	if len(msgs) == 0 || msgs[0].msg.GetEvent().GetMapBootstrap() == nil {
		t.Fatal("bootstrap must precede spectator frame")
	}
	first := spectatorFull(t, msgs, 2)
	for _, robot := range first.Robots {
		if robot.Nick == "" {
			t.Fatal("full global frame lacks robot identity")
		}
	}
	if m.encoders[m.robotOf[player.playerID]] == m.specEncoders[spec.playerID] {
		t.Fatal("player and spectator share encoder")
	}
	plog.take()
	spec.Resync()
	m.step()
	spectatorFull(t, log.take(), 3)
	if lastSnapshot(t, plog.take()).Full {
		t.Fatal("spectator resync forced player encoder")
	}
}

func TestSpectatorDisconnectFencesActionsAndFreesOnlyOwnState(t *testing.T) {
	h, rc, player, plog, m := spectatorMatch(t, true)
	spec, log := bindSpectator(t, h, rc)
	m.step()
	log.take()
	plog.take()
	before := m.sim.Snapshot()
	spec.RouteInput(&ombv1.ClientInput{Seq: 999, MoveX: 1000})
	spec.ToggleAssist()
	spec.Say("not allowed")
	spec.SubmitScript(&ombv1.ScriptSubmit{Source: "function tick() {}"})
	spec.AiPrompt(&ombv1.AiPrompt{Text: "not allowed"})
	spec.HostCommand(ombv1.RoomAction_ABORT)
	if !reflect.DeepEqual(before, m.sim.Snapshot()) || !m.activeLocked() || len(plog.take()) != 0 || len(log.take()) != 0 {
		t.Fatal("spectator changed simulation or emitted player action")
	}
	player.RouteInput(&ombv1.ClientInput{Seq: 20, AxisMask: uint32(sim.AxisMove), MoveX: 1000})
	h.Unregister(spec)
	if rc.spectators[spec.playerID] != nil || m.specEncoders[spec.playerID] != nil || m.specReliableFull[spec.playerID] {
		t.Fatal("disconnect retained spectator encoder")
	}
	m.step()
	robot, _ := m.sim.Robot(m.robotOf[player.playerID])
	if robot.ConsumedSeq != 20 || robot.Control.Output.Move.X != 1 || rc.Room.MemberCount() != 1 {
		t.Fatal("spectator disconnect touched human control or membership")
	}
	spec.Resync()
	spec.LeaveRoom()
	if len(m.specEncoders) != 0 || len(log.take()) != 0 {
		t.Fatal("stale spectator regained feed")
	}
}

func TestSpectatorStaleUnregisterDoesNotDropNewEncoder(t *testing.T) {
	h, rc, _, _, m := spectatorMatch(t, true)
	old, _ := bindSpectator(t, h, rc)
	current := NewSession(func(*ombv1.ServerMsg) {}, func(*ombv1.ServerMsg) {})
	current.playerID, current.rc, current.spectator = old.playerID, rc, true
	rc.spectators[old.playerID] = current
	m.step()
	encoder := m.specEncoders[old.playerID]
	h.Unregister(old)
	if rc.spectators[current.playerID] != current || m.specEncoders[current.playerID] != encoder {
		t.Fatal("stale unregister removed current spectator encoder")
	}
}

func TestSpectatorFinalFrameAndEndedJoin(t *testing.T) {
	h, rc, _, _, m := spectatorMatch(t, false)
	_, liveLog := bindSpectator(t, h, rc)
	m.step()
	liveLog.take()
	for m.sim.WorldView().Frame.Tick < sim.MatchTicks-1 {
		m.sim.Tick()
	}
	m.tick = sim.MatchTicks - 1
	liveLog.take()
	m.step()
	msgs := liveLog.take()
	spectatorFull(t, msgs, sim.MatchTicks)
	fullIndex, endIndex, endCount := -1, -1, 0
	for i, msg := range msgs {
		if msg.msg.GetSnapshot() != nil {
			fullIndex = i
		}
		if msg.msg.GetEvent().GetMatchEnd() != nil {
			endIndex, endCount = i, endCount+1
			if !msg.reliable {
				t.Fatal("unreliable final settlement")
			}
		}
	}
	if fullIndex < 0 || endIndex <= fullIndex || endCount != 1 {
		t.Fatal("final full must precede one settlement event")
	}
	stopTestMatch(t, m)
	late, lateLog := bindSpectator(t, h, rc)
	verify := func(msgs []sentMessage) {
		t.Helper()
		if len(msgs) < 3 || msgs[0].msg.GetEvent().GetMapBootstrap() == nil || msgs[2].msg.GetEvent().GetMatchEnd() == nil {
			t.Fatal("ended join requires immediate map/full/end without another tick")
		}
		spectatorFull(t, msgs, sim.MatchTicks)
		if !reflect.DeepEqual(msgs[2].msg.GetEvent(), m.finalEnd) {
			t.Fatal("settlement changed after end")
		}
	}
	verify(lateLog.take())
	late.Resync()
	verify(lateLog.take())
}

func TestSpectatorWaitsThroughAbortAndMapReplacement(t *testing.T) {
	h, rc, player, _, old := spectatorMatch(t, true)
	spec, log := bindSpectator(t, h, rc)
	old.step()
	log.take()
	stopTestMatch(t, old)
	spec.Resync()
	if len(log.take()) != 0 {
		t.Fatal("aborted match replayed stale frame")
	}
	_, lateLog := bindSpectator(t, h, rc)
	for _, msg := range lateLog.take() {
		if msg.msg.GetSnapshot() != nil || msg.msg.GetEvent().GetMapBootstrap() != nil {
			t.Fatal("aborted match bootstrapped")
		}
	}
	log.take() // The later observer's bind also broadcasts room state to this one.
	players := map[uint64]SessionInfo{player.playerID: {PlayerID: player.playerID, Nick: player.nick}}
	addSoloBots(players, 3)
	next, err := NewMatch(rc, 77, 2, players, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, next) })
	rc.mu.Lock()
	rc.match = next
	for _, s := range rc.spectators {
		next.bootstrapSpectatorLocked(s)
	}
	rc.mu.Unlock()
	next.step()
	msgs := log.take()
	if msgs[0].msg.GetEvent().GetMapBootstrap() == nil {
		t.Fatal("replacement lacks map bootstrap")
	}
	spectatorFull(t, msgs, 1)
	old.step()
	if len(log.take()) != 0 {
		t.Fatal("superseded match published")
	}
}

func TestSpectatorCapEnforcedAndLeaveReleasesSlot(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("SPECTR")
	var first *Session
	for i := 0; i < maxSpectators; i++ {
		s, _ := bindSpectator(t, h, rc)
		if first == nil {
			first = s
		}
	}
	over := NewSession(func(*ombv1.ServerMsg) {}, func(*ombv1.ServerMsg) {})
	h.Register(over)
	if err := rc.BindSpectator(over); err == nil {
		t.Fatal("spectator cap not enforced")
	}
	first.LeaveRoom()
	if err := rc.BindSpectator(over); err != nil {
		t.Fatal(err)
	}
	if rc.Room.MemberCount() != 0 || rc.Room.HostID() != 0 || len(rc.identities) != 0 {
		t.Fatal("spectator allocated a player")
	}
}

// TestEndedPlayerFinalFrameReliableFull（审计 S-34）：终局 tick 玩家帧与观战者
// 同样 ForceFull + 可靠发送——没有下一个 tick 可以修复丢失的末帧；局中普通
// tick 仍走 lossy（对照组）。
func TestEndedPlayerFinalFrameReliableFull(t *testing.T) {
	_, _, _, plog, m := spectatorMatch(t, false) // 内部已 step 到 tick 1（bootstrap 后首帧 reliable full）
	m.step()                                     // tick 2：普通帧
	mid := lastSnapshot(t, plog.take())
	if mid.Full || mid.Tick != 2 {
		t.Fatalf("mid-match frame should be a lossy delta: full=%v tick=%d", mid.Full, mid.Tick)
	}
	for m.sim.WorldView().Frame.Tick < sim.MatchTicks-1 {
		m.sim.Tick()
	}
	m.tick = sim.MatchTicks - 1
	plog.take()
	m.step() // tick = MatchTicks：终局帧

	msgs := plog.take()
	var final *sentMessage
	for i := len(msgs) - 1; i >= 0; i-- {
		if snap := msgs[i].msg.GetSnapshot(); snap != nil && snap.Tick == sim.MatchTicks {
			final = &msgs[i]
			break
		}
	}
	if final == nil {
		t.Fatal("no final player frame at MatchTicks")
	}
	if !final.reliable || !final.msg.GetSnapshot().Full {
		t.Fatalf("final player frame must be reliable+full (S-34): reliable=%v full=%v",
			final.reliable, final.msg.GetSnapshot().Full)
	}
}
