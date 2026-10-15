package sim

import "testing"

func TestShieldMinimumAndCooldown(t *testing.T) {
	simulation := NewSim(1, []uint32{1}, nil)
	robot := &simulation.robots[0]
	robot.Control.Output.Shield = true
	simulation.tick = 1
	simulation.prepareCombat()
	robot.Control.Output.Shield = false
	for tick := uint32(2); tick <= 3; tick++ {
		simulation.tick = tick
		simulation.prepareCombat()
		if !robot.Combat.ShieldOn {
			t.Fatalf("shield ended before minimum at tick %d", tick)
		}
	}
	simulation.tick = 4
	simulation.prepareCombat()
	if robot.Combat.ShieldOn {
		t.Fatal("shield did not release")
	}
	robot.Control.Output.Shield = true
	for tick := uint32(5); tick < 16; tick++ {
		simulation.tick = tick
		simulation.prepareCombat()
		if robot.Combat.ShieldOn {
			t.Fatalf("cooldown bypass at tick %d", tick)
		}
	}
	simulation.tick = 16
	simulation.prepareCombat()
	if !robot.Combat.ShieldOn {
		t.Fatal("200ms cooldown was extended by requests")
	}
}

func TestShieldCooldownInterpolation(t *testing.T) {
	for _, sample := range []struct{ duration, cooldown uint32 }{{3, 12}, {4, 13}, {300, 96}, {600, 180}, {900, 180}} {
		simulation := NewSim(1, []uint32{1}, nil)
		robot := &simulation.robots[0]
		robot.Control.Output.Shield = true
		for tick := uint32(1); tick <= sample.duration; tick++ {
			simulation.tick = tick
			robot.Energy = MaxEnergy
			simulation.prepareCombat()
		}
		robot.Control.Output.Shield = false
		simulation.tick = sample.duration + 1
		simulation.prepareCombat()
		robot.Control.Output.Shield = true
		for offset := uint32(1); offset < sample.cooldown; offset++ {
			simulation.tick = sample.duration + 1 + offset
			simulation.prepareCombat()
			if robot.Combat.ShieldOn {
				t.Fatalf("duration %d: cooldown shorter than %d", sample.duration, sample.cooldown)
			}
		}
		simulation.tick = sample.duration + 1 + sample.cooldown
		simulation.prepareCombat()
		if !robot.Combat.ShieldOn {
			t.Fatalf("duration %d: cooldown exceeded %d", sample.duration, sample.cooldown)
		}
	}
}

func TestLegacyShieldStillReleasesImmediately(t *testing.T) {
	simulation := NewSim(1, []uint32{1}, nil)
	simulation.simulationVersion = 5
	robot := &simulation.robots[0]
	robot.Control.Output.Shield = true
	simulation.tick = 1
	simulation.prepareCombat()
	robot.Control.Output.Shield = false
	simulation.tick = 2
	simulation.prepareCombat()
	if robot.Combat.ShieldOn {
		t.Fatal("legacy shield timing changed")
	}
}
