package sim

import (
	"fmt"
	"math"
	"sort"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func cloneMap(m *MapDef) *MapDef {
	if m == nil {
		return nil
	}
	out := *m
	out.Walls = append([]Wall{}, m.Walls...)
	out.Uplinks = append([]UplinkDef{}, m.Uplinks...)
	out.CorePads = append([]CorePadDef{}, m.CorePads...)
	out.HealthPacks = append([]HealthPackDef{}, m.HealthPacks...)
	out.CoreRules.GroupWeights = make(map[Phase][]float64, len(m.CoreRules.GroupWeights))
	for phase, weights := range m.CoreRules.GroupWeights {
		out.CoreRules.GroupWeights[phase] = append([]float64{}, weights...)
	}
	return &out
}

// SetMap configures authoritative geometry before tick one. Validation and
// spawn selection are transactional; caller mutation cannot affect the match.
func (s *Sim) SetMap(def *MapDef) error {
	if s.tick != 0 || def == nil {
		return fmt.Errorf("sim: map required before match start")
	}
	m := cloneMap(def)
	sort.Slice(m.Walls, func(i, j int) bool { return m.Walls[i].ID < m.Walls[j].ID })
	sort.Slice(m.Uplinks, func(i, j int) bool { return m.Uplinks[i].ID < m.Uplinks[j].ID })
	sort.Slice(m.CorePads, func(i, j int) bool { return m.CorePads[i].ID < m.CorePads[j].ID })
	sort.Slice(m.HealthPacks, func(i, j int) bool { return m.HealthPacks[i].ID < m.HealthPacks[j].ID })
	validPhase := func(p Phase) bool { return p == PhaseOuterRing || p == PhaseCoreOpen }
	if !finite(m.CoreZone.Radius) || m.CoreZone.Radius < 0 || (m.CoreZone.Radius > 0 && !validPhase(m.CoreZone.UnlockPhase)) {
		return fmt.Errorf("sim: invalid core zone")
	}
	for _, sector := range m.Sectors {
		r := sector.SpawnArea
		if !r.Min.finite() || !r.Max.finite() || !sector.Center.finite() || r.Min.X > r.Max.X || r.Min.Y > r.Max.Y {
			return fmt.Errorf("sim: invalid spawn sector %d", sector.ID)
		}
	}
	for i, w := range m.Walls {
		if w.ID == 0 || (i > 0 && m.Walls[i-1].ID == w.ID) || !w.Min.finite() || !w.Max.finite() || w.Min.X >= w.Max.X || w.Min.Y >= w.Max.Y {
			return fmt.Errorf("sim: invalid wall %d", w.ID)
		}
	}
	for i, u := range m.Uplinks {
		if u.ID == 0 || (i > 0 && m.Uplinks[i-1].ID == u.ID) || !u.Pos.finite() || !finite(u.InteractR) || u.InteractR <= 0 || !validPhase(u.ActivePhase) {
			return fmt.Errorf("sim: invalid uplink %d", u.ID)
		}
	}
	for i, h := range m.HealthPacks {
		if h.ID == 0 || (i > 0 && m.HealthPacks[i-1].ID == h.ID) || !h.Pos.finite() || h.Pos.Len() < m.CoreZone.Radius+RobotRadius {
			return fmt.Errorf("sim: invalid health pack %d", h.ID)
		}
		for _, wall := range m.Walls {
			if overlapsWall(h.Pos, wall) {
				return fmt.Errorf("sim: health pack %d overlaps wall %d", h.ID, wall.ID)
			}
		}
	}
	if len(m.CorePads) > 0 && (m.CoreRules.PeriodTicks <= 0 || uint64(m.CoreRules.PeriodTicks) > math.MaxUint32) {
		return fmt.Errorf("sim: invalid core period")
	}
	for phase, weights := range m.CoreRules.GroupWeights {
		if !validPhase(phase) {
			return fmt.Errorf("sim: invalid weight phase")
		}
		total := 0.0
		for _, w := range weights {
			if !finite(w) || w < 0 {
				return fmt.Errorf("sim: invalid core weight")
			}
			total += w
		}
		if !finite(total) {
			return fmt.Errorf("sim: core weight sum overflows")
		}
	}
	for i, p := range m.CorePads {
		if p.ID == 0 || (i > 0 && m.CorePads[i-1].ID == p.ID) || !p.Pos.finite() || p.Group < 0 || (p.Value != 10 && p.Value != 25) {
			return fmt.Errorf("sim: invalid core pad %d", p.ID)
		}
		for _, phase := range []Phase{PhaseOuterRing, PhaseCoreOpen} {
			if p.Group >= len(m.CoreRules.GroupWeights[phase]) {
				return fmt.Errorf("sim: missing core group %d in phase %d", p.Group, phase)
			}
		}
	}
	candidate := &Sim{mapDef: m, walls: m.Walls, phase: s.phase, rng: s.rng}
	positions := make([]Vec2, len(s.robots))
	for i, r := range s.robots {
		p, ok := candidate.spawnInSector(r.Sector)
		if !ok {
			return fmt.Errorf("sim: no legal spawn in sector %d", r.Sector)
		}
		positions[i] = p
	}
	s.mapDef, s.walls, s.rng = m, m.Walls, candidate.rng
	s.uplinks = make([]Uplink, len(m.Uplinks))
	s.cores = make([]CoreView, len(m.CorePads))
	s.healthPacks = make([]HealthPack, len(m.HealthPacks))
	for i, p := range m.CorePads {
		s.cores[i] = CoreView{ID: p.ID, Pos: p.Pos, Value: p.Value}
		s.reserveID(p.ID)
	}
	for i, h := range m.HealthPacks {
		s.healthPacks[i] = HealthPack{ID: h.ID, Pos: h.Pos}
		s.reserveID(h.ID)
	}
	for i, u := range m.Uplinks {
		s.uplinks[i] = Uplink{Def: u, ReadyAt: make(map[uint32]uint32)}
		s.reserveID(u.ID)
	}
	for _, w := range m.Walls {
		s.reserveID(w.ID)
	}
	for i := range s.robots {
		s.robots[i].Position, s.robots[i].SpawnPosition = positions[i], positions[i]
	}
	s.publishView()
	return nil
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func (s *Sim) reserveID(id uint32) {
	if s.nextProjectile != 0 && id >= s.nextProjectile {
		s.nextProjectile = id + 1
	}
}
func (s *Sim) zoneLocked() bool {
	return s.mapDef != nil && s.mapDef.CoreZone.Radius > 0 && Phase(s.phase) < s.mapDef.CoreZone.UnlockPhase
}
func (s *Sim) freePosition(p Vec2) bool {
	if !s.insideArena(p) {
		return false
	}
	if s.zoneLocked() && p.Len() < s.mapDef.CoreZone.Radius+RobotRadius-collisionEpsilon {
		return false
	}
	for _, w := range s.walls {
		if overlapsWall(p, w) {
			return false
		}
	}
	return true
}
func (s *Sim) spawnInSector(sector uint32) (Vec2, bool) {
	if s.mapDef == nil || sector >= 8 {
		return Vec2{}, false
	}
	area := s.mapDef.Sectors[sector].SpawnArea
	for i := 0; i < 128; i++ {
		p := Vec2{area.Min.X + s.randomUnit()*(area.Max.X-area.Min.X), area.Min.Y + s.randomUnit()*(area.Max.Y-area.Min.Y)}
		if s.freePosition(p) {
			return p, true
		}
	}
	// Bounded deterministic fallback; occupied robot positions are allowed because
	// the soft solver pushes partners and opponents apart on the same tick.
	for x := 0; x <= 16; x++ {
		for y := 0; y <= 16; y++ {
			p := Vec2{area.Min.X + float64(x)/16*(area.Max.X-area.Min.X), area.Min.Y + float64(y)/16*(area.Max.Y-area.Min.Y)}
			if s.freePosition(p) {
				return p, true
			}
		}
	}
	return Vec2{}, false
}

func (s *Sim) uplinkActive(u *Uplink) bool {
	return Phase(s.phase) >= u.Def.ActivePhase && (!u.Def.Main || Phase(s.phase) >= PhaseCoreOpen)
}
func (s *Sim) canHack(r *Robot, u *Uplink) bool {
	return r.State == Alive && r.Control.Output.Interact && !r.Control.Output.Fire && r.Position.Sub(u.Def.Pos).Len() <= u.Def.InteractR && s.tick >= u.ReadyAt[r.ID]
}
func (s *Sim) stepUplinks() {
	busy := make(map[uint32]bool)
	for i := range s.uplinks {
		u := &s.uplinks[i]
		for id, until := range u.ReadyAt {
			if until <= s.tick {
				delete(u.ReadyAt, id)
			}
		}
		if !s.uplinkActive(u) {
			u.HackingID, u.ProgressTicks = 0, 0
			continue
		}
		if u.HackingID != 0 {
			idx, ok := s.index[u.HackingID]
			if !ok || !s.canHack(&s.robots[idx], u) || busy[u.HackingID] {
				u.HackingID, u.ProgressTicks = 0, 0
			}
		}
		if u.HackingID == 0 {
			for j := range s.robots {
				r := &s.robots[j]
				if !busy[r.ID] && s.canHack(r, u) {
					u.HackingID = r.ID
					break
				}
			}
		}
		if u.HackingID == 0 {
			continue
		}
		busy[u.HackingID] = true
		u.ProgressTicks++
		if u.ProgressTicks == HackDuration {
			value := int32(15)
			if u.Def.Main {
				value = 25
			}
			s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_UplinkHack{UplinkHack: &ombv1.EvUplinkHack{By: u.HackingID, UplinkId: u.Def.ID, Value: value}}})
			u.ReadyAt[u.HackingID] = s.tick + HackCooldown
			u.HackingID, u.ProgressTicks = 0, 0
		}
	}
}

