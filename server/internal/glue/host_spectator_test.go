package glue

import (
	"fmt"
	"reflect"
	"sync"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/room"
)

func bindHostSpectator(t *testing.T, h *Hub, rc *RoomConn, nick string) (*Session, *messageLog) {
	t.Helper()
	log := &messageLog{}
	s := NewSession(log.send(true), log.send(false), nil)
	h.Register(s)
	if err := rc.BindHostSpectator(s, nick, "#22d3ee"); err != nil {
		t.Fatal(err)
	}
	return s, log
}

func TestHostSpectatorBindDoesNotCreatePlayer(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("HOSTSP")
	host, log := bindHostSpectator(t, h, rc, "host")
	if !host.IsHostSpectator() || host.IsSpectator() || rc.hostSession != host {
		t.Fatal("host spectator session did not get the control role")
	}
	if len(rc.sessions) != 0 || len(rc.identities) != 0 || rc.Room.MemberCount() != 0 {
		t.Fatal("host spectator occupied a player identity")
	}
	state := lastRoomState(t, log.take())
	if !state.GetHostSpectator() || state.GetRobotsOnline() != 0 || state.GetHostNick() != "host" {
		t.Fatalf("unexpected host spectator room state: %+v", state)
	}

	guest, _ := bindLogged(t, h, rc, "guest")
	if len(rc.sessions) != 1 || rc.Room.MemberCount() != 1 || rc.Room.HostID() != host.playerID {
		t.Fatal("ordinary player did not join without taking host control")
	}
	if guest.IsHost() {
		t.Fatal("ordinary player took host control from spectator host")
	}
}

func TestHostSpectatorReconnectRestoresControlIdentity(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("HOSTRC")
	old, _ := bindHostSpectator(t, h, rc, "host")
	hostID := old.playerID
	h.Unregister(old)
	if rc.hostSession != nil || rc.Room.HostID() != hostID {
		t.Fatal("disconnect released host spectator identity")
	}

	log := &messageLog{}
	newSession := NewSession(log.send(true), log.send(false), nil)
	h.Register(newSession)
	if err := rc.BindJoin(newSession, "host", "#22d3ee", true); err != nil {
		t.Fatal(err)
	}
	if !newSession.IsHostSpectator() || newSession.playerID != hostID || rc.hostSession != newSession {
		t.Fatal("host reconnect did not restore the original control identity")
	}
	if len(rc.sessions) != 0 || rc.Room.MemberCount() != 0 || len(rc.identities) != 0 {
		t.Fatal("host reconnect created a player identity")
	}
	if !lastRoomState(t, log.take()).GetHostSpectator() {
		t.Fatal("host spectator mode disappeared after reconnect")
	}
}

func TestHostSpectatorReceivesFullWorldSnapshotsWithoutSelf(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("HOSTVW")
	host, hostLog := bindHostSpectator(t, h, rc, "host")
	player, _ := bindLogged(t, h, rc, "player")
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{
		player.playerID: {PlayerID: player.playerID, Nick: player.nick, Color: player.color},
	}, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	m.bootstrapHostSpectatorLocked(host)
	rc.mu.Unlock()
	m.step()

	for _, sent := range hostLog.take() {
		if snap := sent.msg.GetSnapshot(); snap != nil && snap.Full {
			if snap.Self != nil || len(snap.Robots) != 1 || !sent.reliable {
				t.Fatalf("host spectator received player projection: reliable=%v self=%v robots=%d", sent.reliable, snap.Self, len(snap.Robots))
			}
			return
		}
	}
	t.Fatal("host spectator did not receive a full world snapshot")
}

