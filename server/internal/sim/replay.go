package sim

import (
	"encoding/json"
	"fmt"
	"io"
	"reflect"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// checkpointPositionValid 复用装配入口（SetSpawn/SetWalls）与运行时物理共
// 同维护的位置谓词：gen>=2 地图必须在竞技场圆盘内（与 insideArena 同条
// 件），且不得与任何墙体重叠（overlapsWall 原函数）。死亡机器人保留阵亡
// 时刻的合法位置，因此对所有机器人统一校验；gen<2 地图无圆盘边界，仅查墙。
func checkpointPositionValid(cp Checkpoint, p Vec2) bool {
	if cp.Map != nil && cp.Map.GeneratorVer >= 2 && p.Len() > arenaCenterRadius {
		return false
	}
	for _, wall := range cp.Walls {
		if overlapsWall(p, wall) {
			return false
		}
	}
	return true
}

// RestoreCheckpoint resumes exact simulation state, including pending controls.
// It never regenerates the map, advances RNG, or starts a clock. The caller owns
// Tick and must not run external scripts during deterministic replay.
func RestoreCheckpoint(state Checkpoint, sink EventSink) (*Sim, error) {
	// A serialization roundtrip detaches nested maps/slices and rejects NaN/Inf.
	raw, err := json.Marshal(state)
	if err != nil {
		return nil, fmt.Errorf("sim: checkpoint: %w", err)
	}
	var cp Checkpoint
	if err := json.Unmarshal(raw, &cp); err != nil {
		return nil, fmt.Errorf("sim: checkpoint: %w", err)
	}
	wantPhase := ombv1.Phase_OUTER_RING
	if cp.Tick >= CoreOpenTick {
		wantPhase = ombv1.Phase_CORE_OPEN
	}
	if cp.SimulationVersion < 0 || cp.SimulationVersion > SimulationVersion || cp.Tick > MatchTicks ||
		cp.Phase != wantPhase ||
		cp.Ended != (cp.Tick == MatchTicks) || cp.Robots == nil || cp.Walls == nil {
		return nil, fmt.Errorf("sim: invalid checkpoint lifecycle")
	}
	ids := make([]uint32, len(cp.Robots))
	known := make(map[uint32]bool, len(cp.Robots))
	for i, robot := range cp.Robots {
		if robot.ID == 0 || known[robot.ID] || (i > 0 && robot.ID <= cp.Robots[i-1].ID) ||
			robot.Sector >= 8 || (robot.State != Alive && robot.State != Dead) {
			return nil, fmt.Errorf("sim: invalid checkpoint robot %d", robot.ID)
		}
		// 装配入口与运行时物理共同维护的不变量（S-28）：位置永不进墙、
		// gen>=2 时必在竞技场圆盘内，HP 始终落在 [0, MaxHP]。合法 checkpoint
		// 不会违反；违反者只能来自被篡改/手工编辑的日志——例如卡墙位置会造
		// 出 slideRobot 接触清速、sweepWall t=0 推不动、traceSolid 先挡射线
		// 的不可交互机器人。
		if !checkpointPositionValid(cp, robot.Position) {
			return nil, fmt.Errorf("sim: invalid checkpoint robot %d position", robot.ID)
		}
		if robot.HP < 0 || robot.HP > MaxHP {
			return nil, fmt.Errorf("sim: invalid checkpoint robot %d hp", robot.ID)
		}
		known[robot.ID], ids[i] = true, robot.ID
	}
	// DamageBy 的键在伤害结算时必为在场机器人 ID；未知键只可能来自手工编辑。
	// 第二遍扫描：键可指向花名册中更靠后的机器人。
	for _, robot := range cp.Robots {
		for attacker := range robot.Combat.DamageBy {
			if !known[attacker] {
				return nil, fmt.Errorf("sim: invalid checkpoint damage attacker %d", attacker)
			}
		}
	}
	// 0 是「ID 耗尽」哨兵：恢复它会触发 fireProjectiles 的耗尽守卫，全员禁射
	// 到局终。合法装配（NewSim/reserveID）保证 NextProjectile 恒 >= 1。
	if cp.NextProjectile == 0 {
		return nil, fmt.Errorf("sim: invalid checkpoint next_projectile")
	}
	for i, wall := range cp.Walls {
		if wall.ID == 0 || (i > 0 && wall.ID <= cp.Walls[i-1].ID) || wall.Min.X >= wall.Max.X || wall.Min.Y >= wall.Max.Y {
			return nil, fmt.Errorf("sim: invalid checkpoint wall %d", wall.ID)
		}
	}
	if cp.Map != nil {
		// Validate geometry/rules using a zero-player sim: no spawn RNG or
		// checkpoint state is consumed or replaced by SetMap.
		check := NewSim(cp.Seed, nil, nil)
		if err := check.SetMap(cp.Map); err != nil {
			return nil, fmt.Errorf("sim: checkpoint map: %w", err)
		}
		if len(cp.Walls) != len(check.walls) || len(cp.Cores) != len(check.cores) || len(cp.HealthPacks) != len(check.healthPacks) || len(cp.Uplinks) != len(check.uplinks) {
			return nil, fmt.Errorf("sim: inconsistent checkpoint entities")
		}
		for i := range cp.Walls {
			if cp.Walls[i] != check.walls[i] {
				return nil, fmt.Errorf("sim: checkpoint walls differ from map")
			}
		}
		for i, core := range cp.Cores {
			want := check.cores[i]
			if core.ID != want.ID || core.Pos != want.Pos || core.Value != want.Value {
				return nil, fmt.Errorf("sim: checkpoint core differs from map")
			}
		}
		for i, pack := range cp.HealthPacks {
			want := check.healthPacks[i]
			if pack.ID != want.ID || pack.Pos != want.Pos {
				return nil, fmt.Errorf("sim: checkpoint health pack differs from map")
			}
		}
		for i, uplink := range cp.Uplinks {
			invalidDecay := cp.SimulationVersion < 3 && uplink.DecayAt != 0
			if cp.SimulationVersion >= 3 {
				invalidDecay = (uplink.HackingID != 0 && uplink.DecayAt != 0) ||
					(uplink.ProgressTicks == 0 && uplink.DecayAt != 0) ||
					(uplink.DecayAt != 0 && uplink.DecayAt <= cp.Tick)
			}
			if uplink.Def != check.uplinks[i].Def || uplink.ReadyAt == nil || invalidDecay ||
				(uplink.HackingID != 0 && !known[uplink.HackingID]) || uplink.ProgressTicks >= HackDuration {
				return nil, fmt.Errorf("sim: invalid checkpoint uplink")
			}
		}
	} else if len(cp.Cores) != 0 || len(cp.HealthPacks) != 0 || len(cp.Uplinks) != 0 {
		return nil, fmt.Errorf("sim: objectives require checkpoint map")
	}
	s := NewSim(cp.Seed, ids, sink)
	s.simulationVersion = cp.SimulationVersion
	s.tick, s.phase, s.ended = cp.Tick, cp.Phase, cp.Ended
	s.robots, s.walls, s.mapDef = cp.Robots, cp.Walls, cp.Map
	s.rng, s.nextProjectile = cp.RNG, cp.NextProjectile
	s.projectiles, s.cores, s.healthPacks, s.uplinks = cp.Projectiles, cp.Cores, cp.HealthPacks, cp.Uplinks
	s.publishView()
	return s, nil
}

// ReplayTo consumes a validated JSONL stream, starts at its latest checkpoint
// not after targetTick, and advances to exactly that tick. Identity/scoring are
// projected separately by stats.ReadReplay. EOF is not proof of match end;
// replay beyond the last recorded tick is rejected.
func ReplayTo(source io.Reader, targetTick uint32, sink EventSink) (*Sim, error) {
	if targetTick > MatchTicks {
		return nil, fmt.Errorf("sim: replay target beyond match end")
	}
	records, err := ReadMatchEventLog(source)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 || records[0].Type != RecordMatchStart || records[len(records)-1].Tick < targetTick {
		return nil, fmt.Errorf("sim: replay missing start or target coverage")
	}
	if err := validateReplayContinuity(records); err != nil {
		return nil, err
	}
	checkpoint := records[0].State
	for i := 1; i < len(records); i++ {
		record := &records[i]
		if record.Type == RecordMatchStart {
			return nil, fmt.Errorf("sim: duplicate replay start")
		}
		if record.Type == RecordCheckpoint && record.Tick <= targetTick {
			checkpoint = record.State
		}
	}
	s, err := RestoreCheckpoint(*checkpoint, sink)
	if err != nil {
		return nil, err
	}
	index := 0
	for index < len(records) && records[index].Tick <= s.tick {
		index++
	}
	for s.tick < targetTick {
		for index < len(records) && records[index].Tick == s.tick+1 {
			record := &records[index]
			if record.Type == RecordInput || record.Type == RecordControl {
				if err := s.applyReplayRecord(*record); err != nil {
					return nil, err
				}
			}
			index++
		}
		s.Tick()
	}
	return s, nil
}

func validateReplayContinuity(records []LogRecord) error {
	initial := records[0].State
	if _, err := RestoreCheckpoint(*initial, nil); err != nil {
		return err
	}
	type sequence struct {
		latest  uint32
		has     bool
		pending *Input
	}
	sequences := make(map[uint32]sequence, len(initial.Robots))
	for _, robot := range initial.Robots {
		seq := sequence{latest: robot.LatestSeq, has: robot.HasSeq}
		if robot.InputPending {
			pending := robot.PendingInput
			seq.pending = &pending
		}
		sequences[robot.ID] = seq
	}
	for i := 1; i < len(records); i++ {
		record := records[i]
		switch record.Type {
		case RecordMatchStart:
			return fmt.Errorf("sim: duplicate replay start")
		case RecordCheckpoint:
			cp := record.State
			if cp.Seed != initial.Seed || cp.SimulationVersion != initial.SimulationVersion ||
				!reflect.DeepEqual(cp.Map, initial.Map) || !reflect.DeepEqual(cp.Walls, initial.Walls) || len(cp.Robots) != len(initial.Robots) {
				return fmt.Errorf("sim: replay checkpoint changed match identity or rules")
			}
			for j, robot := range cp.Robots {
				want := initial.Robots[j]
				if robot.ID != want.ID || robot.Nick != want.Nick || robot.Color != want.Color || robot.Sector != want.Sector {
					return fmt.Errorf("sim: replay checkpoint changed robot identity")
				}
				seq := sequences[robot.ID]
				if robot.HasSeq != seq.has || robot.LatestSeq != seq.latest || (robot.HasSeq && robot.ConsumedSeq > robot.LatestSeq) {
					return fmt.Errorf("sim: replay checkpoint changed input sequence")
				}
			}
			if _, err := RestoreCheckpoint(*cp, nil); err != nil {
				return err
			}
		case RecordInput, RecordControl:
			seq, ok := sequences[record.RobotID]
			if !ok {
				return fmt.Errorf("sim: replay control for unknown robot %d", record.RobotID)
			}
			if record.Type == RecordInput {
				input := record.Input
				pendingCopy := seq.pending != nil && record.Tick == initial.Tick+1 && *input == *seq.pending
				if seq.has && (input.Seq < seq.latest || (input.Seq == seq.latest && !pendingCopy)) {
					return fmt.Errorf("sim: replay input sequence did not advance")
				}
				seq.latest, seq.has, seq.pending = input.Seq, true, nil
				sequences[record.RobotID] = seq
			}
		}
	}
	return nil
}

func (s *Sim) applyReplayRecord(record LogRecord) error {
	i, ok := s.index[record.RobotID]
	if !ok {
		return fmt.Errorf("sim: replay control for unknown robot %d", record.RobotID)
	}
	r := &s.robots[i]
	switch record.Type {
	case RecordInput:
		if record.Input == nil || (r.HasSeq && (record.Input.Seq < r.LatestSeq ||
			(record.Input.Seq == r.LatestSeq && (!r.InputPending || *record.Input != r.PendingInput)))) {
			return fmt.Errorf("sim: replay input sequence did not advance")
		}
		// Records contain consumed/coalesced input, not another upstream
		// packet. Overwrite pending state already captured by match_start.
		r.PendingInput, r.LatestSeq, r.HasSeq, r.InputPending = *record.Input, record.Input.Seq, true, true
	case RecordControl:
		c := record.Control
		r.Control.PendingScript = cloneCommands(c.Script)
		r.Control.ScriptPending = c.Script != nil || c.ScriptFailed
		r.Control.ScriptFailed = c.ScriptFailed
		r.Control.ToggleCount = c.Toggles
		r.RespawnPending = c.Respawn
		r.Control.PendingSay = c.Say
	}
	return nil
}
