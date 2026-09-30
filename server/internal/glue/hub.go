// Package glue connects transport sessions, room lifecycle and simulation.
package glue

import (
	"fmt"
	"sync"
	"sync/atomic"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/room"
)

type Hub struct {
	mu     sync.Mutex
	rooms  map[string]*RoomConn
	player map[uint64]*Session
	nextID uint64
}

func NewHub() *Hub {
	return &Hub{rooms: map[string]*RoomConn{}, player: map[uint64]*Session{}, nextID: 1000}
}
func (h *Hub) EnsureRoom(code string) *RoomConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if rc := h.rooms[code]; rc != nil {
		return rc
	}
	rc := newRoomConn(code)
	h.rooms[code] = rc
	return rc
}
func (h *Hub) Register(s *Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.nextID++
	s.playerID = h.nextID
	s.hub = h
	h.player[s.playerID] = s
}

// Unregister detaches only this connection. Membership and recovery identity survive.
func (h *Hub) Unregister(s *Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rc := s.rc; rc != nil {
		rc.mu.Lock()
		if rc.sessions[s.playerID] == s {
			if m := rc.match; m != nil && m.activeLocked() {
				m.releaseHumanLocked(s.playerID)
			}
			delete(rc.sessions, s.playerID)
		}
		rc.mu.Unlock()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.player[s.playerID] == s {
		delete(h.player, s.playerID)
	}
}

type RoomConn struct {
	Code string
	Room *room.Room
	// One owner lock covers membership, active-session checks, sim mutations,
	// encoder state and publication. Launcher/Abort never acquire it under Room.mu.
	mu         sync.Mutex
	sessions   map[uint64]*Session
	identities map[string]SessionInfo
	match      *Match
	launcher   room.SimLauncher
	launch     atomic.Pointer[asyncHandle]
}

func newRoomConn(code string) *RoomConn {
	return &RoomConn{Code: code, Room: room.NewRoom(code, 0), sessions: map[uint64]*Session{}, identities: map[string]SessionInfo{}}
}

type Session struct {
	mu           sync.Mutex // binding fields; lock before RoomConn.mu, then Hub.mu
	hub          *Hub
	playerID     uint64
	nick, color  string
	rc           *RoomConn
	SendReliable func(*ombv1.ServerMsg)
	SendLossy    func(*ombv1.ServerMsg)
}

func NewSession(reliable, lossy func(*ombv1.ServerMsg)) *Session {
	return &Session{SendReliable: reliable, SendLossy: lossy}
}

// Bind uses exact room+nickname as the internal-deployment recovery identity.
// The newest connection takes over, including host rights; prior sockets become inert.
// Reconnect retains original metadata and robot state rather than creating a robot.
func (rc *RoomConn) Bind(s *Session, nick, color string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if s.rc != nil {
		return fmt.Errorf("session already bound")
	}
	info, restore := rc.identities[nick]
	if !restore {
		info = SessionInfo{PlayerID: s.playerID, Nick: nick, Color: color}
		if err := rc.Room.Join(info.PlayerID, nick, color); err != nil {
			return fmt.Errorf("join room: %w", err)
		}
		rc.Room.TransferHost(info.PlayerID)
		rc.identities[nick] = info
	}
	if s.hub != nil {
		s.hub.mu.Lock()
		if s.hub.player[s.playerID] == s {
			delete(s.hub.player, s.playerID)
		}
		s.playerID = info.PlayerID
		s.hub.player[s.playerID] = s
		s.hub.mu.Unlock()
	} else {
		s.playerID = info.PlayerID
	}
	s.nick, s.color, s.rc = info.Nick, info.Color, rc
	if rc.sessions[s.playerID] != nil {
		if m := rc.match; m != nil && m.activeLocked() {
			m.releaseHumanLocked(s.playerID)
		}
	}
	rc.sessions[s.playerID] = s
	if m := rc.match; m != nil && m.activeLocked() {
		m.bootstrapLocked(s)
	}
	return nil
}
func (s *Session) BindRoom(rc *RoomConn) { s.mu.Lock(); defer s.mu.Unlock(); s.rc = rc }

// withRoom fences every upstream operation against a nickname takeover or detach.
func (s *Session) withRoom(fn func(*RoomConn)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rc := s.rc; rc != nil {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		if rc.sessions[s.playerID] == s {
			fn(rc)
		}
	}
}
func (s *Session) RouteInput(in *ombv1.ClientInput) {
	s.withRoom(func(rc *RoomConn) {
		if m := rc.match; m != nil && m.activeLocked() {
			m.applyInputLocked(s.playerID, in)
		}
	})
}
func (s *Session) Say(text string) {
	s.withRoom(func(rc *RoomConn) {
		if m := rc.match; m != nil && m.activeLocked() {
			if rid, ok := m.robotOf[s.playerID]; ok {
				m.sim.Say(rid, text)
			}
		}
	})
}
func (s *Session) ToggleAssist() {
	s.withRoom(func(rc *RoomConn) {
		if m := rc.match; m != nil && m.activeLocked() {
			if rid, ok := m.robotOf[s.playerID]; ok {
				m.sim.AssistToggle(rid)
			}
		}
	})
}
func (s *Session) HostCommand(kind ombv1.RoomAction_Kind) {
	act := map[ombv1.RoomAction_Kind]room.Action{ombv1.RoomAction_START: room.ActionStart, ombv1.RoomAction_ABORT: room.ActionAbort, ombv1.RoomAction_RESTART: room.ActionRestart, ombv1.RoomAction_WARMUP: room.ActionWarmup}[kind]
	if act == 0 {
		return
	}
	s.withRoom(func(rc *RoomConn) {
		if err := rc.Room.HostCommand(s.playerID, act); err != nil {
			s.SendReliable(say("command failed: " + err.Error()))
			return
		}
		rc.broadcastRoomStateLocked()
	})
}
func (s *Session) SubmitScript(sub *ombv1.ScriptSubmit) {
	if sub == nil {
		return
	}
	s.withRoom(func(rc *RoomConn) {
		m := rc.match
		if m == nil || !m.activeLocked() {
			return
		}
		ok, errMsg, rev := m.submitScriptLocked(s.playerID, sub.GetSource())
		s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_ScriptResult{ScriptResult: &ombv1.EvScriptResult{ClientScriptId: sub.GetClientScriptId(), Ok: ok, Error: errMsg, ScriptRev: rev}}}}})
	})
}
func (s *Session) AiPrompt(p *ombv1.AiPrompt) {
	if p == nil {
		return
	}
	s.withRoom(func(rc *RoomConn) {
		if m := rc.match; m != nil && m.activeLocked() {
			rc.broadcastLocked(say("AI agent: not configured (set DEEPSEEK_API_KEY) — prompt: " + p.GetText()))
		}
	})
}
func (s *Session) Resync() {
	s.withRoom(func(rc *RoomConn) {
		if m := rc.match; m != nil && m.activeLocked() {
			m.forceResyncLocked(s.playerID)
		}
	})
}

