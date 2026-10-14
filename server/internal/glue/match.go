// Match 一个权威对局的装配与 60Hz 驱动（Phase D 集成）。
//
// 时序（每 tick，ADR-0007 单时钟）：sim 内部完成 input→仲裁→物理→事件；
// glue 在 Tick 后取 WorldView → 每观察者 AOI（T3）→ snapshot 编码 → 下行。
// 脚本池接入分两步：v1 集成先跑「无脚本」权威循环（手操路径），脚本 tick
// 注入在 sim 下一步扩展点（ApplyScriptCommands）就绪后接入——见 phase-d 后续。
package glue

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/mapgen"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/script"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
	"github.com/modenicheng/oh-my-bot/server/internal/snapshot"
	"github.com/modenicheng/oh-my-bot/server/internal/snippet"
	"github.com/modenicheng/oh-my-bot/server/internal/stats"
)

// Match 一个运行中的对局。
type Match struct {
	rc *RoomConn

	sim    *sim.Sim
	mapDef *sim.MapDef
	proj   *stats.ProjectorImpl
	log    *sim.MatchEventLog
	// sink is the effective event pipeline assembled in NewMatch (glue-only or
	// log+glue multiSink). Non-sim events must flow through the same chain so
	// they are persisted and projected identically.
	sink sim.EventSink

	// scoreboard 记录最近一次已广播的实时积分榜指纹与事件，用于变更时才重发与观战者 catch-up。
	lastScoreboard     string
	lastScoreboardTick uint32

	encoders map[uint32]*snapshot.DeltaEncoder
	wallIX   *snapshot.WallIndex

	scriptPool *script.RunPool

	robotOf      map[uint64]uint32 // playerID -> robotID
	playerOf     map[uint32]uint64 // robotID -> playerID
	botRobots    map[uint32]bool
	reliableFull map[uint64]bool
	// Spectator state is keyed by connection id (hub id), never robot id, so a
	// spectator feed can never collide with player encoders on this match.
	specEncoders     map[uint64]*snapshot.DeltaEncoder
	specReliableFull map[uint64]bool
	// finalEnd holds the settlement event after a naturally finished match so
	// late joiners/reconnectors can be caught up (aborted matches stay nil).
	finalEnd *ombv1.ServerEvent
	// lastScoreboardEv 缓存最近一次实时积分榜事件：中途接入的观战者 catch-up 用。
	lastScoreboardEv *ombv1.ServerEvent
	handle           *asyncHandle
	startOnce        sync.Once

	// ai is the room-scoped code assistant for this match; nil disables AI safely.
	ai *AIService

	tick       uint32
	eventSeq   uint64 // projected-event identity for OnEventRecord dedup
	warmup     bool
	finishReq  bool // 房主提前结算请求（rc.mu 守护；下一 step 消费）
	stopOnce   sync.Once
	finishOnce sync.Once
	stop       chan struct{}
	done       chan struct{}

	// 大房并行（批 2）：观察者侧 AOI/编码按机器人互相独立，分派到
	// obsWorkers 个 worker 并行执行。encMu 只护编码器/全量标记两个 map
	// 的并发读写（key 互异的 map 并发写在 Go 亦是竞态）；锁序恒为
	// rc.mu → encMu，无反向嵌套。rc.mu 本身保证 step 期间无房间级写者。
	encMu      sync.Mutex
	obsWorkers int

	// tickStatWindow（批 2 可观测性）：最近 tick 环形窗口的墙钟（默认
	// 600 tick = 10s）与脚本顺延累计。statMu 在 step 尾部落账，锁序
	// rc.mu → statMu（与 encMu 平级叶子）。
	statMu     sync.Mutex
	tickWindow []time.Duration
	tickCursor int
	deferrals  atomic.Uint64
}

// parallelObserverThreshold：观察者少于该值走串行路径——小房不值得付
// 任务分发的调度开销。包级 var 供确定性对照测试改写（强制串行/并行）。
var parallelObserverThreshold = 16

// observerWorkers 默认并行度 = clamp(NumCPU, 1, 8)。每 tick 的
// parallelFor 按需起临时 goroutine（60Hz 下调度开销可忽略），避免
// 常驻 worker 的生命周期管理。
func observerWorkers() int {
	w := runtime.NumCPU()
	if w > 8 {
		w = 8
	}
	if w < 1 {
		w = 1
	}
	return w
}

