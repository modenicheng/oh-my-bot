// Match 一个权威对局的装配与 60Hz 驱动（Phase D 集成）。
//
// 时序（每 tick，ADR-0007 单时钟）：sim 内部完成 input→仲裁→物理→事件；
// glue 在 Tick 后取 WorldView → 每观察者 AOI（T3）→ snapshot 编码 → 下行。
// 脚本池接入分两步：v1 集成先跑「无脚本」权威循环（手操路径），脚本 tick
// 注入在 sim 下一步扩展点（ApplyScriptCommands）就绪后接入——见 phase-d 后续。
package glue

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log"
	"sync"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/mapgen"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/script"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
	"github.com/modenicheng/oh-my-bot/server/internal/snapshot"
	"github.com/modenicheng/oh-my-bot/server/internal/stats"
)

const (
	tickHz     = 60
	frameDue   = 12 * time.Millisecond
	matchTicks = 8 * 60 * tickHz // 28800
)

// Match 一个运行中的对局。
type Match struct {
	rc *RoomConn

	sim    *sim.Sim
	mapDef *sim.MapDef
	proj   *stats.ProjectorImpl
	log    *sim.MatchEventLog

	encoders map[uint32]*snapshot.DeltaEncoder
	wallIX   *snapshot.WallIndex

	scriptPool *script.RunPool
	runtimes   map[uint32]*script.GojaRuntime // robotID -> runtime（脚本装载/热更）

	robotOf      map[uint64]uint32 // playerID -> robotID
	playerOf     map[uint32]uint64 // robotID -> playerID
	botRobots    map[uint32]bool
	reliableFull map[uint64]bool
	handle       *asyncHandle
	startOnce    sync.Once

	tick       uint32
	warmup     bool
	stopOnce   sync.Once
	finishOnce sync.Once
	stop       chan struct{}
	done       chan struct{}
}

// SessionInfo 装配参数（房间成员快照）。
type SessionInfo struct {
	PlayerID uint64
	Nick     string
	Color    string
	Bot      bool
}

// NewMatch only assembles. Publication sends bootstrap before start runs the clock.
// seed/matchSeq 必须由调用方传入：room.HostCommand 持 room.mu 调 Launch，
// 此处反查 Room.Seed()/SessionSeq() 会非重入死锁。
func NewMatch(rc *RoomConn, seed uint64, matchSeq int, players map[uint64]SessionInfo, warmup bool) (*Match, error) {
	m := &Match{
		rc:           rc,
		proj:         stats.NewProjector(),
		robotOf:      map[uint64]uint32{},
		playerOf:     map[uint32]uint64{},
		botRobots:    map[uint32]bool{},
		reliableFull: map[uint64]bool{},
		warmup:       warmup,
		encoders:     map[uint32]*snapshot.DeltaEncoder{},
		stop:         make(chan struct{}),
		done:         make(chan struct{}),
	}

	// 地图：种子由房间状态机在 Start 时生成（经 Launch 传入）
	def, err := mapgen.Generate(seed)
	if err != nil {
		return nil, fmt.Errorf("mapgen: %w", err)
	}
	m.mapDef = def

	// player↔robot 映射（glue 唯一 owner；robotID = 稳定哈希 playerID）
	ids := make([]uint32, 0, len(players))
	playerMap := map[uint32]uint64{}
	for pid, info := range players {
		rid := stableRobotID(pid)
		if _, exists := m.playerOf[rid]; rid == 0 || exists {
			return nil, fmt.Errorf("duplicate or zero robot identity for player %d", pid)
		}
		m.robotOf[pid] = rid
		m.playerOf[rid] = pid
		if info.Bot {
			m.botRobots[rid] = true
		}
		playerMap[rid] = pid
		ids = append(ids, rid)
	}

	// 事件管线：sim → 日志落盘（正式局）+ 投影 + 可靠广播
	var sinkAll sim.EventSink = m.newSink()
	if !warmup {
		matchID := fmt.Sprintf("%s-%d", rc.Code, matchSeq)
		ml, err := sim.NewMatchEventLogIn("data/matches", matchID)
		if err != nil {
			return nil, fmt.Errorf("event log: %w", err)
		}
		m.log = ml
		sinkAll = multiSink{primary: ml, secondary: sinkAll}
	}
	m.sim = sim.NewSim(seed, ids, sinkAll)
	if err := m.sim.SetMap(def); err != nil {
		if m.log != nil {
			_ = m.log.Close()
		}
		return nil, fmt.Errorf("setmap: %w", err)
	}
	for pid, info := range players {
		m.sim.SetRobotMeta(m.robotOf[pid], info.Nick, info.Color)
	}
	m.proj.SetPlayerMap(playerMap)
	nicks := make(map[uint32]string, len(players))
	partners := make(map[uint32]uint32, len(players))
	for pid, info := range players {
		rid := m.robotOf[pid]
		nicks[rid] = info.Nick
		if robot, ok := m.sim.Robot(rid); ok && robot.Combat.Partner != 0 {
			partners[rid] = robot.Combat.Partner
		}
	}
	m.proj.SetNickMap(nicks)
	m.proj.SetPartnerMap(partners)
	m.wallIX = snapshot.NewWallIndex(def.Walls, 4.0)
	m.runtimes = map[uint32]*script.GojaRuntime{}
	m.scriptPool = script.NewRunPool(script.Config{})
	for rid := range m.botRobots {
		rt := script.NewGojaRuntime(script.Config{})
		if err := rt.Load(soloBotSource(rid)); err != nil {
			rt.Close()
			m.scriptPool.Close()
			if m.log != nil {
				_ = m.log.Close()
			}
			return nil, fmt.Errorf("test bot %d: %w", rid, err)
		}
		m.scriptPool.Register(rid, rt)
		m.runtimes[rid] = rt
		m.sim.AssistToggle(rid)
	}

	return m, nil
}