const (
	HealthPackHeal     = 30.0
	HealthPackCooldown = 30 * TickRate

	// CoreRadius/HealthPackRadius are pickup body radii in world meters. Pickup
	// is circle overlap swept along the whole per-tick motion path (inclusive at
	// tangency), so a dash or knockback cannot skip an item its body touched.
	// Path reach is clamped at the first wall/locked-zone/arena contact, so
	// items behind cover or a locked core are never absorbed through it.
	CoreRadius       = 0.35
	HealthPackRadius = 0.55
)

// sweptReach reports whether a robot moving start->end this tick came within
// RobotRadius+itemR of center (inclusive), without crossing solid geometry.
func (s *Sim) sweptReach(start, end, center Vec2, itemR float64) bool {
	touches := func(p Vec2) bool {
		return p.Sub(center).Len() <= RobotRadius+itemR+collisionEpsilon && s.LineOfSight(p, center)
	}
	// The final position is legal even when wall sliding makes its chord
	// cross a corner; keep that contact before clipping the swept chord.
	if touches(start) || touches(end) {
		return true
	}
	if c := s.sweepContact(start, end.Sub(start)); c.hit && c.t < 1-collisionEpsilon {
		end = start.Add(end.Sub(start).Scale(max(0, c.t)))
	}
	d := end.Sub(start)
	l := d.Len()
	if l <= collisionEpsilon {
		return false
	}
	t := math.Max(0, math.Min(1, ((center.X-start.X)*d.X+(center.Y-start.Y)*d.Y)/(l*l)))
	return touches(start.Add(d.Scale(t)))
}

