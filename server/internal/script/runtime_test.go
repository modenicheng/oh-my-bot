package script

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ---- 测试夹具 ----

func testFrame() sim.ScriptFrame {
	m := &sim.MapDef{Seed: 42}
	obs := sim.Observation{
		Frame: sim.FrameView{Tick: 120, Phase: sim.PhaseOuterRing, TimeLeftS: 180, Map: m},
		Robots: []sim.RobotView{
			{ID: 1, Pos: sim.Vec2{X: 10, Y: 0}, HpX10: 100, EnergyX10: 100},
			{ID: 2, Pos: sim.Vec2{X: 0, Y: 8}, HpX10: 87, EnergyX10: 60},
			{ID: 3, Pos: sim.Vec2{X: -6, Y: -6}, HpX10: 55, EnergyX10: 40},
		},
		PartnerID: 2,
		Cores: []sim.CoreView{
			{ID: 10, Pos: sim.Vec2{X: 30, Y: 0}, Alive: true},
			{ID: 11, Pos: sim.Vec2{X: -30, Y: 5}, Alive: true},
			{ID: 12, Pos: sim.Vec2{X: 0, Y: -30}, Alive: false},
		},
		Uplinks: []sim.UplinkView{
			{ID: 20, Pos: sim.Vec2{X: 15, Y: 15}, Active: true},
			{ID: 21, Pos: sim.Vec2{X: -15, Y: 15}, Active: false, HackingID: 3},
		},
		Projectiles: []sim.ProjView{
			{ID: 30, Pos: sim.Vec2{X: 5, Y: 5}},
		},
	}
	return sim.ScriptFrame{Self: obs.Robots[0], Obs: obs}
}

// loadAndTick 便捷：装载 + 单 tick。
func loadAndTick(t *testing.T, src string, frame sim.ScriptFrame) (sim.ScriptCommands, error) {
	t.Helper()
	rt := NewGojaRuntime(Config{})
	if err := rt.Load(src); err != nil {
		t.Fatalf("Load: %v", err)
	}
	defer rt.Close()
	return rt.Tick(frame)
}

// ---- 基础：入口解析 / L0 指针语义 ----

func TestTickEntryForms(t *testing.T) {
	frame := testFrame()
	cases := []struct {
		name string
		src  string
	}{
		{"top-level function", "var c=0; function tick(ctx){ c++; ctx.api.fire(); }"},
		{"bot object", "var c=0; const bot = { tick(ctx){ c++; ctx.api.fire(); } };"},
		{"manual-style with export stripped", "var c=0;\nconst bot = { tick(ctx){ c++; ctx.api.fire(); } };\nexport default bot;"},
		{"manual-style with import type", "import type { BotModule } from '@omb/bot-api';\nvar c=0;\nconst bot = { tick(ctx){ c++; ctx.api.fire(); } };\nexport default bot;"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmds, err := loadAndTick(t, tc.src, frame)
			if err != nil {
				t.Fatalf("tick: %v", err)
			}
			if cmds.Fire == nil || !*cmds.Fire {
				t.Fatalf("Fire should be set (pointer semantics), got %+v", cmds)
			}
		})
	}
}

func TestPointerSemanticsUntouchedAxes(t *testing.T) {
	// tick 里不调 fire → Fire nil；不调 move → Move nil（仲裁器保留旧控制）。
	cmds, err := loadAndTick(t, "function tick(ctx){ ctx.api.dash(); }", testFrame())
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	if cmds.Fire != nil {
		t.Errorf("Fire must be nil when fire() not called, got %v", *cmds.Fire)
	}
	if cmds.Move != nil {
		t.Errorf("Move must be nil when move() not called")
	}
	if cmds.Dash == nil || !*cmds.Dash {
		t.Errorf("Dash should be set")
	}
	if cmds.Say != nil || cmds.Aim != nil || cmds.Shield != nil || cmds.Interact != nil {
		t.Errorf("untouched axes must be nil: %+v", cmds)
	}
}

func TestSayPassThrough(t *testing.T) {
	cmds, err := loadAndTick(t, `function tick(ctx){ ctx.api.say("hello world"); }`, testFrame())
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	if cmds.Say == nil || *cmds.Say != "hello world" {
		t.Fatalf("Say passthrough failed: %+v", cmds.Say)
	}
}

func TestSelfAndGame(t *testing.T) {
	// 脚本读 ctx.self/ctx.game 并通过 say 回传，验证字段映射。
	src := `function tick(ctx){
		ctx.api.say(ctx.self.hp + "|" + ctx.self.energy + "|" + ctx.self.position.x + "|" +
			ctx.game.time + "|" + ctx.game.phase + "|" + ctx.game.mapSeed);
	}`
	cmds, err := loadAndTick(t, src, testFrame())
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	want := "10|10|10|2|OUTER_RING|42"
	if cmds.Say == nil || *cmds.Say != want {
		t.Fatalf("self/game mapping: got %v want %q", cmds.Say, want)
	}
}