// parallelFor 对 n 个下标并行执行 fn（少于 2 项、单 worker 或未过阈值时
// 串行）。必须在 rc.mu 持有下调用；fn 不得再获取 rc.mu。
func (m *Match) parallelFor(n int, fn func(i int)) {
	if n < 2 || m.obsWorkers < 2 || n < parallelObserverThreshold {
		for i := 0; i < n; i++ {
			fn(i)
		}
		return
	}
	jobs := make(chan int, n)
	for i := 0; i < n; i++ {
		jobs <- i
	}
	close(jobs)
	var wg sync.WaitGroup
	wg.Add(m.obsWorkers)
	for w := 0; w < m.obsWorkers; w++ {
		go func() {
			defer wg.Done()
			for i := range jobs {
				fn(i)
			}
		}()
	}
	wg.Wait()
}

// encoderFor 取（或首帧惰性建）机器人的增量编码器。并发安全：并行观察者
// 任务经 encMu 互斥；rc.mu 持有期无其它写者。
func (m *Match) encoderFor(rid uint32) *snapshot.DeltaEncoder {
	m.encMu.Lock()
	defer m.encMu.Unlock()
	enc := m.encoders[rid]
	if enc == nil {
		enc = snapshot.NewEncoder()
		enc.ForceFull()
		m.encoders[rid] = enc
	}
	return enc
}

// takeReliableFull 原子读取并清除「下一帧走可靠+全量」标记。
func (m *Match) takeReliableFull(pid uint64) bool {
	m.encMu.Lock()
	defer m.encMu.Unlock()
	v := m.reliableFull[pid]
	delete(m.reliableFull, pid)
	return v
}

// specEncoderFor / takeSpecReliableFull：观战者侧同构（按连接 id 键控）。
func (m *Match) specEncoderFor(pid uint64) *snapshot.DeltaEncoder {
	m.encMu.Lock()
	defer m.encMu.Unlock()
	enc := m.specEncoders[pid]
	if enc == nil {
		enc = snapshot.NewEncoder()
		enc.ForceFull()
		m.specEncoders[pid] = enc
	}
	return enc
}

func (m *Match) takeSpecReliableFull(pid uint64) bool {
	m.encMu.Lock()
	defer m.encMu.Unlock()
	v := m.specReliableFull[pid]
	delete(m.specReliableFull, pid)
	return v
}

// SessionInfo 装配参数（房间成员快照）。
type SessionInfo struct {
	PlayerID uint64
	Nick     string
	Color    string
	Bot      bool
	// Snippets is an immutable deep-copied launch snapshot. NewMatch assembles
	// outside rc.mu and must never read the live RoomConn.snippets map.
	Snippets []snippet.Setting
	// ScriptSource and Assist are room-scoped Bot configuration. They survive
	// Match replacement but are cleared when the player explicitly leaves.
	ScriptSource string
	Assist       bool
}

// NewMatch only assembles. Publication sends bootstrap before start runs the clock.
// seed/matchSeq 必须由调用方传入：room.HostCommand 持 room.mu 调 Launch，
// 此处反查 Room.Seed()/SessionSeq() 会非重入死锁。
// aiSvc 可为 nil（未配置 key）：AI 提示走禁用回执，其余链路不受影响。
func NewMatch(rc *RoomConn, seed uint64, matchSeq int, players map[uint64]SessionInfo, warmup bool, aiSvc *AIService) (*Match, error) {
	m := &Match{
		rc:               rc,
		proj:             stats.NewProjector(),
		robotOf:          map[uint64]uint32{},
		playerOf:         map[uint32]uint64{},
		botRobots:        map[uint32]bool{},
		reliableFull:     map[uint64]bool{},
		specEncoders:     map[uint64]*snapshot.DeltaEncoder{},
		specReliableFull: map[uint64]bool{},
		warmup:           warmup,
		encoders:         map[uint32]*snapshot.DeltaEncoder{},
		stop:             make(chan struct{}),
		done:             make(chan struct{}),
		ai:               aiSvc,
		obsWorkers:       observerWorkers(),
	}

	// The room launcher owns quota-cycle resets so warmup and its following
	// scored match share one budget as required by ADR-0010.

	// 地图：种子由房间状态机在 Start 时生成（经 Launch 传入）
	def, err := mapgen.GenerateForPlayers(seed, len(players))
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
	sinkAll := m.newSink()
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
	m.sink = sinkAll
	if err := m.sim.SetMap(def); err != nil {
		if m.log != nil {
			_ = m.log.Close()
		}
		return nil, fmt.Errorf("setmap: %w", err)
	}
	if warmup {
		// 热身场无终局语义：拉长时长上限，避免长时间热身被终局逻辑冻结。
		m.sim.SetWarmupDurations()
	}
	for pid, info := range players {
		m.sim.SetRobotMeta(m.robotOf[pid], info.Nick, info.Color)
	}
	m.proj.SetPlayerMap(playerMap)
	nicks := make(map[uint32]string, len(players))
	for pid, info := range players {
		rid := m.robotOf[pid]
		nicks[rid] = info.Nick
	}
	m.proj.SetNickMap(nicks)
	if m.log != nil {
		identities := make([]sim.MatchPlayer, 0, len(players))
		for pid, info := range players {
			rid := m.robotOf[pid]
			identities = append(identities, sim.MatchPlayer{
				RobotID: rid, PlayerID: pid, Nick: info.Nick, Bot: info.Bot,
			})
		}
		sort.Slice(identities, func(i, j int) bool { return identities[i].RobotID < identities[j].RobotID })
		if err := m.log.SetPlayers(identities); err != nil {
			_ = m.log.Close()
			return nil, fmt.Errorf("match identities: %w", err)
		}
	}
	m.wallIX = snapshot.NewWallIndex(def.Walls, 4.0)
	scriptCfg := script.Config{TickTimeout: scriptTickQuota(len(players))}
	m.scriptPool = script.NewRunPool(scriptCfg)
	for rid := range m.botRobots {
		rt := script.NewGojaRuntime(scriptCfg)
		if err := rt.Load(soloBotSource(rid)); err != nil {
			rt.Close()
			m.scriptPool.Close()
			if m.log != nil {
				_ = m.log.Close()
			}
			return nil, fmt.Errorf("test bot %d: %w", rid, err)
		}
		m.scriptPool.Register(rid, rt)
		m.sim.AssistToggle(rid)
	}
	// 玩家脚本和 assist 是房间身份状态：新局重新装配运行时，但不丢失
	// 上一局已经热更成功的源码或驾驶辅助开关。
	m.applySavedPlayerScripts(players)
	// 房间保存的 Snippet 配置应用到新局 runtime（warmup→running、Restart
	// 保留；snippet-only 玩家由此获得 runtime）。
	m.applySavedSnippets(players)
	m.restoreSavedAssist(players)

	return m, nil
}

