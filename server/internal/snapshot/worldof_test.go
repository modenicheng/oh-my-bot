package snapshot

import (
	"reflect"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// WorldOf 是 glue→snapshot 的唯一 World 组装点：字段逐一对照，防止新增
// WorldView 字段后遗漏拷贝（AI 感知、脚本 tick、观战全走这一条路）。
func TestWorldOfCopiesAllFields(t *testing.T) {
	wv := sim.WorldView{
		Frame:       sim.FrameView{Tick: 42, Phase: sim.PhaseCoreOpen, TimeLeftS: 137, Map: &sim.MapDef{Seed: 7}},
		Robots:      []sim.RobotView{{ID: 1, Pos: sim.Vec2{X: 1, Y: 2}, Nick: "a"}},
		Projectiles: []sim.ProjView{{ID: 9, Owner: 1}},
		Cores:       []sim.CoreView{{ID: 3, Alive: true}},
		HealthPacks: []sim.HealthPackView{{ID: 4, Available: true}},
		Uplinks:     []sim.UplinkView{{ID: 5, Active: true}},
		Controls:    map[uint32]sim.ArbitratedInput{1: {MoveSrc: 'H'}},
		PulseScans:  map[uint32]bool{1: true},
		AckSeqs:     map[uint32]uint32{1: 11},
	}
	w := WorldOf(wv)
	if w.FrameView != wv.Frame {
		t.Fatalf("FrameView = %+v, want %+v", w.FrameView, wv.Frame)
	}
	if !reflect.DeepEqual(w.Robots, wv.Robots) || !reflect.DeepEqual(w.Projectiles, wv.Projectiles) ||
		!reflect.DeepEqual(w.Cores, wv.Cores) || !reflect.DeepEqual(w.HealthPacks, wv.HealthPacks) ||
		!reflect.DeepEqual(w.Uplinks, wv.Uplinks) {
		t.Fatalf("WorldOf entity slices drifted: %+v", w)
	}
	// 感知裁剪输入必须可用：等价于手工字面量组装。
	manual := World{
		FrameView:   wv.Frame,
		Robots:      wv.Robots,
		Projectiles: wv.Projectiles,
		Cores:       wv.Cores,
		HealthPacks: wv.HealthPacks,
		Uplinks:     wv.Uplinks,
	}
	if !reflect.DeepEqual(w, manual) {
		t.Fatal("WorldOf result differs from literal assembly")
	}
	obs := BuildObservation(w, nil, 1, 0, 20)
	if len(obs.Robots) != 1 || obs.Frame.Tick != 42 {
		t.Fatalf("BuildObservation over WorldOf = %+v", obs)
	}
}
