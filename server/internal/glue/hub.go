// Package glue 装配全链路：netws 会话 → Room → Sim（mapgen）→ 脚本池 →
// snapshot → stats → ai。它是唯一知道所有包的服务器编排层（Phase D，主线实现）。
package glue

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"sync"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/room"
)

// Hub 管理全部房间与连接会话。
type Hub struct {
	mu     sync.Mutex
	rooms  map[string]*RoomConn // roomCode -> room
	player map[uint64]*Session  // playerID -> 活跃会话（重连顶替旧会话）
	nextID uint64
}

func NewHub() *Hub {
	return &Hub{rooms: map[string]*RoomConn{}, player: map[uint64]*Session{}, nextID: 1000}
}

// EnsureRoom 取或建房间（首次进房者即房主）。
func (h *Hub) EnsureRoom(code string) *RoomConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if rc, ok := h.rooms[code]; ok {
		return rc
	}
	rc := newRoomConn(code)
	h.rooms[code] = rc
	return rc
}

// Register 会话注册（分配全局唯一 playerID；断线后重连复用 ID 需按昵称——v1 简化：新连接新 ID，
// 重连顶替由 Join 时按 nick+room 匹配实现，见 RoomConn.bind）。
func (h *Hub) Register(s *Session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.nextID++
	s.playerID = h.nextID
	h.player[s.playerID] = s
}

// Unregister 会话注销。
func (h *Hub) Unregister(s *Session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if cur, ok := h.player[s.playerID]; ok && cur == s {
		delete(h.player, s.playerID)
	}
}

// RoomConn 一个房间及其对局编排。
type RoomConn struct {
	Code string
	Room *room.Room // 状态机（Join/HostCommand/StateBroadcast/AddMatchResult）

	mu       sync.Mutex
	sessions map[uint64]*Session // playerID -> 会话（本房间）
	match    *Match              // 当前对局（nil=warmup/idle）
	launcher room.SimLauncher
}

func newRoomConn(code string) *RoomConn {
	// 首个进入者即房主：以占位 ID 0 创建状态机，Bind 时首个真实玩家接管房主。
	return &RoomConn{Code: code, Room: room.NewRoom(code, 0), sessions: map[uint64]*Session{}}
}

// Session 一个 WS 连接的会话状态。
type Session struct {
	mu       sync.Mutex
	hub      *Hub
	playerID uint64
	nick     string
	color    string
	rc       *RoomConn
	// 下行发送（netws 双通道，语义层消息）
	SendReliable func(msg *ombv1.ServerMsg)
	SendLossy    func(msg *ombv1.ServerMsg)
	closed       bool
}

// Bind 会话加入房间（携带成员信息注册到状态机）。
func (rc *RoomConn) Bind(s *Session, nick, color string) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	// 房主接管：占位 host=0 的房间由首位真实玩家接管（房间创建者语义）
	if rc.Room.HostID() == 0 {
		rc.Room.TransferHost(s.playerID)
	}
	if err := rc.Room.Join(s.playerID, nick, color); err != nil {
		return fmt.Errorf("join room: %w", err)
	}
	s.nick, s.color = nick, color
	s.rc = rc
	rc.sessions[s.playerID] = s
	return nil
}

// sessionOf 取房间内会话（无锁读 map 由 rc.mu 保护——调用方持锁或接受弱一致）。
func (rc *RoomConn) sessionOf(pid uint64) *Session {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.sessions[pid]
}

// Broadcast 可靠广播到房间全部会话。
func (rc *RoomConn) Broadcast(msg *ombv1.ServerMsg) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	for _, s := range rc.sessions {
		s.SendReliable(msg)
	}
}

// NewSession 构造会话（双通道）。
func NewSession(sendReliable, sendLossy func(*ombv1.ServerMsg)) *Session {
	return &Session{SendReliable: sendReliable, SendLossy: sendLossy}
}

// BindRoom 会话绑定房间（输入路由入口）。
func (s *Session) BindRoom(rc *RoomConn) { s.rc = rc }

// RouteInput 输入帧 → 当前对局。
func (s *Session) RouteInput(in *ombv1.ClientInput) {
	if m := s.rc.currentMatch(); m != nil && in != nil {
		m.ApplyClientInput(s.playerID, in)
	}
}

// HostCommand 房主指令 → 房间状态机。
func (s *Session) HostCommand(kind ombv1.RoomAction_Kind) {
	act := map[ombv1.RoomAction_Kind]room.Action{
		ombv1.RoomAction_START: room.ActionStart, ombv1.RoomAction_ABORT: room.ActionAbort,
		ombv1.RoomAction_RESTART: room.ActionRestart, ombv1.RoomAction_WARMUP: room.ActionWarmup,
	}[kind]
	if act == 0 {
		return
	}
	if err := s.rc.Room.HostCommand(s.playerID, act); err != nil {
		s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
			Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: 0, Text: "command failed: " + err.Error()}},
		}}})
		return
	}
	s.rc.BroadcastRoomState()
}

// SubmitScript 脚本提交 → 当前对局（结果回执走可靠通道）。
func (s *Session) SubmitScript(sub *ombv1.ScriptSubmit) {
	m := s.rc.currentMatch()
	if m == nil || sub == nil {
		return
	}
	ok, errMsg, rev := m.SubmitScript(s.playerID, sub.GetSource())
	s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_ScriptResult{ScriptResult: &ombv1.EvScriptResult{
			ClientScriptId: sub.GetClientScriptId(), Ok: ok, Error: errMsg, ScriptRev: rev,
		}},
	}}})
}

