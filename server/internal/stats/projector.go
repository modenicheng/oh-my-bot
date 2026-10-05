package stats

import (
	"cmp"
	"fmt"
	"math"
	"sort"
	"strconv"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	sim "github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// Score weights (v0.3 §6). Core/Uplink values come from the event payloads.
const (
	ScoreKill   int32 = 25
	ScoreAssist int32 = 10
	ScoreHit    int32 = 1
)

// movementSlack widens the per-interval physical distance cap (sim.MaxSpeed
// over the elapsed ticks) so float rounding can never reject a legit delta;
// teleports (respawn without a seen EvRespawn) still exceed it.
const movementSlack = 1.05

// robotStats is the per-robot accumulation state. "*At" fields record the tick
// at which the counter reached its current value — the "first achiever wins"
// tie-break input for max-value titles (v0.3 §13).
type robotStats struct {
	id uint32

	score        int32
	kills        int32
	deaths       int32
	assists      int32
	killSteals   int32
	healedX10    int32
	hitsLanded   int32 // EvHit `from` count — v1 BARRAGE proxy for shots
	cores        int32
	uplinks      int32
	wallHits     int32
	aiRounds     int32
	aiTokensK    int32
	scriptErrors int32
	// snippetUses counts CS_SNIPPET-sourced control activity from the
	// throttled EvSnippetUsage telemetry sim emits when a final output axis
	// actually resolved to snippet control (config alone never counts).
	snippetUses int32

	killsAt        uint32
	killStealsAt   uint32
	healedAt       uint32
	deathsAt       uint32
	hitsAt         uint32
	coresAt        uint32
	uplinksAt      uint32
	wallHitsAt     uint32
	aiRoundsAt     uint32
	scriptErrorsAt uint32

	// RUNNER: cumulative checkpoint position delta.
	dist        float64
	distAt      uint32 // checkpoint tick of the last distance increment
	lastPos     *sim.Vec2
	lastPosTick uint32

	// SURVIVOR: currently open alive segment (aliveSince) and best closed one.
	aliveKnown   bool // an alive segment is open (respawn/first sighting)
	aliveSince   uint32
	maxSurvTicks uint32
	maxSurvAt    uint32
}

// ProjectorImpl is the v1 Projector. It is a sequential, single-goroutine
// consumer (same threading contract as sim.EventSink): glue feeds it from the
// room/sim loop; tests feed it synchronously. It doubles as a
// sim.CheckpointSink so glue can register one object for both event and
// checkpoint streams (checkpoint lines carry the positions RUNNER needs).
type ProjectorImpl struct {
	robots map[uint32]*robotStats

	// Glue-injected identity tables (after EvMatchStart).
	players map[uint32]uint64
	nicks   map[uint32]string

	// seen holds dedup keys for both identity schemes: content keys
	// ("tick|kind|payload", legacy OnEvent) and record keys ("r|seq",
	// OnEventRecord). The prefixes cannot collide.
	seen map[string]struct{}

	lastTick   uint32
	hasCp      bool
	lastCpTick uint32

	matchStartSeen bool
	matchEnded     bool

	finalDone bool
	final     []ScoreRow
}

var (
	_ Projector          = (*ProjectorImpl)(nil)
	_ sim.CheckpointSink = (*ProjectorImpl)(nil)
	_ sim.ReplaySink     = (*ProjectorImpl)(nil)
)

// NewProjector creates an empty projector for one match.
func NewProjector() *ProjectorImpl {
	return &ProjectorImpl{
		robots:  make(map[uint32]*robotStats),
		players: make(map[uint32]uint64),
		nicks:   make(map[uint32]string),
		seen:    make(map[string]struct{}),
	}
}

// SetPlayerMap implements Projector. Glue calls it right after EvMatchStart.
func (p *ProjectorImpl) SetPlayerMap(m map[uint32]uint64) {
	p.players = make(map[uint32]uint64, len(m))
	for k, v := range m {
		p.players[k] = v
	}
}

// SetNickMap injects robotID→display nick. Ev* events carry no nicks
// (RobotState.nick lives only in snapshots), so identity comes from glue.
func (p *ProjectorImpl) SetNickMap(m map[uint32]string) {
	p.nicks = make(map[uint32]string, len(m))
	for k, v := range m {
		p.nicks[k] = v
	}
}

// SetPartnerMap is retained as a no-op for callers and legacy replay options.
// Live matches no longer have partner mechanics or BEST_PARTNER settlement.
func (p *ProjectorImpl) SetPartnerMap(map[uint32]uint32) {}

func (p *ProjectorImpl) robot(id uint32) *robotStats {
	if r, ok := p.robots[id]; ok {
		return r
	}
	r := &robotStats{id: id}
	p.robots[id] = r
	return r
}

// OnEvent consumes one event (same order as EventSink) under CONTENT
// identity: replaying an already seen tick+kind+payload is a no-op. This is
// the legacy/unordered-source entry point (old callers, content-dedup tests).
// Ordered sources (glue live feed, JSONL replay) must use OnEventRecord,
// which distinguishes genuinely distinct same-tick identical-payload events
// (e.g. two projectiles hitting the same target with equal damage in one
// tick) that content dedup would wrongly merge — dropping ScoreHit and the
// BARRAGE proxy. Events after EvMatchEnd are ignored so a double-fed stream
// tail cannot skew the result.
func (p *ProjectorImpl) OnEvent(tick uint32, ev *ombv1.ServerEvent) {
	if ev == nil || ev.Kind == nil || p.matchEnded {
		return
	}
	key := eventKey(tick, ev)
	if key == "" {
		return // nil oneof payload: defensive, nothing to project
	}
	if _, dup := p.seen[key]; dup {
		return
	}
	p.seen[key] = struct{}{}
	p.applyEvent(tick, ev)
}

// OnEventRecord consumes one event under ORDERED-SOURCE identity: the
// caller-assigned sequence is the dedup key, so every logically distinct
// event counts exactly once regardless of payload equality, and re-feeding
// the same sequence is a no-op. Glue assigns one sequence per projected event
// (sim loop order); replay assigns one per JSONL event line — line order is a
// reliable identity, so nothing is added to the wire. sequence 0 carries no
// ordered identity and falls back to OnEvent content dedup. Defenses match
// OnEvent: nil event, nil kind, and nil oneof payloads never project.
func (p *ProjectorImpl) OnEventRecord(sequence uint64, tick uint32, ev *ombv1.ServerEvent) {
	if sequence == 0 {
		p.OnEvent(tick, ev)
		return
	}
	if ev == nil || ev.Kind == nil || p.matchEnded {
		return
	}
	key := "r|" + strconv.FormatUint(sequence, 10)
	if _, dup := p.seen[key]; dup {
		return
	}
	p.seen[key] = struct{}{}
	p.applyEvent(tick, ev)
}

// applyEvent is the shared projection body for both entry points: dedup has
// already happened and the sequence/content key is already recorded.
func (p *ProjectorImpl) applyEvent(tick uint32, ev *ombv1.ServerEvent) {
	if tick > p.lastTick {
		p.lastTick = tick
	}

	switch k := ev.Kind.(type) {
	case *ombv1.ServerEvent_Kill:
		if e := k.Kill; e != nil {
			p.onKill(tick, e)
		}
	case *ombv1.ServerEvent_CorePickup:
		if e := k.CorePickup; e != nil {
			r := p.robot(e.By)
			r.score += e.Value
			r.cores++
			r.coresAt = tick
		}
	case *ombv1.ServerEvent_UplinkHack:
		if e := k.UplinkHack; e != nil {
			r := p.robot(e.By)
			r.score += e.Value
			r.uplinks++
			r.uplinksAt = tick
		}
	case *ombv1.ServerEvent_Hit:
		if e := k.Hit; e != nil {
			r := p.robot(e.From)
			r.score += ScoreHit
			r.hitsLanded++
			r.hitsAt = tick
		}
	case *ombv1.ServerEvent_Heal:
		if e := k.Heal; e != nil && e.HealX10 > 0 {
			r := p.robot(e.By)
			r.healedX10 += e.HealX10
			r.healedAt = tick
		}
	case *ombv1.ServerEvent_Respawn:
		if e := k.Respawn; e != nil {
			r := p.robot(e.Robot)
			r.aliveKnown = true
			r.aliveSince = tick
			// Respawn teleports to a sector spawn we do not know from the
			// event; drop the last known position so the next checkpoint
			// re-seeds instead of accumulating a teleport delta.
			r.lastPos = nil
		}
	case *ombv1.ServerEvent_Say:
		if e := k.Say; e != nil {
			p.robot(e.Robot) // presence only: the speaker joins the board
		}
	case *ombv1.ServerEvent_PhaseChange:
		// Consumed for completeness; no per-player projection.
	case *ombv1.ServerEvent_WallHit:
		if e := k.WallHit; e != nil {
			r := p.robot(e.Robot)
			r.wallHits++
			r.wallHitsAt = tick
		}
	case *ombv1.ServerEvent_ScriptError:
		if e := k.ScriptError; e != nil {
			r := p.robot(e.Robot)
			r.scriptErrors++
			r.scriptErrorsAt = tick
		}
	case *ombv1.ServerEvent_SnippetUsage:
		if e := k.SnippetUsage; e != nil {
			r := p.robot(e.Robot)
			r.snippetUses++
		}
	case *ombv1.ServerEvent_MatchStart:
		if e := k.MatchStart; e != nil {
			p.matchStartSeen = true
			_ = e // seed/players carry no per-robot projection in v1
		}
	case *ombv1.ServerEvent_AiUsage:
		if e := k.AiUsage; e != nil && e.RoundsDelta > 0 {
			r := p.robot(e.Robot)
			r.aiRounds += int32(e.RoundsDelta)
			r.aiTokensK += int32(e.TokensDelta)
			r.aiRoundsAt = tick
		}
	case *ombv1.ServerEvent_MatchEnd:
		if e := k.MatchEnd; e != nil {
			p.matchEnded = true
			// Close every open survival segment at the final tick; the
			// embedded scores are the projector's own output serialized by
			// glue, so they are deliberately not trusted here.
			for _, r := range p.robots {
				p.closeSegment(r, tick)
			}
		}
	case *ombv1.ServerEvent_RoomState, *ombv1.ServerEvent_AiQuota,
		*ombv1.ServerEvent_ScriptResult, *ombv1.ServerEvent_MapBootstrap:
		// Consumed for completeness (full-event consumption); no stats effect.
	}
}

func (p *ProjectorImpl) onKill(tick uint32, e *ombv1.EvKill) {
	victim := p.robot(e.Victim)
	victim.deaths++
	victim.deathsAt = tick
	p.closeSegment(victim, tick)

	if e.Killer != 0 && e.Killer != e.Victim {
		killer := p.robot(e.Killer)
		killer.kills++
		killer.killsAt = tick
		killer.score += ScoreKill
		assists := e.Assists
		//nolint:staticcheck // 旧字段 Assist：兼容旧 replay 归档（proto 已弃用）
		if len(assists) == 0 && e.Assist != 0 {
			assists = []uint32{e.Assist} // legacy replay compatibility
		}
		for _, assist := range assists {
			if assist == 0 || assist == e.Killer {
				continue
			}
			a := p.robot(assist)
			a.assists++
			a.score += ScoreAssist
		}
		if e.KillSteal {
			killer.killSteals++
			killer.killStealsAt = tick
		}
	}
}

func (p *ProjectorImpl) closeSegment(r *robotStats, tick uint32) {
	if r.aliveKnown && tick > r.aliveSince {
		if length := tick - r.aliveSince; length > r.maxSurvTicks {
			r.maxSurvTicks = length
			r.maxSurvAt = tick
		}
	}
	r.aliveKnown = false
}

// OnMatchInit ingests the tick-0 initial state (sim.ReplaySink). Production
// glue registers this projector in the same sink chain as the match log, so
// the live path sees the same bootstrap as a replay — SURVIVOR segments open
// from tick 0 and robots gain a position seed.
func (p *ProjectorImpl) OnMatchInit(state sim.Checkpoint) {
	p.OnCheckpoint(state)
}

// OnInput is a ReplaySink no-op: control inputs drive the sim, not the stats
// projection.
func (p *ProjectorImpl) OnInput(tick uint32, robotID uint32, input sim.Input) {}

// OnCheckpoint ingests a full-state checkpoint (match_start line or 60s
// checkpoint line). It is the only position source, feeding RUNNER deltas and
// bootstrapping SURVIVOR segments when respawn events were not observed.
// Duplicate/backwards checkpoints are ignored (idempotent re-feed).
func (p *ProjectorImpl) OnCheckpoint(cp sim.Checkpoint) {
	if p.hasCp && cp.Tick <= p.lastCpTick {
		return
	}
	p.hasCp = true
	p.lastCpTick = cp.Tick
	if cp.Tick > p.lastTick {
		p.lastTick = cp.Tick
	}

	for i := range cp.Robots {
		rob := &cp.Robots[i]
		r := p.robot(rob.ID)
		pos := sim.Vec2{X: rob.Position.X, Y: rob.Position.Y}
		if rob.State == sim.Dead {
			// Death without a seen EvKill (defensive): close the segment at
			// checkpoint granularity and remember the death-spot position.
			p.closeSegment(r, cp.Tick)
			r.lastPos = &pos
			r.lastPosTick = cp.Tick
			continue
		}
		if !r.aliveKnown {
			r.aliveKnown = true
			r.aliveSince = cp.Tick
		}
		if r.lastPos != nil {
			elapsed := cp.Tick - r.lastPosTick
			capDelta := sim.MaxSpeed * sim.DT * float64(elapsed) * movementSlack
			if d := math.Hypot(pos.X-r.lastPos.X, pos.Y-r.lastPos.Y); d > 0 && d <= capDelta {
				r.dist += d
				r.distAt = cp.Tick
			}
			// d > capDelta: unexplained teleport — re-seed without counting.
		}
		r.lastPos = &pos
		r.lastPosTick = cp.Tick
	}
}

// Live returns the current board sorted by score desc, tie robotID asc.
// Titles stay empty until Final (titles are settlement-only).
func (p *ProjectorImpl) Live() LiveSnapshot {
	sorted := p.sortedRobots()
	rows := make([]ScoreRow, 0, len(sorted))
	for _, r := range sorted {
		rows = append(rows, ScoreRow{RobotID: r.id, PlayerID: p.players[r.id], Nick: p.nicks[r.id], Score: r.score})
	}
	sortRows(rows)
	return LiveSnapshot{Tick: p.lastTick, Rows: rows}
}

// Final evaluates the 13 titles and freezes the settlement rows (computed
// once; later calls return the cached result). Production glue calls it after
// EvMatchEnd; calling earlier evaluates the state seen so far.
func (p *ProjectorImpl) Final() []ScoreRow {
	if p.finalDone {
		// Defensive copy: the frozen settlement must not be mutable through a
		// previously returned slice.
		out := make([]ScoreRow, len(p.final))
		copy(out, p.final)
		return out
	}
	sorted := p.sortedRobots()
	titles := p.evaluateTitles(sorted)
	rows := make([]ScoreRow, 0, len(sorted))
	for _, r := range sorted {
		rows = append(rows, ScoreRow{
			RobotID:  r.id,
			PlayerID: p.players[r.id],
			Nick:     p.nicks[r.id],
			Score:    r.score,
			Titles:   titles[r.id],
		})
	}
	sortRows(rows)
	p.final = rows
	p.finalDone = true
	out := make([]ScoreRow, len(rows))
	copy(out, rows)
	return out
}

func (p *ProjectorImpl) sortedRobots() []*robotStats {
	ids := make([]uint32, 0, len(p.robots))
	for id := range p.robots {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := make([]*robotStats, 0, len(ids))
	for _, id := range ids {
		out = append(out, p.robots[id])
	}
	return out
}

func sortRows(rows []ScoreRow) {
	sort.SliceStable(rows, func(i, j int) bool {
		// Stable keeps the projector's own deterministic row identity (robot
		// id) for full ties instead of relying on the comparator's strict order.
		return cmp.Or(
			cmp.Compare(rows[j].Score, rows[i].Score),     // score desc
			cmp.Compare(rows[i].RobotID, rows[j].RobotID), // tie: robot id asc
		) < 0
	})
}

// eventKey builds the dedup fingerprint: tick + kind + full payload. The log
// stream carries no event sequence numbers, so content within a tick is the
// identity; a genuine same-tick identical-payload duplicate (e.g. two EvHit
// with equal from/to/dmg) is indistinguishable from a replayed event and is
// counted once — accepted v1 trade-off, noted in the completion report.
func eventKey(tick uint32, ev *ombv1.ServerEvent) string {
	switch k := ev.Kind.(type) {
	case *ombv1.ServerEvent_Kill:
		if e := k.Kill; e != nil {
			return fmt.Sprintf("%d|k|%d|%d|%d|%v|%t", tick, e.Killer, e.Victim, e.Assist, e.Assists, e.KillSteal) //nolint:staticcheck // 旧字段 Assist 参与 fingerprint，兼容旧 replay
		}
	case *ombv1.ServerEvent_CorePickup:
		if e := k.CorePickup; e != nil {
			return fmt.Sprintf("%d|c|%d|%d|%d", tick, e.By, e.CoreId, e.Value)
		}
	case *ombv1.ServerEvent_UplinkHack:
		if e := k.UplinkHack; e != nil {
			return fmt.Sprintf("%d|u|%d|%d|%d", tick, e.By, e.UplinkId, e.Value)
		}
	case *ombv1.ServerEvent_Hit:
		if e := k.Hit; e != nil {
			return fmt.Sprintf("%d|h|%d|%d|%d", tick, e.From, e.To, e.Dmg)
		}
	case *ombv1.ServerEvent_Heal:
		if e := k.Heal; e != nil {
			return fmt.Sprintf("%d|heal|%d|%d|%d", tick, e.By, e.Id, e.HealX10)
		}
	case *ombv1.ServerEvent_Respawn:
		if e := k.Respawn; e != nil {
			return fmt.Sprintf("%d|r|%d|%d", tick, e.Robot, e.Sector)
		}
	case *ombv1.ServerEvent_Say:
		if e := k.Say; e != nil {
			return fmt.Sprintf("%d|s|%d|%s", tick, e.Robot, e.Text)
		}
	case *ombv1.ServerEvent_PhaseChange:
		if e := k.PhaseChange; e != nil {
			return fmt.Sprintf("%d|p|%d|%d", tick, e.From, e.To)
		}
	case *ombv1.ServerEvent_WallHit:
		if e := k.WallHit; e != nil {
			at := e.At
			ax, ay := 0.0, 0.0
			if at != nil {
				ax, ay = at.X, at.Y
			}
			return fmt.Sprintf("%d|w|%d|%v|%v|%v", tick, e.Robot, ax, ay, e.Impact)
		}
	case *ombv1.ServerEvent_ScriptError:
		if e := k.ScriptError; e != nil {
			return fmt.Sprintf("%d|e|%d|%s|%d", tick, e.Robot, e.Error, e.ScriptRev)
		}
	case *ombv1.ServerEvent_MatchStart:
		if e := k.MatchStart; e != nil {
			return fmt.Sprintf("%d|ms|%d|%d", tick, e.MapSeed, e.Players)
		}
	case *ombv1.ServerEvent_AiUsage:
		if e := k.AiUsage; e != nil {
			return fmt.Sprintf("%d|a|%d|%d|%d|%d", tick, e.Robot, e.RoundsDelta, e.TokensDelta, e.GlobalLeftK)
		}
	case *ombv1.ServerEvent_MatchEnd:
		if k.MatchEnd != nil {
			return fmt.Sprintf("%d|me|%d", tick, len(k.MatchEnd.Scores))
		}
	case *ombv1.ServerEvent_RoomState:
		if e := k.RoomState; e != nil {
			return fmt.Sprintf("%d|rs|%d|%d|%s", tick, e.State, e.RobotsOnline, e.HostNick)
		}
	case *ombv1.ServerEvent_AiQuota:
		if e := k.AiQuota; e != nil {
			return fmt.Sprintf("%d|aq|%d|%d|%d", tick, e.RoundsLeft, e.TokensUsedK, e.GlobalTokensLeftK)
		}
	case *ombv1.ServerEvent_ScriptResult:
		if e := k.ScriptResult; e != nil {
			return fmt.Sprintf("%d|sr|%d|%t|%s|%d", tick, e.ClientScriptId, e.Ok, e.Error, e.ScriptRev)
		}
	case *ombv1.ServerEvent_SnippetUsage:
		if e := k.SnippetUsage; e != nil {
			return fmt.Sprintf("%d|nu|%d|%d", tick, e.Robot, e.Axes)
		}
	case *ombv1.ServerEvent_MapBootstrap:
		if e := k.MapBootstrap; e != nil {
			return fmt.Sprintf("%d|mb|%s|%d", tick, e.MapHash, e.GeneratorVersion)
		}
	}
	return ""
}
