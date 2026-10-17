package snapshot

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestLegacyLocalMapMetadata(t *testing.T) {
	encoder := NewEncoder()
	obs := sim.Observation{
		Frame:        sim.FrameView{Map: &sim.MapDef{Version: 1, Partial: true, Walls: []sim.Wall{{ID: 1}}}},
		VisionRadius: 20,
	}
	first := encoder.Encode(1, 0, sim.PhaseOuterRing, 100, obs, nil)
	if first.MapJson == nil || !json.Valid([]byte(first.GetMapJson())) || first.GetVisionRadius() != 20 {
		t.Fatalf("legacy full lost local JSON/radius: %v", first)
	}
	if next := encoder.Encode(2, 0, sim.PhaseOuterRing, 100, obs, nil); next.MapJson != nil || next.GetVisionRadius() != 20 {
		t.Fatalf("legacy unchanged map must be sparse, but radius remains present: %v", next)
	}
	obs.Frame.Map.Walls[0].Min.X = 4
	changed := encoder.Encode(3, 0, sim.PhaseOuterRing, 100, obs, nil)
	if changed.MapJson == nil || changed.GetMapJson() == first.GetMapJson() {
		t.Fatalf("legacy changed map was not serialized: %v", changed)
	}
	encoder.ForceFull()
	if full := encoder.Encode(4, 0, sim.PhaseOuterRing, 100, obs, nil); !full.Full || full.MapJson == nil {
		t.Fatalf("legacy resync lost local JSON: %v", full)
	}
}

func TestCompactMetadataOptInAndTransitions(t *testing.T) {
	encoder := NewEncoder()
	obs := sim.Observation{
		Frame:        sim.FrameView{Map: &sim.MapDef{Version: 1, Partial: true, Walls: []sim.Wall{{ID: 1}}}},
		VisionRadius: 20,
	}
	legacy := encoder.Encode(1, 0, sim.PhaseOuterRing, 100, obs, nil)
	if legacy.MapJson == nil || encoder.lastMap == "" {
		t.Fatal("new encoders must retain legacy local JSON by default")
	}
	encoder.SetCompactMetadata(true)
	if encoder.lastMap != "" {
		t.Fatal("enabling compact metadata must discard the local JSON baseline")
	}
	for tick := uint32(2); tick <= 4; tick++ {
		if tick == 3 {
			obs.VisionRadius = 32
			obs.Frame.Map.Walls[0].Min.X = 4
		}
		if tick == 4 {
			encoder.ForceFull()
		}
		compact := encoder.Encode(tick, 0, sim.PhaseOuterRing, 100, obs, nil)
		if compact.MapJson != nil || encoder.lastMap != "" || compact.VisionRadius == nil || compact.GetVisionRadius() != obs.VisionRadius {
			t.Fatalf("compact metadata must skip local JSON but always carry partial vision: %v", compact)
		}
		if compact.Full != (tick == 4) || compact.BaseTick != tick-1 {
			t.Fatalf("metadata mode must not disturb snapshot continuity: %v", compact)
		}
	}
	encoder.SetCompactMetadata(false)
	legacy = encoder.Encode(5, 0, sim.PhaseOuterRing, 100, obs, nil)
	if legacy.Full || legacy.MapJson == nil || encoder.lastMap != legacy.GetMapJson() {
		t.Fatalf("returning to legacy must restore local JSON on the next delta: %v", legacy)
	}
	encoder.SetCompactMetadata(false)
	if next := encoder.Encode(6, 0, sim.PhaseOuterRing, 100, obs, nil); next.MapJson != nil {
		t.Fatalf("setting the same capability each tick must preserve the JSON baseline: %v", next)
	}
	encoder.SetCompactMetadata(true)
	encoder.SetCompactMetadata(false)
	if next := encoder.Encode(7, 0, sim.PhaseOuterRing, 100, obs, nil); next.MapJson == nil {
		t.Fatalf("toggling without an intervening frame must still reset local JSON: %v", next)
	}

	obs.Frame.Map.Partial = false
	encoder.SetCompactMetadata(true)
	if spec := encoder.Encode(8, 0, sim.PhaseOuterRing, 100, obs, nil); spec.MapJson != nil || spec.VisionRadius != nil || spec.Self != nil {
		t.Fatalf("spectators must not gain local metadata: %v", spec)
	}
}

func TestCompactMetadataPreservesEverySelfAndFullPackState(t *testing.T) {
	encoder := NewEncoder()
	encoder.SetCompactMetadata(true)
	obs := sim.Observation{
		Frame:        sim.FrameView{Map: &sim.MapDef{Version: 1, Partial: true}},
		VisionRadius: 20,
		HealthPacks:  []sim.HealthPackView{{ID: 7, Pos: sim.Vec2{X: 3, Y: 4}, RespawnInS: 1}},
	}
	self := selfIn(1)
	self.InputGeneration = 17
	for tick := uint32(1); tick <= 4; tick++ {
		if tick == 2 {
			obs.HealthPacks[0].Available = true
			obs.HealthPacks[0].RespawnInS = 0
		}
		if tick == 4 {
			encoder.ForceFull()
		}
		delta := encoder.Encode(tick, tick, sim.PhaseOuterRing, 100, obs, self)
		if delta.Self == nil || delta.Self.GetInputGeneration() != 17 || delta.Self.RobotId != 1 || delta.Self.MoveSrc == 0 {
			t.Fatalf("simulation encoder must send self even when unchanged: %v", delta)
		}
		if delta.MapJson != nil || delta.GetVisionRadius() != 20 || delta.Full != (tick == 1 || tick == 4) {
			t.Fatalf("compact full/delta metadata is incorrect: %v", delta)
		}
		if tick == 3 {
			if len(delta.HealthPacks) != 0 {
				t.Fatalf("unchanged respawned pack must be sparse: %v", delta)
			}
			continue
		}
		if len(delta.HealthPacks) != 1 {
			t.Fatalf("new/changed/full pack state missing: %v", delta)
		}
		if tick >= 2 && (!delta.HealthPacks[0].Available || delta.HealthPacks[0].RespawnInS != 0) {
			t.Fatalf("respawn completion must transmit zero and available=true: %v", delta)
		}
	}
}

