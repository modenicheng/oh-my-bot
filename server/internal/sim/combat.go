package sim

import (
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"math"
	"sort"
	"strings"
	"unicode"
)

func (s *Sim) prepareCombat() {
	for i := range s.robots {
		r := &s.robots[i]
		c := &r.Combat
		in := r.Control.Output
		if r.State == Dead {
			c.ShieldOn = false
			if s.simulationVersion >= 2 {
				c.DashUntil = 0
			}
			continue
		}
		r.Energy = math.Min(MaxEnergy, r.Energy+EnergyRegen*DT)
		c.ShieldOn = in.Shield && r.Energy+collisionEpsilon >= ShieldDrain*DT
		if c.ShieldOn {
			r.Energy = math.Max(0, r.Energy-ShieldDrain*DT)
		}
		if s.simulationVersion < 2 {
			// Recorded v0/v1 inputs allowed shield and timed Dash together.
			if in.Dash && s.tick >= c.DashReady && r.Energy+collisionEpsilon >= DashCost {
				direction := dashDirection(in.Move, r.Heading)
				r.Energy = math.Max(0, r.Energy-DashCost)
				c.DashReady, c.DashUntil, c.DashDirection = s.tick+DashCooldown, s.tick+DashDuration, direction
			}
		} else {
			if !in.Dash {
				c.DashExhausted = false
			}
			if !in.Shield && in.Dash && !c.DashExhausted && r.Energy+collisionEpsilon >= DashCost*DT {
				// Held Dash is continuous: every active tick pays the per-second
				// drain, refreshes direction, and remains active for exactly this tick.
				r.Energy = math.Max(0, r.Energy-DashCost*DT)
				c.DashReady, c.DashUntil, c.DashDirection = s.tick, s.tick+1, dashDirection(in.Move, r.Heading)
			} else {
				// Release, shield intent, or insufficient energy stops immediately.
				// Exhaustion requires a release before Dash may start again, avoiding
				// one-tick cue flicker as passive regeneration crosses the threshold.
				if in.Dash && !in.Shield && r.Energy+collisionEpsilon < DashCost*DT {
					c.DashExhausted = true
				}
				if c.DashUntil >= s.tick && c.DashUntil != 0 {
					if speed := r.Velocity.Len(); speed > MaxSpeed {
						r.Velocity = r.Velocity.Scale(MaxSpeed / speed)
					}
				}
				c.DashUntil = 0
			}
		}
		if c.PulseRequested && s.tick >= c.PulseReady && r.Energy+collisionEpsilon >= PulseCost {
			r.Energy = math.Max(0, r.Energy-PulseCost)
			c.PulseTick, c.PulseReady = s.tick, s.tick+PulseCooldown
		}
		c.PulseRequested = false
	}
}

func dashDirection(move Vec2, heading float64) Vec2 {
	if n := move.Len(); n > 0 {
		return move.Scale(1 / n)
	}
	return Vec2{math.Cos(heading), math.Sin(heading)}
}

// normalizeSay bounds visible text without allocating for the whole upstream string.
func normalizeSay(text string) string {
	var out strings.Builder
	out.Grow(160)
	count, space := 0, false
	for _, ch := range text {
		if unicode.IsSpace(ch) || unicode.IsControl(ch) {
			space = count > 0
			continue
		}
		if space {
			if count >= 159 {
				break
			}
			out.WriteByte(' ')
			count++
			space = false
		}
		out.WriteRune(ch)
		count++
		if count == 160 {
			break
		}
	}
	return out.String()
}

func (s *Sim) say(r *Robot, text string) bool {
	if s.tick < r.Combat.SayReady {
		return false
	}
	text = normalizeSay(text)
	if text == "" {
		return false
	}
	r.Combat.SayReady = s.tick + SayCooldown
	s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: r.ID, Text: text}}})
	return true
}

