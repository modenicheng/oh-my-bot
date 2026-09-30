package sim

import (
	"fmt"
	"math"
	"sort"
)

// Wall is an immutable axis-aligned solid rectangle, in world meters.
// Robot centers collide with its rounded (radius 0.6m) Minkowski boundary.
type Wall struct {
	ID  uint32 `json:"id"`
	Min Vec2   `json:"min"`
	Max Vec2   `json:"max"`
}

const collisionEpsilon = 1e-10

// contact is the earliest obstacle contact found while sweeping a robot-shaped
// (radius 0.6m) point along one segment. normal is the obstacle's free-space
// outward normal at the contact point; zero for an already-inside degenerate.
type contact struct {
	t      float64
	normal Vec2
	hit    bool
}

// sweepContact returns the earliest contact of the robot with any wall, the
// locked core circle or the gen>=2 arena boundary along p + t*d, t in [0,1].
// The contact's free-space normal is chosen from the obstacle hit so callers
// can slide without re-deriving geometry. Entry angle and per-obstacle tie
// order are deterministic; overlapping obstacles resolve to the same normal.
func (s *Sim) sweepContact(p, d Vec2) contact {
	best := contact{t: 1, hit: false}
	consider := func(t float64, n Vec2) {
		if t <= best.t+collisionEpsilon {
			if t < best.t-collisionEpsilon {
				best = contact{t: t, normal: n, hit: true}
				return
			}
			// Same contact from two obstacles: keep the most opposing normal so a
			// crevice corner does not leak displacement along either wall alone.
			into := d.X*n.X + d.Y*n.Y
			if !best.hit || into < d.X*best.normal.X+d.Y*best.normal.Y {
				best.normal = n
			}
			best.t = math.Min(best.t, t)
			best.hit = true
		}
	}
	for _, wall := range s.walls {
		if t, n, ok := sweepWallNormal(p, d, wall); ok {
			consider(t, n)
		}
	}
	if s.zoneLocked() {
		if t, ok := sweepCircle(p, d, Vec2{}, s.mapDef.CoreZone.Radius+RobotRadius); ok {
			consider(t, contactCircleNormal(p.Add(d.Scale(t))))
		}
	}
	if t, ok := s.sweepArena(p, d); ok {
		consider(t, arenaDiskNormal(p.Add(d.Scale(t))))
	}
	return best
}

// contactCircleNormal is the outward normal of a circle centered at the origin.
func contactCircleNormal(p Vec2) Vec2 {
	if n := p.Len(); n > collisionEpsilon {
		return p.Scale(1 / n)
	}
	return Vec2{}
}

// arenaDiskNormal is the inward free-space normal at a boundary point of the
// playable disk: sliding removes motion into the disk's interior boundary.
func arenaDiskNormal(p Vec2) Vec2 { return contactCircleNormal(p).Scale(-1) }

