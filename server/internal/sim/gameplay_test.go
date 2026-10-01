package sim

import (
	"fmt"
	"math"
	"reflect"
	"strings"
	"sync"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func ptr[T any](v T) *T              { return &v }
func stepTicks(s *Sim, count uint32) { advance(s, s.CurrentTick()+count) }

func gameMap() *MapDef {
	m := &MapDef{Version: 1, CoreZone: CoreZoneDef{Radius: 5, UnlockPhase: PhaseCoreOpen}, CoreRules: CoreRulesDef{PeriodTicks: 60, GroupWeights: map[Phase][]float64{PhaseOuterRing: {1, 0}, PhaseCoreOpen: {0, 1}}}}
	for i := range m.Sectors {
		p := Vec2{30 + float64(i)*4, 30}
		m.Sectors[i] = Sector{ID: uint32(i), Center: p, SpawnArea: Rect{Min: p, Max: p.Add(Vec2{2, 2})}}
	}
	return m
}
func healthPackMap() *MapDef {
	m := gameMap()
	m.HealthPacks = []HealthPackDef{{ID: 1, Pos: Vec2{X: 10, Y: 10}}}
	return m
}

func enemySim(t *testing.T) (*Sim, *recordingSink) {
	t.Helper()
	sink := &recordingSink{}
	s := NewSim(7, []uint32{1, 2, 3, 4}, sink)
	for i := range s.robots {
		if err := s.SetSpawn(s.robots[i].ID, Vec2{float64(i) * 30, 50}, uint32(i)); err != nil {
			t.Fatal(err)
		}
	}
	return s, sink
}
func TestHealthPackPickupRules(t *testing.T) {
	s := NewSim(7, []uint32{2, 1}, nil)
	if err := s.SetMap(healthPackMap()); err != nil {
		t.Fatal(err)
	}
	pack := &s.healthPacks[0]
	for i := range s.robots {
		s.robots[i].Position = pack.Pos
		s.robots[i].HP = MaxHP
	}
	s.stepHealthPacks()
	if pack.ReadyAt != 0 || len(s.events) != 0 {
		t.Fatalf("full health consumed pack: ready=%d events=%d", pack.ReadyAt, len(s.events))
	}

	first := &s.robots[s.index[1]]
	second := &s.robots[s.index[2]]
	first.HP = 95
	second.HP = 40
	s.stepHealthPacks()
	if first.HP != MaxHP || second.HP != 40 || pack.ReadyAt != HealthPackCooldown {
		t.Fatalf("bad single-consumer pickup: first=%.1f second=%.1f ready=%d", first.HP, second.HP, pack.ReadyAt)
	}
	heal := s.events[len(s.events)-1].GetHeal()
	if heal == nil || heal.By != 1 || heal.Id != 1 || heal.HealX10 != 50 {
		t.Fatalf("bad heal event: %+v", heal)
	}

	first.HP = 50
	s.tick = HealthPackCooldown - 1
	s.stepHealthPacks()
	if first.HP != 50 {
		t.Fatal("pack respawned early")
	}
	s.tick = HealthPackCooldown
	first.State = Dead
	second.HP = 80
	s.stepHealthPacks()
	if first.HP != 50 || second.HP != MaxHP || pack.ReadyAt != 2*HealthPackCooldown {
		t.Fatalf("dead pickup or cooldown failure: first=%.1f second=%.1f ready=%d", first.HP, second.HP, pack.ReadyAt)
	}
}

func TestHealthPackCheckpointRestoresCooldown(t *testing.T) {
	s := NewSim(9, []uint32{1}, nil)
	m := healthPackMap()
	if err := s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	r := &s.robots[s.index[1]]
	r.Position = s.healthPacks[0].Pos
	r.HP = 60
	s.stepHealthPacks()
	cp := s.Snapshot()
	if len(cp.HealthPacks) != 1 || cp.HealthPacks[0].ReadyAt != HealthPackCooldown {
		t.Fatalf("checkpoint missing health cooldown: %+v", cp.HealthPacks)
	}
	restored, err := RestoreCheckpoint(cp, nil)
	if err != nil {
		t.Fatal(err)
	}
	view := restored.WorldView().HealthPacks
	if len(view) != 1 || view[0].Available || view[0].RespawnInS != 30 {
		t.Fatalf("restored health view mismatch: %+v", view)
	}
}

func TestArbitrationAxisMaskTable(t *testing.T) {
	script := ArbitratedInput{Move: Vec2{1, 0}, Aim: 1.2, Fire: true, Dash: true, Shield: true, Interact: true}
	human := ArbitratedInput{Move: Vec2{}, Aim: 0, Fire: false, Dash: false, Shield: false, Interact: false}
	for mask := AxisMask(0); mask <= allAxes; mask++ {
		t.Run(fmt.Sprintf("mask_%02d", mask), func(t *testing.T) {
			c := ControlState{Assist: true, Script: script, ScriptAxes: allAxes, Human: human, HumanAxes: mask}
			got := c.resolve()
			want := script
			setAxes(&want, human, mask)
			want.MoveSrc, want.TurretSrc = 'S', 'S'
			if mask&AxisMove != 0 {
				want.MoveSrc = 'H'
			}
			if mask&AxisAim != 0 {
				want.TurretSrc = 'H'
			}
			if got != want {
				t.Fatalf("got %+v want %+v", got, want)
			}
			c.Assist = false
			got = c.resolve()
			want = ArbitratedInput{MoveSrc: '-', TurretSrc: '-'}
			setAxes(&want, human, mask)
			if mask&AxisMove != 0 {
				want.MoveSrc = 'H'
			}
			if mask&AxisAim != 0 {
				want.TurretSrc = 'H'
			}
			if got != want {
				t.Fatalf("assist off: got %+v want %+v", got, want)
			}
		})
	}
}
func TestScriptPointerSemanticsAndHumanPersistence(t *testing.T) {
	s := NewSim(1, []uint32{1}, nil)
	s.AssistToggle(1) // scripts are opt-in: arbitration requires assist on
	move := Vec2{1, 0}
	aim := 1.0
	if !s.ApplyScriptCommands(1, ScriptCommands{Move: &move, Aim: &aim, Fire: ptr(true), Shield: ptr(true)}) {
		t.Fatal("script rejected")
	}
	move.X, aim = 0, 2
	s.Tick()
	out := s.Arbitrated(1)
	if out.Move.X != 1 || out.Aim != 1 || !out.Fire || !out.Shield {
		t.Fatalf("script alias %+v", out)
	}
	s.ApplyScriptCommands(1, ScriptCommands{})
	s.Tick()
	if s.Arbitrated(1) != out {
		t.Fatal("nil lost held script state")
	}
	s.ApplyScriptCommands(1, ScriptCommands{Move: ptr(Vec2{}), Fire: ptr(false), Shield: ptr(false)})
	s.Tick()
	if out = s.Arbitrated(1); out.Move != (Vec2{}) || out.Fire || out.Shield || out.Aim != 1 {
		t.Fatalf("zero/false not respected %+v", out)
	}
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisMove), MoveY: 1000})
	s.ApplyScriptCommands(1, ScriptCommands{Move: ptr(Vec2{1, 0}), Aim: ptr(2.0)})
	s.Tick()
	stepTicks(s, 10)
	if out = s.Arbitrated(1); out.Move != (Vec2{0, 1}) || out.MoveSrc != 'H' || out.TurretSrc != 'S' {
		t.Fatalf("human did not retain axis %+v", out)
	}
	s.AssistToggle(1)
	s.Tick()
	if s.robots[0].Control.Assist || s.Arbitrated(1).TurretSrc != '-' {
		t.Fatal("assist off failed")
	}
	s.AssistToggle(1)
	s.ApplyScriptCommands(1, ScriptCommands{Move: ptr(Vec2{1, 0})})
	s.Tick()
	if s.Arbitrated(1).MoveSrc != 'S' {
		t.Fatal("toggle on did not return axis")
	}
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisMove)})
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 3, AxisMask: uint32(AxisAim), Aim: 3})
	s.Tick()
	if out = s.Arbitrated(1); out.Move != (Vec2{}) || out.Aim != 3 || out.MoveSrc != 'H' {
		t.Fatalf("coalesced release lost %+v", out)
	}
	s.ClearScriptAxes(1)
	s.Tick()
	if s.Arbitrated(1).MoveSrc != 'H' {
		t.Fatal("script failure cleared human override")
	}
	if s.ApplyInput(1, &ombv1.ClientInput{Seq: 4, AxisMask: 16}) || s.ApplyScriptCommands(1, ScriptCommands{Aim: ptr(math.NaN())}) {
		t.Fatal("nonfinite or unknown axis accepted")
	}
}
func TestProjectileIntervalEnergySpeedAndRange(t *testing.T) {
	s := NewSim(1, []uint32{1}, nil)
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisFire), Fire: true})
	s.Tick()
	closeFloat(t, s.robots[0].Energy, 95)
	closeFloat(t, s.projectiles[0].Pos.X, .5)
	stepTicks(s, 14)
	if len(s.projectiles) != 1 {
		t.Fatal("fired before 250ms")
	}
	s.Tick()
	if len(s.projectiles) != 2 {
		t.Fatal("no shot after 250ms")
	}
	closeFloat(t, s.robots[0].Energy, 92.5)
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisFire)})
	s.Tick()
	s.projectiles = []Projectile{{ID: 99, Owner: 1, Spread: MaxSpread}}
	for i := 0; i < 32; i++ {
		s.stepProjectiles()
	}
	closeFloat(t, s.projectiles[0].Distance, 16)
	closeFloat(t, s.projectiles[0].Pos.Y, 0)
	s.stepProjectiles()
	if s.projectiles[0].Heading <= 0 || s.projectiles[0].Pos.Y <= 0 {
		t.Fatal("16-20m spread absent")
	}
	for i := 0; i < 6; i++ {
		s.stepProjectiles()
	}
	closeFloat(t, s.projectiles[0].Distance, 19.5)
	s.stepProjectiles()
	if len(s.projectiles) != 0 {
		t.Fatal("projectile survived 20m hard cap")
	}
}
func TestProjectileDamageCircleWallsAndAllEnemies(t *testing.T) {
	for _, tc := range []struct {
		name            string
		y               float64
		wall, protected bool
		damage          float64
	}{
		{name: "inside_radius", y: .59, damage: 12}, {name: "outside_radius", y: .61}, {name: "wall", wall: true}, {name: "invulnerable", protected: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, sink := enemySim(t)
			s.robots[0].Position = Vec2{}
			s.robots[1].Position = Vec2{5, tc.y}
			if tc.wall {
				s.walls = []Wall{{ID: 99, Min: Vec2{2, -1}, Max: Vec2{2.01, 1}}}
			}
			s.robots[1].Combat.Invulnerable = tc.protected
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisFire), Fire: true})
			s.Tick()
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, AxisMask: uint32(AxisFire)})
			stepTicks(s, 12)
			closeFloat(t, s.robots[1].HP, 100-tc.damage)
			count := 0
			for _, ev := range sink.events {
				if h := ev.GetHit(); h != nil {
					count++
					if h.From != 1 || h.To != 2 || h.Dmg != 12 {
						t.Fatalf("bad hit %+v", h)
					}
				}
			}
			if (count == 1) != (tc.damage > 0) {
				t.Fatalf("wrong hit count %d", count)
			}
		})
	}
}
func TestEnergyDashShieldAndPulseNumerics(t *testing.T) {
	t.Run("regen", func(t *testing.T) {
		s := NewSim(0, []uint32{1}, nil)
		s.robots[0].Energy = 0
		stepTicks(s, 60)
		closeFloat(t, s.robots[0].Energy, 10)
	})
	t.Run("dash", func(t *testing.T) {
		s := NewSim(0, []uint32{1}, nil)
		s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAbility), Dash: true})
		s.Tick()
		closeFloat(t, s.robots[0].Energy, 80)
		closeFloat(t, s.robots[0].Velocity.Len(), 16)
		stepTicks(s, 17)
		closeFloat(t, s.robots[0].Position.X, 4.8)
		s.Tick()
		if s.robots[0].Velocity.Len() > 8 {
			t.Fatal("dash lasted beyond .30s")
		}
		stepTicks(s, 131)
		if s.robots[0].Combat.DashReady != 151 {
			t.Fatal("dash reset before 2.5s")
		}
		s.Tick()
		if s.robots[0].Combat.DashReady != 301 {
			t.Fatal("dash not ready at 2.5s")
		}
		closeFloat(t, s.robots[0].Velocity.Len(), 16)
	})
	t.Run("shield", func(t *testing.T) {
		s, _ := enemySim(t)
		s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(allAxes), MoveX: 1000, Fire: true, Shield: true})
		s.Tick()
		closeFloat(t, s.robots[0].Energy, 99.7)
		s.damage(2, &s.robots[0], 12)
		closeFloat(t, s.robots[0].HP, 95.8)
		stepTicks(s, 59)
		closeFloat(t, s.robots[0].Energy, 99.7+59*(10.0-18.0)/60)
		closeFloat(t, s.robots[0].Velocity.Len(), 6.4)
		if len(s.projectiles) != 0 {
			t.Fatal("shield allowed firing")
		}
	})
	t.Run("pulse", func(t *testing.T) {
		s, _ := enemySim(t)
		s.AssistToggle(1)
		s.robots[0].Position = Vec2{}
		s.robots[1].Position = Vec2{31, 0}
		s.robots[2].Position = Vec2{0, 31}
		s.robots[3].Position = Vec2{33, 0}
		s.walls = []Wall{{ID: 99, Min: Vec2{-1, 10}, Max: Vec2{1, 11}}}
		s.ApplyScriptCommands(1, ScriptCommands{PulseScan: true})
		s.Tick()
		closeFloat(t, s.robots[0].Energy, 88)
		world := s.WorldView()
		closeFloat(t, world.ScanRadius(1), 32)
		obs, ok := world.Observe(1)
		if !ok || len(obs.Robots) != 2 || obs.Robots[1].ID != 2 {
			t.Fatalf("pulse wall/range error %+v", obs.Robots)
		}
		s.ApplyScriptCommands(1, ScriptCommands{PulseScan: true})
		s.Tick()
		if s.WorldView().PulseScans[1] {
			t.Fatal("pulse bypassed 2s cooldown")
		}
		closeFloat(t, s.WorldView().ScanRadius(1), 20)
		stepTicks(s, 118)
		s.ApplyScriptCommands(1, ScriptCommands{PulseScan: true})
		s.Tick()
		if !s.WorldView().PulseScans[1] {
			t.Fatal("pulse not ready at 2s")
		}
	})
}
func TestDamageShareAttributionAndThreeSecondRespawn(t *testing.T) {
	tests := []struct {
		name   string
		damage []struct {
			from   uint32
			amount float64
		}
		wantKiller uint32
		wantAssist []uint32
		wantSteal  bool
	}{
		{name: "multiple_sub_half_contributors", damage: []struct {
			from   uint32
			amount float64
		}{{2, 20}, {3, 30}, {1, 50}}, wantKiller: 1, wantAssist: []uint32{2, 3}},
		{name: "exact_half_not_assist", damage: []struct {
			from   uint32
			amount float64
		}{{2, 50}, {1, 50}}, wantKiller: 1},
		{name: "finisher_sub_half_is_steal", damage: []struct {
			from   uint32
			amount float64
		}{{2, 60}, {1, 40}}, wantKiller: 1, wantSteal: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := NewSim(7, []uint32{1, 2, 3, 4}, nil)
			victim := &s.robots[3]
			for _, hit := range tc.damage {
				s.damage(hit.from, victim, hit.amount)
			}
			kill := s.events[len(s.events)-1].GetKill()
			if kill == nil || kill.Killer != tc.wantKiller || kill.Victim != 4 || !reflect.DeepEqual(append([]uint32{}, kill.Assists...), append([]uint32{}, tc.wantAssist...)) || kill.KillSteal != tc.wantSteal || kill.Assist != 0 {
				t.Fatalf("bad attribution %+v", kill)
			}
		})
	}

	s, sink := enemySim(t)
	m := gameMap()
	if err := s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	s.Tick()
	s.events = nil
	s.damage(2, &s.robots[2], 25)
	s.robots[2].HP = 40 // healing does not clear lifetime damage ledger
	s.damage(1, &s.robots[2], 40)
	kill := s.events[len(s.events)-1].GetKill()
	if kill == nil || kill.KillSteal || !reflect.DeepEqual(kill.Assists, []uint32{2}) {
		t.Fatalf("healed lifetime attribution lost: %+v", kill)
	}
	if s.robots[2].Combat.RespawnAt != 181 {
		t.Fatal("respawn deadline not 3s")
	}
	stepTicks(s, 179)
	if s.robots[2].State != Dead {
		t.Fatal("respawn too early")
	}
	s.Tick()
	r := s.robots[2]
	if r.State != Alive || r.HP != 100 || r.Energy != 100 || !r.Combat.Invulnerable || len(r.Combat.DamageBy) != 0 || !m.Sectors[2].SpawnArea.Contains(r.Position) {
		t.Fatalf("bad respawn %+v", r)
	}
	if sink.events[len(sink.events)-1].GetRespawn() == nil {
		t.Fatal("missing respawn event")
	}
}

