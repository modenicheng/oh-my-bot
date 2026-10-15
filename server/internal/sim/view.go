package sim

import "math"

// WorldView supplements the frozen FrameView, which intentionally contains no
// entity table. Published data never aliases live simulation state. Readers
// may retain or mutate returned values, even while the owner advances Tick.
type WorldView struct {
	Frame       FrameView
	Robots      []RobotView
	Projectiles []ProjView
	Cores       []CoreView
	HealthPacks []HealthPackView
	Uplinks     []UplinkView
	PointDrops  []PointDropView
	Controls    map[uint32]ArbitratedInput
	PulseScans  map[uint32]bool // active only on the successful pulse tick
	AckSeqs     map[uint32]uint32
}

func cloneRobot(r Robot) Robot {
	r.Control.PendingScript = cloneCommands(r.Control.PendingScript)
	if r.Combat.DamageBy != nil {
		copy := make(map[uint32]float64, len(r.Combat.DamageBy))
		for id, v := range r.Combat.DamageBy {
			copy[id] = v
		}
		r.Combat.DamageBy = copy
	}
	return r
}
func cloneUplinks(src []Uplink) []Uplink {
	out := make([]Uplink, len(src))
	for i, u := range src {
		out[i] = u
		out[i].ReadyAt = make(map[uint32]uint32, len(u.ReadyAt))
		for id, tick := range u.ReadyAt {
			out[i].ReadyAt[id] = tick
		}
	}
	return out
}
func (s *Sim) publishView() {
	v := &WorldView{Frame: FrameView{Tick: s.tick, Phase: Phase(s.phase), TimeLeftS: secondsLeft(s.tick, s.matchTicks), Map: s.mapDef},
		Robots: make([]RobotView, len(s.robots)), Projectiles: make([]ProjView, len(s.projectiles)), Cores: append([]CoreView{}, s.cores...),
		HealthPacks: make([]HealthPackView, len(s.healthPacks)), Uplinks: make([]UplinkView, len(s.uplinks)),
		PointDrops: make([]PointDropView, len(s.pointDrops)),
		Controls:   make(map[uint32]ArbitratedInput), PulseScans: make(map[uint32]bool), AckSeqs: make(map[uint32]uint32)}
	if v.Frame.Map == nil && len(s.walls) != 0 {
		v.Frame.Map = &MapDef{Walls: s.walls}
	}
	for i, r := range s.robots {
		invuln := uint32(0)
		if r.Combat.Invulnerable {
			invuln = secondsLeft(s.tick, r.Combat.InvulnUntil)
			if r.Combat.InvulnUntil == 0 {
				invuln = InvulnDuration / TickRate
			}
		}
		v.Robots[i] = RobotView{ID: r.ID, Pos: r.Position, Vel: r.Velocity, Turret: r.Heading, HpX10: ToX10(r.HP), EnergyX10: ToX10(r.Energy),
			ShieldOn: r.Combat.ShieldOn, Dashing: r.Combat.DashUntil > s.tick, Dead: r.State == Dead, RespawnInS: secondsLeft(s.tick, r.Combat.RespawnAt), InvulnS: invuln, Nick: r.Nick, Color: r.Color,
			MaxHpX10: ToX10(s.maxHPOf(&r)), MaxEnergyX10: ToX10(s.maxEnergyOf(&r))}
		v.Controls[r.ID] = r.Control.Output
		v.AckSeqs[r.ID] = r.ConsumedSeq
		if r.Combat.PulseTick == s.tick && s.tick != 0 && r.State != Dead {
			v.PulseScans[r.ID] = true
		}
	}
	for i, p := range s.projectiles {
		v.Projectiles[i] = ProjView{ID: p.ID, Owner: p.Owner, Pos: p.Pos, Heading: p.Heading}
		if owner, ok := s.index[p.Owner]; ok {
			v.Projectiles[i].Color = s.robots[owner].Color
		}
	}
	for i, pack := range s.healthPacks {
		v.HealthPacks[i] = HealthPackView{ID: pack.ID, Pos: pack.Pos, Available: pack.ReadyAt <= s.tick, RespawnInS: secondsLeft(s.tick, pack.ReadyAt)}
	}
	for i, d := range s.pointDrops {
		v.PointDrops[i] = PointDropView{ID: d.ID, Pos: d.Pos, Points: d.Points}
	}
	for i, u := range s.uplinks {
		cds := make(map[uint32]uint32, len(u.ReadyAt))
		for id, tick := range u.ReadyAt {
			if tick > s.tick {
				cds[id] = secondsLeft(s.tick, tick)
			}
		}
		v.Uplinks[i] = UplinkView{ID: u.Def.ID, Pos: u.Def.Pos, Main: u.Def.Main, Active: s.uplinkActive(&u), HackingID: u.HackingID, ProgressS: float64(u.ProgressTicks) * DT, PersonalCDs: cds}
	}
	s.view.Store(v)
}

func (s *Sim) View() FrameView {
	v := s.view.Load()
	if v == nil {
		return FrameView{}
	}
	f := v.Frame
	f.Map = cloneMap(f.Map)
	return f
}
func (s *Sim) RobotViews() []RobotView { return append([]RobotView{}, s.view.Load().Robots...) }
func cloneUplinkViews(in []UplinkView) []UplinkView {
	out := make([]UplinkView, len(in))
	for i, u := range in {
		out[i] = u
		out[i].PersonalCDs = make(map[uint32]uint32, len(u.PersonalCDs))
		for id, t := range u.PersonalCDs {
			out[i].PersonalCDs[id] = t
		}
	}
	return out
}
func (s *Sim) UplinkViews() []UplinkView            { return cloneUplinkViews(s.view.Load().Uplinks) }
func (s *Sim) Arbitrated(id uint32) ArbitratedInput { return s.view.Load().Controls[id] }