// AiPrompt AI 改码请求 → 当前对局（配额检查在 Match/AI 服务侧）。
func (s *Session) AiPrompt(p *ombv1.AiPrompt) {
	if m := s.rc.currentMatch(); m != nil && p != nil {
		m.HandleAiPrompt(s.playerID, p.GetText())
	}
}

// Resync 请求全量重同步（下 tick 强制 full 快照）。
func (s *Session) Resync() {
	if m := s.rc.currentMatch(); m != nil {
		m.ForceResync(s.playerID)
	}
}

// LeaveRoom 离房。
func (s *Session) LeaveRoom() {
	if s.rc == nil {
		return
	}
	_ = s.rc.Room.Leave(s.playerID)
	s.rc.BroadcastRoomState()
}

// BroadcastRoomState 状态广播（可靠通道全员）。
func (rc *RoomConn) BroadcastRoomState() {
	ev := rc.Room.StateBroadcast()
	rc.Broadcast(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_RoomState{RoomState: ev},
	}}})
}

// RouteInput 占位：输入按 Session 路由（连接闭包捕获会话，见 main.go）。
func (h *Hub) RouteInput(_ *ombv1.ClientMsg, _, _ func(*ombv1.ServerMsg)) {}

// RouteLeave 离房（成员移除 + 状态广播）。
func (h *Hub) RouteLeave(_ *ombv1.ClientMsg) {}

// RouteOther 其他上行（script/ai/assist/resync——Phase D 后续）。
func (h *Hub) RouteOther(_ *ombv1.ClientMsg, _, _ func(*ombv1.ServerMsg)) {}

// launcherAdapter 实现 room.SimLauncher：Start → 装配 Match + 地图下发。
type launcherAdapter struct{ rc *RoomConn }

func (la *launcherAdapter) Launch(seed uint64, playerIDs []uint64) room.MatchHandle {
	return la.launch(true, seed, playerIDs, false)
}

// LaunchWarmup 热身场：同链路装配，标记 warmup（不落 JSONL、无 MatchEnd 结算）。
func (la *launcherAdapter) LaunchWarmup(seed uint64, playerIDs []uint64) room.MatchHandle {
	return la.launch(true, seed, playerIDs, true)
}

func (la *launcherAdapter) launch(_ bool, seed uint64, playerIDs []uint64, warmup bool) room.MatchHandle {
	// Launch 在 room.HostCommand（reader 协程同步调用）里执行：装配全程异步化，
	// 立即返回占位 handle，避免 reader 协程被 NewMatch/mapgen/log 初始化阻塞。
	ch := make(chan *Match, 1)
	go func() {
		m, _ := la.launchSync(seed, playerIDs, warmup)
		ch <- m
	}()
	// 房间状态机需要立即拿到 handle——返回包装器，把 Abort 转发给异步启动的 match。
	return &asyncHandle{ch: ch}
}

func (la *launcherAdapter) launchSync(seed uint64, playerIDs []uint64, warmup bool) (*Match, error) {
	players := map[uint64]SessionInfo{}
	la.rc.mu.Lock()
	for _, pid := range playerIDs {
		if s, ok := la.rc.sessions[pid]; ok {
			players[pid] = SessionInfo{PlayerID: pid, Nick: s.nick, Color: s.color}
		}
	}
	la.rc.mu.Unlock()

	m, err := NewMatch(la.rc, seed, int(seed&0xffffffff), players, warmup)
	if err != nil {
		la.rc.Broadcast(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
			Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: 0, Text: "match launch failed: " + err.Error()}},
		}}})
		return nil, err
	}
	la.rc.setMatch(m)

	// 地图一次性可靠下发（服务器为地图唯一 owner——审核阻塞项 2）
	mapJSON, _ := json.Marshal(m.mapDef)
	hh := fnv.New128a()
	hh.Write(mapJSON)
	la.rc.Broadcast(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_MapBootstrap{MapBootstrap: &ombv1.EvMapBootstrap{
			MapJson: string(mapJSON), MapHash: hex.EncodeToString(hh.Sum(nil)), GeneratorVersion: uint32(m.mapDef.GeneratorVer),
		}},
	}}})
	la.rc.BroadcastRoomState()
	return m, nil
}

// asyncHandle：包装异步启动的 match，实现 room.MatchHandle。
type asyncHandle struct {
	ch   chan *Match
	once sync.Once
}

func (a *asyncHandle) Abort() {
	a.once.Do(func() {
		select {
		case m := <-a.ch:
			if m != nil {
				m.Abort()
			}
		case <-time.After(2 * time.Second):
		}
	})
}

func (rc *RoomConn) setMatch(m *Match) {
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()
}

func (rc *RoomConn) currentMatch() *Match {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.match
}

// EnsureLauncher 给房间装 launcher（首次 Join 后惰性装配）。
func (rc *RoomConn) EnsureLauncher() {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.launcher == nil {
		rc.launcher = &launcherAdapter{rc: rc}
		rc.Room.SetSimLauncher(rc.launcher)
	}
}