func TestHostSpectatorCannotUsePlayerActions(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("HOSTIN")
	host, hostLog := bindHostSpectator(t, h, rc, "host")
	player, _ := bindLogged(t, h, rc, "player")
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{
		player.playerID: {PlayerID: player.playerID, Nick: player.nick},
	}, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()
	before := m.sim.Snapshot()
	hostLog.take()
	host.RouteInput(&ombv1.ClientInput{Seq: 99, MoveX: 1000})
	host.Say("blocked")
	host.ToggleAssist()
	host.SubmitScript(&ombv1.ScriptSubmit{Source: "function tick() {}"})
	host.ScriptRollback(&ombv1.ScriptRollback{VersionId: 1})
	host.BuyUpgrade(1)
	host.AiPrompt(&ombv1.AiPrompt{Text: "blocked"})
	host.ConfigureSnippets(&ombv1.SnippetConfig{})
	if !reflect.DeepEqual(before, m.sim.Snapshot()) || len(hostLog.take()) != 0 ||
		len(rc.snippets) != 0 || len(rc.scriptSource) != 0 || len(rc.scriptVersions) != 0 || len(rc.assist) != 0 {
		t.Fatal("host spectator changed simulation or emitted player output")
	}
}

func TestHostSpectatorConcurrentFirstJoinsAreAtomic(t *testing.T) {
	for attempt := 0; attempt < 30; attempt++ {
		h := NewHub()
		rc := h.EnsureRoom("HOSTCC")
		const count = 12
		sessions := make([]*Session, count)
		for i := range sessions {
			sessions[i] = NewSession(func(*ombv1.ServerMsg) {}, func(*ombv1.ServerMsg) {}, nil)
			h.Register(sessions[i])
		}
		start := make(chan struct{})
		results := make(chan error, count)
		var joins sync.WaitGroup
		for i, s := range sessions {
			joins.Add(1)
			go func() {
				defer joins.Done()
				<-start
				results <- rc.BindJoin(s, fmt.Sprintf("player%d", i), "red", true)
			}()
		}
		close(start)
		joins.Wait()
		close(results)
		for err := range results {
			if err != nil {
				t.Fatalf("simultaneous first joins rejected a later player: %v", err)
			}
		}
		if rc.hostSession == nil || !rc.Room.HostSpectator() || len(rc.sessions) != count-1 ||
			len(rc.identities) != count-1 || rc.Room.MemberCount() != count-1 {
			t.Fatal("first joins did not produce one host spectator and the remaining players")
		}
	}
}

func TestHostSpectatorLaterJoinIntentDoesNotChangeMode(t *testing.T) {
	for _, spectatorHost := range []bool{false, true} {
		t.Run(fmt.Sprintf("spectatorHost=%v", spectatorHost), func(t *testing.T) {
			h := NewHub()
			rc := h.EnsureRoom("HOSTMD")
			join := func(nick string, intent bool) *Session {
				s := NewSession(func(*ombv1.ServerMsg) {}, func(*ombv1.ServerMsg) {}, nil)
				h.Register(s)
				if err := rc.BindJoin(s, nick, "red", intent); err != nil {
					t.Fatal(err)
				}
				return s
			}
			host := join("host", spectatorHost)
			for i, intent := range []bool{true, false, true} {
				guest := join(fmt.Sprintf("guest%d", i), intent)
				if guest.IsHostSpectator() || guest.IsHost() {
					t.Fatal("later Join changed a guest into host spectator")
				}
			}
			if rc.Room.HostSpectator() != spectatorHost || !host.IsHost() {
				t.Fatal("later Join changed the creation mode or host")
			}
		})
	}
}

func TestHostSpectatorExplicitLeaveFullyReleasesIdentity(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("HOSTLV")
	host, log := bindHostSpectator(t, h, rc, "host")
	player, _ := bindLogged(t, h, rc, "player")
	m := assembledTestMatch(t, rc, player)
	rc.mu.Lock()
	rc.match = m
	m.bootstrapHostSpectatorLocked(host)
	rc.mu.Unlock()
	m.step()
	log.take()
	hostID := host.playerID
	host.LeaveRoom()
	if rc.hostSession != nil || rc.hostIdentitySet || !reflect.DeepEqual(rc.hostIdentity, SessionInfo{}) {
		t.Fatal("explicit leave retained dedicated host recovery identity")
	}
	if m.specEncoders[hostID] != nil || m.specReliableFull[hostID] {
		t.Fatal("explicit leave retained host spectator encoder")
	}
	if !player.IsHost() || host.IsHost() || rc.Room.HostSpectator() {
		t.Fatal("explicit leave did not transfer host control")
	}
	host.Resync()
	host.HostCommand(ombv1.RoomAction_SOLO_BOTS)
	h.Unregister(host)
	log.take()
	m.step()
	if len(log.take()) != 0 || rc.Room.SoloBots() != 0 {
		t.Fatal("departed host retained control or snapshot feed")
	}
	rejoin, _ := bindLogged(t, h, rc, "host")
	if rejoin.IsHostSpectator() || rejoin.playerID == hostID || rc.Room.MemberCount() != 2 {
		t.Fatal("explicitly released nickname could not rejoin as a fresh player")
	}
}

