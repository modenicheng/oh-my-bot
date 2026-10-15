package main

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestVisualReplayExportsRandomResources(t *testing.T) {
	frame := visualFrameProto(sim.ReplayVisualFrame{Resources: &sim.ReplayVisualResources{
		Cores:      []sim.CoreView{{ID: 10, Pos: sim.Vec2{X: 50, Y: 2}, Value: 10, Alive: true}, {ID: 11, Value: 25}},
		PointDrops: []sim.PointDropView{{ID: 12, Pos: sim.Vec2{X: 51, Y: 5}, Points: 1}},
	}})
	if frame.Resources == nil || len(frame.Resources.Cores) != 1 || len(frame.Resources.PointDrops) != 1 {
		t.Fatal("visual export lost resources or retained a dead core")
	}
	core, drop := frame.Resources.Cores[0], frame.Resources.PointDrops[0]
	if core.Base.Id != 10 || core.Base.Pos.X != 50 || core.Base.Pos.Y != 2 || core.Value != 10 ||
		drop.Base.Id != 12 || drop.Base.Pos.X != 51 || drop.Base.Pos.Y != 5 || drop.Points != 1 {
		t.Fatal("visual export changed resource state")
	}
	if visualFrameProto(sim.ReplayVisualFrame{}).Resources != nil {
		t.Fatal("legacy visual frame acquired new resource semantics")
	}
}