// sweepWallNormal extends sweepWall with the wall's free-space contact normal:
// the face axis the segment crosses, or the rounded-corner radial direction.
// Rounded corners keep sliding smooth; tangential or separating paths miss.
func sweepWallNormal(p, d Vec2, w Wall) (float64, Vec2, bool) {
	if d.X == 0 && d.Y == 0 {
		return 0, Vec2{}, false
	}
	if overlapsWall(p, w) {
		return 0, Vec2{}, true
	}
	// Configuration accepts sub-epsilon overlap. Treat its inward motion as
	// contact now: dividing that spatial error by a small step otherwise makes
	// a negative time outside the sweep's fraction tolerance.
	nearest := Vec2{max(w.Min.X, min(w.Max.X, p.X)), max(w.Min.Y, min(w.Max.Y, p.Y))}
	offset := p.Sub(nearest)
	if dist := offset.Len(); dist > 0 && dist <= RobotRadius && offset.X*d.X+offset.Y*d.Y < 0 {
		return 0, offset.Scale(1 / dist), true
	}
	bestT, bestN, hit := 1.0, Vec2{}, false
	accept := func(t float64, n Vec2) {
		if t >= -collisionEpsilon && t <= bestT+collisionEpsilon {
			if t < bestT-collisionEpsilon {
				bestT, bestN, hit = max(0, t), n, true
				return
			}
			if !hit || n.Len() <= bestN.Len()+collisionEpsilon {
				bestN = n
			}
			bestT = math.Min(bestT, math.Max(0, t))
			hit = true
		}
	}
	vertical := func(x float64, n Vec2) {
		t := (x - p.X) / d.X
		y := p.Y + t*d.Y
		if y >= w.Min.Y-collisionEpsilon && y <= w.Max.Y+collisionEpsilon {
			accept(t, n)
		}
	}
	horizontal := func(y float64, n Vec2) {
		t := (y - p.Y) / d.Y
		x := p.X + t*d.X
		if x >= w.Min.X-collisionEpsilon && x <= w.Max.X+collisionEpsilon {
			accept(t, n)
		}
	}
	if d.X > 0 {
		vertical(w.Min.X-RobotRadius, Vec2{X: -1})
	}
	if d.X < 0 {
		vertical(w.Max.X+RobotRadius, Vec2{X: 1})
	}
	if d.Y > 0 {
		horizontal(w.Min.Y-RobotRadius, Vec2{Y: -1})
	}
	if d.Y < 0 {
		horizontal(w.Max.Y+RobotRadius, Vec2{Y: 1})
	}
	a := d.X*d.X + d.Y*d.Y
	for _, corner := range [...]Vec2{w.Min, {X: w.Min.X, Y: w.Max.Y}, {X: w.Max.X, Y: w.Min.Y}, w.Max} {
		x, y := p.X-corner.X, p.Y-corner.Y
		dot := x*d.X + y*d.Y
		if dot >= 0 {
			continue
		}
		c := x*x + y*y - RobotRadius*RobotRadius
		disc := dot*dot - a*c
		if disc <= 0 {
			continue
		} // A tangent never enters the solid.
		// Stable small root: avoids cancellation near an existing contact.
		t := c / (-dot + math.Sqrt(disc))
		contactP := Vec2{p.X + t*d.X, p.Y + t*d.Y}
		if (corner.X == w.Min.X && contactP.X > corner.X+collisionEpsilon) ||
			(corner.X == w.Max.X && contactP.X < corner.X-collisionEpsilon) ||
			(corner.Y == w.Min.Y && contactP.Y > corner.Y+collisionEpsilon) ||
			(corner.Y == w.Max.Y && contactP.Y < corner.Y-collisionEpsilon) {
			continue
		}
		n := Vec2{X: contactP.X - corner.X, Y: contactP.Y - corner.Y}
		if n.Len() <= collisionEpsilon {
			continue
		}
		accept(t, n.Scale(1/n.Len()))
	}
	return bestT, bestN, hit
}

// SetWalls replaces the map before tick 1, without retaining caller-owned slices.
// Invalid geometry/IDs and walls covering a spawn are rejected atomically.
func (s *Sim) SetWalls(walls []Wall) error {
	if s.tick != 0 {
		return fmt.Errorf("sim: cannot change walls after match start")
	}
	next := append([]Wall{}, walls...)
	sort.Slice(next, func(i, j int) bool { return next[i].ID < next[j].ID })
	for i, w := range next {
		if w.ID == 0 || (i > 0 && next[i-1].ID == w.ID) ||
			!w.Min.finite() || !w.Max.finite() || w.Min.X >= w.Max.X || w.Min.Y >= w.Max.Y {
			return fmt.Errorf("sim: invalid wall %d", w.ID)
		}
		for _, r := range s.robots {
			if overlapsWall(r.Position, w) || overlapsWall(r.SpawnPosition, w) {
				return fmt.Errorf("sim: wall %d overlaps robot %d spawn", w.ID, r.ID)
			}
		}
	}
	s.walls = next
	if s.mapDef != nil {
		s.mapDef = cloneMap(s.mapDef)
		s.mapDef.Walls = append([]Wall{}, next...)
	}
	s.publishView()
	return nil
}

func overlapsWall(p Vec2, w Wall) bool {
	x := max(w.Min.X, min(w.Max.X, p.X))
	y := max(w.Min.Y, min(w.Max.Y, p.Y))
	return math.Hypot(p.X-x, p.Y-y) < RobotRadius-collisionEpsilon
}

// sweepWall returns the earliest inward contact along p + t*d, t in [0,1].
// Testing faces plus corner circles avoids both tunneling and the square-corner
// false positives of a radius-expanded AABB. Tangency/moving away is not a hit.
func sweepWall(p, d Vec2, w Wall) (float64, bool) {
	t, _, hit := sweepWallNormal(p, d, w)
	return t, hit
}