func TestHostSpectatorLeaveAllowsNewHostInEmptyRoom(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("HOSTNW")
	host, _ := bindHostSpectator(t, h, rc, "host")
	host.LeaveRoom()
	h.Unregister(host)
	next := NewSession(func(*ombv1.ServerMsg) {}, func(*ombv1.ServerMsg) {}, nil)
	h.Register(next)
	if err := rc.BindJoin(next, "host", "red", true); err != nil {
		t.Fatal(err)
	}
	if !next.IsHost() || next.IsHostSpectator() || rc.Room.MemberCount() != 1 {
		t.Fatal("new host could not join as a player after explicit host leave")
	}
}

func TestHostSpectatorReconnectPublishesRoleBeforeMap(t *testing.T) {
	for _, spectatorHost := range []bool{false, true} {
		t.Run(fmt.Sprintf("spectatorHost=%v", spectatorHost), func(t *testing.T) {
			h := NewHub()
			rc := h.EnsureRoom("HOSTOR")
			old := NewSession(func(*ombv1.ServerMsg) {}, func(*ombv1.ServerMsg) {}, nil)
			h.Register(old)
			if err := rc.BindJoin(old, "host", "red", spectatorHost); err != nil {
				t.Fatal(err)
			}
			player := old
			if spectatorHost {
				player, _ = bindLogged(t, h, rc, "player")
			}
			m := assembledTestMatch(t, rc, player)
			rc.mu.Lock()
			rc.match = m
			rc.mu.Unlock()
			h.Unregister(old)
			log := &messageLog{}
			reconnect := NewSession(log.send(true), log.send(false), nil)
			h.Register(reconnect)
			if err := rc.BindJoin(reconnect, "host", "red", false); err != nil {
				t.Fatal(err)
			}
			stateIndex, mapIndex := -1, -1
			for i, sent := range log.take() {
				if state := sent.msg.GetEvent().GetRoomState(); state != nil {
					stateIndex = i
					if state.HostNick != "host" || state.HostSpectator != spectatorHost {
						t.Fatal("reconnect received incorrect authoritative role")
					}
				}
				if sent.msg.GetEvent().GetMapBootstrap() != nil {
					mapIndex = i
				}
			}
			if mapIndex < 0 {
				t.Fatal("reconnect did not receive map bootstrap")
			}
			if spectatorHost && (stateIndex < 0 || mapIndex <= stateIndex) {
				t.Fatal("host spectator role must arrive before map bootstrap")
			}
			if !spectatorHost && mapIndex != 0 {
				// Ordinary player reconnects retain the established bootstrap-first
				// contract; a room-state catch-up may follow it.
				if stateIndex >= 0 && stateIndex < mapIndex {
					t.Fatal("ordinary player role state must not precede map bootstrap")
				}
			}
			m.step()
			if snap := lastSnapshot(t, log.take()); !snap.Full || (snap.Self == nil) != spectatorHost {
				t.Fatal("host reconnect did not force the correct full snapshot projection")
			}
		})
	}
}

