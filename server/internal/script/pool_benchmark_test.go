package script

import (
	"fmt"
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

const heavyPoolSize = 64

func heavyBenchmarkSource(id uint32) string {
	return fmt.Sprintf("const botID = %d, personality = %d;\n", id, id%3) + `
let held = 0;
const cooldowns = {};
function tick(bot) {
  const p = bot.self.position, now = bot.game.time;
  const scan = bot.scan();
  const dist = q => Math.hypot(q.x - p.x, q.y - p.y);
  const unlocked = bot.game.phase === "CORE_OPEN";
  const reachable = q => unlocked || Math.hypot(q.x, q.y) > 29;
  const enemy = bot.nearestEnemy();
  if (held && !scan.uplinks.some(u => u.id === held && u.holder === botID)) {
    cooldowns[held] = now + 30; held = 0;
  }
  const uplinks = scan.uplinks.filter(u => (u.ready || u.holder === botID) && reachable(u) && !(cooldowns[u.id] > now)).sort((a,b) => dist(a)-dist(b));
  const cores = scan.cores.filter(reachable).sort((a,b) => dist(a)-dist(b));
  const uplink = uplinks[0];
  const preferUplink = personality === 0 || Math.floor(now / 20) % 3 === personality;
  if (uplink && dist(uplink) < 1.5) {
    if (uplink.holder === botID) held = uplink.id;
    bot.move(0,0); bot.interact(); return;
  }
  if (enemy && bot.self.energy > 20) { bot.aimAt(enemy); bot.fire(); }
  let target = (preferUplink && uplink) || cores[0] || uplink || (enemy && enemy.position);
  if (!target) {
    const angle = now / 12 + personality * 2.094;
    target = {x: 48 * Math.cos(angle), y: 48 * Math.sin(angle)};
  }
  bot.navigateTo(target);
}
`
}

func heavyBenchmarkFrames() []sim.ScriptFrame {
	robots := make([]sim.RobotView, heavyPoolSize)
	for i := range robots {
		robots[i] = sim.RobotView{
			ID:        uint32(i + 1),
			Pos:       sim.Vec2{X: float64(i%8)*8 - 28, Y: float64(i/8)*8 - 28},
			HpX10:     1000,
			EnergyX10: 1000,
		}
	}
	cores := []sim.CoreView{
		{ID: 1, Pos: sim.Vec2{X: 34, Y: 0}, Alive: true},
		{ID: 2, Pos: sim.Vec2{X: -34, Y: 0}, Alive: true},
		{ID: 3, Pos: sim.Vec2{X: 0, Y: 34}, Alive: true},
		{ID: 4, Pos: sim.Vec2{X: 0, Y: -34}, Alive: true},
	}
	uplinks := []sim.UplinkView{
		{ID: 1, Pos: sim.Vec2{X: 22, Y: 22}, Active: true},
		{ID: 2, Pos: sim.Vec2{X: -22, Y: 22}, Active: true},
		{ID: 3, Pos: sim.Vec2{X: 22, Y: -22}, Active: true},
		{ID: 4, Pos: sim.Vec2{X: -22, Y: -22}, Active: true},
	}
	frames := make([]sim.ScriptFrame, heavyPoolSize)
	for i := range frames {
		obs := sim.Observation{
			Frame:   sim.FrameView{Tick: 120, Phase: sim.PhaseOuterRing, TimeLeftS: 180, Map: &sim.MapDef{Seed: 42}},
			Robots:  robots,
			Cores:   cores,
			Uplinks: uplinks,
		}
		frames[i] = sim.ScriptFrame{Self: robots[i], Obs: obs}
	}
	return frames
}

func BenchmarkRunPool64Heavy(b *testing.B) {
	for _, workers := range []int{8, 16, 24, 32, 64} {
		b.Run(fmt.Sprintf("workers-%d", workers), func(b *testing.B) {
			cfg := Config{PoolSize: workers}
			pool := NewRunPool(cfg)
			defer pool.Close()
			for i := 1; i <= heavyPoolSize; i++ {
				rt := NewGojaRuntime(cfg)
				if err := rt.Load(heavyBenchmarkSource(uint32(i))); err != nil {
					b.Fatalf("load %d: %v", i, err)
				}
				pool.Register(uint32(i), rt)
			}
			frames := heavyBenchmarkFrames()
			b.ReportAllocs()
			b.ResetTimer()
			var deferred, failed int64
			for n := 0; n < b.N; n++ {
				deadline := time.Now().Add(12 * time.Millisecond)
				for i := 1; i <= heavyPoolSize; i++ {
					_ = pool.Submit(uint32(i), frames[i-1], deadline)
				}
				for _, result := range pool.Collect(deadline) {
					if result.Deferred {
						deferred++
					} else if result.Err != nil {
						failed++
					}
				}
			}
			b.StopTimer()
			total := float64(b.N * heavyPoolSize)
			b.ReportMetric(float64(deferred)*100/total, "deferred_pct")
			b.ReportMetric(float64(failed)*100/total, "failed_pct")
		})
	}
}