func TestDamageLedgerCountsOnlyEffectiveEnemyDamage(t *testing.T) {
	s := NewSim(0, []uint32{1, 2}, nil)
	victim := &s.robots[1]
	victim.HP = 10
	s.damage(1, victim, 100)
	closeFloat(t, victim.Combat.DamageBy[1], 10)

	s = NewSim(0, []uint32{1, 2}, nil)
	victim = &s.robots[1]
	victim.Combat.ShieldOn = true
	s.damage(1, victim, 12)
	closeFloat(t, victim.Combat.DamageBy[1], 12*ShieldDamageScale)

	s = NewSim(0, []uint32{1, 2}, nil)
	victim = &s.robots[1]
	victim.Combat.Invulnerable = true
	s.damage(1, victim, 12)
	s.damage(2, victim, 12)
	if len(victim.Combat.DamageBy) != 0 {
		t.Fatalf("ineffective/self damage entered ledger: %v", victim.Combat.DamageBy)
	}
}
func TestInvulnerabilityThreeRulesAndDeathAxes(t *testing.T) {
	s, _ := enemySim(t)
	s.Respawn(1)
	s.Tick()
	stepTicks(s, 300)
	if !s.robots[0].Combat.Invulnerable {
		t.Fatal("idle protection expired")
	}
	s.damage(2, &s.robots[0], 12)
	closeFloat(t, s.robots[0].HP, 100)
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(AxisAim), Aim: 1})
	s.Tick()
	first := s.tick
	stepTicks(s, 239)
	if !s.robots[0].Combat.Invulnerable {
		t.Fatal("protection broke before 4s")
	}
	s.Tick()
	if s.robots[0].Combat.Invulnerable || s.tick != first+240 {
		t.Fatal("protection did not break at 4s")
	}
	for _, tc := range []struct {
		name  string
		input *ombv1.ClientInput
	}{{"fire", &ombv1.ClientInput{AxisMask: uint32(AxisFire), Fire: true}}, {"interact", &ombv1.ClientInput{AxisMask: uint32(AxisAbility), Interact: true}}} {
		t.Run(tc.name, func(t *testing.T) {
			x := NewSim(0, []uint32{1}, nil)
			x.Respawn(1)
			x.Tick()
			x.ApplyInput(1, tc.input)
			x.Tick()
			if x.robots[0].Combat.Invulnerable {
				t.Fatal("active action retained invulnerability")
			}
		})
	}
	s.ApplyScriptCommands(1, ScriptCommands{Move: ptr(Vec2{1, 0}), Fire: ptr(true)})
	s.robots[0].Control.Assist = true // death-axis behavior is observed with arbitration active
	s.Tick()
	s.damage(2, &s.robots[0], 100)
	if s.robots[0].Control.Output.Fire || s.robots[0].Control.ScriptAxes != 0 || s.robots[0].Control.HumanAxes != 0 {
		t.Fatal("death retained axes")
	}
	s.ApplyInput(1, &ombv1.ClientInput{Seq: 9, AxisMask: uint32(AxisFire), Fire: true})
	s.Tick()
	if s.Arbitrated(1).Fire || s.WorldView().AckSeqs[1] != 9 {
		t.Fatal("dead input activated or missing ack")
	}
	stepTicks(s, 179)
	if s.Arbitrated(1).Fire || !s.robots[0].Combat.Invulnerable {
		t.Fatal("stale fire escaped respawn")
	}
}
func TestAllRobotsAreEnemiesAndSay(t *testing.T) {
	s := NewSim(0, []uint32{1, 2}, nil)
	s.Tick()
	if s.robots[0].Position.Sub(s.robots[1].Position).Len() < 1.2-1e-8 {
		t.Fatal("robots did not soft separate")
	}
	s.damage(1, &s.robots[1], 12)
	closeFloat(t, s.robots[1].HP, 88)
	obs, ok := s.WorldView().Observe(1)
	if !ok || obs.PartnerID != 0 || obs.IsPartner(2) {
		t.Fatalf("live partner mechanism remains: %+v", obs)
	}
	sink := &recordingSink{}
	s = NewSim(1, []uint32{1}, sink)
	s.AssistToggle(1) // Say flows through script arbitration, which is opt-in
	for i := 0; i < 181; i++ {
		s.ApplyScriptCommands(1, ScriptCommands{Say: ptr("hello")})
		s.Tick()
	}
	ticks := []uint32{}
	for _, ev := range sink.events {
		if msg := ev.GetSay(); msg != nil {
			ticks = append(ticks, ev.Tick)
			if msg.Text != "hello" {
				t.Fatal("say changed")
			}
		}
	}
	if !reflect.DeepEqual(ticks, []uint32{1, 181}) {
		t.Fatalf("say CD %v", ticks)
	}
}

