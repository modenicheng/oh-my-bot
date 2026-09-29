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
	if d.X == 0 && d.Y == 0 {
		return 0, false
	}
	if overlapsWall(p, w) {
		return 0, true
	}
	first, hit := 1.0, false
	accept := func(t float64) {
		if t >= -collisionEpsilon && t <= first+collisionEpsilon {
			first, hit = max(0, min(first, t)), true
		}
	}
	vertical := func(x float64) {
		t := (x - p.X) / d.X
		y := p.Y + t*d.Y
		if y >= w.Min.Y-collisionEpsilon && y <= w.Max.Y+collisionEpsilon {
			accept(t)
		}
	}
	horizontal := func(y float64) {
		t := (y - p.Y) / d.Y
		x := p.X + t*d.X
		if x >= w.Min.X-collisionEpsilon && x <= w.Max.X+collisionEpsilon {
			accept(t)
		}
	}
	if d.X > 0 {
		vertical(w.Min.X - RobotRadius)
	}
	if d.X < 0 {
		vertical(w.Max.X + RobotRadius)
	}
	if d.Y > 0 {
		horizontal(w.Min.Y - RobotRadius)
	}
	if d.Y < 0 {
		horizontal(w.Max.Y + RobotRadius)
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
		contact := Vec2{p.X + t*d.X, p.Y + t*d.Y}
		if (corner.X == w.Min.X && contact.X > corner.X+collisionEpsilon) ||
			(corner.X == w.Max.X && contact.X < corner.X-collisionEpsilon) ||
			(corner.Y == w.Min.Y && contact.Y > corner.Y+collisionEpsilon) ||
			(corner.Y == w.Max.Y && contact.Y < corner.Y-collisionEpsilon) {
			continue
		}
		accept(t)
	}
	return first, hit
}
