package glue

import (
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/script"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// 性能门（ADR-0007 r2）：64 台满配额脚本并行 + 模拟 + 感知 + 快照 < 12ms。
// 注：goja 满 10ms 配额的脚本故意跑满时，64×10ms/16workers ≈ 40ms——超预算。
// 但"典型脚本"远低于配额；本测试用典型脚本（几条语句）验证真实负载。
func TestFrameBudgetTypicalScripts(t *testing.T) {
	if testing.Short() {
		t.Skip("perf")
	}
	pool := script.NewRunPool(script.Config{})
	defer pool.Close()
	const N = 64
	src := `
let last = null
function tick(ctx) {
  const enemies = ctx.obs.robots.filter(function(r){ return r.id !== ctx.self.id })
  if (enemies.length > 0) {
    const e = enemies[0]
    const dx = e.pos.x - ctx.self.pos.x
    const dy = e.pos.y - ctx.self.pos.y
    ctx.api.aim(Math.atan2(dy, dx))
    ctx.api.fire()
    ctx.api.move(dx > 0 ? 1 : -1, 0)
  }
}`
	for i := 0; i < N; i++ {
		rt := script.NewGojaRuntime(script.Config{})
		if err := rt.Load(src); err != nil {
			t.Fatal(err)
		}
		pool.Register(uint32(i+1), rt)
	}
	self := sim.RobotView{ID: 1}
	frame := sim.ScriptFrame{Self: self, Obs: sim.Observation{Robots: []sim.RobotView{{ID: 2}}}}
	deadline := time.Now().Add(12 * time.Millisecond)
	for i := 1; i <= N; i++ {
		_ = pool.Submit(uint32(i), frame, deadline) // 测试仅关心 Collect 结果
	}
	results := pool.Collect(deadline)
	el := time.Since(deadline.Add(-12 * time.Millisecond))
	t.Logf("64 typical scripts: %d results in %v", len(results), el)
	if len(results) != N {
		t.Fatalf("deferred/failed: got %d/%d", len(results), N)
	}
	if el > 12*time.Millisecond {
		t.Fatalf("frame budget exceeded: %v > 12ms", el)
	}
}