// Explicit leave frees the seat and nickname; closing a socket uses Unregister instead.
func (s *Session) LeaveRoom() {
	s.withRoom(func(rc *RoomConn) {
		if m := rc.match; m != nil && m.activeLocked() {
			m.releaseHumanLocked(s.playerID)
		}
		delete(rc.sessions, s.playerID)
		delete(rc.identities, s.nick)
		_ = rc.Room.Leave(s.playerID)
		if s.hub != nil {
			s.hub.mu.Lock()
			if s.hub.player[s.playerID] == s {
				delete(s.hub.player, s.playerID)
			}
			s.hub.mu.Unlock()
		}
		rc.broadcastRoomStateLocked()
	})
}
func (rc *RoomConn) sessionOf(pid uint64) *Session {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.sessions[pid]
}
func (rc *RoomConn) Broadcast(msg *ombv1.ServerMsg) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.broadcastLocked(msg)
}
func (rc *RoomConn) broadcastLocked(msg *ombv1.ServerMsg) {
	for _, s := range rc.sessions {
		s.SendReliable(msg)
	}
}
func (rc *RoomConn) BroadcastRoomState() {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.broadcastRoomStateLocked()
}
func (rc *RoomConn) broadcastRoomStateLocked() {
	rc.broadcastLocked(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_RoomState{RoomState: rc.Room.StateBroadcast()}}}})
}
func say(text string) *ombv1.ServerMsg {
	return &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Text: text}}}}}
}

type launcherAdapter struct{ rc *RoomConn }

func (la *launcherAdapter) Launch(seed uint64, ids []uint64) room.MatchHandle {
	return la.launch(seed, ids, false)
}
func (la *launcherAdapter) LaunchWarmup(seed uint64, ids []uint64) room.MatchHandle {
	return la.launch(seed, ids, true)
}
func (la *launcherAdapter) launch(seed uint64, ids []uint64, warmup bool) room.MatchHandle {
	a := &asyncHandle{}
	if previous := la.rc.launch.Swap(a); previous != nil {
		previous.Abort()
	}
	go la.launchSync(a, seed, append([]uint64(nil), ids...), warmup)
	return a
}
func (la *launcherAdapter) launchSync(a *asyncHandle, seed uint64, ids []uint64, warmup bool) {
	rc := la.rc
	rc.mu.Lock()
	players := map[uint64]SessionInfo{}
	for _, info := range rc.identities {
		for _, id := range ids {
			if id == info.PlayerID {
				players[id] = info
				break
			}
		}
	}
	rc.mu.Unlock()
	if a.cancelled.Load() || rc.launch.Load() != a {
		return
	}
	m, err := NewMatch(rc, seed, int(seed&0xffffffff), players, warmup)
	if err != nil {
		rc.mu.Lock()
		if rc.launch.Load() == a && !a.cancelled.Load() {
			rc.broadcastLocked(say("match launch failed: " + err.Error()))
		}
		rc.mu.Unlock()
		return
	}
	la.publish(a, m)
}

// publish is the only point where an assembled match may become visible.
func (la *launcherAdapter) publish(a *asyncHandle, m *Match) {
	rc := la.rc
	rc.mu.Lock()
	defer rc.mu.Unlock()
	a.match.Store(m)
	if a.cancelled.Load() || rc.launch.Load() != a {
		m.Stop()
		m.start()
		return
	}
	if rc.match != nil {
		rc.match.Stop()
	}
	m.handle = a
	rc.match = m
	for _, s := range rc.sessions {
		m.bootstrapLocked(s)
	}
	rc.broadcastRoomStateLocked()
	m.start()
}

// Abort must never wait under Room.mu. A cancelled assembly can never publish.
type asyncHandle struct {
	cancelled atomic.Bool
	match     atomic.Pointer[Match]
}

func (a *asyncHandle) Abort() {
	a.cancelled.Store(true)
	if m := a.match.Load(); m != nil {
		m.Stop()
	}
}
func (rc *RoomConn) currentMatch() *Match { rc.mu.Lock(); defer rc.mu.Unlock(); return rc.match }
func (rc *RoomConn) EnsureLauncher() {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.launcher == nil {
		rc.launcher = &launcherAdapter{rc: rc}
		rc.Room.SetSimLauncher(rc.launcher)
	}
}