type sayEvent struct {
	*ombv1.EvSay
	Tick uint32
}

func sayEvents(sink *recordingSink) []sayEvent {
	out := []sayEvent{}
	for _, ev := range sink.events {
		if m := ev.GetSay(); m != nil {
			out = append(out, sayEvent{m, ev.Tick})
		}
	}
	return out
}

type capturedControl struct {
	tick, robot uint32
	control     ControlRecord
}

// controlCapture records the ControlRecord stream replay needs for manual say.
type controlCapture struct {
	recordingSink
	controls []capturedControl
}

func (c *controlCapture) OnControl(tick, robotID uint32, control ControlRecord) {
	c.controls = append(c.controls, capturedControl{tick, robotID,
		ControlRecord{Script: cloneCommands(control.Script), ScriptFailed: control.ScriptFailed,
			Toggles: control.Toggles, Respawn: control.Respawn, Say: control.Say}})
}

func TestManualSayQueueValidationAndCooldown(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(3, []uint32{1, 2}, sink)
	// Manual say is a human path independent of assist arbitration.
	if !s.Say(1, "hello") {
		t.Fatal("alive manual say rejected without assist")
	}
	if len(sayEvents(sink)) != 0 {
		t.Fatal("queued say emitted an event outside Tick")
	}
	if s.Say(99, "ghost") || s.Say(2, "") || s.Say(1, " \t ") {
		t.Fatal("unknown robot or blank text accepted")
	}
	if s.Say(1, "second") {
		t.Fatal("second manual say coalesced over a pending one")
	}
	s.Tick()
	evs := sayEvents(sink)
	if len(evs) != 1 || evs[0].Robot != 1 || evs[0].Text != "hello" || evs[0].Tick != 1 {
		t.Fatalf("manual say not emitted on the next tick: %+v", evs)
	}
	// Queueable only when the next tick clears the cooldown: tick+1 >= 181.
	if s.Say(1, "early") {
		t.Fatal("manual say queued during cooldown")
	}
	stepTicks(s, 177) // tick 178: 179 still inside the window
	if s.Say(1, "still early") {
		t.Fatal("manual say queued on the last cooldown tick")
	}
	stepTicks(s, 2) // tick 180: queueable, consumed on tick 181
	if !s.Say(1, "again") {
		t.Fatal("manual say not queueable when cooldown expires")
	}
	s.Tick()
	ticks := []uint32{}
	for _, m := range sayEvents(sink) {
		ticks = append(ticks, m.Tick)
	}
	if !reflect.DeepEqual(ticks, []uint32{1, 181}) {
		t.Fatalf("manual say cooldown ticks %v", ticks)
	}
	// Dead and ended matches never queue.
	d, _ := enemySim(t)
	d.robots[1].State = Dead
	if d.Say(2, "dead") {
		t.Fatal("dead robot queued a say")
	}
	advance(s, MatchTicks)
	if !s.Ended() || s.Say(1, "ended") {
		t.Fatal("ended match queued a say")
	}
}