// WorldView returns entity tables and metadata from ONE atomic publication;
// separate getter calls across concurrent ticks need not describe the same frame.
func (s *Sim) WorldView() WorldView {
	src := s.view.Load()
	out := *src
	out.Frame.Map = cloneMap(src.Frame.Map)
	out.Robots = append([]RobotView{}, src.Robots...)
	out.Projectiles = append([]ProjView{}, src.Projectiles...)
	out.Cores = append([]CoreView{}, src.Cores...)
	out.HealthPacks = append([]HealthPackView{}, src.HealthPacks...)
	out.Uplinks = cloneUplinkViews(src.Uplinks)
	out.PointDrops = append([]PointDropView{}, src.PointDrops...)
	out.Controls = make(map[uint32]ArbitratedInput, len(src.Controls))
	for id, c := range src.Controls {
		out.Controls[id] = c
	}
	out.PulseScans = make(map[uint32]bool, len(src.PulseScans))
	for id, on := range src.PulseScans {
		out.PulseScans[id] = on
	}
	out.AckSeqs = make(map[uint32]uint32, len(src.AckSeqs))
	for id, seq := range src.AckSeqs {
		out.AckSeqs[id] = seq
	}
	return out
}

// ScanRadius exposes a pulse's one-frame range without teaching scripts about
// human control. T3 can use this plus LineOfSight to build Observation.
func (v WorldView) ScanRadius(id uint32) float64 {
	if v.PulseScans[id] {
		return PulseRadius
	}
	return VisionRadius
}
func (v WorldView) LineOfSight(from, to Vec2) bool {
	if !from.finite() || !to.finite() {
		return false
	}
	if v.Frame.Map == nil {
		return true
	}
	d := to.Sub(from)
	for _, w := range v.Frame.Map.Walls {
		if _, hit := segmentWall(from, d, w); hit {
			return false
		}
	}
	z := v.Frame.Map.CoreZone
	if z.Radius > 0 && v.Frame.Phase < z.UnlockPhase {
		if _, hit := sweepCircle(from, d, Vec2{}, z.Radius); hit {
			return false
		}
	}
	return true
}

func (v WorldView) SurfaceVisible(from, to Vec2) bool {
	if !from.finite() || !to.finite() {
		return false
	}
	if v.Frame.Map == nil {
		return true
	}
	delta := to.Sub(from)
	tolerance := 1e-7 / math.Max(1, delta.Len())
	for _, wall := range v.Frame.Map.Walls {
		if fraction, hit := segmentWall(from, delta, wall); hit && fraction < 1-tolerance {
			return false
		}
	}
	zone := v.Frame.Map.CoreZone
	if zone.Radius > 0 && v.Frame.Phase < zone.UnlockPhase {
		if fraction, hit := sweepCircle(from, delta, Vec2{}, zone.Radius); hit && fraction < 1-tolerance {
			return false
		}
	}
	return true
}

// Observe is a standalone convenience for integrations without a T3 builder.
// All entities and map surfaces require range and line of sight.
func (v WorldView) Observe(id uint32) (Observation, bool) {
	return v.ObserveLocal(id, v.ScanRadius(id), nil)
}

func (v WorldView) ObserveLocal(id uint32, radius float64, visible func(Vec2, Vec2) bool) (Observation, bool) {
	var self RobotView
	found := false
	for _, r := range v.Robots {
		if r.ID == id {
			self, found = r, true
			break
		}
	}
	if !found {
		return Observation{}, false
	}
	frame := v.Frame
	if visible == nil {
		visible = v.LineOfSight
	}
	canSee := func(position Vec2) bool { return self.Pos.Sub(position).Len() <= radius && visible(self.Pos, position) }
	frame.Map = v.localMap(self.Pos, radius, visible)
	obs := Observation{Frame: frame, VisionRadius: radius}
	for _, r := range v.Robots {
		if r.ID == id || canSee(r.Pos) {
			obs.Robots = append(obs.Robots, r)
		}
	}
	for _, p := range v.Projectiles {
		if canSee(p.Pos) {
			obs.Projectiles = append(obs.Projectiles, p)
		}
	}
	for _, core := range v.Cores {
		if canSee(core.Pos) {
			obs.Cores = append(obs.Cores, core)
		}
	}
	for _, pack := range v.HealthPacks {
		if canSee(pack.Pos) {
			obs.HealthPacks = append(obs.HealthPacks, pack)
		}
	}
	for _, drop := range v.PointDrops {
		if canSee(drop.Pos) {
			obs.PointDrops = append(obs.PointDrops, drop)
		}
	}
	for _, uplink := range v.Uplinks {
		if !canSee(uplink.Pos) {
			continue
		}
		cooldown, exists := uplink.PersonalCDs[id]
		uplink.PersonalCDs = nil
		if exists {
			uplink.PersonalCDs = map[uint32]uint32{id: cooldown}
		}
		obs.Uplinks = append(obs.Uplinks, uplink)
	}
	return obs, true
}
