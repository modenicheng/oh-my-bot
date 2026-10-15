package script

import (
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/dop251/goja"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestBuyUpgradeRequiresPrimitiveTrack(t *testing.T) {
	_, err := loadAndTick(t, `function tick(bot) {
  if (typeof bot.buyUpgrade !== "function") throw new Error("buyUpgrade missing");
  let coerced = false;
  const invalid = [undefined, null, 1, true, Symbol("hp"), {}, ["hp"],
    new String("hp"), {toString() { coerced = true; return "hp"; }},
    new Proxy({}, {get() { throw new Error("must not inspect objects"); }}),
    "", "HP", " hp", "hp ", "health", "__proto__"];
  for (const track of invalid) {
    let rejected = false;
    try { bot.buyUpgrade(track); } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      rejected = true;
    }
    if (!rejected) throw new Error("invalid track accepted");
  }
  if (coerced) throw new Error("track coerced to string");
  if (bot.buyUpgrade("hp") !== undefined) throw new Error("purchase must return void");
}`, testFrame())
	if err != nil {
		t.Fatal(err)
	}
}

func TestBuyUpgradeAppendsBoundedWireTracksEachTick(t *testing.T) {
	runtime := NewGojaRuntime(Config{})
	defer runtime.Close()
	if err := runtime.Load(`let buy;
function tick(bot) {
  if (!buy) buy = bot.buyUpgrade;
  if (buy !== bot.buyUpgrade || buy !== bot.api.buyUpgrade) throw new Error("method identity changed");
  const tracks = ["hp", "speed", "shield", "attack", "energy"];
  for (let index = 0; index < 100; index++) buy(tracks[index % tracks.length]);
  let rejected = false;
  try { buy(1); } catch (error) { rejected = error instanceof TypeError; }
  if (!rejected) throw new Error("saturated collector skipped track validation");
}`); err != nil {
		t.Fatal(err)
	}
	frame := testFrame()
	frame.Self.Dead = true
	var previous []uint8
	for tick := 0; tick < 2; tick++ {
		commands, err := runtime.Tick(frame)
		if err != nil {
			t.Fatal(err)
		}
		want := []uint8{1, 2, 3, 4, 5, 1, 2, 3}
		if !slices.Equal(commands.Upgrades, want) || effectiveAxes(commands) != 0 || commands.SnippetAxes != 0 {
			t.Fatalf("tick %d purchases: %+v, want %v and no action axes", tick, commands, want)
		}
		if previous != nil && !slices.Equal(previous, want) {
			t.Fatalf("previous tick purchases mutated: %v", previous)
		}
		previous = commands.Upgrades
	}
}

func TestSelfUpgradeSnapshotAndBounty(t *testing.T) {
	frame := testFrame()
	frame.Upg = sim.UpgradeState{Points: 37, Levels: [sim.UpgradeTrackCount]uint8{1, 2, 3, 4, 5}}
	_, err := loadAndTick(t, `function tick(bot) {
  const upgrade = bot.self.upgrade;
  if (upgrade.points !== 37 || !upgrade.bounty ||
      JSON.stringify(upgrade.levels) !== '{"hp":1,"speed":2,"shield":3,"attack":4,"energy":5}') {
    throw new Error("upgrade mapping: " + JSON.stringify(upgrade));
  }
  bot.buyUpgrade("hp");
  if (upgrade.points !== 37 || upgrade.levels.hp !== 1) throw new Error("purchase changed snapshot eagerly");
}`, frame)
	if err != nil {
		t.Fatal(err)
	}
	for track := 0; track < sim.UpgradeTrackCount; track++ {
		for _, level := range []uint8{0, sim.BountyStateLevel - 1, sim.BountyStateLevel, sim.UpgradeMaxLevel} {
			frame := testFrame()
			frame.Upg.Levels[track] = level
			source := fmt.Sprintf(`function tick(bot) { if (bot.self.upgrade.bounty !== %t) throw new Error("bounty threshold wrong"); }`, level >= sim.BountyStateLevel)
			if _, err := loadAndTick(t, source, frame); err != nil {
				t.Fatalf("track %d level %d: %v", track, level, err)
			}
		}
	}
}

