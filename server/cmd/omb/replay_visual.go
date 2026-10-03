package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

const replayVisualSampleEvery uint32 = 6

type replayVisualRecord struct {
	Type        string       `json:"type"`
	Tick        uint32       `json:"tick"`
	Phase       sim.Phase    `json:"phase"`
	Robots      [][8]float64 `json:"robots"`
	Projectiles [][5]float64 `json:"projectiles"`
}

// writeVisualReplay projects an authoritative event log into the browser form:
// original header/start/events plus compact deterministic world samples.
func writeVisualReplay(w io.Writer, r io.Reader) error {
	var complete bytes.Buffer
	if err := copyCompleteRecords(&complete, r); err != nil {
		return err
	}
	data := complete.Bytes()
	frames, err := sim.ReplayVisualFrames(bytes.NewReader(data), replayVisualSampleEvery)
	if err != nil {
		return err
	}

	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 4096), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		var header struct {
			SchemaVersion *int   `json:"schema_version"`
			Type          string `json:"type"`
		}
		if err := json.Unmarshal(line, &header); err != nil {
			return fmt.Errorf("replay visual record: %w", err)
		}
		if header.SchemaVersion != nil || header.Type == "match_start" || header.Type == "event" {
			if _, err := w.Write(append(append([]byte{}, line...), '\n')); err != nil {
				return err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}

	encoder := json.NewEncoder(w)
	for _, frame := range frames {
		record := replayVisualRecord{Type: "visual", Tick: frame.Tick, Phase: frame.Phase, Robots: make([][8]float64, len(frame.Robots)), Projectiles: make([][5]float64, len(frame.Projectiles))}
		for i, robot := range frame.Robots {
			alive, invulnerable := 0.0, 0.0
			if robot.Alive {
				alive = 1
			}
			if robot.Invulnerable {
				invulnerable = 1
			}
			record.Robots[i] = [8]float64{float64(robot.ID), robot.Pos.X, robot.Pos.Y, robot.Heading, robot.HP, robot.Energy, alive, invulnerable}
		}
		for i, projectile := range frame.Projectiles {
			record.Projectiles[i] = [5]float64{float64(projectile.ID), float64(projectile.Owner), projectile.Pos.X, projectile.Pos.Y, projectile.Heading}
		}
		if err := encoder.Encode(record); err != nil {
			return err
		}
	}
	return nil
}