// scriptTickQuota 单脚本 tick 配额随花名册规模分档（批 2）。收集 deadline
// 仍是整帧 FrameBudget；单脚本配额限制的是最坏脚本的独占时长——花名册
// 越大、worker 上排队的脚本越多，越早把超时脚本顺延（清轴计 idle），
// 让「更多但更瘦」的脚本都能轮转。≤64 人维持包默认 10ms 不变。
func scriptTickQuota(players int) time.Duration {
	switch {
	case players > 128:
		return 4 * time.Millisecond
	case players > 64:
		return 6 * time.Millisecond
	default:
		return 0
	}
}

// sink 适配 EventSink 接口：投影 + 广播（不阻塞、不改事件——契约要求）。
type glueSink struct{ m *Match }

func (g glueSink) OnEvent(tick uint32, ev *ombv1.ServerEvent) {
	if ev.GetMatchEnd() != nil {
		// The final checkpoint is delivered after Sim emits this marker.
		// Settle only then so RUNNER includes the last checkpoint interval.
		return
	}
	g.m.eventSeq++
	g.m.proj.OnEventRecord(g.m.eventSeq, tick, ev)
	// Sim emits under rc.mu; never reacquire it from the sink.
	if g.m.activeLocked() {
		g.m.rc.broadcastLocked(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: ev}})
	}
}

func (m *Match) newSink() sim.EventSink { return glueSink{m: m} }

func (g glueSink) OnCheckpoint(state sim.Checkpoint) {
	g.m.proj.OnCheckpoint(state)
	// 终局 checkpoint（自然到点 tick==matchTicks，或提前结算 Ended）触发结算
	// 投影与广播；热身场无结算语义。此前按 tick==MatchTicks 判定，无法覆盖
	// 可配置时长与提前结算两种形态（Ended 由 sim 在 emit 后置位，见 Tick）。
	if !state.Ended || g.m.warmup {
		return
	}
	end := settledMatchEnd(state.Tick, nil)
	g.m.eventSeq++
	g.m.proj.OnEventRecord(g.m.eventSeq, state.Tick, end)
	end = settledMatchEnd(state.Tick, g.m.proj.Final())
	g.m.finalEnd = end // frozen settlement for late spectator joiners
	if g.m.log != nil {
		g.m.log.OnEvent(state.Tick, end)
	}
	if g.m.activeLocked() {
		// Spectators receive settlement after their reliable final full frame.
		for _, s := range g.m.rc.sessions {
			s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: end}})
		}
	}
}
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
	if ev.GetMatchEnd() != nil {
		// The glue sink records the populated end after the final checkpoint.
		if _, ok := ms.secondary.(glueSink); ok {
			return
		}
	}
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
	// 重连玩家：补发最近一次实时积分榜（快照不含分数，不补则榜空到下一拍）。
	if s := m.rc.sessions[pid]; s != nil && m.lastScoreboardEv != nil {
		s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: m.lastScoreboardEv}})
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
	rt := m.scriptPool.Ensure(rid)
	if rt == nil {
		return false, "match stopped", 0
	}
	if err := rt.Load(src); err != nil {
		if rt.Source() == "" && len(rt.Snippets()) == 0 {
			// Ensure 刚建的空 VM 首次装载失败：注销，不留每帧产出 ErrNoModule
			// 的空转运行时。已有旧版本则保旧（Hot Swap 语义）。
			m.scriptPool.Unregister(rid)
		}
		return false, err.Error(), rt.Rev() // 旧版本继续跑
	}
	m.rc.scriptSource[pid] = src
	m.sendScriptLogsLocked(rid, rt)
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

