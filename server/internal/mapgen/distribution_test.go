package mapgen

import (
	"math"
	"sort"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestResourceAngularCoverage(t *testing.T) {
	for seed := uint64(0); seed < 256; seed++ {
		def, err := Generate(seed)
		if err != nil {
			t.Fatal(err)
		}
		for group, count := range []int{16, 12, 6} {
			angles := []float64{}
			for _, p := range def.CorePads {
				if p.Group == group {
					angles = append(angles, angleDeg(p.Pos.X, p.Pos.Y))
				}
			}
			sort.Float64s(angles)
			if len(angles) != count {
				t.Fatalf("seed %d group %d count %d", seed, group, len(angles))
			}
			for i, a := range angles {
				next := angles[(i+1)%count]
				if i == count-1 {
					next += 360
				}
				if next-a > 1.3*360/float64(count) {
					t.Errorf("seed %d group %d empty arc %.2f degrees exceeds %.2f", seed, group, next-a, 1.3*360/float64(count))
				}
			}
			if group == 0 {
				wedges := [8]int{}
				for _, a := range angles {
					wedges[int(a/45)]++
				}
				for k, n := range wedges {
					if n != 2 {
						t.Errorf("seed %d outer wedge %d pads %d, want 2", seed, k, n)
					}
				}
			}
		}
	}
}

func TestStrataClearanceAndSpawns(t *testing.T) {
	for seed := uint64(0); seed < 256; seed++ {
		def, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		counts := [8][2]int{}
		for i, w := range def.Walls {
			center := w.Min.Add(w.Max).Scale(0.5)
			band := 0
			if center.Len() >= 55 {
				band = 1
			}
			counts[int(angleDeg(center.X, center.Y)/45)][band]++
			width, height := w.Max.X-w.Min.X, w.Max.Y-w.Min.Y
			if math.Abs(math.Max(width, height)-4) > 1e-9 || math.Abs(math.Min(width, height)-0.7) > 1e-9 {
				t.Fatalf("seed %d invalid cover size", seed)
			}
			for _, p := range []sim.Vec2{w.Min, w.Max, {X: w.Min.X, Y: w.Max.Y}, {X: w.Max.X, Y: w.Min.Y}} {
				if p.Len() > 79.4 {
					t.Fatalf("seed %d wall outside arena", seed)
				}
			}
			for _, other := range def.Walls[:i] {
				if gap2(wallRect(w), wallRect(other)) < 2.2*2.2-1e-9 {
					t.Fatalf("seed %d insufficient wall gap", seed)
				}
			}
			for _, p := range def.CorePads {
				if nearestDist2(wallRect(w), p.Pos) < 2.5*2.5-1e-9 {
					t.Fatalf("seed %d pad blocked", seed)
				}
			}
			for _, u := range def.Uplinks {
				if nearestDist2(wallRect(w), u.Pos) < 2.2*2.2-1e-9 {
					t.Fatalf("seed %d uplink blocked", seed)
				}
			}
		}
		for k, c := range counts {
			if c != [2]int{4, 2} {
				t.Fatalf("seed %d wedge %d cover counts %v", seed, k, c)
			}
		}
		for i, p := range def.CorePads {
			for _, q := range def.CorePads[:i] {
				gap := 5.0
				if p.Group == 2 {
					gap = 3.5
				}
				if p.Group == q.Group && p.Pos.Sub(q.Pos).Len() < gap {
					t.Fatalf("seed %d pads too close", seed)
				}
			}
			for _, u := range def.Uplinks {
				if p.Pos.Sub(u.Pos).Len() < 3 {
					t.Fatalf("seed %d pad/uplink too close", seed)
				}
			}
		}
		s := sim.NewSim(seed, []uint32{1, 2, 3, 4, 5, 6, 7, 8}, nil)
		if err := s.SetMap(def); err != nil {
			t.Fatalf("seed %d SetMap: %v", seed, err)
		}
		for _, r := range s.Snapshot().Robots {
			if r.Position.Len() > 79.4 {
				t.Fatalf("seed %d initial spawn outside", seed)
			}
		}
		for id := uint32(1); id <= 8; id++ {
			s.Respawn(id)
		}
		s.Tick()
		for _, r := range s.Snapshot().Robots {
			if r.Position.Len() > 79.4 {
				t.Fatalf("seed %d respawn outside", seed)
			}
		}
	}
}

func TestPlayableGridIsCircular(t *testing.T) {
	blocked, n := gridFor(nil, true)
	for _, p := range [][2]float64{{79.9, 0}, {70, 70}, {-70, -70}} {
		if !blocked[gridIndex(p[1])*n+gridIndex(p[0])] {
			t.Errorf("outside arena grid cell %v is free", p)
		}
	}
	if blocked[gridIndex(0)*n+gridIndex(0)] {
		t.Fatal("open center blocked")
	}
	if math.Abs(agentR-0.6) > 1e-12 {
		t.Fatal("radius drift")
	}
}