func TestHostSpectatorReconnectAfterSettlementAndStartNext(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("HOSTEN")
	host, log := bindHostSpectator(t, h, rc, "host")
	player, playerLog := bindLogged(t, h, rc, "player")
	first := startScoredMatchViaHost(t, h, rc, host)
	host.HostCommand(ombv1.RoomAction_PAUSE)
	first.step()
	rc.mu.Lock()
	paused := rc.paused
	rc.mu.Unlock()
	if !paused {
		t.Fatal("host spectator could not pause")
	}
	log.take()
	host.Resync()
	first.step()
	if snap := lastSnapshot(t, log.take()); !snap.Full || snap.Self != nil {
		t.Fatal("paused resync did not return full spectator snapshot")
	}
	host.HostCommand(ombv1.RoomAction_RESUME)
	if lastRoomState(t, log.take()).GetPaused() {
		t.Fatal("host spectator could not resume")
	}
	host.HostCommand(ombv1.RoomAction_FINISH)
	first.step()
	stopTestMatch(t, first)
	if rc.Room.State() != room.Ended {
		t.Fatal("host spectator could not finish")
	}
	if snap := lastSnapshot(t, playerLog.take()); snap.Self == nil {
		t.Fatal("normal player lost its self snapshot")
	}
	if scores := rc.Room.SessionScores(); len(scores) != 1 || scores[0].PlayerID != player.playerID {
		t.Fatal("host spectator appeared on the session board")
	}
	hostID := host.playerID
	h.Unregister(host)
	log = &messageLog{}
	reconnect := NewSession(log.send(true), log.send(false), nil)
	h.Register(reconnect)
	if err := rc.BindJoin(reconnect, "host", "red", false); err != nil {
		t.Fatal(err)
	}
	if !reconnect.IsHost() || reconnect.playerID != hostID || !reconnect.IsHostSpectator() {
		t.Fatal("ended reconnect lost dedicated host identity")
	}
	verifySettlement := func(msgs []sentMessage, withRole bool) {
		t.Helper()
		if withRole {
			if len(msgs) == 0 || !msgs[0].msg.GetEvent().GetRoomState().GetHostSpectator() {
				t.Fatal("ended reconnect did not publish authoritative role first")
			}
			msgs = msgs[1:]
		}
		if len(msgs) != 3 || msgs[0].msg.GetEvent().GetMapBootstrap() == nil ||
			msgs[1].msg.GetSnapshot() == nil || msgs[2].msg.GetEvent().GetMatchEnd() == nil {
			t.Fatal("ended host requires immediate map/full/settlement replay")
		}
		if snap := msgs[1].msg.GetSnapshot(); !snap.Full || snap.Self != nil || len(snap.Robots) != 1 {
			t.Fatal("frozen settlement snapshot has wrong host projection")
		}
		for _, msg := range msgs {
			if !msg.reliable {
				t.Fatal("settlement replay must be reliable")
			}
		}
		if !reflect.DeepEqual(msgs[2].msg.GetEvent(), first.finalEnd) {
			t.Fatal("reconnect settlement differs from the frozen settlement")
		}
	}
	verifySettlement(log.take(), true)
	reconnect.Resync()
	verifySettlement(log.take(), false)
	reconnect.HostCommand(ombv1.RoomAction_START)
	next := waitPublished(t, rc, first)
	t.Cleanup(func() { stopTestMatch(t, next) })
	if next.warmup || rc.Room.SessionSeq() != 2 || len(next.robotOf) != 1 || next.robotOf[hostID] != 0 {
		t.Fatal("direct START from ended lost host mode or changed the player roster")
	}
}

func TestHostSpectatorIsHostFencesTakeovers(t *testing.T) {
	for _, spectatorHost := range []bool{false, true} {
		t.Run(fmt.Sprintf("spectatorHost=%v", spectatorHost), func(t *testing.T) {
			h := NewHub()
			rc := h.EnsureRoom("HOSTTK")
			log := &messageLog{}
			old := NewSession(log.send(true), log.send(false), nil)
			h.Register(old)
			if err := rc.BindJoin(old, "host", "red", spectatorHost); err != nil {
				t.Fatal(err)
			}
			stop, done := make(chan struct{}), make(chan struct{})
			go func() {
				defer close(done)
				for {
					select {
					case <-stop:
						return
					default:
						old.IsHost()
					}
				}
			}()
			current := NewSession(func(*ombv1.ServerMsg) {}, func(*ombv1.ServerMsg) {}, nil)
			h.Register(current)
			err := rc.BindJoin(current, "host", "red", false)
			close(stop)
			<-done
			if err != nil {
				t.Fatal(err)
			}
			if old.IsHost() || !current.IsHost() {
				t.Fatal("IsHost did not fence the superseded connection")
			}
			h.Unregister(old)
			old.LeaveRoom()
			if !current.IsHost() {
				t.Fatal("stale disconnect or leave removed current host")
			}
		})
	}
}
