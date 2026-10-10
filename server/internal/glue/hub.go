// Package glue connects transport sessions, room lifecycle and simulation.
package glue

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/room"
	"github.com/modenicheng/oh-my-bot/server/internal/snippet"
)

type Hub struct {
	mu     sync.Mutex
	rooms  map[string]*RoomConn
	player map[uint64]*Session
	nextID uint64

	// aiNew 每房间派生 AIService（从同一 ServerConfig 构造；nil = 禁用）。
	aiNew           func() *AIService
	defaultSoloBots uint32

	// 空房间清道夫阈值（审计 S-26）。warmupIdleStop：空置房间停掉 warmup
	// 对局（覆盖页面刷新的断开→重连窗口）；roomEvictAfter：空置更久后关停
	// 并从 rooms 逐出（期间同房码+昵称仍可恢复身份）。经 SetWarmupIdleStop/
	// SetRoomEvictAfter 配置（env：OMB_WARMUP_IDLE_STOP/OMB_ROOM_EVICT_AFTER），
	// 测试可改小。
	warmupIdleStop time.Duration
	roomEvictAfter time.Duration
}

// maxSpectators caps the read-only audience per room. Spectators are pure
// consumers, so the cap protects publication bandwidth rather than gameplay.
const maxSpectators = 64

const (
	defaultWarmupIdleStop = 15 * time.Second
	defaultRoomEvictAfter = 5 * time.Minute
)

func NewHub() *Hub {
	return &Hub{
		rooms:          map[string]*RoomConn{},
		player:         map[uint64]*Session{},
		nextID:         1000,
		warmupIdleStop: defaultWarmupIdleStop,
		roomEvictAfter: defaultRoomEvictAfter,
	}
}

// SetAIService 注入 AI 服务工厂（main 启动时调用；nil 或返回 nil = 禁用）。
// 每房间一个 AIService：配额是房间/局作用域，跨房间不相干扰。
func (h *Hub) SetAIService(newSvc func() *AIService) { h.aiNew = newSvc }

// SetDefaultSoloBots configures newly-created rooms for an explicit local or
// test deployment. Production keeps the zero default unless configured.
func (h *Hub) SetDefaultSoloBots(count uint32) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if count > room.MaxSoloBots {
		count = room.MaxSoloBots
	}
	h.defaultSoloBots = count
}

// SetWarmupIdleStop 配置空房间清道夫「空置停 warmup 对局」的空置阈值（main
// 启动时从 OMB_WARMUP_IDLE_STOP 应用）。非正值拒绝并保留当前值——清道夫
// 只允许调快慢，不允许被配置关闭（关闭等于放弃 S-26 的资源回收）。
func (h *Hub) SetWarmupIdleStop(d time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if d <= 0 {
		return
	}
	h.warmupIdleStop = d
}

// SetRoomEvictAfter 配置空房间清道夫「空置逐出房间」的空置阈值（main 启动
// 时从 OMB_ROOM_EVICT_AFTER 应用）。非正值拒绝并保留当前值。
func (h *Hub) SetRoomEvictAfter(d time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if d <= 0 {
		return
	}
	h.roomEvictAfter = d
}