// sink 适配 EventSink 接口：投影 + 广播（不阻塞、不改事件——契约要求）。
type glueSink struct{ m *Match }

func (g glueSink) OnEvent(tick uint32, ev *ombv1.ServerEvent) {
	g.m.proj.OnEvent(tick, ev)
	// Sim emits under rc.mu; never reacquire it from the sink.
	if g.m.activeLocked() {
		g.m.rc.broadcastLocked(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: ev}})
	}
}

func (m *Match) newSink() sim.EventSink { return glueSink{m: m} }

func (g glueSink) OnCheckpoint(state sim.Checkpoint) { g.m.proj.OnCheckpoint(state) }
func (g glueSink) OnMatchInit(state sim.Checkpoint)  { g.m.proj.OnMatchInit(state) }
func (g glueSink) OnInput(uint32, uint32, sim.Input) {}

var _ sim.CheckpointSink = glueSink{}
var _ sim.ReplaySink = glueSink{}

// multiSink：事件先落盘再投影广播（日志失败不阻断模拟——Err 由 Close 报告）。
type multiSink struct {
	primary   *sim.MatchEventLog
	secondary sim.EventSink
}

func (ms multiSink) OnEvent(tick uint32, ev *ombv1.ServerEvent) {
	ms.primary.OnEvent(tick, ev)
	ms.secondary.OnEvent(tick, ev)
}

// multiSink 转发 ReplaySink/CheckpointSink 可选接口（sim 用类型断言探测——
// 不转发则 match_start/checkpoint/input 永不落盘，回放缺初始状态）。
func (ms multiSink) OnMatchInit(state sim.Checkpoint) {
	ms.primary.OnMatchInit(state)
	if r, ok := ms.secondary.(sim.ReplaySink); ok {
		r.OnMatchInit(state)
	}
}

func (ms multiSink) OnInput(tick uint32, robotID uint32, input sim.Input) {
	ms.primary.OnInput(tick, robotID, input)
}

func (ms multiSink) OnCheckpoint(state sim.Checkpoint) {
	ms.primary.OnCheckpoint(state)
	if cp, ok := ms.secondary.(sim.CheckpointSink); ok {
		cp.OnCheckpoint(state)
	}
}

func (ms multiSink) OnControl(tick, robotID uint32, control sim.ControlRecord) {
	ms.primary.OnControl(tick, robotID, control)
}

var _ sim.GameplayReplaySink = multiSink{}

// HandleAiPrompt v1 最小实现：AI 服务接入前的占位回执（quota 未配 key 时提示）。
// 完整链（QuotaService→Provider→改码→ScriptSubmit）在 AI 运营配置就绪后启用。
func (m *Match) HandleAiPrompt(pid uint64, text string) {
	m.rc.Broadcast(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: 0, Text: "AI agent: not configured (set DEEPSEEK_API_KEY) — prompt: " + text}},
	}}})
}

// ForceResync 下 tick 全量快照。
func (m *Match) ForceResync(pid uint64) {
	m.rc.mu.Lock()
	defer m.rc.mu.Unlock()
	if m.activeLocked() {
		m.forceResyncLocked(pid)
	}
}
func (m *Match) forceResyncLocked(pid uint64) {
	m.reliableFull[pid] = true
	if rid, ok := m.robotOf[pid]; ok {
		if enc := m.encoders[rid]; enc != nil {
			enc.ForceFull()
		}
	}
}

