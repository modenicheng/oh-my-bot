package glue

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/script"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestRunScriptsUpgradeStateAndWarmup(t *testing.T) {
	for _, warmup := range []bool{false, true} {
		t.Run(fmt.Sprintf("warmup=%t", warmup), func(t *testing.T) {
			world := sim.NewSim(1, []uint32{1}, nil)
			checkpoint := world.Snapshot()
			checkpoint.Robots[0].Upg.Points = 10
			world, err := sim.RestoreCheckpoint(checkpoint, nil)
			if err != nil {
				t.Fatal(err)
			}
			pool := script.NewRunPool(script.Config{PoolSize: 1, TickTimeout: time.Second})
			t.Cleanup(pool.Close)
			runtime := script.NewGojaRuntime(script.Config{TickTimeout: time.Second})
			if err := runtime.Load(`function tick(bot) {
  if (bot.self.upgrade.points !== 10 || bot.self.upgrade.levels.hp !== 0) throw new Error("missing private upgrade state");
  bot.buyUpgrade("hp");
  bot.move(1, 0);
}`); err != nil {
				t.Fatal(err)
			}
			pool.Register(1, runtime)
			match := &Match{sim: world, scriptPool: pool, warmup: warmup}
			view := world.WorldView()
			observation, _ := view.Observe(1)
			match.runScripts(view, map[uint32]sim.Observation{1: observation})
			robot, _ := world.Robot(1)
			if robot.Control.PendingScript == nil || robot.Control.PendingScript.Move == nil {
				t.Fatalf("script failed or warmup stripped ordinary actions: %+v", robot.Control)
			}
			wantBuys := 1
			if warmup {
				wantBuys = 0
			}
			if got := len(robot.Control.PendingScript.Upgrades); got != wantBuys {
				t.Fatalf("queued purchases = %d, want %d", got, wantBuys)
			}
			world.Tick()
			robot, _ = world.Robot(1)
			if int(robot.Upg.Levels[sim.TrackHP]) != wantBuys || robot.Upg.Points != int32(10-2*wantBuys) {
				t.Fatalf("warmup purchase result: %+v", robot.Upg)
			}
		})
	}
}

func TestRunScriptsFailedTickDiscardsUpgrade(t *testing.T) {
	world := sim.NewSim(1, []uint32{1}, nil)
	checkpoint := world.Snapshot()
	checkpoint.Robots[0].Upg.Points = 10
	world, err := sim.RestoreCheckpoint(checkpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	pool := script.NewRunPool(script.Config{PoolSize: 1, TickTimeout: time.Second})
	t.Cleanup(pool.Close)
	runtime := script.NewGojaRuntime(script.Config{TickTimeout: time.Second})
	if err := runtime.Load(`function tick(bot) { bot.buyUpgrade("hp"); throw new Error("abort"); }`); err != nil {
		t.Fatal(err)
	}
	pool.Register(1, runtime)
	world.ApplyScriptCommands(1, sim.ScriptCommands{Upgrades: []uint8{1}})
	world.BuyUpgrade(1, sim.TrackSpeed+1)
	match := &Match{sim: world, scriptPool: pool}
	view := world.WorldView()
	observation, _ := view.Observe(1)
	match.runScripts(view, map[uint32]sim.Observation{1: observation})
	world.Tick()
	robot, _ := world.Robot(1)
	if robot.Upg.Levels != [sim.UpgradeTrackCount]uint8{0, 1, 0, 0, 0} || robot.Upg.Points != 8 {
		t.Fatalf("failed tick must discard script purchases but retain human purchases: %+v", robot.Upg)
	}
}

func TestScriptUpgradesFullRosterSmoke(t *testing.T) {
	if os.Getenv("OMB_UPGRADE_LOAD_TEST") != "1" {
		t.Skip("set OMB_UPGRADE_LOAD_TEST=1 for the full-roster upgrade smoke test")
	}
	t.Chdir(t.TempDir())
	hub := NewHub()
	connection := hub.EnsureRoom("UPGRADE-LOAD")
	players := map[uint64]SessionInfo{1: {PlayerID: 1, Nick: "host"}}
	addSoloBots(players, 199)
	if len(players) != 200 {
		t.Fatalf("load roster = %d, want 200", len(players))
	}
	match, err := NewMatch(connection, 42, 1, players, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, match) })
	checkpoint := match.sim.Snapshot()
	checkpoint.MatchTicks = sim.MatchTicks
	for index := range checkpoint.Robots {
		checkpoint.Robots[index].Upg.Points = 100
	}
	match.sim, err = sim.RestoreCheckpoint(checkpoint, match.sink)
	if err != nil {
		t.Fatal(err)
	}
	match.warmup = false
	connection.match = match
	for range 240 {
		match.step()
	}
	upgraded, bounty, totalLevels, maxLevel := 0, 0, 0, uint8(0)
	for _, robot := range match.sim.Snapshot().Robots {
		if !match.botRobots[robot.ID] {
			continue
		}
		hasUpgrade, hasBounty := false, false
		for _, level := range robot.Upg.Levels {
			hasUpgrade = hasUpgrade || level > 0
			hasBounty = hasBounty || level >= sim.BountyStateLevel
			totalLevels += int(level)
			maxLevel = max(maxLevel, level)
		}
		if hasUpgrade {
			upgraded++
		}
		if hasBounty {
			bounty++
		}
	}
	stats := match.StatSnapshot()
	t.Logf("200-player seeded-wallet smoke: upgraded=%d/199 levels=%d max_level=%d bounty=%d drops=%d avg=%.3fms p95=%.3fms deferrals=%d", upgraded, totalLevels, maxLevel, bounty, len(match.sim.WorldView().PointDrops), stats.TickAvgMs, stats.TickP95Ms, stats.ScriptDeferrals)
	if upgraded == 0 {
		t.Fatal("no solo bots upgraded under full-roster load")
	}
}