func TestHealthPackDeltaStamp(t *testing.T) {
	changes := []struct {
		name   string
		mutate func(*sim.HealthPackView)
	}{
		{"x", func(p *sim.HealthPackView) { p.Pos.X = math.Nextafter(p.Pos.X, math.Inf(1)) }},
		{"y", func(p *sim.HealthPackView) { p.Pos.Y = math.Nextafter(p.Pos.Y, math.Inf(1)) }},
		{"available", func(p *sim.HealthPackView) { p.Available = false }},
		{"respawn", func(p *sim.HealthPackView) { p.RespawnInS = 12 }},
	}
	for _, change := range changes {
		t.Run(change.name, func(t *testing.T) {
			encoder := NewEncoder()
			obs := sim.Observation{HealthPacks: []sim.HealthPackView{
				{ID: 7, Pos: sim.Vec2{X: 3, Y: 4}, Available: true},
				{ID: 8, Pos: sim.Vec2{X: 5, Y: 6}, Available: true},
			}}
			first := encoder.Encode(1, 0, sim.PhaseOuterRing, 100, obs, nil)
			if !first.Full || len(first.HealthPacks) != 2 {
				t.Fatalf("full must include every visible pack: %v", first)
			}
			idle := encoder.Encode(2, 0, sim.PhaseOuterRing, 100, obs, nil)
			if len(idle.HealthPacks) != 0 || len(idle.HealthPackGone) != 0 {
				t.Fatalf("idle packs must not be resent: %v", idle)
			}
			change.mutate(&obs.HealthPacks[0])
			delta := encoder.Encode(3, 0, sim.PhaseOuterRing, 100, obs, nil)
			if len(delta.HealthPacks) != 1 || delta.HealthPacks[0].Base.Id != 7 {
				t.Fatalf("only the changed pack must be sent: %v", delta)
			}
			pack, want := delta.HealthPacks[0], obs.HealthPacks[0]
			if pack.Base.Pos.X != want.Pos.X || pack.Base.Pos.Y != want.Pos.Y || pack.Available != want.Available || pack.RespawnInS != want.RespawnInS {
				t.Fatalf("changed pack lost state: %v, want %+v", pack, want)
			}
			if first.HealthPacks[0].Base.Pos.X != 3 || first.HealthPacks[0].Base.Pos.Y != 4 || !first.HealthPacks[0].Available || first.HealthPacks[0].RespawnInS != 0 {
				t.Fatalf("old snapshot aliases the observation: %v", first)
			}
			if next := encoder.Encode(4, 0, sim.PhaseOuterRing, 100, obs, nil); len(next.HealthPacks) != 0 {
				t.Fatalf("changed state did not become the baseline: %v", next)
			}
		})
	}
}

func TestHealthPackVisibilityLifecycleAndResync(t *testing.T) {
	encoder := NewEncoder()
	obs := sim.Observation{HealthPacks: []sim.HealthPackView{{ID: 9}, {ID: 3}}}
	encoder.Encode(1, 0, sim.PhaseOuterRing, 100, obs, nil)
	obs.HealthPacks = nil
	exit := encoder.Encode(2, 0, sim.PhaseOuterRing, 100, obs, nil)
	if !reflect.DeepEqual(exit.HealthPackGone, []uint32{3, 9}) || len(exit.HealthPacks) != 0 {
		t.Fatalf("exit must produce sorted tombstones: %v", exit)
	}
	if idle := encoder.Encode(3, 0, sim.PhaseOuterRing, 100, obs, nil); len(idle.HealthPackGone) != 0 {
		t.Fatalf("tombstones must not repeat: %v", idle)
	}
	// Re-entry with exactly the original state still needs a complete record.
	obs.HealthPacks = []sim.HealthPackView{{ID: 3}, {ID: 11, Available: true}}
	entry := encoder.Encode(4, 0, sim.PhaseOuterRing, 100, obs, nil)
	if len(entry.HealthPacks) != 2 || entry.HealthPacks[0].Base.Id != 3 || entry.HealthPacks[1].Base.Id != 11 || len(entry.HealthPackGone) != 0 {
		t.Fatalf("new and re-entering packs need complete state: %v", entry)
	}
	encoder.ForceFull()
	obs.HealthPacks = obs.HealthPacks[:1]
	full := encoder.Encode(5, 0, sim.PhaseOuterRing, 100, obs, nil)
	if !full.Full || len(full.HealthPacks) != 1 || full.HealthPacks[0].Base.Id != 3 || len(full.HealthPackGone) != 0 {
		t.Fatalf("full must replace the pack baseline without tombstones: %v", full)
	}
	if next := encoder.Encode(6, 0, sim.PhaseOuterRing, 100, obs, nil); len(next.HealthPacks) != 0 || len(next.HealthPackGone) != 0 {
		t.Fatalf("full did not replace the baseline: %v", next)
	}
	obs.HealthPacks = nil
	if next := encoder.Encode(7, 0, sim.PhaseOuterRing, 100, obs, nil); !reflect.DeepEqual(next.HealthPackGone, []uint32{3}) {
		t.Fatalf("post-resync exit lost its tombstone: %v", next)
	}
}