// SubmitScript 玩家脚本提交（编译失败保旧版——Hot Swap 语义）。
func (m *Match) SubmitScript(pid uint64, src string) (ok bool, errMsg string, rev uint32) {
	m.rc.mu.Lock()
	defer m.rc.mu.Unlock()
	if !m.activeLocked() {
		return false, "match stopped", 0
	}
	return m.submitScriptLocked(pid, src)
}
func (m *Match) submitScriptLocked(pid uint64, src string) (ok bool, errMsg string, rev uint32) {
	rid, ok := m.robotOf[pid]
	if !ok {
		return false, "not in match", 0
	}
	rt := m.scriptPool.RuntimeOf(rid)
	if rt == nil {
		rt = script.NewGojaRuntime(script.Config{})
		m.scriptPool.Register(rid, rt)
		m.runtimes[rid] = rt
	}
	if err := rt.Load(src); err != nil {
		return false, err.Error(), rt.Rev() // 旧版本继续跑
	}
	return true, "", rt.Rev()
}

// ApplyClientInput serializes pending inputs with Tick; ack comes from consumed sim input.
func (m *Match) ApplyClientInput(pid uint64, in *ombv1.ClientInput) {
	m.rc.mu.Lock()
	defer m.rc.mu.Unlock()
	if m.activeLocked() {
		m.applyInputLocked(pid, in)
	}
}
func (m *Match) applyInputLocked(pid uint64, in *ombv1.ClientInput) {
	if rid, ok := m.robotOf[pid]; ok {
		m.sim.ApplyInput(rid, in)
	}
}

// Abort 实现 room.MatchHandle（幂等：room 状态机可能重复调用）。
func (m *Match) Abort() { m.Stop() }

// Release held human controls through the ordinary input/log path. Script-owned
// axes and assist state survive; the next full snapshot acknowledges this sequence.
func (m *Match) releaseHumanLocked(pid uint64) {
	rid, ok := m.robotOf[pid]
	if !ok {
		return
	}
	r, ok := m.sim.Robot(rid)
	if !ok {
		return
	}
	axes := r.Control.HumanAxes
	if r.InputPending {
		axes |= r.PendingInput.AxisMask
	}
	axes &= sim.AxisMove | sim.AxisFire | sim.AxisAbility
	if axes == 0 {
		return
	}
	m.sim.ApplyInput(rid, &ombv1.ClientInput{Seq: r.LatestSeq + 1, AxisMask: uint32(axes), Aim: r.Heading})
}

func (m *Match) Stop() {
	m.stopOnce.Do(func() { close(m.stop) })
	// Also dispose assembled matches cancelled before publication.
	m.start()
}
func (m *Match) Done() <-chan struct{} { return m.done }

func (m *Match) start() { m.startOnce.Do(func() { go m.run() }) }
func (m *Match) activeLocked() bool {
	select {
	case <-m.stop:
		return false
	default:
	}
	return m.rc.match == m && (m.handle == nil || (!m.handle.cancelled.Load() && m.rc.launch.Load() == m.handle))
}
func (m *Match) bootstrapLocked(s *Session) {
	data, _ := json.Marshal(m.mapDef)
	h := fnv.New128a()
	_, _ = h.Write(data)
	s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_MapBootstrap{MapBootstrap: &ombv1.EvMapBootstrap{MapJson: string(data), MapHash: hex.EncodeToString(h.Sum(nil)), GeneratorVersion: uint32(m.mapDef.GeneratorVer)}}}}})
	m.forceResyncLocked(s.playerID)
}
func (m *Match) run() {
	defer close(m.done)
	defer func() {
		m.rc.mu.Lock()
		defer m.rc.mu.Unlock()
		m.scriptPool.Close()
		if m.log != nil {
			if err := m.log.Close(); err != nil {
				log.Printf("[match %s] event log close error: %v", m.rc.Code, err)
			}
		}
	}()
	ticker := time.NewTicker(time.Second / tickHz)
	defer ticker.Stop()
	for {
		select {
		case <-m.stop:
			return
		default:
		}
		m.step()
		select {
		case <-m.stop:
			return
		case <-ticker.C:
		}
	}
}