func TestScanObservation(t *testing.T) {
	src := `function tick(ctx){
		var o = ctx.scan();
		var parts = [];
		parts.push("robots=" + o.robots.length);
		parts.push("hp2=" + o.robots[1].hp);
		parts.push("cores=" + o.cores.length);
		parts.push("uplinks=" + o.uplinks.length);
		parts.push("ready0=" + o.uplinks[0].ready);
		parts.push("holder1=" + o.uplinks[1].holder);
		parts.push("proj=" + o.projectiles.length);
		ctx.api.say(parts.join(","));
	}`
	cmds, err := loadAndTick(t, src, testFrame())
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	got := *cmds.Say
	// robots: 3 total - self(1) = 2；cores: 2 alive；uplinks: 2（全部可见，含未激活）。
	want := "robots=2,hp2=5.5,cores=2,uplinks=2,ready0=true,holder1=3,proj=1"
	if got != want {
		t.Fatalf("scan shape: got %q want %q", got, want)
	}
}

// ---- L1 ----

func TestL1MoveToDirectionVector(t *testing.T) {
	// self(10,0) → core(30,0)：单位向量 (1,0)。
	src := `function tick(ctx){ ctx.api.moveTo({x:30, y:0}); }`
	cmds, err := loadAndTick(t, src, testFrame())
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	if cmds.Move == nil {
		t.Fatalf("moveTo must produce Move")
	}
	if cmds.Move.X < 0.999 || cmds.Move.Y > 0.001 {
		t.Fatalf("moveTo(30,0) from (10,0) expect unit (1,0), got %+v", *cmds.Move)
	}
}

func TestL1AimAtEntity(t *testing.T) {
	// 敌 (0,8) 相对 self (10,0)：向量 (-10,8)，atan2(8,-10)。
	src := `function tick(ctx){
		var e = ctx.api.nearestEnemy();
		ctx.api.aimAt(e);
	}`
	cmds, err := loadAndTick(t, src, testFrame())
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	if cmds.Aim == nil {
		t.Fatalf("aimAt(entity) must produce Aim")
	}
	want := math.Atan2(-6, -16) // 唯一敌人 id3(-6,-6) 相对 self(10,0)；id2 是 partner 被排除
	if d := *cmds.Aim - want; d > 1e-9 || d < -1e-9 {
		t.Fatalf("aimAt(entity) angle: got %v want %v", *cmds.Aim, want)
	}
}

func TestL1NearestAndPartner(t *testing.T) {
	src := `function tick(ctx){
		var p = ctx.api.partner();
		var c = ctx.api.nearestCore();
		var u = ctx.api.nearestUplink();
		ctx.api.say(p.id + "," + p.isPartner + "," + c.x + "," + u.x + "," + u.y);
	}`
	cmds, err := loadAndTick(t, src, testFrame())
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	// partner=2(id2,isPartner)、nearestCore=(30,0)、nearestUplink=(15,15)（唯一 Active）。
	if got := *cmds.Say; got != "2,true,30,15,15" {
		t.Fatalf("L1: got %q", got)
	}
}

// ---- 配额 ----

func TestQuotaExceededInterrupts(t *testing.T) {
	rt := NewGojaRuntime(Config{TickTimeout: 30 * time.Millisecond})
	defer rt.Close()
	if err := rt.Load(`function tick(ctx){ var s=0; for(var i=0;;i++){ s+=i; } }`); err != nil {
		t.Fatalf("Load: %v", err)
	}
	start := time.Now()
	cmds, err := rt.Tick(testFrame())
	elapsed := time.Since(start)
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("want ErrQuotaExceeded, got %v", err)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("interrupt too slow: %v", elapsed)
	}
	if !cmdsIsZero(cmds) {
		t.Fatalf("commands must be cleared on quota exceed: %+v", cmds)
	}
	// 中断后 VM 可复用：配额标记已清。
	if err := rt.Load(`function tick(ctx){ ctx.api.fire(); }`); err != nil {
		t.Fatalf("reload after interrupt: %v", err)
	}
	cmds, err = rt.Tick(testFrame())
	if err != nil || cmds.Fire == nil {
		t.Fatalf("VM reuse after interrupt failed: %v %+v", err, cmds)
	}
}

func cmdsIsZero(c sim.ScriptCommands) bool {
	return c.Move == nil && c.Aim == nil && c.Fire == nil && c.Dash == nil &&
		c.Shield == nil && c.Interact == nil && c.Say == nil && !c.PulseScan
}

func TestQuotaConfigurable(t *testing.T) {
	// 1ms 配额对死循环也必须生效。
	rt := NewGojaRuntime(Config{TickTimeout: time.Millisecond})
	defer rt.Close()
	_ = rt.Load(`function tick(ctx){ while(true){} }`)
	_, err := rt.Tick(testFrame())
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("1ms quota: want ErrQuotaExceeded, got %v", err)
	}
}

// ---- Hot Swap / Rev ----

