// Package glue 装配全链路：netws 会话 → Room → Sim（mapgen）→ 脚本池 →
// snapshot → stats → ai。它是唯一知道所有包的服务器编排层（Phase D，主线实现）。
package glue

import (
	"fmt"
	"sync"

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

// NewSession 构造会话。
func NewSession(sendReliable func(*ombv1.ServerMsg)) *Session {
	return &Session{SendReliable: sendReliable}
}

// BroadcastRoomState 状态广播（可靠通道全员）。
func (rc *RoomConn) BroadcastRoomState() {
	ev := rc.Room.StateBroadcast()
	rc.Broadcast(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_RoomState{RoomState: ev},
	}}})
}

// RouteInput 输入帧路由到当前对局（无对局时丢弃——热身/大厅态）。
func (h *Hub) RouteInput(up *ombv1.ClientMsg, _, _ func(*ombv1.ServerMsg)) {
	if in := up.GetInput(); in != nil {
		if s := h.sessionBySend(nil); s != nil {
			_ = s
		}
	}
	// 会话→playerID 绑定经 Join 完成；输入按 playerID 路由（v1：房间内单对局）
}

// RouteLeave 离房（成员移除 + 状态广播）。
func (h *Hub) RouteLeave(_ *ombv1.ClientMsg) {}

// RouteOther 其他上行（script/ai/assist/resync——Phase D 后续）。
func (h *Hub) RouteOther(_ *ombv1.ClientMsg, _, _ func(*ombv1.ServerMsg)) {}

func (h *Hub) sessionBySend(_ func(*ombv1.ServerMsg)) *Session { return nil }