func (s *Sim) fireProjectiles() {
	for i := range s.robots {
		r := &s.robots[i]
		if r.State == Dead || !r.Control.Output.Fire || r.Combat.ShieldOn || s.tick < r.Combat.FireReady || r.Energy+collisionEpsilon < FireCost || s.nextProjectile == 0 {
			continue
		}
		r.Energy = math.Max(0, r.Energy-FireCost)
		r.Combat.FireReady = s.tick + FireInterval
		s.projectiles = append(s.projectiles, Projectile{ID: s.nextProjectile, Owner: r.ID, Pos: r.Position, Heading: r.Heading, BaseHeading: r.Heading, Spread: (s.randomUnit()*2 - 1) * MaxSpread})
		// Telemetry only: announce the attack at the muzzle; impacts follow below.
		s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_Shot{Shot: &ombv1.EvShot{
			Projectile: s.nextProjectile, Owner: r.ID, Color: r.Color, At: &ombv1.Vec2{X: r.Position.X, Y: r.Position.Y}, Heading: float32(r.Heading)}}})
		s.nextProjectile++ // zero means exhausted IDs: never wrap and reuse an entity.
	}
}

func (s *Sim) stepProjectiles() {
	alive := s.projectiles[:0]
	for _, p := range s.projectiles {
		remaining := ProjectileRange - p.Distance
		if remaining <= collisionEpsilon {
			continue
		}
		length := math.Min(ProjectileSpeed*DT, remaining)
		falloff := math.Max(0, math.Min(1, (p.Distance+length/2-EffectiveRange)/(ProjectileRange-EffectiveRange)))
		p.Heading = p.BaseHeading + p.Spread*falloff
		delta := Vec2{math.Cos(p.Heading) * length, math.Sin(p.Heading) * length}
		fraction, blocked := s.traceSolid(p.Pos, delta)
		victim := -1
		owner, ok := s.index[p.Owner]
		if !ok {
			continue
		}
		for i := range s.robots {
			r := &s.robots[i]
			if r.State == Dead || r.ID == p.Owner {
				continue
			}
			if t, hit := sweepCircle(p.Pos, delta, r.Position, RobotRadius); hit && (t < fraction-collisionEpsilon || (!blocked && victim < 0 && t <= fraction)) {
				fraction, victim = t, i
			}
		}
		p.Pos = p.Pos.Add(delta.Scale(fraction))
		p.Distance += length * fraction
		if victim >= 0 {
			v := &s.robots[victim]
			// Impact telemetry precedes damage so observers see the hit even when
			// protection (invulnerability/partner) means no HP follows.
			s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_ProjectileImpact{ProjectileImpact: &ombv1.EvProjectileImpact{
				Projectile: p.ID, Owner: p.Owner, Color: s.robots[owner].Color, Target: v.ID, At: &ombv1.Vec2{X: p.Pos.X, Y: p.Pos.Y},
				Shield: v.Combat.ShieldOn, Invulnerable: v.Combat.Invulnerable}}})
			s.damage(p.Owner, v, ShotDamage)
			continue
		}
		if blocked || p.Distance >= ProjectileRange-collisionEpsilon {
			// A projectile dying against a solid (wall/locked core) reports its
			// stopping point with Target 0; range expiry stays silent.
			if blocked {
				s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_ProjectileImpact{ProjectileImpact: &ombv1.EvProjectileImpact{
					Projectile: p.ID, Owner: p.Owner, Color: s.robots[owner].Color, At: &ombv1.Vec2{X: p.Pos.X, Y: p.Pos.Y}}}})
			}
			continue
		}
		alive = append(alive, p)
	}
	s.projectiles = alive
}

func (s *Sim) damage(attacker uint32, r *Robot, amount float64) {
	_, ok := s.index[attacker]
	if !ok || r.State == Dead || r.Combat.Invulnerable || attacker == r.ID {
		return
	}
	if r.Combat.ShieldOn {
		amount *= ShieldDamageScale
	}
	amount = math.Min(amount, r.HP)
	r.HP = math.Max(0, r.HP-amount)
	if amount <= 0 {
		return
	}
	if r.Combat.DamageBy == nil {
		r.Combat.DamageBy = make(map[uint32]float64)
	}
	r.Combat.DamageBy[attacker] += amount
	// EvHit.dmg is an integer in protocol v1. Physics retains fractional shield
	// damage (4.2); only event telemetry is rounded, never the HP calculation.
	s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_Hit{Hit: &ombv1.EvHit{From: attacker, To: r.ID, Dmg: int32(math.Round(amount))}}})
	if r.HP > 0 {
		return
	}
	contributors := make([]uint32, 0, len(r.Combat.DamageBy))
	for id := range r.Combat.DamageBy {
		contributors = append(contributors, id)
	}
	sort.Slice(contributors, func(i, j int) bool { return contributors[i] < contributors[j] })
	// Stable addition order keeps the strict half-damage boundary identical
	// across live play and replay without rounding away effective HP damage.
	totalDamage := 0.0
	for _, id := range contributors {
		totalDamage += r.Combat.DamageBy[id]
	}
	assists := make([]uint32, 0, len(contributors))
	for _, id := range contributors {
		if id != attacker && r.Combat.DamageBy[id]*2 < totalDamage {
			assists = append(assists, id)
		}
	}
	killSteal := totalDamage > 0 && r.Combat.DamageBy[attacker]*2 < totalDamage
	r.State, r.Velocity = Dead, Vec2{}
	r.Input, r.PendingInput, r.InputPending = Input{}, Input{}, false
	r.Control = ControlState{Assist: r.Control.Assist}
	r.Combat.ShieldOn, r.Combat.DashUntil, r.Combat.RespawnAt = false, 0, s.tick+RespawnDelay
	s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_Kill{Kill: &ombv1.EvKill{Killer: attacker, Victim: r.ID, Assists: assists, KillSteal: killSteal, At: &ombv1.Vec2{X: r.Position.X, Y: r.Position.Y}}}})
}