func (h *Hub) EnsureRoom(code string) *RoomConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if rc := h.rooms[code]; rc != nil {
		return rc
	}
	rc := newRoomConn(code)
	rc.Room.SetSoloBots(h.defaultSoloBots)
	if h.aiNew != nil {
		rc.ai = h.aiNew()
	}
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
// Spectators are exact-connection removed and never touch membership or inputs.
func (h *Hub) Unregister(s *Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rc := s.rc; rc != nil {
		rc.mu.Lock()
		if s.spectator {
			// Exact-connection removal: a spliced spectator id can never remove a
			// newer spectator connection (spectators have no takeover semantics).
			if rc.spectators[s.playerID] == s {
				delete(rc.spectators, s.playerID)
				if m := rc.match; m != nil {
					m.dropSpectatorLocked(s.playerID)
				}
			}
		} else if rc.sessions[s.playerID] == s {
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

// StartJanitor 启动空房间清道夫（进程生命周期；main 启动时调用一次）。
func (h *Hub) StartJanitor(interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			h.janitorSweep()
		}
	}()
}

// janitorSweep 单轮扫描（审计 S-26）：warmup 对局的终局条件带 !warmup，房间
// 空置后永不自我终止（0 接收者仍 60Hz 满速步进）；h.rooms 此前无任何淘汰点，
// 身份/脚本/版本状态随之无界累积。规则：房间空置（无玩家会话且无观战者）超过
// warmupIdleStop 先停 warmup 对局（正式局有 MatchTicks 上界且空置重连要能回
// 对局，不受影响）；空置超过 roomEvictAfter 关停房间（closed 拒绝新绑定、丢弃
// 在途装配）并从 rooms 逐出。锁序：先在 h.mu 下拍快照再逐房拿 rc.mu——Bind 的
// 既有顺序是 rc.mu → h.mu，禁止反向嵌套。
func (h *Hub) janitorSweep() {
	h.mu.Lock()
	rooms := make([]*RoomConn, 0, len(h.rooms))
	for _, rc := range h.rooms {
		rooms = append(rooms, rc)
	}
	h.mu.Unlock()

	var evict []*RoomConn
	now := time.Now()
	for _, rc := range rooms {
		rc.mu.Lock()
		if len(rc.sessions) > 0 || len(rc.spectators) > 0 {
			rc.emptySince = time.Time{}
			rc.mu.Unlock()
			continue
		}
		if rc.emptySince.IsZero() {
			rc.emptySince = now
		}
		idle := now.Sub(rc.emptySince)
		if m := rc.match; m != nil && m.warmup && idle >= h.warmupIdleStop {
			m.Stop()
			rc.match = nil
			// Room 转 Ended（幂等；Ended → WARMUP/START/RESTART 均合法，
			// 回来的人可直接重开）。房间已空，广播是无接收者的状态收口。
			// 注意必须走 EndWarmup：warmup 房间状态是 Warmup，EndMatch 只认
			// Running，且 Warmup 态下发 WARMUP 本身是非法转移。
			rc.Room.EndWarmup()
			rc.broadcastRoomStateLocked()
		}
		if idle >= h.roomEvictAfter {
			rc.closed = true
			if rc.match != nil {
				rc.match.Stop()
				rc.match = nil
			}
			if a := rc.launch.Load(); a != nil {
				a.Abort()
			}
			evict = append(evict, rc)
		}
		rc.mu.Unlock()
	}
	if len(evict) > 0 {
		h.mu.Lock()
		for _, rc := range evict {
			if h.rooms[rc.Code] == rc {
				delete(h.rooms, rc.Code)
			}
		}
		h.mu.Unlock()
	}
}

type RoomConn struct {
	Code string
	Room *room.Room
	// One owner lock covers membership, active-session checks, sim mutations,
	// encoder state and publication. Launcher/Abort never acquire it under Room.mu.
	mu         sync.Mutex
	sessions   map[uint64]*Session
	spectators map[uint64]*Session
	identities map[string]SessionInfo
	// Bot 配置按玩家身份保存：同房间换局保留，显式离开才清理。
	snippets     map[uint64][]snippet.Setting
	scriptSource map[uint64]string
	assist       map[uint64]bool
	// scriptVersions 每玩家脚本版本链（房间身份状态：AI 直填 + 版本回退的
	// 服务器权威记录；跨局保留，显式离开清理，观战结构性不可见）。
	scriptVersions map[uint64]*scriptVersionChain
	match          *Match
	launcher       room.SimLauncher
	launch         atomic.Pointer[asyncHandle]

	// ai is shared by warmup and its following scored match, so both consume
	// the same room-cycle quota. A new warmup (or direct start from idle) resets it.
	ai *AIService

	// 空置追踪与关停标记（审计 S-26 清道夫；均由 mu 守护）。emptySince 是
	// 最近一次「无玩家会话且无观战者」的起点；closed 置位后 Bind 拒绝新绑定、
	// publish 丢弃在途装配。
	emptySince time.Time
	closed     bool
}

func newRoomConn(code string) *RoomConn {
	return &RoomConn{
		Code: code, Room: room.NewRoom(code, 0),
		sessions: map[uint64]*Session{}, spectators: map[uint64]*Session{}, identities: map[string]SessionInfo{},
		snippets: map[uint64][]snippet.Setting{}, scriptSource: map[uint64]string{}, assist: map[uint64]bool{},
		scriptVersions: map[uint64]*scriptVersionChain{},
	}
}

type Session struct {
	mu           sync.Mutex // binding fields; lock before RoomConn.mu, then Hub.mu
	hub          *Hub
	playerID     uint64
	nick, color  string
	rc           *RoomConn
	spectator    bool // read-only observer; never joins Room/identities/match players
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
	if rc.closed {
		return fmt.Errorf("room closed")
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
	// 版本链属房间身份：无对局的重连/接管也补发（AI 直填 + 回退的客户端基准）。
	rc.sendScriptVersionsStateLocked(s.playerID)
	// 审计 S-27：快照循环只认 NewMatch 装配时冻结的花名册（robotOf）。局中/
	// 热身中新加入的身份不在花名册——发了 MapBootstrap 也永远等不到第一帧
	// （客户端 awaitingFull 卡死到下一局发布），只留房间大厅，下一局发布自动入列。
	if m := rc.match; m != nil && m.activeLocked() {
		if _, inRoster := m.robotOf[s.playerID]; inRoster {
			m.bootstrapLocked(s)
		}
	}
	return nil
}
func (s *Session) BindRoom(rc *RoomConn) { s.mu.Lock(); defer s.mu.Unlock(); s.rc = rc }

// BindSpectator attaches a read-only observer. It uses the registered connection
// id (the unique hub id) as its key but never joins Room members/identities, never
// claims host rights and never changes any online/seat count.
func (rc *RoomConn) BindSpectator(s *Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if s.rc != nil {
		return fmt.Errorf("session already bound")
	}
	if rc.closed {
		return fmt.Errorf("room closed")
	}
	if len(rc.spectators) >= maxSpectators {
		return fmt.Errorf("spectator room full (%d)", maxSpectators)
	}
	s.spectator = true
	s.nick, s.color = "", ""
	s.rc = rc
	rc.spectators[s.playerID] = s
	if m := rc.match; m != nil {
		m.bootstrapSpectatorLocked(s)
	}
	rc.broadcastRoomStateLocked()
	return nil
}

// withRoom fences every upstream operation against a nickname takeover or detach.
// Player actions additionally require membership in rc.sessions — spectators are
// structurally absent from it, so every player path below is fenced for them.
func (s *Session) withRoom(fn func(*RoomConn)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rc := s.rc; rc != nil {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		if !s.spectator && rc.sessions[s.playerID] == s {
			fn(rc)
		}
	}
}

// withSpectatorRoom fences the two spectator operations (resync, leave) against
// detach while still holding the owner lock.
func (s *Session) withSpectatorRoom(fn func(*RoomConn)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rc := s.rc; rc != nil {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		if s.spectator && rc.spectators[s.playerID] == s {
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
				// Persist the preference immediately as well as after the next
				// authoritative tick, so an instant restart cannot lose it.
				if robot, exists := m.sim.Robot(rid); exists {
					rc.assist[s.playerID] = !robot.Control.Assist || robot.Control.HumanAxes != 0
				}
			}
		}
	})
}
func (s *Session) HostCommand(kind ombv1.RoomAction_Kind) {
	act := map[ombv1.RoomAction_Kind]room.Action{ombv1.RoomAction_START: room.ActionStart, ombv1.RoomAction_ABORT: room.ActionAbort, ombv1.RoomAction_RESTART: room.ActionRestart, ombv1.RoomAction_WARMUP: room.ActionWarmup, ombv1.RoomAction_SOLO_BOTS: room.ActionSoloBots}[kind]
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

// normalizeScriptEditorSource preserves legacy submissions while separating
// executable JavaScript from the owner editor model. Missing or unknown language
// values use JavaScript compatibility semantics.
func normalizeScriptEditorSource(sub *ombv1.ScriptSubmit) (string, ombv1.ScriptLanguage) {
	if sub.GetLanguage() != ombv1.ScriptLanguage_SCRIPT_LANGUAGE_TS {
		// JavaScript has one source of truth: version exactly what the runtime
		// loaded, ignoring a mismatched optional editor_source.
		return sub.GetSource(), ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS
	}
	editorSource := sub.GetSource()
	if sub.EditorSource != nil {
		editorSource = sub.GetEditorSource()
	}
	return editorSource, ombv1.ScriptLanguage_SCRIPT_LANGUAGE_TS
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
		runtimeSource := sub.GetSource()
		editorSource, language := normalizeScriptEditorSource(sub)
		ok, errMsg, rev := m.submitScriptLocked(s.playerID, runtimeSource)
		var versionID uint32
		if ok {
			// 版本记录（不推送）：ScriptResult 回执先发，版本链快照随后，
			// 客户端按固定顺序消费（回执 → 版本链）。运行时始终装载 JS，
			// 版本链另存编辑器源码与语言供 owner 恢复 JS/TS 模型。
			versionID = m.recordScriptVersionLocked(s.playerID, rev, ombv1.ScriptOrigin_ORIGIN_MANUAL, runtimeSource, editorSource, language)
		}
		s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_ScriptResult{ScriptResult: &ombv1.EvScriptResult{ClientScriptId: sub.GetClientScriptId(), Ok: ok, Error: errMsg, ScriptRev: rev, VersionId: &versionID}}}}})
		if ok {
			m.pushScriptVersionsLocked(s.playerID)
		}
	})
}

