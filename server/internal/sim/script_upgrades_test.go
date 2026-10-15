package sim

import (
	"bytes"
	"fmt"
	"reflect"
	"testing"
)

func TestScriptUpgradesMergeAndDetach(t *testing.T) {
	simulation := NewSim(1, []uint32{1}, nil)
	robot := &simulation.robots[simulation.index[1]]
	robot.Upg.Points = 1000
	robot.Combat.Invulnerable = true
	robot.Combat.InvulnUntil = 100
	for range 7 {
		if !simulation.BuyUpgrade(1, TrackSpeed+1) {
			t.Fatal("manual purchase rejected")
		}
	}
	tracks := []uint8{TrackHP + 1, TrackAttack + 1}
	if !simulation.ApplyScriptCommands(1, ScriptCommands{Upgrades: tracks}) {
		t.Fatal("script purchase rejected")
	}
	tracks[0] = TrackEnergy + 1
	simulation.Tick()
	if robot.Upg.Levels != [UpgradeTrackCount]uint8{1, 7, 0, 0, 0} {
		t.Fatalf("manual queue must precede detached script queue within shared cap: %+v", robot.Upg)
	}
	if !robot.Combat.Invulnerable {
		t.Fatal("purchasing must not break spawn invulnerability")
	}
	record := simulation.controlEvents[0].Control
	want := []uint8{2, 2, 2, 2, 2, 2, 2, 1}
	if !reflect.DeepEqual(record.Upgrades, want) || len(record.Script.Upgrades) != 0 {
		t.Fatalf("purchases must be recorded exactly once in canonical order: %+v", record)
	}
	simulation.Tick()
	if robot.Upg.Levels[TrackHP] != 1 {
		t.Fatal("script purchases repeated on next tick")
	}
}

func TestScriptUpgradesBoundedAndCleared(t *testing.T) {
	for _, fail := range []bool{false, true} {
		simulation := NewSim(1, []uint32{1}, nil)
		robot := &simulation.robots[simulation.index[1]]
		robot.Upg.Points = 1000
		tracks := make([]uint8, 20)
		for index := range tracks {
			tracks[index] = TrackHP + 1
		}
		simulation.ApplyScriptCommands(1, ScriptCommands{Upgrades: tracks})
		if got := len(robot.Control.PendingScript.Upgrades); got != MaxUpgradeBuysPerTick {
			t.Fatalf("pending script buys = %d, want %d", got, MaxUpgradeBuysPerTick)
		}
		if fail {
			simulation.BuyUpgrade(1, TrackSpeed+1)
			simulation.ClearScriptAxes(1)
		}
		simulation.Tick()
		if fail {
			if robot.Upg.Levels != [UpgradeTrackCount]uint8{0, 1, 0, 0, 0} {
				t.Fatalf("failed tick must clear only script purchases: %+v", robot.Upg)
			}
		} else if robot.Upg.Levels[TrackHP] != MaxUpgradeBuysPerTick {
			t.Fatalf("script purchase cap not enforced: %+v", robot.Upg)
		}
	}
}

func TestScriptUpgradesWhileDeadOrAssistOff(t *testing.T) {
	for _, dead := range []bool{false, true} {
		simulation := NewSim(1, []uint32{1}, nil)
		robot := &simulation.robots[simulation.index[1]]
		robot.Upg.Points = 5
		simulation.SetAssist(1, false)
		if dead {
			robot.State = Dead
			robot.HP = 0
			robot.Combat.RespawnAt = 100
		}
		simulation.ApplyScriptCommands(1, ScriptCommands{Upgrades: []uint8{1, 1, 1}})
		simulation.Tick()
		if robot.Upg.Levels[TrackHP] != 2 || robot.Upg.Points != 0 {
			t.Fatalf("purchase must ignore axis arbitration and silently reject unaffordable buys: %+v", robot.Upg)
		}
		if dead {
			simulation.Respawn(1)
			simulation.Tick()
			if robot.State != Alive || robot.HP != simulation.maxHPOf(robot) {
				t.Fatalf("respawn must use upgraded maximum: %+v", robot)
			}
		}
	}
}

func TestScriptUpgradesReplay(t *testing.T) {
	var output bytes.Buffer
	log, err := NewMatchEventLogWriter(&output)
	if err != nil {
		t.Fatal(err)
	}
	simulation := NewSim(77, []uint32{1}, log)
	simulation.robots[simulation.index[1]].Upg.Points = 1000
	for tick := range 5 {
		simulation.BuyUpgrade(1, TrackSpeed+1)
		simulation.ApplyScriptCommands(1, ScriptCommands{Upgrades: []uint8{1, 4, 5}})
		if tick == 2 {
			simulation.ClearScriptAxes(1)
		}
		simulation.Tick()
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	replayed, err := ReplayTo(bytes.NewReader(output.Bytes()), simulation.Snapshot().Tick, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(replayed.Snapshot(), simulation.Snapshot()) {
		t.Fatal("script purchases replay differs from live state")
	}
}

func TestScriptUpgradeReplayRejectsNestedPurchases(t *testing.T) {
	for _, tracks := range [][]uint8{{1}, {0}, {6}, {1, 1, 1, 1, 1, 1, 1, 1, 1}} {
		record := diskRecord{
			Type: RecordTypeDiskName(RecordControl), Tick: 1, RobotID: 1,
			Control: &ControlRecord{Script: &ScriptCommands{Upgrades: tracks}, Upgrades: []uint8{1}},
		}
		if err := validateRecord(record); err == nil {
			t.Fatalf("nested purchases must be rejected: %v", tracks)
		}
	}
}

func TestScriptUpgradeCheckpointValidation(t *testing.T) {
	for _, tracks := range [][]uint8{{1, 2, 3, 4, 5}, {0}, {6}, {1, 1, 1, 1, 1, 1, 1, 1, 1}} {
		t.Run(fmt.Sprintf("%v", tracks), func(t *testing.T) {
			simulation := NewSim(1, []uint32{1}, nil)
			checkpoint := simulation.Snapshot()
			checkpoint.Robots[0].Control.ScriptPending = true
			checkpoint.Robots[0].Control.PendingScript = &ScriptCommands{Upgrades: tracks}
			restored, err := RestoreCheckpoint(checkpoint, nil)
			valid := reflect.DeepEqual(tracks, []uint8{1, 2, 3, 4, 5})
			if !valid && err == nil {
				t.Fatalf("malformed pending purchases accepted: %v", tracks)
			}
			if valid && (err != nil || !reflect.DeepEqual(restored.Snapshot(), checkpoint)) {
				t.Fatalf("valid pending purchases must survive restore: %v", err)
			}
		})
	}
}

func TestScriptUpgradesLegacyVersionNoop(t *testing.T) {
	for version := range 5 {
		simulation := NewSim(1, []uint32{1}, nil)
		simulation.simulationVersion = version
		robot := &simulation.robots[simulation.index[1]]
		robot.Upg.Points = 100
		simulation.ApplyScriptCommands(1, ScriptCommands{Upgrades: []uint8{1}})
		simulation.Tick()
		if robot.Upg.Points != 100 || robot.Upg.Levels[TrackHP] != 0 || len(robot.Control.PendingUpgrades) != 0 {
			t.Fatalf("legacy version %d retained unsupported purchases: %+v", version, robot)
		}
	}
}
