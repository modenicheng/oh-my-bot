package script

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// 方法绑定缓存（vmBindings）的行为契约：
//
//  1. bot 壳 / self / game / scan() 返回值每帧、每调用全新（手册 data.md
//     「生命周期」），与旧实现一致；
//  2. 方法对象身份跨 tick 稳定，且始终写入**当帧**的命令收集器；
//  3. 跨 tick 持有的方法引用在下一 tick 调用时作用正确（帧数据切换）；
//  4. Scan 快照对象之间互不共享（含 pulseScan 与 scan）；
//  5. Snippet 阶段与玩家阶段各拿独立 hooks 视图（玩家轴丢弃语义不变）。

func TestMethodIdentityStableAcrossTicks(t *testing.T) {
	rt := NewGojaRuntime(Config{})
	if err := rt.Load(`var prevMove, prevScan, prevBot;
function tick(bot) {
  if (prevMove !== undefined) {
    if (bot.move !== prevMove) throw new Error("bot.move identity changed across ticks");
    if (bot.scan !== prevScan) throw new Error("bot.scan identity changed across ticks");
    if (bot.move !== prevBot.move) throw new Error("method not shared across bot shells");
  }
  prevMove = bot.move; prevScan = bot.scan; prevBot = bot;
}`); err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	f1 := testFrame()
	if _, err := rt.Tick(f1); err != nil {
		t.Fatal(err)
	}
	f2 := testFrame()
	f2.Self.Pos = sim.Vec2{X: 3, Y: 4}
	if _, err := rt.Tick(f2); err != nil {
		t.Fatal(err)
	}
	if _, err := rt.Tick(f2); err != nil {
		t.Fatal(err)
	}
}

func TestHeldMethodWritesCurrentTickCollector(t *testing.T) {
	// 脚本把 bot.fire 存到全局，下一 tick 只调旧引用：命令必须写入当帧。
	rt := NewGojaRuntime(Config{})
	if err := rt.Load(`
var heldFire = null;
function tick(bot) {
  if (!heldFire) { heldFire = bot.fire; return; } // 第一帧：只存引用
  heldFire();                                     // 第二帧：调旧引用
}`); err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	frame := testFrame()
	if cmds, err := rt.Tick(frame); err != nil {
		t.Fatal(err)
	} else if cmds.Fire != nil {
		t.Fatal("first tick should not fire")
	}
	cmds, err := rt.Tick(frame)
	if err != nil {
		t.Fatal(err)
	}
	if cmds.Fire == nil || !*cmds.Fire {
		t.Fatal("held fire reference must write into the current tick collector")
	}
}

func TestHeldNavigateUsesCurrentFrame(t *testing.T) {
	// 跨 tick 持有的 navigateTo 引用必须使用当帧的 self 位置。
	rt := NewGojaRuntime(Config{})
	if err := rt.Load(`
var nav = null;
function tick(bot) {
  if (!nav) { nav = bot.navigateTo; }
  nav({x: 100, y: 0}); // 目标在正东；self 位置决定输出方向
}`); err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	frame := testFrame() // self (10,0)
	if cmds, err := rt.Tick(frame); err != nil {
		t.Fatal(err)
	} else if cmds.Move == nil || cmds.Move.X < 0.99 {
		t.Fatalf("tick1 move = %+v, want +x", cmds.Move)
	}
	// 第二帧 self 在目标东侧：方向应翻转为 -x（证明读的是当帧位置）。
	frame2 := testFrame()
	frame2.Self.Pos = sim.Vec2{X: 110, Y: 0}
	if cmds, err := rt.Tick(frame2); err != nil {
		t.Fatal(err)
	} else if cmds.Move == nil || cmds.Move.X > -0.99 {
		t.Fatalf("tick2 move = %+v, want -x (current-frame semantics)", cmds.Move)
	}
}

func TestBotShellFreshEachTick(t *testing.T) {
	// bot/self/scan 仍是每帧新对象：脚本改写上一帧拿到的对象不影响本帧。
	rt := NewGojaRuntime(Config{})
	if err := rt.Load(`
var oldBot = null, oldSelf = null, oldScan = null;
function tick(bot) {
  if (oldBot) {
    if (bot === oldBot) throw new Error("bot shell reused across ticks");
    if (bot.self === oldSelf) throw new Error("self reused across ticks");
    if (bot.scan() === oldScan) throw new Error("scan result reused");
  }
  oldBot = bot; oldSelf = bot.self; oldScan = bot.scan();
}`); err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	for i := 0; i < 3; i++ {
		if _, err := rt.Tick(testFrame()); err != nil {
			t.Fatal(i, err)
		}
	}
}