// ScriptRollback 把玩家自己的历史版本设为当前版本（仅房间玩家；观战者被
// withRoom 结构性拒绝，上游路由还会提前拒绝并回结构化 notice）。
func (s *Session) ScriptRollback(rb *ombv1.ScriptRollback) {
	if rb == nil {
		return
	}
	s.withRoom(func(rc *RoomConn) {
		m := rc.match
		if m == nil || !m.activeLocked() {
			return
		}
		m.rollbackScriptLocked(s.playerID, rb.GetVersionId())
	})
}
func (s *Session) AiPrompt(p *ombv1.AiPrompt) {
	if p == nil {
		return
	}
	s.withRoom(func(rc *RoomConn) {
		if m := rc.match; m != nil && m.activeLocked() {
			m.handleAiPromptLocked(s.playerID, p.GetText())
		}
	})
}
func (s *Session) Resync() {
	if s.IsSpectator() {
		s.withSpectatorRoom(func(rc *RoomConn) {
			if m := rc.match; m != nil {
				m.forceSpectatorResyncLocked(s.playerID)
			}
		})
		return
	}
	s.withRoom(func(rc *RoomConn) {
		if m := rc.match; m != nil && m.activeLocked() {
			m.forceResyncLocked(s.playerID)
		}
	})
}

