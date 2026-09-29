// Match 一个权威对局的装配与 60Hz 驱动（Phase D 集成）。
//
// 时序（每 tick，ADR-0007 单时钟）：sim 内部完成 input→仲裁→物理→事件；
// glue 在 Tick 后取 WorldView → 每观察者 AOI（T3）→ snapshot 编码 → 下行。
// 脚本池接入分两步：v1 集成先跑「无脚本」权威循环（手操路径），脚本 tick
// 注入在 sim 下一步扩展点（ApplyScriptCommands）就绪后接入——见 phase-d 后续。
package glue

import (
	"fmt"
	"log"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/mapgen"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
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

	robotOf  map[uint64]uint32 // playerID -> robotID
	playerOf map[uint32]uint64 // robotID -> playerID
	lastSeq  map[uint64]uint32

	tick uint32
	stop chan struct{}
	done chan struct{}
}

// SessionInfo 装配参数（房间成员快照）。
type SessionInfo struct {
	PlayerID uint64
	Nick     string
	Color    string
}

// NewMatch 装配并启动（独立 goroutine 60Hz 驱动）。
func NewMatch(rc *RoomConn, players map[uint64]SessionInfo) (*Match, error) {
	m := &Match{
		rc:       rc,
		proj:     stats.NewProjector(),
		robotOf:  map[uint64]uint32{},
		playerOf: map[uint32]uint64{},
		lastSeq:  map[uint64]uint32{},
		encoders: map[uint32]*snapshot.DeltaEncoder{},
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}

	// 地图：种子来自房间状态机（Start 时生成）
	def, err := mapgen.Generate(rc.Room.Seed())
	if err != nil {
		return nil, fmt.Errorf("mapgen: %w", err)
	}
	m.mapDef = def

	// player↔robot 映射（glue 唯一 owner；robotID = 稳定哈希 playerID）
	ids := make([]uint32, 0, len(players))
	playerMap := map[uint32]uint64{}
	for pid := range players {
		rid := stableRobotID(pid)
		m.robotOf[pid] = rid
		m.playerOf[rid] = pid
		playerMap[rid] = pid
		ids = append(ids, rid)
	}

	// 事件管线：sim → 日志落盘 + 投影 + 可靠广播（multiSink 组合）
	matchID := fmt.Sprintf("%s-%d", rc.Code, rc.Room.SessionSeq())
	ml, err := sim.NewMatchEventLogIn("data/matches", matchID)
	if err != nil {
		return nil, fmt.Errorf("event log: %w", err)
	}
	m.log = ml
	sink := m.newSink()
	m.sim = sim.NewSim(rc.Room.Seed(), ids, multiSink{primary: ml, secondary: sink})
	if err := m.sim.SetMap(def); err != nil {
		return nil, fmt.Errorf("setmap: %w", err)
	}
	m.proj.SetPlayerMap(playerMap)
	m.wallIX = snapshot.NewWallIndex(def.Walls, 4.0)

	go m.run()
	return m, nil
}

// sink 适配 EventSink 接口：投影 + 广播（不阻塞、不改事件——契约要求）。
type glueSink struct{ m *Match }

func (g glueSink) OnEvent(tick uint32, ev *ombv1.ServerEvent) {
	g.m.proj.OnEvent(tick, ev)
	g.m.rc.Broadcast(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: ev}})
}

func (m *Match) newSink() sim.EventSink { return glueSink{m: m} }

// multiSink：事件先落盘再投影广播（日志失败不阻断模拟——Err 由 Close 报告）。
type multiSink struct {
	primary   *sim.MatchEventLog
	secondary sim.EventSink
}

func (ms multiSink) OnEvent(tick uint32, ev *ombv1.ServerEvent) {
	ms.primary.OnEvent(tick, ev)
	ms.secondary.OnEvent(tick, ev)
}

// ApplyClientInput 连接层收到输入帧转投模拟（带 seq 缓存供 ack）。
func (m *Match) ApplyClientInput(pid uint64, in *ombv1.ClientInput) {
	if rid, ok := m.robotOf[pid]; ok {
		m.lastSeq[pid] = in.GetSeq()
		m.sim.ApplyInput(rid, in)
	}
}

func (m *Match) Stop()                 { close(m.stop) }
func (m *Match) Done() <-chan struct{} { return m.done }

func (m *Match) run() {
	defer close(m.done)
	ticker := time.NewTicker(time.Second / tickHz)
	defer ticker.Stop()
	for {
		select {
		case <-m.stop:
			return
		default:
		}
		m.step()
		<-ticker.C
	}
}

func (m *Match) step() {
	m.tick++
	m.sim.Tick()

	wv := m.sim.WorldView()

	// 每在线观察者：AOI 裁剪 → delta 编码 → lossy 下行
	for _, rv := range wv.Robots {
		pid, ok := m.playerOf[rv.ID]
		if !ok {
			continue
		}
		s := m.rc.sessionOf(pid)
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
		}, m.wallIX, rv.ID, wv.Partners[rv.ID])
		ctrl := wv.Controls[rv.ID]
		self := snapshot.SelfInput{
			Robot:     rv,
			MoveSrc:   ctrl.MoveSrc, // 仲裁标记直传（'H'/'S'/'-'，契约一致）
			TurretSrc: ctrl.TurretSrc,
		}
		delta := enc.Encode(m.tick, wv.AckSeqs[rv.ID], wv.Frame.Phase, wv.Frame.TimeLeftS, obs, &self)
		s.SendLossy(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: delta}})
	}

	if m.tick >= matchTicks {
		m.finish(wv)
		return
	}
}

func (m *Match) finish(wv sim.WorldView) {
	rows := m.proj.Final()
	scores := map[uint64]int32{}
	for _, r := range rows {
		scores[r.PlayerID] = r.Score
	}
	m.rc.Room.AddMatchResult(scores)
	// 终局事件（含 13 称号）：可靠广播
	end := &ombv1.ServerEvent{
		Tick: m.tick,
		Kind: &ombv1.ServerEvent_MatchEnd{MatchEnd: finalRowsOf(rows)},
	}
	m.rc.Broadcast(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: end}})
	if m.log != nil {
		if err := m.log.Close(); err != nil {
			// 日志失败不推翻对局结果，但要可见（运维排查）
			log.Printf("[match %s] event log close error: %v", m.rc.Code, err)
		}
	}
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
