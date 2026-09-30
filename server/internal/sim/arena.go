package sim

import "math"

const arenaCenterRadius = 80.0 - RobotRadius

// MapDef is persisted in initial states and checkpoints. Gen1 (including old
// definitions without a generator version) keeps its unbounded replay physics.
func (s *Sim) boundedArena() bool { return s.mapDef != nil && s.mapDef.GeneratorVer >= 2 }

func (s *Sim) insideArena(p Vec2) bool {
	return !s.boundedArena() || p.Len() <= arenaCenterRadius
}

// sweepArena returns the exit from the playable disk, the opposite root from
// sweepCircle's entrance into a solid. A chord may move inward then exit again.
// The caller treats the boundary as a wall: slide along it or stop, never leave.
func (s *Sim) sweepArena(p, d Vec2) (float64, bool) {
	if !s.boundedArena() {
		return 0, false
	}
	end := p.Add(d)
	if end.Len() <= arenaCenterRadius {
		return 0, false
	}
	a := d.X*d.X + d.Y*d.Y
	if a == 0 {
		return 0, false
	}
	dot := p.X*d.X + p.Y*d.Y
	c := p.X*p.X + p.Y*p.Y - arenaCenterRadius*arenaCenterRadius
	root := math.Sqrt(math.Max(0, dot*dot-a*c))
	var t float64
	if dot >= 0 {
		if root+dot == 0 {
			return 0, true
		}
		t = -c / (root + dot)
	} else {
		t = (root - dot) / a
	}
	return math.Max(0, math.Min(1, t)), true
}

// containInArena projects a point into the playable disk. The mover sweeps
// projected destinations before using them; the final correction only handles
// rounding overshoot after that sweep.
func (s *Sim) containInArena(p Vec2) Vec2 {
	if s.boundedArena() {
		if n := p.Len(); n > arenaCenterRadius {
			return p.Scale(math.Nextafter(arenaCenterRadius, 0) / n)
		}
	}
	return p
}