func (s *Sim) respawnRobot(r *Robot) {
	pos := r.SpawnPosition
	if s.mapDef != nil {
		if next, ok := s.spawnInSector(r.Sector); ok {
			pos = next
		}
	}
	r.Position, r.Velocity, r.HP, r.Energy = pos, Vec2{}, MaxHP, MaxEnergy
	r.State, r.Heading, r.RespawnPending = Alive, 0, false
	r.Input, r.PendingInput, r.InputPending = Input{}, Input{}, false
	r.Control = ControlState{Assist: r.Control.Assist}
	// Personal station cooldowns survive death; combat cooldowns and controls do
	// not. The 4s protection timer starts only after a new effective operation.
	r.Combat = CombatState{Invulnerable: true, SayReady: r.Combat.SayReady}
	s.events = append(s.events, &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_Respawn{Respawn: &ombv1.EvRespawn{Robot: r.ID, Sector: r.Sector}}})
}

// sweepCircle tests a point segment against a solid circle. Boundary contacts
// moving inward count; tangencies and contacts moving away do not.
func sweepCircle(p, d, center Vec2, radius float64) (float64, bool) {
	offset := p.Sub(center)
	a := d.X*d.X + d.Y*d.Y
	c := offset.X*offset.X + offset.Y*offset.Y - radius*radius
	if c < -collisionEpsilon {
		return 0, true
	}
	dot := offset.X*d.X + offset.Y*d.Y
	if a == 0 || dot >= 0 {
		return 0, false
	}
	if c <= 0 {
		return 0, true // inward motion from a tolerated boundary overlap
	}
	disc := dot*dot - a*c
	if disc <= 0 {
		return 0, false
	}
	t := c / (-dot + math.Sqrt(disc))
	return math.Max(0, math.Min(1, t)), t >= -collisionEpsilon && t <= 1+collisionEpsilon
}

func segmentWall(p, d Vec2, w Wall) (float64, bool) {
	lo, hi := 0.0, 1.0
	slab := func(pos, delta, minV, maxV float64) bool {
		if delta == 0 {
			return pos >= minV && pos <= maxV
		}
		a, b := (minV-pos)/delta, (maxV-pos)/delta
		if a > b {
			a, b = b, a
		}
		lo, hi = math.Max(lo, a), math.Min(hi, b)
		return lo <= hi
	}
	if !slab(p.X, d.X, w.Min.X, w.Max.X) || !slab(p.Y, d.Y, w.Min.Y, w.Max.Y) {
		return 0, false
	}
	return lo, true
}

func (s *Sim) traceSolid(p, d Vec2) (float64, bool) {
	fraction, hit := 1.0, false
	for _, w := range s.walls {
		if t, ok := segmentWall(p, d, w); ok && t <= fraction {
			fraction, hit = t, true
		}
	}
	if s.zoneLocked() {
		if t, ok := sweepCircle(p, d, Vec2{}, s.mapDef.CoreZone.Radius); ok && t <= fraction {
			fraction, hit = t, true
		}
	}
	return fraction, hit
}

// LineOfSight must be called on the owner. Worker readers use WorldView instead.
func (s *Sim) LineOfSight(from, to Vec2) bool {
	if !from.finite() || !to.finite() {
		return false
	}
	_, blocked := s.traceSolid(from, to.Sub(from))
	return !blocked
}