// IsSpectator reports whether this connection is a read-only observer. The flag
// is set once at bind time and never changes on a live session.
func (s *Session) IsSpectator() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.spectator }

// Explicit leave frees the seat and nickname; closing a socket uses Unregister instead.
// A spectator leaving just detaches its read-only connection.
func (s *Session) LeaveRoom() {
	if s.IsSpectator() {
		s.withSpectatorRoom(func(rc *RoomConn) {
			delete(rc.spectators, s.playerID)
			if m := rc.match; m != nil {
				m.dropSpectatorLocked(s.playerID)
			}
		})
		return
	}
	s.withRoom(func(rc *RoomConn) {
		if m := rc.match; m != nil && m.activeLocked() {
			m.releaseHumanLocked(s.playerID)
		}
		delete(rc.sessions, s.playerID)
		delete(rc.identities, s.nick)
		delete(rc.snippets, s.playerID)
		delete(rc.scriptSource, s.playerID)
		delete(rc.assist, s.playerID) // 身份释放：同房间 Bot 状态随之清理
		delete(rc.scriptVersions, s.playerID)
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
	for _, s := range rc.spectators {
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

// SystemSay is the exported robot-0 system Say used outside glue (cmd/omb
// upstream routing). The "join failed: " prefix is a client contract: the
// RoomSession treats it as a terminal join failure and stops retrying.
func SystemSay(text string) *ombv1.ServerMsg { return say(text) }

// controlNoticeMsg 是结构化控制通知（审计 X-4）的下行帧：join 拒绝 / AI 状态
// 等控制面文案的机器可读形态。过渡期与旧客户端兼容：sendNotice 先发本事件、
// 紧随同文 robot=0 SystemSay（旧客户端按前缀解析）；新客户端消费 notice 后对
// 成对 say 去重（packages/protocol dedupeControlNoticeSay，顺序由两侧测试互钉）。
// 不落 Match Event Log：这些通知不属于对局事件流。
func controlNoticeMsg(code ombv1.EvControlNotice_Code, text string) *ombv1.ServerMsg {
	return &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_ControlNotice{ControlNotice: &ombv1.EvControlNotice{Code: code, Text: text}},
	}}}
}

// ControlNotice 导出结构化控制通知构造（cmd/omb 上行路由在 glue 之外，无 Session
// 可用，需自行控制发送顺序：notice 在前、兼容 say 在后）。
func ControlNotice(code ombv1.EvControlNotice_Code, text string) *ombv1.ServerMsg {
	return controlNoticeMsg(code, text)
}

// sendNotice 定向成对下发：notice 在前、兼容 say 在后（固定顺序，客户端去重依赖）。
// AI 类通知由 aiNotice 包装（say 带原有 AI 前缀文案，兼容旧面板分流）。
func sendNotice(s *Session, code ombv1.EvControlNotice_Code, text string) {
	s.SendReliable(controlNoticeMsg(code, text))
	s.SendReliable(SystemSay(text))
}

// aiNotice 保持过渡期双形态文案一致：notice.text 与兼容 say 同文
// （旧客户端靠前缀分流，新客户端靠 code）。join 拒绝的双形态在 cmd/omb
// （sendJoinFailedReliable），不在此重复。
func aiNotice(s *Session, code ombv1.EvControlNotice_Code, text string) {
	sendNotice(s, code, text)
}

type launcherAdapter struct{ rc *RoomConn }

func (la *launcherAdapter) Launch(seed uint64, ids []uint64) room.MatchHandle {
	return la.launch(seed, ids, false, 0)
}
func (la *launcherAdapter) LaunchWarmup(seed uint64, ids []uint64) room.MatchHandle {
	return la.launch(seed, ids, true, 0)
}
func (la *launcherAdapter) LaunchWithBots(seed uint64, ids []uint64, count uint32) room.MatchHandle {
	return la.launch(seed, ids, false, count)
}
func (la *launcherAdapter) LaunchWarmupWithBots(seed uint64, ids []uint64, count uint32) room.MatchHandle {
	return la.launch(seed, ids, true, count)
}
func (la *launcherAdapter) launch(seed uint64, ids []uint64, warmup bool, botCount uint32) room.MatchHandle {
	a := &asyncHandle{}
	if previous := la.rc.launch.Swap(a); previous != nil {
		previous.Abort()
	}
	go la.launchSync(a, seed, append([]uint64(nil), ids...), warmup, botCount)
	return a
}
func (la *launcherAdapter) launchSync(a *asyncHandle, seed uint64, ids []uint64, warmup bool, botCount uint32) {
	rc := la.rc
	rc.mu.Lock()
	players := map[uint64]SessionInfo{}
	for _, info := range rc.identities {
		for _, id := range ids {
			if id == info.PlayerID {
				info.Snippets = append([]snippet.Setting{}, rc.snippets[id]...)
				info.ScriptSource = rc.scriptSource[id]
				info.Assist = rc.assist[id]
				players[id] = info
				break
			}
		}
	}
	addSoloBots(players, botCount)
	aiSvc := rc.ai
	// Warmup starts a new quota cycle. A direct scored start from idle does too;
	// starting from an active warmup deliberately keeps the same budget.
	if aiSvc != nil && (warmup || rc.match == nil || !rc.match.warmup) {
		aiSvc.Restart()
	}
	rc.mu.Unlock()
	if a.cancelled.Load() || rc.launch.Load() != a {
		return
	}
	m, err := NewMatch(rc, seed, int(seed&0xffffffff), players, warmup, aiSvc)
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
	// 审计 S-26：房间被清道夫逐出后，在途装配不得再把对局发布到孤儿房间上。
	if rc.closed || a.cancelled.Load() || rc.launch.Load() != a {
		m.Stop()
		m.start()
		return
	}
	if rc.match != nil {
		rc.match.Stop()
	}
	m.handle = a
	m.syncRoomSnippetsLocked()
	rc.match = m
	for _, s := range rc.sessions {
		m.bootstrapLocked(s)
	}
	for _, s := range rc.spectators {
		m.bootstrapSpectatorLocked(s)
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