func TestScanDistinctPerCallAndFromPulseScan(t *testing.T) {
	// 同一 tick 内：scan() 每次调用新对象；pulseScan 与 scan 互为新对象
	//（但 pulseScan 自身共享一份快照，手册允许）。
	rt := NewGojaRuntime(Config{})
	if err := rt.Load(`
function tick(bot) {
  const a = bot.scan();
  const b = bot.scan();
  if (a === b) throw new Error("scan must return fresh object per call");
  if (a.robots === b.robots) throw new Error("scan arrays must not be shared");
  const p1 = bot.pulseScan();
  const p2 = bot.pulseScan();
  if (p1 !== p2) throw new Error("pulseScan should share one snapshot per tick");
  if (p1 === a) throw new Error("pulseScan must not alias scan result");
  if (p1.robots.length !== a.robots.length) throw new Error("pulse/scan shape mismatch");
  // 内容一致性：两次 scan 数据相同（同一冻结 Observation）。
  if (a.tick !== b.tick || a.robots[0].id !== b.robots[0].id) throw new Error("scan content mismatch");
}`); err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	if _, err := rt.Tick(testFrame()); err != nil {
		t.Fatal(err)
	}
}

func TestPlayerAndSnippetPhasesGetIndependentHooks(t *testing.T) {
	// 玩家阶段与 snippet 阶段各自 buildTickContext：snippet 收集器收到
	// 玩家已操作轴的丢弃语义不变（这里验证两阶段命令合并路径正常）。
	rt := NewGojaRuntime(Config{})
	if err := rt.Load(`function tick(bot) { bot.move(1, 0); }`); err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	cmds, err := rt.Tick(testFrame())
	if err != nil {
		t.Fatal(err)
	}
	if cmds.Move == nil || cmds.Move.X < 0.99 {
		t.Fatalf("move = %+v", cmds.Move)
	}
}

func TestAimAtOverloadStillWorks(t *testing.T) {
	// L1 重载走绑定的 hooks：aimAt(entity) 用当帧观测解析角度。
	rt := NewGojaRuntime(Config{})
	if err := rt.Load(`function tick(bot) { const e = bot.nearestEnemy(); if (e) bot.aimAt(e); }`); err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	cmds, err := rt.Tick(testFrame())
	if err != nil {
		t.Fatal(err)
	}
	if cmds.Aim == nil {
		t.Fatal("aimAt(entity) must produce Aim")
	}
}

func TestHotSwapRebuildsBindings(t *testing.T) {
	// Hot Swap 后旧绑定不得写入：Load 成功重建 VM + 绑定，旧函数对象
	// 属于旧 VM，不再可达；新脚本的方法走新绑定。
	rt := NewGojaRuntime(Config{})
	if err := rt.Load(`function tick(bot) { bot.fire(); }`); err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	if cmds, err := rt.Tick(testFrame()); err != nil || cmds.Fire == nil {
		t.Fatalf("tick1: %+v %v", cmds, err)
	}
	if err := rt.Load(`function tick(bot) { bot.dash(); }`); err != nil {
		t.Fatal(err)
	}
	cmds, err := rt.Tick(testFrame())
	if err != nil {
		t.Fatal(err)
	}
	if cmds.Fire != nil {
		t.Fatal("old script's fire must not leak after hot swap")
	}
	if cmds.Dash == nil {
		t.Fatal("new script's dash must work")
	}
}

func TestBindingsReleaseFrameAfterTick(t *testing.T) {
	// tick 结束后 hooks 不再持有帧数据（release 语义）：行为级验证——
	// 下一 tick 前 frame 可被 GC（这里只验证 release 后字段清空，通过
	// 再次 tick 正常工作佐证 bindings 仍可用）。
	rt := NewGojaRuntime(Config{})
	if err := rt.Load(`function tick(bot) { bot.scan(); }`); err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	for i := 0; i < 2; i++ {
		if _, err := rt.Tick(testFrame()); err != nil {
			t.Fatal(i, err)
		}
	}
	if rt.bindings.hooks.frame.Obs.Robots != nil || rt.bindings.hooks.cmd != nil {
		t.Fatal("hooks must be released after tick")
	}
}