func TestManualSayQueueDroppedIfKilledBeforeTick(t *testing.T) {
	s, sink := enemySim(t)
	s.Say(1, "pending")
	s.damage(2, &s.robots[0], 100) // death lands before the queued say is consumed
	s.Tick()
	if len(sayEvents(sink)) != 0 {
		t.Fatal("robot spoke on the tick it died")
	}
	if r := mustRobot(t, s, 1); r.Control.PendingSay != "" {
		t.Fatal("dead robot retained a pending manual say")
	}
	if s.Say(1, "still dead") {
		t.Fatal("dead robot queued a say after death")
	}
}

func TestManualSayCooldownSurvivesDeath(t *testing.T) {
	s, sink := enemySim(t)
	if !s.Say(1, "first") {
		t.Fatal("manual say rejected")
	}
	s.Tick() // emitted on tick 1, SayReady = 181
	s.damage(2, &s.robots[0], 100)
	s.Respawn(1)
	s.Tick()          // explicit respawn resets combat but preserves the personal cooldown
	stepTicks(s, 177) // tick 179: queueing would consume on 180, still blocked
	if s.Say(1, "too soon") {
		t.Fatal("say cooldown was reset by death")
	}
	stepTicks(s, 1) // tick 180: queueable, consumed on 181
	if !s.Say(1, "after respawn") {
		t.Fatal("say not queueable after respawn")
	}
	s.Tick()
	ticks := []uint32{}
	for _, m := range sayEvents(sink) {
		ticks = append(ticks, m.Tick)
	}
	if !reflect.DeepEqual(ticks, []uint32{1, 181}) {
		t.Fatalf("death broke the say cooldown schedule: %v", ticks)
	}
}