func (s *Sim) pushRobot(r *Robot, delta Vec2) {
	fraction := 1.0
	for _, w := range s.walls {
		if t, hit := sweepWall(r.Position, delta, w); hit && t < fraction {
			fraction = t
		}
	}
	if s.zoneLocked() {
		if t, hit := sweepCircle(r.Position, delta, Vec2{}, s.mapDef.CoreZone.Radius+RobotRadius); hit && t < fraction {
			fraction = t
		}
	}
	if t, hit := s.sweepArena(r.Position, delta); hit && t < fraction {
		fraction = t
	}
	r.Position = s.containInArena(r.Position.Add(delta.Scale(fraction)))
}

// A small restitution and per-contact velocity cap soften dash impacts.
// Existing acceleration damping brings knocked, idle robots back to rest.
const (
	robotRestitution = 0.15
	maxKnockSpeed    = 4.0
)

// robotContact records one tick's touch between overlapping robots before any
// positional correction runs. normal points from a to b; closing is the
// approach speed along it (zero or negative means stationary or separating).
type robotContact struct {
	a, b    int
	normal  Vec2
	closing float64
}

// Capture contacts before positional relaxation changes their normals. Apply
// at most one impulse per pair per tick, not one per relaxation pass.
// No collision damage, dash cancellation or partner exemption.
func (s *Sim) softCollide() {
	var contacts []robotContact
	if s.simulationVersion >= 1 {
		contacts = s.captureRobotContacts()
	}
	// ID order stabilizes coincident starts; every correction is swept.
	for pass := 0; pass < 3; pass++ {
		for i := range s.robots {
			a := &s.robots[i]
			if a.State == Dead {
				continue
			}
			for j := i + 1; j < len(s.robots); j++ {
				b := &s.robots[j]
				if b.State == Dead {
					continue
				}
				delta := b.Position.Sub(a.Position)
				distance := delta.Len()
				if distance >= 2*RobotRadius-collisionEpsilon {
					continue
				}
				direction := Vec2{X: 1}
				if distance > collisionEpsilon {
					direction = delta.Scale(1 / distance)
				}
				push := direction.Scale((2*RobotRadius - distance) / 2)
				s.pushRobot(a, push.Scale(-1))
				s.pushRobot(b, push)
			}
		}
	}
	s.applyRobotImpulses(contacts)
}

// ID-sorted i<j order is deterministic. Coincident centers have no reliable
// normal, so they receive positional separation only.
func (s *Sim) captureRobotContacts() []robotContact {
	var contacts []robotContact
	for i := range s.robots {
		a := &s.robots[i]
		if a.State == Dead {
			continue
		}
		for j := i + 1; j < len(s.robots); j++ {
			b := &s.robots[j]
			if b.State == Dead {
				continue
			}
			delta := b.Position.Sub(a.Position)
			distance := delta.Len()
			if distance >= 2*RobotRadius-collisionEpsilon || distance <= collisionEpsilon {
				continue
			}
			normal := delta.Scale(1 / distance)
			closing := (a.Velocity.X-b.Velocity.X)*normal.X + (a.Velocity.Y-b.Velocity.Y)*normal.Y
			if closing <= 0 {
				continue
			}
			contacts = append(contacts, robotContact{a: i, b: j, normal: normal, closing: closing})
		}
	}
	return contacts
}

// Bound each impulse by both incoming and current closing speed: an earlier
// contact may already have slowed this pair. Using only incoming speeds adds
// energy in crowds. Equal and opposite impulses preserve total momentum;
// normal movement sweeps and acceleration damping apply on the next tick.
func (s *Sim) applyRobotImpulses(contacts []robotContact) {
	for _, c := range contacts {
		a, b := &s.robots[c.a], &s.robots[c.b]
		closing := (a.Velocity.X-b.Velocity.X)*c.normal.X + (a.Velocity.Y-b.Velocity.Y)*c.normal.Y
		if closing <= 0 {
			continue
		}
		knock := math.Min(maxKnockSpeed, (1+robotRestitution)*math.Min(c.closing, closing)/2)
		a.Velocity.X -= c.normal.X * knock
		a.Velocity.Y -= c.normal.Y * knock
		b.Velocity.X += c.normal.X * knock
		b.Velocity.Y += c.normal.Y * knock
	}
}
