package sim

import (
	"fmt"
	"math"
	"reflect"
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
func enemySim(t *testing.T) (*Sim, *recordingSink) {
	t.Helper()
	sink := &recordingSink{}
	s := NewSim(7, []uint32{1, 2, 3, 4}, sink)
	for i := range s.robots {
		s.robots[i].Combat.Partner = 0
		if err := s.SetSpawn(s.robots[i].ID, Vec2{float64(i) * 30, 50}, uint32(i)); err != nil {
			t.Fatal(err)
		}
	}
	return s, sink
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
func TestProjectileDamageCircleWallsAndPartners(t *testing.T) {
	for _, tc := range []struct {
		name                     string
		y                        float64
		wall, partner, protected bool
		damage                   float64
	}{
		{name: "inside_radius", y: .59, damage: 12}, {name: "outside_radius", y: .61}, {name: "wall", wall: true}, {name: "partner", partner: true}, {name: "invulnerable", protected: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, sink := enemySim(t)
			s.robots[0].Position = Vec2{}
			s.robots[1].Position = Vec2{5, tc.y}
			if tc.wall {
				s.walls = []Wall{{ID: 99, Min: Vec2{2, -1}, Max: Vec2{2.01, 1}}}
			}
			if tc.partner {
				s.robots[0].Combat.Partner = 2
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
func TestKillAssistAndThreeSecondRespawn(t *testing.T) {
	s, sink := enemySim(t)
	m := gameMap()
	if err := s.SetMap(m); err != nil {
		t.Fatal(err)
	}
	s.robots[0].Combat.Partner = 2
	s.robots[1].Combat.Partner = 1
	s.Tick()
	s.events = nil
	s.damage(2, &s.robots[2], 12)
	for i := 0; i < 8; i++ {
		s.damage(1, &s.robots[2], 12)
	}
	kill := s.events[len(s.events)-1].GetKill()
	if kill == nil || kill.Killer != 1 || kill.Victim != 3 || kill.Assist != 2 {
		t.Fatalf("bad assist kill %+v", kill)
	}
	if s.robots[2].HP != 0 || s.robots[2].State != Dead {
		t.Fatal("nine 12 damage hits did not kill")
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
	if r.State != Alive || r.HP != 100 || r.Energy != 100 || !r.Combat.Invulnerable || !m.Sectors[2].SpawnArea.Contains(r.Position) {
		t.Fatalf("bad respawn %+v", r)
	}
	if sink.events[len(sink.events)-1].GetRespawn() == nil {
		t.Fatal("missing respawn event")
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
func TestPartnersFixedFriendlyFireSoftCollisionAndSay(t *testing.T) {
	a := NewSim(99, []uint32{4, 1, 3, 2}, nil)
	b := NewSim(99, []uint32{1, 2, 3, 4}, nil)
	if !reflect.DeepEqual(a.WorldView().Partners, b.WorldView().Partners) {
		t.Fatal("pairing not deterministic")
	}
	pairs := a.WorldView().Partners
	for id, p := range pairs {
		if p == 0 || p == id || pairs[p] != id {
			t.Fatal("invalid reciprocal pair")
		}
	}
	s := NewSim(0, []uint32{1, 2}, nil)
	s.Tick()
	if s.robots[0].Position.Sub(s.robots[1].Position).Len() < 1.2-1e-8 {
		t.Fatal("partners did not soft separate")
	}
	s.damage(1, &s.robots[1], 12)
	closeFloat(t, s.robots[1].HP, 100)
	s.Respawn(1)
	s.Tick()
	if s.PartnerID(1) != 2 {
		t.Fatal("pair changed after respawn")
	}
	sink := &recordingSink{}
	s = NewSim(1, []uint32{1}, sink)
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
	old.Partners[1] = 999
	fresh := s.WorldView()
	if fresh.Robots[0].HpX10 != 1000 || fresh.Frame.Map.CoreRules.GroupWeights[PhaseOuterRing][0] != 1 || fresh.Uplinks[0].PersonalCDs[1] != 0 || fresh.Partners[1] != 2 {
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
				_ = s.PartnerID(1)
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