// tickStatWindowLen 可观测性窗口：600 tick ≈ 10s。
const tickStatWindowLen = 600

// recordTickStat 在 step 返回前记录本 tick 墙钟（未激活 tick 不计——
// inactive 提前 return 不经过本 defer 的注册点）。
func (m *Match) recordTickStat(started time.Time) {
	m.statMu.Lock()
	defer m.statMu.Unlock()
	if len(m.tickWindow) < tickStatWindowLen {
		m.tickWindow = append(m.tickWindow, time.Since(started))
		return
	}
	m.tickWindow[m.tickCursor] = time.Since(started)
	m.tickCursor = (m.tickCursor + 1) % tickStatWindowLen
}

// MatchStats 是 /api/stats 的单对局快照。
type MatchStats struct {
	Tick            uint32  `json:"tick"`
	TickAvgMs       float64 `json:"tick_avg_ms"`
	TickP95Ms       float64 `json:"tick_p95_ms"`
	Warmup          bool    `json:"warmup"`
	ScriptDeferrals uint64  `json:"script_deferrals"`
}

// StatSnapshot 汇总本对局观测窗口。并发安全（statMu / atomic）；tick 与
// warmup 读取不加 rc.mu——两者为单调/装配期冻结字段，撕裂读取无危害。
func (m *Match) StatSnapshot() MatchStats {
	m.statMu.Lock()
	window := make([]time.Duration, len(m.tickWindow))
	copy(window, m.tickWindow)
	m.statMu.Unlock()
	sort.Slice(window, func(i, j int) bool { return window[i] < window[j] })
	out := MatchStats{Tick: m.tick, Warmup: m.warmup, ScriptDeferrals: m.deferrals.Load()}
	if len(window) > 0 {
		// 纳秒分辨率：小房单机 warmup 的 tick 可为亚微秒级，µs 取整会归零。
		var total int64
		for _, d := range window {
			total += int64(d)
		}
		out.TickAvgMs = float64(total) / float64(len(window)) / 1e6
		// nearest-rank p95：第 ceil(0.95·n) 个次序统计量（下标从 0）。
		out.TickP95Ms = float64(window[(95*len(window)+99)/100-1]) / 1e6
	}
	return out
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
	// 包含 Aim：断线/失焦时把全部人工轴（含炮塔）交还仲裁，下一全量快照确认。
	axes &= sim.AxisMove | sim.AxisAim | sim.AxisFire | sim.AxisAbility
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
	m.sendMapBootstrapLocked(s)
	m.forceResyncLocked(s.playerID)
	m.sendSnippetStateLocked(s)
	// 版本链补发：异步 NewMatch 装配期间发生的写入只到旧会话；接管/重连
	// 后由此对齐（Bind 已对无对局场景补发，这里覆盖发布时点）。
	m.rc.sendScriptVersionsStateLocked(s.playerID)
}

// applySavedPlayerScripts restores room-scoped player code before snippets are
// combined. Match-local position, combat and world state are intentionally new.
func (m *Match) applySavedPlayerScripts(players map[uint64]SessionInfo) {
	for pid, info := range players {
		if info.Bot || info.ScriptSource == "" {
			continue
		}
		rid, ok := m.robotOf[pid]
		if !ok {
			continue
		}
		rt := script.NewGojaRuntime(script.Config{})
		if err := rt.Load(info.ScriptSource); err != nil {
			rt.Close()
			continue
		}
		m.scriptPool.Register(rid, rt)
	}
}

// restoreSavedAssist queues the room-scoped assist preference after snippets
// have created any snippet-only runtimes. World position/combat state remains new.
func (m *Match) restoreSavedAssist(players map[uint64]SessionInfo) {
	for pid, info := range players {
		if info.Bot || !info.Assist {
			continue
		}
		if rid, ok := m.robotOf[pid]; ok {
			m.sim.SetAssist(rid, true)
		}
	}
}

