package sim

import (
	"fmt"
	"io"
)

// ReplayVisualFrame is a compact, render-oriented sample from an authoritative
// deterministic replay. Scoring and timeline events remain sourced from the
// original event log; these frames supply the continuously changing world state.
type ReplayVisualFrame struct {
	Tick        uint32                   `json:"tick"`
	Phase       Phase                    `json:"phase"`
	Robots      []ReplayVisualRobot      `json:"robots"`
	Projectiles []ReplayVisualProjectile `json:"projectiles"`
}

type ReplayVisualRobot struct {
	ID           uint32  `json:"id"`
	Pos          Vec2    `json:"pos"`
	Heading      float64 `json:"heading"`
	HP           float64 `json:"hp"`
	Energy       float64 `json:"energy"`
	Alive        bool    `json:"alive"`
	Invulnerable bool    `json:"invulnerable"`
}

type ReplayVisualProjectile struct {
	ID      uint32  `json:"id"`
	Owner   uint32  `json:"owner"`
	Pos     Vec2    `json:"pos"`
	Heading float64 `json:"heading"`
}

// ReplayVisualFrames validates and replays one log exactly once, sampling the
// published world every sampleEvery ticks and at the final recorded tick.
func ReplayVisualFrames(source io.Reader, sampleEvery uint32) ([]ReplayVisualFrame, error) {
	if sampleEvery == 0 {
		return nil, fmt.Errorf("sim: replay visual sample interval is zero")
	}
	records, err := ReadMatchEventLog(source)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 || records[0].Type != RecordMatchStart || records[0].State == nil {
		return nil, fmt.Errorf("sim: replay missing start")
	}
	if err := validateReplayContinuity(records); err != nil {
		return nil, err
	}
	s, err := RestoreCheckpoint(*records[0].State, nil)
	if err != nil {
		return nil, err
	}
	endTick := records[len(records)-1].Tick
	frames := make([]ReplayVisualFrame, 0, int(endTick/sampleEvery)+2)
	frames = append(frames, visualFrame(s.WorldView()))
	index := 0
	for index < len(records) && records[index].Tick <= s.tick {
		index++
	}
	for s.tick < endTick {
		nextTick := s.tick + 1
		for index < len(records) && records[index].Tick == nextTick {
			record := records[index]
			if record.Type == RecordInput || record.Type == RecordControl {
				if err := s.applyReplayRecord(record); err != nil {
					return nil, err
				}
			}
			index++
		}
		s.Tick()
		if s.tick%sampleEvery == 0 || s.tick == endTick {
			frames = append(frames, visualFrame(s.WorldView()))
		}
	}
	return frames, nil
}

func visualFrame(view WorldView) ReplayVisualFrame {
	frame := ReplayVisualFrame{
		Tick:        view.Frame.Tick,
		Phase:       view.Frame.Phase,
		Robots:      make([]ReplayVisualRobot, len(view.Robots)),
		Projectiles: make([]ReplayVisualProjectile, len(view.Projectiles)),
	}
	for i, robot := range view.Robots {
		frame.Robots[i] = ReplayVisualRobot{
			ID: robot.ID, Pos: robot.Pos, Heading: robot.Turret,
			HP: FromX10(robot.HpX10), Energy: FromX10(robot.EnergyX10),
			Alive: !robot.Dead, Invulnerable: robot.InvulnS > 0,
		}
	}
	for i, projectile := range view.Projectiles {
		frame.Projectiles[i] = ReplayVisualProjectile{
			ID: projectile.ID, Owner: projectile.Owner, Pos: projectile.Pos, Heading: projectile.Heading,
		}
	}
	return frame
}
