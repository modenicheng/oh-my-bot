package script

import (
	"math"
	"os"
	"strings"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// 验证手册示例 predictive-shield.ts 能过真实装载管线（TS 剥离 + goja），
// 并在合成弹道下验证预测逻辑：正面来弹开盾、远离弹/掠过弹/自己的弹不开盾。
//
// TS 示例按客户端提交管线转 JS：import type / 类型注解剥除（与服务端
// stripModuleSyntax + Monaco emit 清理等价的最小手工转换）。
func toJsExample(src string) string {
	lines := strings.Split(src, "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "import type") {
			continue
		}
		out = append(out, l)
	}
	joined := strings.Join(out, "\n")
	joined = strings.ReplaceAll(joined, "function tick(bot: BotContext) {", "function tick(bot) {")
	return joined
}

func TestPredictiveShieldExampleLoads(t *testing.T) {
	raw, err := os.ReadFile("../../cmd/omb/manual/examples/predictive-shield.ts")
	if err != nil {
		t.Skipf("example not readable: %v", err)
	}
	rt := NewGojaRuntime(Config{})
	if err := rt.Load(toJsExample(string(raw))); err != nil {
		t.Fatalf("Load predictive-shield.js: %v", err)
	}
	defer rt.Close()

	self := sim.RobotView{ID: 1, Pos: sim.Vec2{X: 10, Y: 0}, HpX10: 100, EnergyX10: 100}
	mk := func(projs ...sim.ProjView) sim.ScriptFrame {
		return sim.ScriptFrame{Self: self, Obs: sim.Observation{
			Frame:       sim.FrameView{Tick: 100, Map: &sim.MapDef{Seed: 7}},
			Projectiles: projs,
		}}
	}

	// 场景 A：敌弹 5m 外正面飞来（heading=π 沿 -x）→ 命中窗口内 → 开盾。
	cmds, err := rt.Tick(mk(sim.ProjView{ID: 50, Owner: 2, Pos: sim.Vec2{X: 15, Y: 0}, Heading: math.Pi}))
	if err != nil {
		t.Fatalf("tick A: %v", err)
	}
	if cmds.Shield == nil || !*cmds.Shield {
		t.Fatalf("incoming projectile should raise shield, got %+v", cmds.Shield)
	}

	// 场景 B：第二帧弹更近（位移差分路径）→ 仍开盾不炸。
	cmds, err = rt.Tick(mk(sim.ProjView{ID: 50, Owner: 2, Pos: sim.Vec2{X: 14.5, Y: 0}, Heading: math.Pi}))
	if err != nil {
		t.Fatalf("tick B: %v", err)
	}
	if cmds.Shield == nil || !*cmds.Shield {
		t.Fatalf("closer projectile should keep shield, got %+v", cmds.Shield)
	}

	// 场景 C：弹背向飞行（在找左侧 heading=π 朝 -x 远离）→ 不开盾。
	cmds, err = rt.Tick(mk(sim.ProjView{ID: 51, Owner: 2, Pos: sim.Vec2{X: 5, Y: 0}, Heading: math.Pi}))
	if err != nil {
		t.Fatalf("tick C: %v", err)
	}
	if cmds.Shield != nil && *cmds.Shield {
		t.Fatal("outbound projectile must not raise shield")
	}

	// 场景 D：横向偏离 2.5m > 判定半径的掠过弹 → 不开盾。
	cmds, err = rt.Tick(mk(sim.ProjView{ID: 52, Owner: 2, Pos: sim.Vec2{X: 15, Y: 2.5}, Heading: math.Pi}))
	if err != nil {
		t.Fatalf("tick D: %v", err)
	}
	if cmds.Shield != nil && *cmds.Shield {
		t.Fatal("grazing projectile (2.5m lateral) must not raise shield")
	}

	// 场景 E：自己的弹（owner 过滤）→ 不开盾。
	cmds, err = rt.Tick(mk(sim.ProjView{ID: 53, Owner: 1, Pos: sim.Vec2{X: 15, Y: 0}, Heading: math.Pi}))
	if err != nil {
		t.Fatalf("tick E: %v", err)
	}
	if cmds.Shield != nil && *cmds.Shield {
		t.Fatal("own projectile must not raise shield")
	}
}
