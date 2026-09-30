package mapgen

import (
	"fmt"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

const (
	coverHalfLen      = 2.0
	coverThick        = 0.7
	poiClearance      = 2.5
	wallClearance     = 2.2
	midCoverBatches   = 4
	outerCoverBatches = 2
)

func rectToWall(id uint32, r rect) sim.Wall {
	return sim.Wall{ID: id, Min: sim.Vec2{X: r.MinX, Y: r.MinY}, Max: sim.Vec2{X: r.MaxX, Y: r.MaxY}}
}

// Exact quarter turns keep the AABB multiset invariant under 90° rotation.
func wedgeCenter(p sim.Vec2, k int) sim.Vec2 {
	q := p
	if k%2 == 1 {
		q = rot45(q)
	}
	for i := 0; i < (k>>1)%4; i++ {
		q = rot90(q)
	}
	return q
}

func coverXLong(k int) bool { return k%4 == 0 || k%4 == 3 }

// genWalls replaces long spoke/ring barriers with short cover groups. Each
// radial/angular cell supplies one eight-wedge batch; cells cannot be skipped.
// Candidates are a seeded cyclic traversal of a bounded 7×7 local lattice,
// with small shared radial/angular jitter. Rejection only relocates cover
// inside its assigned cell, never into an already crowded part of the ring.
func genWalls(r *rng, uplinks []sim.UplinkDef, pads []sim.CorePadDef) ([]sim.Wall, error) {
	walls := make([]sim.Wall, 0, 8*(midCoverBatches+outerCoverBatches))
	// Mid: two radial tracks × two angular slots; outer: two tracks in the
	// gaps between spawn sectors. The inner track remains outside the lock.
	cells := [][2]float64{{36, 8}, {36, 37}, {49, 8}, {49, 37}, {60, 22.5}, {75, 22.5}}
	clear := func(q rect) bool {
		for _, p := range []sim.Vec2{{X: q.MinX, Y: q.MinY}, {X: q.MinX, Y: q.MaxY}, {X: q.MaxX, Y: q.MinY}, {X: q.MaxX, Y: q.MaxY}} {
			if p.Len() > outerMaxR-agentR {
				return false
			}
		}
		if nearestDist2(q, sim.Vec2{}) < (coreZoneR+wallClearance)*(coreZoneR+wallClearance) {
			return false
		}
		for k := 0; k < 8; k++ {
			if gap2(q, spawnAreaOf(k)) < poiClearance*poiClearance {
				return false
			}
		}
		for _, p := range pads {
			if nearestDist2(q, p.Pos) < poiClearance*poiClearance {
				return false
			}
		}
		for _, u := range uplinks {
			if nearestDist2(q, u.Pos) < wallClearance*wallClearance {
				return false
			}
		}
		for _, w := range walls {
			if gap2(q, wallRect(w)) < wallClearance*wallClearance {
				return false
			}
		}
		return true
	}
	for cell, c := range cells {
		start := r.intn(49)
		radialJitter, angularJitter := r.rangeF(-0.25, 0.25), r.rangeF(-0.25, 0.25)
		accepted := false
		for attempt := 0; attempt < 49; attempt++ {
			index := (start + attempt) % 49
			radius := c[0] + float64(index/7-3)*0.8 + radialJitter
			angle := c[1] + float64(index%7-3)*1.2 + angularJitter
			proto := slotDirection(angle / 7.5).Scale(radius)
			batch := make([]sim.Wall, 0, 8)
			valid := true
			for k := 0; k < 8; k++ {
				hx, hy := coverHalfLen, coverThick/2
				if !coverXLong(k) {
					hx, hy = hy, hx
				}
				q := rectAt(wedgeCenter(proto, k), hx, hy)
				if !clear(q) {
					valid = false
					break
				}
				for _, w := range batch {
					if gap2(q, wallRect(w)) < wallClearance*wallClearance {
						valid = false
						break
					}
				}
				if !valid {
					break
				}
				batch = append(batch, rectToWall(uint32(len(walls)+len(batch)+1), q))
			}
			if valid && connectivityOK(append(walls, batch...)) {
				walls = append(walls, batch...)
				accepted = true
				break
			}
		}
		if !accepted {
			return nil, fmt.Errorf("no legal cover in stratum %d", cell)
		}
	}
	return walls, nil
}