func (s *Sim) stepHealthPacks() {
	for i := range s.healthPacks {
		pack := &s.healthPacks[i]
		if pack.ReadyAt > s.tick {
			continue
		}
		for j := range s.robots {
			r := &s.robots[j]
			reached := r.Position.Sub(pack.Pos).Len() <= RobotRadius
			if s.simulationVersion >= 2 {
				reached = s.sweptReach(r.PathStart, r.Position, pack.Pos, HealthPackRadius)
			}
			if r.State != Alive || r.HP >= MaxHP || !reached {
				continue
			}
			heal := math.Min(HealthPackHeal, MaxHP-r.HP)
			r.HP += heal
			pack.ReadyAt = s.tick + HealthPackCooldown
			s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_Heal{Heal: &ombv1.EvHeal{
				By: r.ID, Id: pack.ID, HealX10: int32(math.Round(heal * 10)), At: &ombv1.Vec2{X: pack.Pos.X, Y: pack.Pos.Y},
			}}})
			break
		}
	}
}

func (s *Sim) stepCores() {
	if s.mapDef == nil || len(s.cores) == 0 {
		return
	}
	if s.tick == 1 || s.tick%uint32(s.mapDef.CoreRules.PeriodTicks) == 0 {
		s.spawnCore()
	}
	for i := range s.cores {
		core := &s.cores[i]
		if !core.Alive || (s.zoneLocked() && core.Pos.Len() < s.mapDef.CoreZone.Radius) {
			continue
		}
		for j := range s.robots {
			r := &s.robots[j]
			reached := r.Position.Sub(core.Pos).Len() <= RobotRadius
			if s.simulationVersion >= 2 {
				reached = s.sweptReach(r.PathStart, r.Position, core.Pos, CoreRadius)
			}
			if r.State == Alive && reached {
				core.Alive = false
				s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_CorePickup{CorePickup: &ombv1.EvCorePickup{By: r.ID, CoreId: core.ID, Value: core.Value}}})
				break
			}
		}
	}
}

// Each period chooses one non-full group by its current phase weight, then one
// empty pad uniformly. Existing live cores are never duplicated or removed.
func (s *Sim) spawnCore() {
	weights := s.mapDef.CoreRules.GroupWeights[Phase(s.phase)]
	available := make([][]int, len(weights))
	total := 0.0
	for i, p := range s.mapDef.CorePads {
		if !s.cores[i].Alive && (!s.zoneLocked() || p.Pos.Len() >= s.mapDef.CoreZone.Radius) {
			available[p.Group] = append(available[p.Group], i)
		}
	}
	for g, ids := range available {
		if len(ids) > 0 {
			total += weights[g]
		}
	}
	if total <= 0 {
		return
	}
	pick := s.randomUnit() * total
	for g, ids := range available {
		if len(ids) == 0 || weights[g] <= 0 {
			continue
		}
		pick -= weights[g]
		if pick < 0 {
			s.cores[ids[int(s.random()%uint64(len(ids)))]].Alive = true
			return
		}
	}
}
