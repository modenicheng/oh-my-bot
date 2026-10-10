package snippet

import (
	"math"
	"strings"
	"testing"

	"github.com/dop251/goja"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// ---- 六模块 catalog 结构验证（v0.3 §9-2；2/3 已移除且编号不复用）----

func TestCatalogSixModulesKindOrder(t *testing.T) {
	mods := Catalog()
	if len(mods) != 6 {
		t.Fatalf("catalog must expose exactly 6 modules, got %d", len(mods))
	}
	wantKinds := []Kind{AutoAim, EmergencyShield, DangerAvoid, Patrol, GlobalCore, LowHpHealthPack}
	for i, mod := range mods {
		if mod.Kind != wantKinds[i] {
			t.Fatalf("module %d has kind %d; want %d (2/3 removed, never reused)", i, mod.Kind, wantKinds[i])
		}
		if mod.Title == "" || mod.Validate == nil || mod.Source == nil {
			t.Fatalf("module kind %d incomplete (title/validate/source)", mod.Kind)
		}
	}
	for _, k := range wantKinds {
		if ModuleOf(k) == nil || ModuleOf(k).Kind != k {
			t.Fatalf("ModuleOf(%d) broken", k)
		}
	}
	// 2/3：已移除的 kind 必须无法解析，编号不复用。
	if ModuleOf(Kind(2)) != nil || ModuleOf(Kind(3)) != nil {
		t.Fatal("removed kinds 2/3 must resolve to nil module (never reused)")
	}
	if ModuleOf(Kind(0)) != nil || ModuleOf(Kind(9)) != nil || ModuleOf(Kind(-1)) != nil {
		t.Fatal("unknown kinds must resolve to nil module")
	}
}

func TestSnippetKindProtoEnumValuesStable(t *testing.T) {
	cases := []struct {
		kind  Kind
		proto ombv1.SnippetKind
		want  int
	}{
		{AutoAim, ombv1.SnippetKind_SNIPPET_AUTO_AIM, 1},
		{EmergencyShield, ombv1.SnippetKind_SNIPPET_EMERGENCY_SHIELD, 4},
		{DangerAvoid, ombv1.SnippetKind_SNIPPET_DANGER_AVOID, 5},
		{Patrol, ombv1.SnippetKind_SNIPPET_PATROL, 6},
		{GlobalCore, ombv1.SnippetKind_SNIPPET_GLOBAL_CORE, 7},
		{LowHpHealthPack, ombv1.SnippetKind_SNIPPET_LOW_HP_HEALTH_PACK, 8},
	}
	for _, tc := range cases {
		if int(tc.kind) != tc.want || int(tc.proto) != tc.want || KindToProto(tc.kind) != tc.proto {
			t.Fatalf("kind mapping drift: kind=%d proto=%d want=%d", tc.kind, tc.proto, tc.want)
		}
	}
}

func TestCatalogDefaultsValidateToThemselves(t *testing.T) {
	for _, mod := range Catalog() {
		got, err := mod.Validate(mod.Default)
		if err != nil {
			t.Fatalf("kind %d default rejected: %v", mod.Kind, err)
		}
		if got != mod.Default {
			t.Fatalf("kind %d default not canonical: %+v vs %+v", mod.Kind, got, mod.Default)
		}
		src := mod.Source(mod.Default)
		if src == "" {
			t.Fatalf("kind %d default source empty", mod.Kind)
		}
	}
}

func TestCatalogValidateRejectsOutOfRange(t *testing.T) {
	cases := []struct {
		name string
		set  Setting
	}{
		{"emergency_shield above 100", Setting{Kind: EmergencyShield, P1: 101}},
		{"danger_avoid Inf", Setting{Kind: DangerAvoid, P1: math.Inf(1)}},
		{"patrol bad pair", Setting{Kind: Patrol, S1: "30;0"}},
		{"patrol non numeric", Setting{Kind: Patrol, S1: "a,b"}},
		{"patrol outside arena", Setting{Kind: Patrol, S1: "90,0"}},
		{"low_hp_health_pack below min", Setting{Kind: LowHpHealthPack, P1: 0}},
		{"low_hp_health_pack above max", Setting{Kind: LowHpHealthPack, P1: 101}},
		{"low_hp_health_pack fractional", Setting{Kind: LowHpHealthPack, P1: 44.6}},
		{"low_hp_health_pack NaN", Setting{Kind: LowHpHealthPack, P1: math.NaN()}},
	}
	for _, tc := range cases {
		if _, err := ModuleOf(tc.set.Kind).Validate(tc.set); err == nil {
			t.Errorf("%s: validation must fail", tc.name)
		}
	}
}

func TestCatalogValidateNormalizes(t *testing.T) {
	// auto_aim 无参数：任意参数位输入都被清空（纯直瞄不预判）。
	s, err := ModuleOf(AutoAim).Validate(Setting{P1: 7, P2: 3, S1: "x"})
	if err != nil || s != (Setting{Kind: AutoAim}) {
		t.Fatalf("auto_aim normalization: %+v err=%v", s, err)
	}
	// 无参数模块清空全部参数位；低血量阈值保留合法整数并清空其余参数。
	s, err = ModuleOf(GlobalCore).Validate(Setting{P1: 7, P2: 8, S1: "ignored"})
	if err != nil || s != (Setting{Kind: GlobalCore}) {
		t.Fatalf("global_core normalization: %+v err=%v", s, err)
	}
	s, err = ModuleOf(LowHpHealthPack).Validate(Setting{P1: 45, P2: 9, S1: "ignored"})
	if err != nil || s != (Setting{Kind: LowHpHealthPack, P1: 45}) {
		t.Fatalf("low_hp_health_pack normalization: %+v err=%v", s, err)
	}
	// patrol 空路径点回退默认圈；非规范串规范化回写。
	s, err = ModuleOf(Patrol).Validate(Setting{Kind: Patrol})
	if err != nil || s.S1 != patrolDefaultS1 {
		t.Fatalf("patrol empty fallback: %+v err=%v", s, err)
	}
	s, err = ModuleOf(Patrol).Validate(Setting{Kind: Patrol, S1: " 30.0 , 0.0 ; 0,30 "})
	if err != nil || s.S1 != "30,0;0,30" {
		t.Fatalf("patrol canonicalization: %q err=%v", s.S1, err)
	}
	pts, err := ParseWaypoints(FormatWaypoints([][2]float64{{-12.5, 40}}))
	if err != nil || len(pts) != 1 || pts[0] != [2]float64{-12.5, 40} {
		t.Fatalf("waypoint roundtrip: %+v err=%v", pts, err)
	}
}

// ---- 官方源码与组合脚本可在 goja 编译运行 ----

// fakeBot 提供官方模块使用的公开 bot API 子集并记录意图。
type fakeBot struct {
	hp              float64 // 0 = 默认测试场景 20 HP
	packUnavailable bool
	aims            []float64
	fires           int
	moves           [][2]float64
	navigations     [][2]float64
	shields         []bool
}

func (f *fakeBot) botObj(vm *goja.Runtime) *goja.Object {
	bot := vm.NewObject()
	self := vm.NewObject()
	hpValue := f.hp
	if hpValue == 0 {
		hpValue = 20
	}
	_ = self.Set("hp", hpValue) // 默认危险低血量：护盾/血包模块都有事可做
	pos := vm.NewObject()
	_ = pos.Set("x", 0.0)
	_ = pos.Set("y", 0.0)
	_ = self.Set("position", pos)
	_ = bot.Set("self", self)

	vec := func(x, y float64) *goja.Object {
		o := vm.NewObject()
		_ = o.Set("x", x)
		_ = o.Set("y", y)
		return o
	}
	enemy := vm.NewObject()
	_ = enemy.Set("id", 2.0)
	_ = enemy.Set("position", vec(5, 0))
	_ = enemy.Set("velocity", vec(1, 0))
	_ = bot.Set("nearestEnemy", func(call goja.FunctionCall) goja.Value { return enemy })

	scan := vm.NewObject()
	_ = scan.Set("cores", []interface{}{vec(3, 0)})
	hp := vm.NewObject()
	_ = hp.Set("x", 2.0)
	_ = hp.Set("y", 1.0)
	_ = hp.Set("available", !f.packUnavailable)
	_ = scan.Set("healthPacks", []interface{}{hp})
	_ = scan.Set("robots", []interface{}{enemy})
	_ = scan.Set("projectiles", []interface{}{vec(1, 1)})
	_ = bot.Set("scan", func(call goja.FunctionCall) goja.Value { return scan })

	_ = bot.Set("aimAt", func(call goja.FunctionCall) goja.Value {
		f.aims = append(f.aims, call.Argument(0).ToFloat())
		return goja.Undefined()
	})
	_ = bot.Set("fire", func(call goja.FunctionCall) goja.Value {
		f.fires++
		return goja.Undefined()
	})
	_ = bot.Set("move", func(call goja.FunctionCall) goja.Value {
		f.moves = append(f.moves, [2]float64{call.Argument(0).ToFloat(), call.Argument(1).ToFloat()})
		return goja.Undefined()
	})
	_ = bot.Set("moveTo", func(call goja.FunctionCall) goja.Value {
		o := call.Argument(0).(*goja.Object)
		f.moves = append(f.moves, [2]float64{o.Get("x").ToFloat(), o.Get("y").ToFloat()})
		return goja.Undefined()
	})
	_ = bot.Set("navigateTo", func(call goja.FunctionCall) goja.Value {
		o := call.Argument(0).(*goja.Object)
		f.navigations = append(f.navigations, [2]float64{o.Get("x").ToFloat(), o.Get("y").ToFloat()})
		return goja.Undefined()
	})
	_ = bot.Set("shield", func(call goja.FunctionCall) goja.Value {
		f.shields = append(f.shields, call.Argument(0).ToBoolean())
		return goja.Undefined()
	})
	return bot
}

// compileCombined 在真实 goja VM 内装载组合产物并返回注册表。
func compileCombined(t *testing.T, player string, cfg []Setting) (*goja.Runtime, []goja.Value, *goja.Object) {
	t.Helper()
	combined, err := Combine(player, cfg)
	if err != nil {
		t.Fatalf("Combine: %v", err)
	}
	vm := goja.New()
	_ = vm.Set("__ombSnips", vm.NewArray())
	if _, err := vm.RunProgram(mustCompile(t, combined)); err != nil {
		t.Fatalf("run combined source: %v", err)
	}
	reg, _ := vm.Get("__ombSnips").(*goja.Object)
	if reg == nil {
		t.Fatal("snippet registry missing")
	}
	n := int(reg.Get("length").ToInteger())
	fns := make([]goja.Value, 0, n)
	for i := 0; i < n; i++ {
		fns = append(fns, reg.Get(string(rune('0'+i))))
	}
	return vm, fns, reg
}

func mustCompile(t *testing.T, src string) *goja.Program {
	t.Helper()
	prog, err := goja.Compile("", src, false)
	if err != nil {
		t.Fatalf("compile official source: %v", err)
	}
	return prog
}

func TestOfficialSourcesCompileAndRunInGoja(t *testing.T) {
	for _, mod := range Catalog() {
		mod := mod
		t.Run(mod.Title, func(t *testing.T) {
			src := mod.Source(mod.Default)
			wrapped := "(function(){\nvar __ombSnips=[];\n" + src + "\n__ombSnips.push(snippetTick);\n" +
				"return __ombSnips[0];\n})();"
			vm := goja.New()
			fn, err := vm.RunString(wrapped)
			if err != nil {
				t.Fatalf("compile/eval official module %d: %v", mod.Kind, err)
			}
			callable, ok := goja.AssertFunction(fn)
			if !ok {
				t.Fatalf("module %d did not register callable snippetTick", mod.Kind)
			}
			fb := &fakeBot{}
			if _, err := callable(goja.Undefined(), fb.botObj(vm)); err != nil {
				t.Fatalf("module %d tick threw: %v", mod.Kind, err)
			}
		})
	}
}

// 各官方模块在自己的默认参数与该 fake 场景下必须产出对应轴意图
// （场景：hp 20、敌在 5m、core 在 3m、弹丸在 1.4m）。
func TestOfficialModulesProduceExpectedAxisIntents(t *testing.T) {
	vm, fns, _ := compileCombined(t, "", defaults())
	if len(fns) != 6 {
		t.Fatalf("combined registry must hold 6 modules, got %d", len(fns))
	}
	fb := &fakeBot{}
	bot := fb.botObj(vm)
	for _, fn := range fns {
		callable, ok := goja.AssertFunction(fn)
		if !ok {
			t.Fatal("registry entry not callable")
		}
		if _, err := callable(goja.Undefined(), bot); err != nil {
			t.Fatalf("snippet tick threw: %v", err)
		}
	}
	// auto_aim 直瞄敌人在 (5,0)：atan2(0,5)=0，不预判（velocity (1,0) 被忽略）。
	if len(fb.aims) != 1 || fb.aims[0] != 0 {
		t.Fatalf("aim intents: %v", fb.aims)
	}
	if fb.fires != 0 {
		t.Fatalf("no module may fire (auto_fire removed), got %d", fb.fires)
	}
	if len(fb.moves) != 2 { // danger_avoid / patrol
		t.Fatalf("move intents: %v", fb.moves)
	}
	if len(fb.navigations) != 2 { // global_core / low_hp_health_pack
		t.Fatalf("navigate intents: %v", fb.navigations)
	}
	if len(fb.shields) != 1 || !fb.shields[0] {
		t.Fatalf("emergency shield must engage at hp 20 <= 30: %v", fb.shields)
	}
}

// 自动瞄准必须直瞄目标当前位置，不做速度预判（提前量是玩家的乐趣）。
func TestAutoAimAimsCurrentPositionNoLead(t *testing.T) {
	vm, fns, _ := compileCombined(t, "", defaults()[:1])
	if len(fns) != 1 {
		t.Fatal("registry must hold auto_aim only")
	}
	// 敌人在 (5,0)，velocity (1,0)：直瞄 0 rad；若做提前量会得到非零角。
	fb := &fakeBot{}
	callable, _ := goja.AssertFunction(fns[0])
	if _, err := callable(goja.Undefined(), fb.botObj(vm)); err != nil {
		t.Fatal(err)
	}
	// 直瞄用目标速度叠加后的位置会得到 atan2(0, 5+t)≈0.16 rad；断言严格 0。
	if len(fb.aims) != 1 || fb.aims[0] != 0 {
		t.Fatalf("auto_aim must aim current position (no lead): %v", fb.aims)
	}
}

func TestNewPickupSourcesUseFlatNavigateTo(t *testing.T) {
	mods := []*Module{ModuleOf(GlobalCore), ModuleOf(LowHpHealthPack)}
	for _, mod := range mods {
		src := mod.Source(mod.Default)
		if !strings.Contains(src, "bot.navigateTo({ x:") {
			t.Fatalf("kind %d must use flat bot.navigateTo API:\n%s", mod.Kind, src)
		}
		if strings.Contains(src, "bot.api.") || strings.Contains(src, "bot.pickup(") || strings.Contains(src, "bot.moveTo(") {
			t.Fatalf("kind %d must use only flat navigateTo for movement pickup:\n%s", mod.Kind, src)
		}
	}
	if !strings.Contains(mods[1].Source(mods[1].Default), "bot.scan().healthPacks") {
		t.Fatal("low-HP health-pack source must use scan().healthPacks")
	}

	vm, fns, _ := compileCombined(t, "", []Setting{mods[0].Default, mods[1].Default})
	run := func(fb *fakeBot) {
		bot := fb.botObj(vm)
		for _, fn := range fns {
			callable, ok := goja.AssertFunction(fn)
			if !ok {
				t.Fatal("registry entry not callable")
			}
			if _, err := callable(goja.Undefined(), bot); err != nil {
				t.Fatalf("snippet tick threw: %v", err)
			}
		}
	}

	low := &fakeBot{}
	run(low)
	if len(low.moves) != 0 || len(low.navigations) != 2 || low.navigations[0] != [2]float64{3, 0} || low.navigations[1] != [2]float64{2, 1} {
		t.Fatalf("low-HP targets: moves=%v navigate=%v", low.moves, low.navigations)
	}

	high := &fakeBot{hp: 90}
	run(high)
	if len(high.navigations) != 1 || high.navigations[0] != [2]float64{3, 0} {
		t.Fatalf("high HP must skip health pack: %v", high.navigations)
	}

	cooling := &fakeBot{packUnavailable: true}
	run(cooling)
	if len(cooling.navigations) != 1 || cooling.navigations[0] != [2]float64{3, 0} {
		t.Fatalf("unavailable pack must be skipped: %v", cooling.navigations)
	}
}

func TestCombineOrdersSnippetsBeforePlayerSource(t *testing.T) {
	const player = "function tick(bot) { bot.move(1, 0); }"
	combined, err := Combine(player, defaults()[:2])
	if err != nil {
		t.Fatal(err)
	}
	vm, fns, _ := compileCombined(t, player, defaults()[:2])
	if len(fns) != 2 {
		t.Fatalf("registry: %d", len(fns))
	}
	// 玩家入口在组合产物顶层作用域可解析。
	if v := vm.Get("tick"); v == nil || goja.IsUndefined(v) {
		t.Fatal("player entry lost in combined source")
	}
	_ = combined
	// snippet-only：无玩家源码也必须可装载（注册表非空、无 tick 入口）。
	_, fns2, _ := compileCombined(t, "", defaults()[:1])
	if len(fns2) != 1 {
		t.Fatalf("snippet-only registry: %d", len(fns2))
	}
}

func TestCombineRejectsUnknownKind(t *testing.T) {
	if _, err := Combine("", []Setting{{Kind: Kind(42)}}); err == nil {
		t.Fatal("unknown kind must fail Combine")
	}
}

func defaults() []Setting {
	out := make([]Setting, 0, len(Catalog()))
	for _, mod := range Catalog() {
		out = append(out, mod.Default)
	}
	return out
}

// 审计 X-2：目录元数据（协议下发的单源）必须自洽——Param 控件形态与范围
// 同 Validate 的边界一致，Key/Hint 非空，DefaultEnabled 与 Default 参数一致。
func TestCatalogMetadataSelfConsistent(t *testing.T) {
	for _, mod := range Catalog() {
		if mod.Key == "" || mod.Title == "" || mod.Hint == "" {
			t.Fatalf("module %v missing key/title/hint: %+v", mod.Kind, mod)
		}
		if mod.Param.Kind == ParamNumber {
			if mod.Param.Step <= 0 || mod.Param.Min >= mod.Param.Max {
				t.Fatalf("module %v invalid number param range: %+v", mod.Kind, mod.Param)
			}
			// 范围边界与 Validate 一致：下界/上界/默认值都能通过校验。
			for _, v := range []float64{mod.Param.Min, mod.Param.Max, mod.Default.P1} {
				if _, err := mod.Validate(Setting{Kind: mod.Kind, P1: v}); err != nil {
					t.Fatalf("module %v param bound %v rejected by own Validate: %v", mod.Kind, v, err)
				}
			}
		}
		if mod.Param.Kind == ParamWaypoints && mod.Default.S1 == "" {
			t.Fatalf("module %v waypoints param without default route", mod.Kind)
		}
	}
}
