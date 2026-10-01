package mapgen

import (
	"fmt"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

const (
	coverThick      = 0.7
	poiClearance    = 2.5
	wallClearance   = 2.2
	innerCoverCells = 1
	midCoverCells   = 4
	outerCoverCells = 2
)

type coverCell struct {
	radius, angle      float64
	halfLen, halfThick float64
}

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

// genWalls lays out deterministic grid-sized cover cells. Each cell is stamped
// across eight wedges, so irregularity comes from the selected footprint and
// cell position while the arena remains fair under 45-degree symmetry.

// Candidates are a seeded cyclic traversal of a bounded 7×7 local lattice,
// with small shared radial/angular jitter. Rejection only relocates cover
// inside its assigned cell, never into an already crowded part of the ring.
func genWalls(r *rng, uplinks []sim.UplinkDef, pads []sim.CorePadDef) ([]sim.Wall, error) {
	walls := make([]sim.Wall, 0, 8*(innerCoverCells+midCoverCells+outerCoverCells)*2)
	// Every cell is snapped to a 7.5-degree direction slot and a half-meter
	// radial lattice. The alternating footprints create L/缺角-like cover
	// silhouettes without changing the AABB collision contract.
	cells := []coverCell{
		{20, 0, 1.0, coverThick / 2}, // inner ring: short cover inside the unlocked core
		{36, 8, 2.0, coverThick / 2}, {36, 37, 2.0, coverThick / 2},
		{49, 8, 2.0, coverThick / 2}, {49, 37, 2.0, coverThick / 2},
		{60, 22.5, 2.0, coverThick / 2}, {75, 22.5, 2.0, coverThick / 2},
	}
	clear := func(q rect, allowCore bool) int {
		for _, p := range []sim.Vec2{{X: q.MinX, Y: q.MinY}, {X: q.MinX, Y: q.MaxY}, {X: q.MaxX, Y: q.MinY}, {X: q.MaxX, Y: q.MaxY}} {
			if p.Len() > outerMaxR-agentR {
				return 1
			}
		}
		if !allowCore && nearestDist2(q, sim.Vec2{}) < (coreZoneR+wallClearance)*(coreZoneR+wallClearance) {
			return 2
		}
		for k := 0; k < 8; k++ {
			if gap2(q, spawnAreaOf(k)) < poiClearance*poiClearance {
				return 3
			}
		}
		for _, p := range pads {
			if nearestDist2(q, p.Pos) < poiClearance*poiClearance {
				return 4
			}
		}
		for _, u := range uplinks {
			if nearestDist2(q, u.Pos) < wallClearance*wallClearance {
				return 5
			}
		}
		for _, w := range walls {
			if gap2(q, wallRect(w)) < wallClearance*wallClearance {
				return 6
			}
		}
		return 0
	}
	for cell, c := range cells {
		start := r.intn(49)
		radialJitter, angularJitter := r.rangeF(-0.25, 0.25), r.rangeF(-0.25, 0.25)
		accepted := false
		clearReject, batchReject, connectivityReject := 0, 0, 0
		for attempt := 0; attempt < 49; attempt++ {
			index := (start + attempt) % 49
			radius := c.radius + float64(index/7-3)*0.5 + radialJitter
			angle := c.angle + float64(index%7-3)*1.2 + angularJitter
			if cell == 0 {
				// The inner stratum is inside the lock while closed and becomes
				// useful cover when CORE_OPEN. Search a deterministic 1m grid.
				radius = 19 + float64(index/7)*0.5 + radialJitter
				angle = float64(index%7)*7.5 + angularJitter
			} else {
				radius = c.radius + float64(index/7-3)*0.8 + radialJitter
				angle = c.angle + float64(index%7-3)*1.2 + angularJitter
			}
			proto := slotDirection(angle / 7.5).Scale(radius)
			batch := make([]sim.Wall, 0, 8)
			valid := true
			for k := 0; k < 8; k++ {
				hx, hy := c.halfLen, c.halfThick
				if !coverXLong(k) {
					hx, hy = hy, hx
				}
				q := rectAt(wedgeCenter(proto, k), hx, hy)
				if clear(q, cell == 0) != 0 {
					clearReject++
					valid = false
					break
				}
				for _, w := range batch {
					if gap2(q, wallRect(w)) < wallClearance*wallClearance {
						batchReject++
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
			if valid {
				connectivityReject++
			}
		}
		if !accepted {
			return nil, fmt.Errorf("no legal cover in stratum %d (clear=%d batch=%d connectivity=%d)", cell, clearReject, batchReject, connectivityReject)
		}
	}
	return walls, nil
}