func (m *Match) sendMapBootstrapLocked(s *Session) {
	data, _ := json.Marshal(m.mapDef)
	h := fnv.New128a()
	_, _ = h.Write(data)
	s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_MapBootstrap{MapBootstrap: &ombv1.EvMapBootstrap{MapJson: string(data), MapHash: hex.EncodeToString(h.Sum(nil)), GeneratorVersion: uint32(m.mapDef.GeneratorVer), Tuning: simTuning()}}}}})
}

// simTuning 下发客户端可见的对局数值（审计 X-3）：仅漂移高危集（HUD/渲染/
// 音效消费的 D3/D5 常量），内部专用常量不在此堆入。值与 server sim 常量同源，
// 由 glue 的 SimTuning golden 测试与客户端 FALLBACK_TUNING_HEX 互钉：服务器改
// 常量而不动此函数（或反之）两侧测试即刻失败。
func simTuning() *ombv1.SimTuning {
	return &ombv1.SimTuning{
		TickRate:            uint32(sim.TickRate),
		MaxHpX10:            sim.ToX10(sim.MaxHP),
		MaxEnergyX10:        sim.ToX10(sim.MaxEnergy),
		FireCost:            sim.FireCost,
		HackDurationTicks:   sim.HackDuration,
		InvulnDurationTicks: sim.InvulnDuration,
		VisionRadius:        sim.VisionRadius,
	}
}

// bootstrapSpectatorLocked attaches a read-only observer to this match.
// Active match: map bootstrap now, reliable full on the next tick. A naturally
// finished match replays map + frozen full + settlement immediately (there is
// no next tick). Aborted/superseded matches bootstrap nothing — the spectator
// waits for the next publication without any old-match feed.
func (m *Match) bootstrapSpectatorLocked(s *Session) {
	if m.activeLocked() {
		m.sendMapBootstrapLocked(s)
		m.forceSpectatorResyncLocked(s.playerID)
		// 中途接入的观战者：补发最近一次实时积分榜，避免等到下一拍才看到名次。
		if m.lastScoreboardEv != nil {
			s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: m.lastScoreboardEv}})
		}
		return
	}
	if m.finalEnd == nil {
		return
	}
	m.spectatorReplayEndLocked(s)
}

// forceSpectatorResyncLocked marks the next spectator frame reliable+full.
// On a finished match there is no next tick: resend the frozen feed instead.
func (m *Match) forceSpectatorResyncLocked(pid uint64) {
	if m.activeLocked() {
		m.specReliableFull[pid] = true
		if enc := m.specEncoders[pid]; enc != nil {
			enc.ForceFull()
		}
		return
	}
	if m.finalEnd == nil {
		return
	}
	if s := m.rc.spectators[pid]; s != nil {
		m.spectatorReplayEndLocked(s)
	}
}

// spectatorReplayEndLocked: map + frozen final full + settlement for a joiner
// arriving after the match ended (no ticks will ever come from this match).
func (m *Match) spectatorReplayEndLocked(s *Session) {
	m.sendMapBootstrapLocked(s)
	wv := m.sim.WorldView()
	obs := snapshot.BuildSpectatorObservation(snapshot.WorldOf(wv))
	enc := m.specEncoders[s.playerID]
	if enc == nil {
		enc = snapshot.NewEncoder()
		m.specEncoders[s.playerID] = enc
	}
	enc.ForceFull()
	delta := enc.Encode(wv.Frame.Tick, 0, wv.Frame.Phase, wv.Frame.TimeLeftS, obs, nil)
	s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: delta}})
	s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: m.finalEnd}})
}

// dropSpectatorLocked frees the per-connection encoder and full flag. Safe on
// any match state; never touches player input or encoders.
func (m *Match) dropSpectatorLocked(pid uint64) {
	delete(m.specEncoders, pid)
	delete(m.specReliableFull, pid)
}

// selfInputOf 组装某机器人的 owner-locked 私有投影（不改冻结的 RobotView API）。
// step 的常规帧与暂停期的重同步帧共用，保证两条路径字段一致。Caller holds rc.mu.
func (m *Match) selfInputOf(wv sim.WorldView, rv sim.RobotView) snapshot.SelfInput {
	ctrl := wv.Controls[rv.ID]
	robot, _ := m.sim.Robot(rv.ID)
	self := snapshot.SelfInput{
		Robot:         rv,
		MoveSrc:       ctrl.MoveSrc, // 仲裁标记直传（'H'/'S'/'-'，契约一致）
		TurretSrc:     ctrl.TurretSrc,
		FireSrc:       ctrl.FireSrc,
		AbilitySrc:    ctrl.AbilitySrc,
		ManualAxes:    uint32(robot.Control.HumanAxes),
		AssistOn:      robot.Control.Assist,
		DashReadyTick: robot.Combat.DashReady,
		FireReadyTick: robot.Combat.FireReady,
	}
	if m.ai != nil && m.ai.quota != nil {
		if pid, ok := m.playerOf[rv.ID]; ok {
			self.AiRounds, self.AiTokensK, _ = m.ai.quota.Snapshot(pid)
		}
	}
	return self
}