func TestUpgradeCostsCachedPerVMAndSnapshotsFresh(t *testing.T) {
	runtime := NewGojaRuntime(Config{})
	defer runtime.Close()
	if err := runtime.Load(`let previous;
function tick(bot) {
  if (previous) {
    if (bot.self.upgrade === previous.upgrade || bot.self.upgrade.levels === previous.upgrade.levels) throw new Error("upgrade snapshot reused");
    if (previous.upgrade.points !== 3 || bot.self.upgrade.points !== 9) throw new Error("snapshot changed");
    if (bot.game.upgradeCosts !== previous.costs) throw new Error("costs allocated per tick");
  }
  previous = {upgrade: bot.self.upgrade, costs: bot.game.upgradeCosts};
}`); err != nil {
		t.Fatal(err)
	}
	frame := testFrame()
	frame.Upg.Points = 3
	if _, err := runtime.Tick(frame); err != nil {
		t.Fatal(err)
	}
	frame.Upg.Points = 9
	if _, err := runtime.Tick(frame); err != nil {
		t.Fatal(err)
	}
	oldBot := runtime.bindings.buildTickContext(frame, newCommandCollector())
	oldCosts := oldBot.Get("game").ToObject(runtime.vm).Get("upgradeCosts")
	if !slices.Equal(oldCosts.Export().([]interface{}), upgradeCostValues()) {
		t.Fatalf("upgradeCosts = %v, want %v", oldCosts.Export(), sim.UpgradeCosts)
	}
	oldVM := runtime.vm
	if err := runtime.Load(`function tick(bot) {}`); err != nil {
		t.Fatal(err)
	}
	newBot := runtime.bindings.buildTickContext(frame, newCommandCollector())
	newCosts := newBot.Get("game").ToObject(runtime.vm).Get("upgradeCosts")
	if runtime.vm == oldVM || oldCosts == newCosts {
		t.Fatal("hot swap reused another VM's cost cache")
	}
}

func upgradeCostValues() []interface{} {
	values := make([]interface{}, len(sim.UpgradeCosts))
	for index, cost := range sim.UpgradeCosts {
		values[index] = int64(cost)
	}
	return values
}

func TestUpgradeReadonlyIgnoresReplacedObjectFreeze(t *testing.T) {
	_, err := loadAndTick(t, `Object.freeze = value => value;
function tick(bot) {
  const upgrade = bot.self.upgrade;
  if (!Object.isFrozen(upgrade) || !Object.isFrozen(upgrade.levels) || !Object.isFrozen(bot.game.upgradeCosts)) {
    throw new Error("module replaced binding freezer");
  }
  for (const observation of [bot.scan(), bot.pulseScan()]) {
    if (!Object.isFrozen(observation.pointDrops) || !Object.isFrozen(observation.pointDrops[0])) throw new Error("mutable drops");
  }
}`, upgradeTestFrame())
	if err != nil {
		t.Fatal(err)
	}
}

func TestBuyUpgradePlayerThenSnippetMerge(t *testing.T) {
	for _, sample := range []struct {
		name   string
		player string
		snips  []string
		want   []uint8
	}{
		{"independent axes", `bot.buyUpgrade("hp"); bot.buyUpgrade("speed"); bot.move(1, 0);`, []string{`bot.buyUpgrade("shield"); bot.move(0, 1);`, `bot.buyUpgrade("attack"); bot.buyUpgrade("energy");`}, []uint8{1, 2, 3, 4, 5}},
		{"shared cap", `for (let index = 0; index < 6; index++) bot.buyUpgrade("hp");`, []string{`for (let index = 0; index < 10; index++) bot.buyUpgrade("speed");`}, []uint8{1, 1, 1, 1, 1, 1, 2, 2}},
		{"player saturated", `for (let index = 0; index < 10; index++) bot.buyUpgrade("hp");`, []string{`bot.buyUpgrade("energy");`}, []uint8{1, 1, 1, 1, 1, 1, 1, 1}},
		{"snippet only", ``, []string{`bot.buyUpgrade("attack");`, `bot.buyUpgrade("energy");`}, []uint8{4, 5}},
	} {
		t.Run(sample.name, func(t *testing.T) {
			runtime := NewGojaRuntime(Config{})
			defer runtime.Close()
			if err := runtime.Load(`function tick(bot) {` + sample.player + `}`); err != nil {
				t.Fatal(err)
			}
			for _, source := range sample.snips {
				value, err := runtime.vm.RunString(`(function(bot) {` + source + `})`)
				if err != nil {
					t.Fatal(err)
				}
				function, ok := goja.AssertFunction(value)
				if !ok {
					t.Fatal("snippet is not callable")
				}
				runtime.snipFns = append(runtime.snipFns, function)
			}
			commands, err := runtime.Tick(testFrame())
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(commands.Upgrades, sample.want) || commands.SnippetAxes != 0 {
				t.Fatalf("merged purchases: %+v, want %v without snippet axis attribution", commands, sample.want)
			}
			if sample.name == "independent axes" && (commands.Move == nil || commands.Move.X != 1 || commands.Move.Y != 0) {
				t.Fatalf("purchase merge changed action-axis priority: %+v", commands)
			}
		})
	}
}

