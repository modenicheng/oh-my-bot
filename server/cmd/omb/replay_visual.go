package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"google.golang.org/protobuf/encoding/protojson"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

const replayVisualSampleEvery uint32 = 6

// writeVisualReplay projects an authoritative event log into the browser form:
// original header/start/events plus compact deterministic world samples.
//
// Visual rows use the explicit named-field v2 shape (audit X-6):
// {"type":"visual","v":2,"tick":N,"phase":P,"robots":[{id,pos:{x,y},...}],...}
// — no more positional compact arrays whose meaning lives only in reader code.
// v1 (positional) rows are only *read* by the client for saved exports.
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
	scanner.Buffer(make([]byte, 4096), sim.MaxLogLine)
	for scanner.Scan() {
		line := scanner.Bytes()
		var header struct {
			SchemaVersion *int   `json:"schema_version"`
			Type          string `json:"type"`
		}
		if err := json.Unmarshal(line, &header); err != nil {
			return fmt.Errorf("replay visual record: %w", err)
		}
		keep := header.Type == sim.RecordTypeDiskName(sim.RecordMatchStart) ||
			header.Type == sim.RecordTypeDiskName(sim.RecordEvent)
		if header.SchemaVersion != nil || keep {
			if _, err := w.Write(append(append([]byte{}, line...), '\n')); err != nil {
				return err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}

	// EmitUnpopulated：visual 行全字段自描述（pos/tick/heading 为 0 也显式落盘），
	// 消除「缺键含义靠读侧约定」的旧数组二义性。
	marshal := protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true}
	for _, frame := range frames {
		body, err := marshal.Marshal(visualFrameProto(frame))
		if err != nil {
			return err
		}
		var record map[string]json.RawMessage
		if err := json.Unmarshal(body, &record); err != nil {
			return err
		}
		delete(record, "v") // envelope owns the version key
		if record["type"], err = json.Marshal(sim.RecordTypeDiskName(sim.RecordVisual)); err != nil {
			return err
		}
		if record["v"], err = json.Marshal(int(ombv1.ReplayVisualVersion_REPLAY_VISUAL_V2)); err != nil {
			return err
		}
		line, err := json.Marshal(record)
		if err != nil {
			return err
		}
		if _, err := w.Write(append(line, '\n')); err != nil {
			return err
		}
	}
	return nil
}

// visualFrameProto 把 sim 的紧凑采样转成权威 ReplayVisualFrame 消息。
// hp/energy 保持游戏单位（与 v1 历史行一致），非线上协议的 x10 定点。
func visualFrameProto(frame sim.ReplayVisualFrame) *ombv1.ReplayVisualFrame {
	out := &ombv1.ReplayVisualFrame{
		V:           ombv1.ReplayVisualVersion_REPLAY_VISUAL_V2,
		Tick:        frame.Tick,
		Phase:       ombv1.Phase(frame.Phase),
		Robots:      make([]*ombv1.ReplayVisualRobot, len(frame.Robots)),
		Projectiles: make([]*ombv1.ReplayVisualProjectile, len(frame.Projectiles)),
	}
	for i, robot := range frame.Robots {
		out.Robots[i] = &ombv1.ReplayVisualRobot{
			Id: robot.ID, Pos: &ombv1.Vec2{X: robot.Pos.X, Y: robot.Pos.Y}, Heading: robot.Heading,
			Hp: robot.HP, Energy: robot.Energy, Alive: robot.Alive, Invulnerable: robot.Invulnerable,
		}
	}
	for i, projectile := range frame.Projectiles {
		out.Projectiles[i] = &ombv1.ReplayVisualProjectile{
			Id: projectile.ID, Owner: projectile.Owner,
			Pos: &ombv1.Vec2{X: projectile.Pos.X, Y: projectile.Pos.Y}, Heading: projectile.Heading,
		}
	}
	return out
}