// flushPausedResyncs：暂停期间没有下一 tick 可消费 reliableFull 标记——对
// 标记中的玩家与观战者直接编码一帧当前全量快照（可靠下发），世界其余部分
// 保持冻结。Caller holds rc.mu.
func (m *Match) flushPausedResyncs() {
	m.encMu.Lock()
	pids := make([]uint64, 0, len(m.reliableFull))
	for pid := range m.reliableFull {
		pids = append(pids, pid)
	}
	specs := make([]uint64, 0, len(m.specReliableFull))
	for pid := range m.specReliableFull {
		specs = append(specs, pid)
	}
	m.encMu.Unlock()
	if len(pids) == 0 && len(specs) == 0 {
		return
	}
	wv := m.sim.WorldView()
	world := snapshot.WorldOf(wv)
	for _, pid := range pids {
		if !m.takeReliableFull(pid) {
			continue
		}
		s := m.rc.sessions[pid]
		rid, ok := m.robotOf[pid]
		if s == nil || !ok {
			continue
		}
		rv, found := robotOf(wv, rid)
		if !found {
			continue
		}
		enc := m.encoderFor(rid)
		enc.ForceFull()
		obs := snapshot.BuildObservation(world, m.wallIX, rid, 0, wv.ScanRadius(rid))
		self := m.selfInputOf(wv, rv)
		delta := enc.Encode(wv.Frame.Tick, wv.AckSeqs[rid], wv.Frame.Phase, wv.Frame.TimeLeftS, obs, &self)
		s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: delta}})
	}
	if len(specs) == 0 {
		return
	}
	specObs := snapshot.BuildSpectatorObservation(world)
	for _, pid := range specs {
		if !m.takeSpecReliableFull(pid) {
			continue
		}
		s := m.rc.spectators[pid]
		if s == nil {
			continue
		}
		enc := m.specEncoderFor(pid)
		enc.ForceFull()
		delta := enc.Encode(wv.Frame.Tick, 0, wv.Frame.Phase, wv.Frame.TimeLeftS, specObs, nil)
		s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: delta}})
	}
}

// requestFinishLocked 房主提前结算请求：下一拍走终局路径（完整管线 + MatchEnd
// + 终局 checkpoint + 结算广播）。隐含解除暂停。Caller holds rc.mu.
func (m *Match) requestFinishLocked() {
	if !m.activeLocked() || m.warmup {
		return
	}
	m.rc.paused = false
	m.finishReq = true
}

// MatchDurations 正式局时长配置（tick；零值 = 服务器默认 8/4 分钟）。
// 由房间建房配置（JoinRoom）解析而来，随每次 Launch 传入。
type MatchDurations struct {
	MatchTicks   uint32
	CoreOpenTick uint32
}