func TestBuyUpgradeFailedTickDiscardsPurchases(t *testing.T) {
	for _, sample := range []struct {
		name   string
		ending string
		quota  bool
	}{
		{"exception", `throw new Error("failed");`, false},
		{"quota", `while (true) {}`, true},
	} {
		t.Run(sample.name, func(t *testing.T) {
			runtime := NewGojaRuntime(Config{TickTimeout: 30 * time.Millisecond})
			defer runtime.Close()
			if err := runtime.Load(`let first = true; function tick(bot) {
if (!first) return;
first = false;
bot.buyUpgrade("hp");` + sample.ending + `}`); err != nil {
				t.Fatal(err)
			}
			commands, err := runtime.Tick(testFrame())
			if err == nil || (sample.quota && !errors.Is(err, ErrQuotaExceeded)) || len(commands.Upgrades) != 0 {
				t.Fatalf("failed tick returned purchases: %+v, %v", commands, err)
			}
			commands, err = runtime.Tick(testFrame())
			if err != nil || len(commands.Upgrades) != 0 {
				t.Fatalf("failed purchases leaked to next tick: %+v, %v", commands, err)
			}
		})
	}
}

func TestBuyUpgradeSnippetFailureDiscardsSnippetPurchases(t *testing.T) {
	for _, sample := range []struct {
		name   string
		ending string
		quota  bool
	}{
		{"exception", `throw new Error("failed snippet");`, false},
		{"quota", `while (true) {}`, true},
	} {
		t.Run(sample.name, func(t *testing.T) {
			runtime := NewGojaRuntime(Config{TickTimeout: 30 * time.Millisecond})
			defer runtime.Close()
			if err := runtime.Load(`function tick(bot) { bot.buyUpgrade("hp"); bot.move(1, 0); }`); err != nil {
				t.Fatal(err)
			}
			value, err := runtime.vm.RunString(`(function(bot) { bot.buyUpgrade("speed"); bot.fire(); ` + sample.ending + `})`)
			if err != nil {
				t.Fatal(err)
			}
			function, ok := goja.AssertFunction(value)
			if !ok {
				t.Fatal("snippet is not callable")
			}
			runtime.snipFns = []goja.Callable{function}
			commands, err := runtime.Tick(testFrame())
			if sample.quota {
				if !errors.Is(err, ErrQuotaExceeded) || len(commands.Upgrades) != 0 || commands.Move != nil {
					t.Fatalf("snippet quota retained commands: %+v, %v", commands, err)
				}
			} else if err != nil || !slices.Equal(commands.Upgrades, []uint8{1}) || commands.Move == nil || commands.Fire != nil {
				t.Fatalf("snippet exception must retain only player commands: %+v, %v", commands, err)
			}
		})
	}
}

func TestRobotRefMaxVitals(t *testing.T) {
	frame := testFrame()
	frame.Obs.Robots[1].MaxHpX10 = 1805
	frame.Obs.Robots[1].MaxEnergyX10 = 2007
	_, err := loadAndTick(t, `function tick(bot) {
  const seen = bot.scan().robots[0];
  const nearest = bot.nearestEnemy();
  for (const robot of [seen, nearest, bot.pulseScan().robots[0]]) {
    if (robot.id !== 2 || robot.maxHp !== 180.5 || robot.maxEnergy !== 200.7) {
      throw new Error("max vitals mapping: " + JSON.stringify(robot));
    }
    if ("upgrade" in robot || "levels" in robot || "points" in robot || "bounty" in robot) {
      throw new Error("private upgrade state leaked");
    }
  }
}`, frame)
	if err != nil {
		t.Fatal(err)
	}
}

func upgradeTestFrame() sim.ScriptFrame {
	frame := testFrame()
	frame.Obs.PointDrops = []sim.PointDropView{
		{ID: 90, Pos: sim.Vec2{X: 95, Y: -100}, Points: 4},
		{ID: 91, Pos: sim.Vec2{X: 11, Y: 2}, Points: 2},
		{ID: 92, Pos: sim.Vec2{X: 9, Y: -2}, Points: 1},
	}
	return frame
}