func TestManualSayNormalizationAndLimit(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(8, []uint32{1}, sink)
	// Blank after normalization is rejected and does not consume the cooldown:
	// a real message queued immediately after still goes out.
	if s.Say(1, " \x07 ") {
		t.Fatal("blank say accepted")
	}
	// Runs of whitespace and control characters collapse to single spaces and trim.
	if !s.Say(1, " \t\r\n a \x01\x02 b \t c ") {
		t.Fatal("whitespace say rejected")
	}
	s.Tick()
	texts := []string{}
	for _, m := range sayEvents(sink) {
		texts = append(texts, m.Text)
	}
	if !reflect.DeepEqual(texts, []string{"a b c"}) {
		t.Fatalf("normalization wrong: %q", texts)
	}
	// The 160 codepoint cap applies to Unicode text, not bytes.
	stepTicks(s, 179) // tick 180: queueable again
	if !s.Say(1, strings.Repeat("中", 200)) {
		t.Fatal("long unicode say rejected")
	}
	s.Tick()
	evs := sayEvents(sink)
	if got := evs[len(evs)-1].Text; got != strings.Repeat("中", 160) {
		t.Fatalf("unicode say not capped at 160 codepoints: %d runes", len([]rune(got)))
	}
	stepTicks(s, 179) // tick 360
	s.Say(1, strings.Repeat("x", 1000))
	s.Tick()
	evs = sayEvents(sink)
	if got := evs[len(evs)-1].Text; got != strings.Repeat("x", 160) {
		t.Fatalf("ascii say not capped at 160 codepoints: %d", len(got))
	}
}