func TestHotSwapCompileFailureKeepsOld(t *testing.T) {
	rt := NewGojaRuntime(Config{})
	defer rt.Close()
	if err := rt.Load(`var state = 0; function tick(ctx){ state++; ctx.api.say("v1:" + state); }`); err != nil {
		t.Fatalf("load v1: %v", err)
	}
	rev1 := rt.Rev()

	// 坏脚本（语法错）。
	if err := rt.Load(`function tick(ctx{`); err == nil {
		t.Fatal("syntax error must fail Load")
	}
	// TS 源码。
	if err := rt.Load("const bot: BotModule = { tick(ctx) { ctx.api.fire(); } };"); err == nil {
		t.Fatal("TS source must be rejected")
	}
	// 缺入口。
	if err := rt.Load(`var x = 1;`); err == nil {
		t.Fatal("missing tick entry must fail Load")
	}
	if rt.Rev() != rev1 {
		t.Fatalf("Rev must not advance on failed Load: %d -> %d", rev1, rt.Rev())
	}

	// 旧版继续跑，模块状态保持。
	cmds, err := rt.Tick(testFrame())
	if err != nil {
		t.Fatalf("old version should keep running: %v", err)
	}
	if got := *cmds.Say; got != "v1:1" {
		t.Fatalf("old script state lost: %q", got)
	}

	// 成功热替换：状态清零（VM 重建），Rev +1。
	if err := rt.Load(`function tick(ctx){ ctx.api.say("v2"); }`); err != nil {
		t.Fatalf("load v2: %v", err)
	}
	if rt.Rev() != rev1+1 {
		t.Fatalf("Rev must advance on success: %d -> %d", rev1, rt.Rev())
	}
	cmds, err = rt.Tick(testFrame())
	if err != nil || *cmds.Say != "v2" {
		t.Fatalf("hot swap to v2 failed: %v %v", err, cmds.Say)
	}
}

func TestRevMonotonic(t *testing.T) {
	rt := NewGojaRuntime(Config{})
	defer rt.Close()
	if rt.Rev() != 0 {
		t.Fatalf("initial Rev should be 0, got %d", rt.Rev())
	}
	prev := rt.Rev()
	for i := 0; i < 5; i++ {
		if err := rt.Load(`function tick(ctx){}`); err != nil {
			t.Fatalf("load: %v", err)
		}
		if rt.Rev() <= prev {
			t.Fatalf("Rev not monotonic: %d then %d", prev, rt.Rev())
		}
		prev = rt.Rev()
	}
}

// ---- 模块状态跨 tick ----

func TestModuleStatePersistsAcrossTicks(t *testing.T) {
	rt := NewGojaRuntime(Config{})
	defer rt.Close()
	if err := rt.Load(`var count = 0; function tick(ctx){ count++; ctx.api.say("n=" + count); }`); err != nil {
		t.Fatalf("Load: %v", err)
	}
	for want := 1; want <= 3; want++ {
		cmds, err := rt.Tick(testFrame())
		if err != nil {
			t.Fatalf("tick %d: %v", want, err)
		}
		if got := *cmds.Say; got != "n="+itoa(want) {
			t.Fatalf("tick %d: got %q", want, got)
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// ---- TS 拒绝 ----

func TestTypeScriptRejection(t *testing.T) {
	tsSources := []string{
		"const bot: BotModule = { tick(ctx) { ctx.api.fire(); } };",
		"function tick(ctx: TickContext): void { ctx.api.fire(); }",
		"export interface Foo { a: number }",
		"type Vec = { x: number };",
		"let hp: number = 10;",
		"const xs: Array<number> = [1];",
		"enum Color { Red }",
	}
	for _, src := range tsSources {
		if err := NewGojaRuntime(Config{}).Load(src); !errors.Is(err, ErrTypeScript) {
			t.Errorf("TS not rejected: %q -> %v", src, err)
		}
	}
	// 手册风格（TS 书写、JS 语义）必须放行：import type / export default 剥除。
	jsOk := "import type { BotModule } from '@omb/bot-api';\nconst bot = { tick(ctx) { ctx.api.fire(); } };\nexport default bot;"
	if err := NewGojaRuntime(Config{}).Load(jsOk); err != nil {
		t.Errorf("manual-style source rejected: %v", err)
	}
}

// ---- 脚本异常 ----

func TestScriptRuntimeErrorClearsCommands(t *testing.T) {
	rt := NewGojaRuntime(Config{})
	defer rt.Close()
	_ = rt.Load(`function tick(ctx){ ctx.api.fire(); throw new Error("boom"); }`)
	cmds, err := rt.Tick(testFrame())
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("script error should propagate: %v", err)
	}
	if !cmdsIsZero(cmds) {
		t.Fatalf("commands must clear on script error: %+v", cmds)
	}
	// 异常不致命：VM 继续可用。
	_ = rt.Load(`function tick(ctx){ ctx.api.dash(); }`)
	if cmds, err := rt.Tick(testFrame()); err != nil || cmds.Dash == nil {
		t.Fatalf("VM must survive script error: %v", err)
	}
}
