package script

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestScanPointDropsExposeFullMap(t *testing.T) {
	_, err := loadAndTick(t, `function tick(bot) {
  const first = bot.scan();
  const again = bot.scan();
  const pulse = bot.pulseScan();
  for (const observation of [first, again, pulse]) {
    const drops = observation.pointDrops;
    if (!Array.isArray(drops) || drops.length !== 3) throw new Error("full-map drops missing");
    if (drops[0].id !== 90 || drops[0].x !== 95 || drops[0].y !== -100 || drops[0].points !== 4) {
      throw new Error("distant drop mapping: " + JSON.stringify(drops[0]));
    }
    if (Object.keys(drops[0]).sort().join(",") !== "id,points,x,y") throw new Error("drop surface drift");
  }
  if (first.pointDrops === again.pointDrops || first.pointDrops[0] === again.pointDrops[0] ||
      first.pointDrops === pulse.pointDrops || first.pointDrops[0] === pulse.pointDrops[0]) {
    throw new Error("drop snapshots shared between scans");
  }
}`, upgradeTestFrame())
	if err != nil {
		t.Fatal(err)
	}
}

func TestScanPointDropsEmpty(t *testing.T) {
	frame := testFrame()
	frame.Obs.Frame.Map = nil
	_, err := loadAndTick(t, `function tick(bot) {
  for (const observation of [bot.scan(), bot.pulseScan()]) {
    if (!Array.isArray(observation.pointDrops) || observation.pointDrops.length !== 0) {
      throw new Error("nil drops must be []");
    }
    if (!Object.isFrozen(observation.pointDrops)) throw new Error("empty drops must be frozen");
  }
  if (bot.nearestPointDrop() !== null) throw new Error("empty nearest must be null");
}`, frame)
	if err != nil {
		t.Fatal(err)
	}
}

func TestNearestPointDropUsesCurrentFrame(t *testing.T) {
	runtime := NewGojaRuntime(Config{})
	defer runtime.Close()
	if err := runtime.Load(`let nearest;
function tick(bot) {
  if (!nearest) nearest = bot.nearestPointDrop;
  if (nearest !== bot.nearestPointDrop) throw new Error("method identity changed");
  const drop = nearest();
  if (!Object.isFrozen(drop)) throw new Error("nearest drop must be frozen");
  bot.say(JSON.stringify(drop));
}`); err != nil {
		t.Fatal(err)
	}
	frame := upgradeTestFrame()
	for _, sample := range []struct {
		position sim.Vec2
		want     string
	}{
		{sim.Vec2{X: 10}, `{"id":91,"x":11,"y":2,"points":2}`},
		{sim.Vec2{X: 100, Y: -100}, `{"id":90,"x":95,"y":-100,"points":4}`},
	} {
		frame.Self.Pos = sample.position
		commands, err := runtime.Tick(frame)
		if err != nil {
			t.Fatal(err)
		}
		if commands.Say == nil || *commands.Say != sample.want {
			t.Fatalf("nearest point drop: got %+v, want %s", commands, sample.want)
		}
	}
}
