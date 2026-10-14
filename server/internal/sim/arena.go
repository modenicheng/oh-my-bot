package sim

import "math"

// legacyArenaDiskR 是 gen<8 地图的历史竞技场半径（80m 圆盘）。
const legacyArenaDiskR = 80.0

// arenaDiskRadiusOf 返回地图的竞技场圆盘半径（外边界，非中心可达半径）。
// gen>=8 的地图显式携带 ArenaRadius；更早的定义没有该字段，沿用 80m。
func arenaDiskRadiusOf(m *MapDef) float64 {
	if m != nil && m.ArenaRadius > 0 {
		return m.ArenaRadius
	}
	return legacyArenaDiskR
}

// arenaCenterRadius 是机器人中心可达半径：圆盘半径减机器人半径。
func arenaCenterRadiusOf(m *MapDef) float64 { return arenaDiskRadiusOf(m) - RobotRadius }
func (s *Sim) arenaCenterRadius() float64   { return arenaCenterRadiusOf(s.mapDef) }

// MapDef is persisted in initial states and checkpoints. Gen1 (including old
// definitions without a generator version) keeps its unbounded replay physics.
func (s *Sim) boundedArena() bool { return s.mapDef != nil && s.mapDef.GeneratorVer >= 2 }

func (s *Sim) insideArena(p Vec2) bool {
	return !s.boundedArena() || p.Len() <= s.arenaCenterRadius()
}

// sweepArena returns the exit from the playable disk, the opposite root from
// sweepCircle's entrance into a solid. A chord may move inward then exit again.
// The caller treats the boundary as a wall: slide along it or stop, never leave.
func (s *Sim) sweepArena(p, d Vec2) (float64, bool) {
	if !s.boundedArena() {
		return 0, false
	}
	end := p.Add(d)
	if end.Len() <= s.arenaCenterRadius() {
		return 0, false
	}
	a := d.X*d.X + d.Y*d.Y
	if a == 0 {
		return 0, false
	}
	dot := p.X*d.X + p.Y*d.Y
	r := s.arenaCenterRadius()
	c := p.X*p.X + p.Y*p.Y - r*r
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
		if n := p.Len(); n > s.arenaCenterRadius() {
			return p.Scale(math.Nextafter(s.arenaCenterRadius(), 0) / n)
		}
	}
	return p
}
