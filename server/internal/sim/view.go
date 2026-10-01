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
	Uplinks     []UplinkView
	Partners    map[uint32]uint32
	Controls    map[uint32]ArbitratedInput
	PulseScans  map[uint32]bool // active only on the successful pulse tick
	AckSeqs     map[uint32]uint32
}

func cloneRobot(r Robot) Robot {
	r.Control.PendingScript = cloneCommands(r.Control.PendingScript)
	if r.Combat.Damagers != nil {
		copy := make(map[uint32]bool, len(r.Combat.Damagers))
		for id, v := range r.Combat.Damagers {
			copy[id] = v
		}
		r.Combat.Damagers = copy
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
	v := &WorldView{Frame: FrameView{Tick: s.tick, Phase: Phase(s.phase), TimeLeftS: secondsLeft(s.tick, MatchTicks), Map: s.mapDef},
		Robots: make([]RobotView, len(s.robots)), Projectiles: make([]ProjView, len(s.projectiles)), Cores: append([]CoreView{}, s.cores...),
		Uplinks: make([]UplinkView, len(s.uplinks)), Partners: make(map[uint32]uint32), Controls: make(map[uint32]ArbitratedInput), PulseScans: make(map[uint32]bool), AckSeqs: make(map[uint32]uint32)}
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
		v.Robots[i] = RobotView{ID: r.ID, Pos: r.Position, Vel: r.Velocity, Turret: r.Heading, HpX10: int32(math.Round(r.HP * 10)), EnergyX10: int32(math.Round(r.Energy * 10)),
			ShieldOn: r.Combat.ShieldOn, Dashing: r.Combat.DashUntil > s.tick, Dead: r.State == Dead, RespawnInS: secondsLeft(s.tick, r.Combat.RespawnAt), InvulnS: invuln, Nick: r.Nick, Color: r.Color}
		v.Partners[r.ID] = r.Combat.Partner
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
func (s *Sim) RobotViews() []RobotView     { return append([]RobotView{}, s.view.Load().Robots...) }
func (s *Sim) ProjectileViews() []ProjView { return append([]ProjView{}, s.view.Load().Projectiles...) }
func (s *Sim) CoreViews() []CoreView       { return append([]CoreView{}, s.view.Load().Cores...) }
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
func (s *Sim) PartnerID(id uint32) uint32           { return s.view.Load().Partners[id] }
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
	out.Uplinks = cloneUplinkViews(src.Uplinks)
	out.Partners = make(map[uint32]uint32, len(src.Partners))
	for id, p := range src.Partners {
		out.Partners[id] = p
	}
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

// Observe is a standalone convenience for integrations without a T3 builder.
// Core/Uplink stay global; a partner is visible through walls at any range.
func (v WorldView) Observe(id uint32) (Observation, bool) {
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
	frame.Map = cloneMap(frame.Map)
	obs := Observation{Frame: frame, PartnerID: v.Partners[id], Cores: append([]CoreView{}, v.Cores...), Uplinks: cloneUplinkViews(v.Uplinks)}
	for _, r := range v.Robots {
		if r.ID == id || r.ID == obs.PartnerID || (self.Pos.Sub(r.Pos).Len() <= v.ScanRadius(id) && v.LineOfSight(self.Pos, r.Pos)) {
			obs.Robots = append(obs.Robots, r)
		}
	}
	for _, p := range v.Projectiles {
		if self.Pos.Sub(p.Pos).Len() <= v.ScanRadius(id) && v.LineOfSight(self.Pos, p.Pos) {
			obs.Projectiles = append(obs.Projectiles, p)
		}
	}
	return obs, true
}