// ApplyDurations 在发布（start）前应用房主时长配置；warmup 忽略（热身场
// 使用 sim 的 WarmupTicks 语义，与正式局时长无关）。
func (m *Match) ApplyDurations(d MatchDurations) error {
	if m.warmup {
		return nil
	}
	return m.sim.SetDurations(d.MatchTicks, d.CoreOpenTick)
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
	ticker := time.NewTicker(time.Second / sim.TickRate)
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
	started := time.Now()
	m.rc.mu.Lock()
	defer m.rc.mu.Unlock()
	if !m.activeLocked() {
		return
	}
	// 房主暂停（仅正式局）：权威时钟停走，世界冻结。暂停期不再有 tick 帧，
	// 但 bootstrap/resync 标记仍需出帧——新接入的玩家/观战者不能挂
	// 「正在同步」到恢复为止。
	if m.rc.paused && !m.warmup {
		m.flushPausedResyncs()
		return
	}
	defer m.recordTickStat(started)
	if m.finishReq {
		m.finishReq = false
		m.sim.FinishEarly()
	}
	m.tick++
	m.sim.Tick()
	m.persistAssistStateLocked()

	wv := m.sim.WorldView()
	// 审计 S-6：每 tick 对同一机器人只构建一次 AOI，脚本池与快照循环共用
	// 同一观测（此前各自构建一遍，SOLO 63 机下每 tick 128 次 LOS 计算）。
	// 批 2：AOI 构建与逐观察者编码均按机器人独立，大房经 parallelFor
	// 并行执行（观察者数低于 parallelObserverThreshold 时保持串行）。
	obsSlice := make([]sim.Observation, len(wv.Robots))
	m.parallelFor(len(wv.Robots), func(i int) {
		rv := wv.Robots[i]
		obsSlice[i] = snapshot.BuildObservation(snapshot.WorldOf(wv), m.wallIX, rv.ID, 0, wv.ScanRadius(rv.ID))
	})
	obsByRobot := make(map[uint32]sim.Observation, len(wv.Robots))
	for i, rv := range wv.Robots {
		obsByRobot[rv.ID] = obsSlice[i]
	}
	m.runScripts(wv, obsByRobot)

	// 每在线观察者：AOI 裁剪 → delta 编码 → lossy 下行
	// ended：终局帧（审计 S-34）——没有下一个 tick 可以修复丢失的末帧，
	// 玩家与观战者同样 ForceFull + 可靠下发（此前玩家走 lossy，终局帧被
	// 丢时该玩家世界定格在倒数第二帧，仅分数可靠不受影响）。
	// 判定用 sim 终局位：自然到点（tick==matchTicks）与提前结算同构。
	ended := m.sim.Ended() && !m.warmup
	world := snapshot.WorldOf(wv)
	m.parallelFor(len(wv.Robots), func(i int) {
		rv := wv.Robots[i]
		pid, ok := m.playerOf[rv.ID]
		if !ok {
			return
		}
		s := m.rc.sessions[pid]
		if s == nil {
			return
		}
		enc := m.encoderFor(rv.ID)
		obs := obsByRobot[rv.ID]
		self := m.selfInputOf(wv, rv)
		if ended {
			enc.ForceFull()
			delta := enc.Encode(m.tick, wv.AckSeqs[rv.ID], wv.Frame.Phase, wv.Frame.TimeLeftS, obs, &self)
			s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: delta}})
			m.takeReliableFull(pid)
			return
		}
		delta := enc.Encode(m.tick, wv.AckSeqs[rv.ID], wv.Frame.Phase, wv.Frame.TimeLeftS, obs, &self)
		msg := &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: delta}}
		if m.takeReliableFull(pid) {
			s.SendReliable(msg)
		} else {
			s.SendLossy(msg)
		}
	})

	// Spectators: full-map observation, no AOI/occlusion, no self, per-connection
	// encoders keyed by connection id. New mid-match joiners get reliable full on
	// their next frame via specReliableFull.
	if len(m.rc.spectators) > 0 {
		obs := snapshot.BuildSpectatorObservation(world)
		specIDs := make([]uint64, 0, len(m.rc.spectators))
		for pid := range m.rc.spectators {
			specIDs = append(specIDs, pid)
		}
		m.parallelFor(len(specIDs), func(i int) {
			pid := specIDs[i]
			s := m.rc.spectators[pid]
			enc := m.specEncoderFor(pid)
			if ended {
				// No next tick can repair a dropped final frame.
				enc.ForceFull()
				delta := enc.Encode(m.tick, 0, wv.Frame.Phase, wv.Frame.TimeLeftS, obs, nil)
				s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: delta}})
				if m.finalEnd != nil {
					s.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: m.finalEnd}})
				}
				m.takeSpecReliableFull(pid)
				return
			}
			delta := enc.Encode(m.tick, 0, wv.Frame.Phase, wv.Frame.TimeLeftS, obs, nil)
			msg := &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: delta}}
			if m.takeSpecReliableFull(pid) {
				s.SendReliable(msg)
			} else {
				s.SendLossy(msg)
			}
		})
	}

	if ended {
		m.finish(wv)
		m.Stop()
		return
	}

	m.maybeBroadcastScoreboard(wv)
}

// persistAssistStateLocked snapshots post-toggle authority into the room identity
// so a replacement Match starts with the same assist preference.
func (m *Match) persistAssistStateLocked() {
	for pid, rid := range m.robotOf {
		if m.botRobots[rid] {
			continue
		}
		if robot, ok := m.sim.Robot(rid); ok {
			m.rc.assist[pid] = robot.Control.Assist
		}
	}
}

// scoreboardEveryTicks 实时积分榜最小广播间隔（2s）：榜是低频信息，无需 60Hz；
// 变化时立即重发，最多每 2s 一拍，兼顾带宽与新鲜度。
const scoreboardEveryTicks = 2 * sim.TickRate

