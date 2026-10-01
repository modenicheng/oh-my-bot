package snapshot

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// Spectator observations must include every entity regardless of AOI/occlusion
// and must never leak per-robot uplink cooldowns (private state).
func TestBuildSpectatorObservationIncludesAllEntitiesAndStripsPersonalCDs(t *testing.T) {
	// 4 robots mutually far apart: player + 3 bots, none within any vision radius.
	far := 1000.0
	world := World{
		FrameView: sim.FrameView{Tick: 10, TimeLeftS: 400},
		Robots: []sim.RobotView{
			{ID: 1, Pos: sim.Vec2{}, HpX10: 100, EnergyX10: 100},
			{ID: 2, Pos: sim.Vec2{X: far, Y: far}, HpX10: 90, EnergyX10: 90},
			{ID: 3, Pos: sim.Vec2{X: -far, Y: -far}, HpX10: 80, EnergyX10: 80},
			{ID: 4, Pos: sim.Vec2{X: far, Y: -far}, HpX10: 70, EnergyX10: 70},
		},
		Projectiles: []sim.ProjView{{ID: 9, Pos: sim.Vec2{X: far}, Owner: 2}},
		Cores:       []sim.CoreView{{ID: 7, Pos: sim.Vec2{Y: far}, Alive: true}},
		Uplinks: []sim.UplinkView{{
			ID: 5, Pos: sim.Vec2{},
			PersonalCDs: map[uint32]uint32{
				1: 3, 2: 2, 3: 1, 4: 0,
			},
		}},
	}
	// Sanity: ordinary AOI observation for robot 1 sees only itself (partner 0,
	// nil index = no walls) — proving the other entities are out of vision.
	plain := BuildObservation(world, nil, 1, 0)
	if len(plain.Robots) != 1 {
		t.Fatalf("precondition: AOI observation should see only self, got %d robots", len(plain.Robots))
	}

	obs := BuildSpectatorObservation(world)
	if len(obs.Robots) != 4 {
		t.Fatalf("spectator must see all 4 robots, got %d", len(obs.Robots))
	}
	if len(obs.Projectiles) != 1 || len(obs.Cores) != 1 || len(obs.Uplinks) != 1 {
		t.Fatalf("spectator must see all projectiles/cores/uplinks, got %d/%d/%d",
			len(obs.Projectiles), len(obs.Cores), len(obs.Uplinks))
	}
	for _, u := range obs.Uplinks {
		if len(u.PersonalCDs) != 0 {
			t.Fatalf("spectator uplink must strip PersonalCDs, got %v", u.PersonalCDs)
		}
	}
	// Must not mutate the input world.
	for _, u := range world.Uplinks {
		if len(u.PersonalCDs) != 4 {
			t.Fatalf("input world PersonalCDs must stay intact, got %v", u.PersonalCDs)
		}
	}
	if obs.Frame.Tick != 10 {
		t.Fatalf("frame not carried: %+v", obs.Frame)
	}
}

// An empty world must produce a complete empty feed — no (0,0) fallback and no
// partial views.
func TestBuildSpectatorObservationEmptyWorld(t *testing.T) {
	obs := BuildSpectatorObservation(World{FrameView: sim.FrameView{Tick: 3, TimeLeftS: 10}})
	if len(obs.Robots) != 0 || len(obs.Uplinks) != 0 || len(obs.Cores) != 0 || len(obs.Projectiles) != 0 {
		t.Fatalf("expected empty entities, got robots=%d cores=%d uplinks=%d projs=%d",
			len(obs.Robots), len(obs.Cores), len(obs.Uplinks), len(obs.Projectiles))
	}
}

// The spectator encoder with self=nil must emit a full snapshot with all robots
// and no Self field.
func TestSpectatorEncoderFullSnapshotNoSelf(t *testing.T) {
	world := World{
		FrameView: sim.FrameView{Tick: 1, TimeLeftS: 480},
		Robots: []sim.RobotView{
			{ID: 1, Pos: sim.Vec2{}, HpX10: 100, EnergyX10: 100},
			{ID: 2, Pos: sim.Vec2{X: 50, Y: 50}, HpX10: 100, EnergyX10: 100},
		},
	}
	obs := BuildSpectatorObservation(world)
	enc := NewEncoder()
	enc.ForceFull()
	delta := enc.Encode(1, 0, sim.PhaseOuterRing, 480, obs, nil)
	if !delta.Full {
		t.Fatal("first spectator frame must be full")
	}
	if delta.Self != nil {
		t.Fatal("spectator snapshot must not carry Self")
	}
	if len(delta.Robots) != 2 {
		t.Fatalf("spectator full must carry all robots, got %d", len(delta.Robots))
	}
}