func (m *Match) step() {
	m.rc.mu.Lock()
	defer m.rc.mu.Unlock()
	if !m.activeLocked() {
		return
	}
	m.tick++
	m.sim.Tick()

	wv := m.sim.WorldView()
	m.runScripts(wv)
	_ = wv // 快照循环在下方使用

	// 每在线观察者：AOI 裁剪 → delta 编码 → lossy 下行
	for _, rv := range wv.Robots {
		pid, ok := m.playerOf[rv.ID]
		if !ok {
			continue
		}
		s := m.rc.sessions[pid]
		if s == nil {
			continue
		}
		enc := m.encoders[rv.ID]
		if enc == nil {
			enc = snapshot.NewEncoder()
			enc.ForceFull()
			m.encoders[rv.ID] = enc
		}
		obs := snapshot.BuildObservation(snapshot.World{
			FrameView:   wv.Frame,
			Robots:      wv.Robots,
			Projectiles: wv.Projectiles,
			Cores:       wv.Cores,
			Uplinks:     wv.Uplinks,
		}, m.wallIX, rv.ID, wv.Partners[rv.ID], wv.ScanRadius(rv.ID))
		ctrl := wv.Controls[rv.ID]
		// Owner-locked private state is projected without changing the frozen RobotView API.
		robot, _ := m.sim.Robot(rv.ID)
		self := snapshot.SelfInput{
			Robot:         rv,
			MoveSrc:       ctrl.MoveSrc, // 仲裁标记直传（'H'/'S'/'-'，契约一致）
			TurretSrc:     ctrl.TurretSrc,
			AssistOn:      robot.Control.Assist,
			DashReadyTick: robot.Combat.DashReady,
			FireReadyTick: robot.Combat.FireReady,
		}
		delta := enc.Encode(m.tick, wv.AckSeqs[rv.ID], wv.Frame.Phase, wv.Frame.TimeLeftS, obs, &self)
		msg := &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: delta}}
		if m.reliableFull[pid] {
			s.SendReliable(msg)
			delete(m.reliableFull, pid)
		} else {
			s.SendLossy(msg)
		}
	}

	if m.tick >= matchTicks && !m.warmup {
		m.finish(wv)
		m.Stop()
		return
	}
}

// runScripts 并行执行全部已装载脚本（deadline 内），结果投回 sim（下一 tick 消费）。
func (m *Match) runScripts(wv sim.WorldView) {
	if len(m.runtimes) == 0 {
		return
	}
	deadline := time.Now().Add(frameDue)
	for rid := range m.runtimes {
		self, ok := robotOf(wv, rid)
		if !ok {
			continue
		}
		obs := snapshot.BuildObservation(snapshot.World{
			FrameView:   wv.Frame,
			Robots:      wv.Robots,
			Projectiles: wv.Projectiles,
			Cores:       wv.Cores,
			Uplinks:     wv.Uplinks,
		}, m.wallIX, rid, wv.Partners[rid], wv.ScanRadius(rid))
		_ = m.scriptPool.Submit(rid, sim.ScriptFrame{Self: self, Obs: obs}, deadline)
	}
	for _, res := range m.scriptPool.Collect(deadline) {
		if res.Err != nil || res.Deferred {
			m.sim.ClearScriptAxes(res.ID) // 超时/异常/顺延：清脚本轴（人类轴保留）
			continue
		}
		if m.botRobots[res.ID] {
			res.Commands = soloBotCommands(res.Commands)
		}
		m.sim.ApplyScriptCommands(res.ID, res.Commands)
	}
}

func robotOf(wv sim.WorldView, id uint32) (sim.RobotView, bool) {
	for _, r := range wv.Robots {
		if r.ID == id {
			return r, true
		}
	}
	return sim.RobotView{}, false
}

func (m *Match) finish(wv sim.WorldView) {
	m.finishOnce.Do(func() { m.finishLocked(wv) })
}

func (m *Match) finishLocked(wv sim.WorldView) {
	rows := m.proj.Final()
	scores := map[uint64]int32{}
	for _, r := range rows {
		if !m.botRobots[r.RobotID] {
			scores[r.PlayerID] = r.Score
		}
	}
	m.rc.Room.AddMatchResult(scores)
	// 终局事件（含 13 称号）：可靠广播
	end := &ombv1.ServerEvent{
		Tick: m.tick,
		Kind: &ombv1.ServerEvent_MatchEnd{MatchEnd: finalRowsOf(rows)},
	}
	m.rc.broadcastLocked(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: end}})
	m.rc.Room.EndMatch()
	m.rc.broadcastRoomStateLocked()
}

func finalRowsOf(rows []stats.ScoreRow) *ombv1.EvMatchEnd {
	out := &ombv1.EvMatchEnd{}
	for _, r := range rows {
		out.Scores = append(out.Scores, &ombv1.ScoreRow{Robot: 0, Score: r.Score, Titles: r.Titles})
	}
	return out
}

// stableRobotID：playerID → 稳定 robotID（FNV-1a 32 位；冲突在 NewSim 排序时自然暴露）。
func stableRobotID(pid uint64) uint32 {
	h := uint32(2166136261)
	for i := 0; i < 8; i++ {
		h ^= uint32(pid >> (i * 8) & 0xff)
		h *= 16777619
	}
	return h
}