// maybeBroadcastScoreboard 在局内定期（或积分变化时）向全部玩家与观战者广播实时积分榜。
// 不落 Match Event Log：榜属于低价值可再生态，重连/观战 catch-up 用 lastScoreboardEv。
func (m *Match) maybeBroadcastScoreboard(wv sim.WorldView) {
	if m.warmup {
		return
	}
	// 每 2s 一拍；未到间隔且榜未变化则跳过，减少编码开销。
	if m.tick-m.lastScoreboardTick < scoreboardEveryTicks && m.lastScoreboardTick != 0 {
		return
	}
	snap := m.proj.Live()
	fp := scoreboardFingerprint(snap.Rows)
	if fp == m.lastScoreboard && m.lastScoreboardTick != 0 {
		return // 榜未变化：跳过重发（首拍 lastScoreboardTick==0 必发）
	}
	m.lastScoreboard = fp
	m.lastScoreboardTick = m.tick
	ev := scoreboardEventOf(m.tick, snap.Rows)
	m.lastScoreboardEv = ev
	m.rc.broadcastLocked(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: ev}}) // 玩家 + 观战者，可靠通道（低频事件，不值得丢）
}

// scoreboardFingerprint 用 榜位+分数 序列做指纹：顺序或分数变化即视为变更。
func scoreboardFingerprint(rows []stats.ScoreRow) string {
	var b strings.Builder
	for i, r := range rows {
		if i > 0 {
			b.WriteByte(';')
		}
		b.WriteString(strconv.FormatUint(uint64(r.RobotID), 10))
		b.WriteByte(':')
		b.WriteString(strconv.FormatInt(int64(r.Score), 10))
	}
	return b.String()
}

// scoreboardEventOf 把 LiveSnapshot 转为 EvScoreboard 协议事件（复用 ScoreRow）。
func scoreboardEventOf(tick uint32, rows []stats.ScoreRow) *ombv1.ServerEvent {
	out := make([]*ombv1.ScoreRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &ombv1.ScoreRow{Robot: r.RobotID, Score: int32(r.Score)})
	}
	return &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_Scoreboard{Scoreboard: &ombv1.EvScoreboard{Rows: out, Tick: tick}}}
}

// runScripts 并行执行全部已装载脚本（deadline 内），结果投回 sim（下一 tick 消费）。
// 遍历注册表（scriptPool 是运行时唯一权威）；id 升序保证 Submit 顺序确定化。
// obsByRobot 由 step() 统一构建（审计 S-6），脚本与快照共享同一观测。
func (m *Match) runScripts(wv sim.WorldView, obsByRobot map[uint32]sim.Observation) {
	ids := m.scriptPool.IDs()
	if len(ids) == 0 {
		return
	}
	deadline := time.Now().Add(sim.FrameBudget)
	for _, rid := range ids {
		self, ok := robotOf(wv, rid)
		if !ok {
			continue
		}
		obs, ok := obsByRobot[rid]
		if !ok {
			continue
		}
		_ = m.scriptPool.Submit(rid, sim.ScriptFrame{Self: self, Obs: obs}, deadline)
	}
	for _, res := range m.scriptPool.Collect(deadline) {
		rt := m.scriptPool.RuntimeOf(res.ID)
		if res.Err != nil || res.Deferred {
			m.deferrals.Add(1)
			m.sim.ClearScriptAxes(res.ID) // 超时/异常/顺延：清脚本轴（人类轴保留）
			if rt != nil && !res.Deferred {
				m.sendScriptLogsLocked(res.ID, rt)
			}
			continue
		}
		if m.botRobots[res.ID] {
			res.Commands = soloBotCommands(res.Commands)
		}
		m.sim.ApplyScriptCommands(res.ID, res.Commands)
		if rt != nil {
			m.sendScriptLogsLocked(res.ID, rt)
		}
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
	m.rc.Room.EndMatch()
	m.rc.broadcastRoomStateLocked()
}

func settledMatchEnd(tick uint32, rows []stats.ScoreRow) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_MatchEnd{MatchEnd: finalRowsOf(rows)}}
}

func finalRowsOf(rows []stats.ScoreRow) *ombv1.EvMatchEnd {
	out := &ombv1.EvMatchEnd{}
	for _, r := range rows {
		out.Scores = append(out.Scores, &ombv1.ScoreRow{Robot: r.RobotID, Score: r.Score, Titles: r.Titles})
	}
	return out
}

// stableRobotID：playerID → 稳定 robotID（FNV-1a 32 位，小端字节序；冲突在 NewSim 排序时自然暴露）。
// 输出与旧手写实现逐位一致（见 golden 测试）——这是线上身份算法，改动词须带回归验证。
func stableRobotID(pid uint64) uint32 {
	var buf [8]byte
	binary.LittleEndian.PutUint64(buf[:], pid)
	h := fnv.New32a()
	_, _ = h.Write(buf[:])
	return h.Sum32()
}