func TestManualSayWinsSameTickAndSharesScriptCooldown(t *testing.T) {
	sink := &recordingSink{}
	s := NewSim(11, []uint32{1}, sink)
	s.AssistToggle(1)
	s.ApplyScriptCommands(1, ScriptCommands{Say: ptr("script")})
	if !s.Say(1, "manual") {
		t.Fatal("manual say rejected")
	}
	s.Tick()
	evs := sayEvents(sink)
	if len(evs) != 1 || evs[0].Text != "manual" || evs[0].Robot != 1 || evs[0].Tick != 1 {
		t.Fatalf("manual say must win the same tick: %+v", evs)
	}
	// Script say shares the same cooldown clock: blocked until tick 181.
	s.ApplyScriptCommands(1, ScriptCommands{Say: ptr("script two")})
	s.Tick()
	if len(sayEvents(sink)) != 1 {
		t.Fatal("script say bypassed the manual say cooldown")
	}
	stepTicks(s, 178) // tick 180: script result consumed on tick 181
	s.ApplyScriptCommands(1, ScriptCommands{Say: ptr("script three")})
	s.Tick()
	evs = sayEvents(sink)
	if len(evs) != 2 || evs[1].Text != "script three" || evs[1].Tick != 181 {
		t.Fatalf("script say not released at cooldown expiry: %+v", evs)
	}
	// The reverse direction: the script-emitted say blocks a manual requeue
	// until the next window (queueable at tick 360, consumed on 361).
	stepTicks(s, 178) // tick 359
	if s.Say(1, "manual early") {
		t.Fatal("manual say bypassed the script say cooldown")
	}
	stepTicks(s, 1) // tick 360
	if !s.Say(1, "manual late") {
		t.Fatal("manual say not queueable after script cooldown")
	}
	s.Tick()
	evs = sayEvents(sink)
	if len(evs) != 3 || evs[2].Text != "manual late" || evs[2].Tick != 361 {
		t.Fatalf("shared cooldown schedule wrong: %+v", evs)
	}
}

func TestManualSayOperatedAndControlRecord(t *testing.T) {
	s := NewSim(12, []uint32{1}, nil)
	s.robots[0].Combat.Invulnerable, s.robots[0].Combat.InvulnUntil = true, 0
	if !s.Say(1, "hi") {
		t.Fatal("manual say rejected")
	}
	s.Tick()
	if s.robots[0].Combat.InvulnUntil != 1+InvulnDuration {
		t.Fatal("successful manual say did not start the protection timer")
	}
	capture := &controlCapture{}
	c := NewSim(9, []uint32{1, 2}, capture)
	c.Say(2, " \t ") // blank says must not produce a control record
	if !c.Say(1, "logged") {
		t.Fatal("manual say rejected")
	}
	c.Tick()
	if len(capture.controls) != 1 {
		t.Fatalf("control records: %+v", capture.controls)
	}
	rec := capture.controls[0]
	if rec.tick != 1 || rec.robot != 1 || rec.control.Say != "logged" {
		t.Fatalf("manual say not logged as a control record: %+v", rec)
	}
	c.Tick()
	if len(capture.controls) != 1 {
		t.Fatal("consumed manual say relogged")
	}
}

func TestPublishedViewsDetachedAndConcurrent(t *testing.T) {
	s := NewSim(5, []uint32{1, 2}, nil)
	m := gameMap()
	m.Uplinks = []UplinkDef{{ID: 90, Pos: Vec2{35, 35}, InteractR: 2.5, ActivePhase: PhaseOuterRing}}
	if err := s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	s.Tick()
	old := s.WorldView()
	old.Frame.Map.CoreRules.GroupWeights[PhaseOuterRing][0] = 999
	old.Robots[0].HpX10 = 0
	old.Uplinks[0].PersonalCDs[1] = 99
	fresh := s.WorldView()
	if fresh.Robots[0].HpX10 != 1000 || fresh.Frame.Map.CoreRules.GroupWeights[PhaseOuterRing][0] != 1 || fresh.Uplinks[0].PersonalCDs[1] != 0 {
		t.Fatal("published view aliases another view")
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 300; j++ {
				v := s.WorldView()
				v.Frame.Map.CoreRules.GroupWeights[PhaseOuterRing][0] = 9
				v.Robots[0].HpX10 = 0
				_ = s.View()
				_ = s.RobotViews()
				v.Observe(1)
			}
		}()
	}
	stepTicks(s, 300)
	wg.Wait()
	if fresh.Frame.Tick != 1 || s.View().Tick != 301 || s.RobotViews()[0].HpX10 != 1000 {
		t.Fatal("view not stable across ticks")
	}
}
