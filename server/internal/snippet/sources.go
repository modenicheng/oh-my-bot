package snippet

import (
	"fmt"
	"strings"
)

// 六条官方 Snippet 模块源码定稿（v0.3 §9-2；自动开火与有限半径自动拾取已下线）。
//
// 契约：每条模块是一段独立 JS，定义 `function snippetTick(bot)`；
// 只使用公开 bot API（bot.scan()/bot.self/bot.game/bot.move()/bot.aimAt()/
// bot.fire()/bot.shield()），状态以模块级闭包变量跨 tick 存活。
// combiner 把它们包进独立 IIFE 命名空间与玩家源码组合执行。
//
// 组合优先级（稳定规则）：运行时先执行玩家源码，再按 catalog 顺序
// 执行 snippet；玩家本 tick 已操作的轴会在 snippet 收集器中被丢弃，
// 未操作轴继续由 Snippet 生效（ADR-0009 分轴并存语义）。

// autoAimSource 自动瞄准（无参数）：炮塔直瞄最近可见敌人的当前位置，
// 不做速度预判——提前量外推是玩家/Bot Script 的乐趣，官方模块不越俎。
func autoAimSource(_ Setting) string {
	return `// 官方 Snippet：自动瞄准（直瞄，不预判）
// 教材要点：scan() 免费读取；atan2 定角。提前量要自己拿 velocity 外推，
// 官方模块只负责把炮口指向目标当前位置。
function snippetTick(bot) {
  var target = bot.nearestEnemy();
  if (!target) return;
  var self = bot.self, p = target.position;
  bot.aimAt(Math.atan2(p.y - self.position.y, p.x - self.position.x));
}
`
}

// emergencyShieldSource 紧急护盾：HP ≤ 阈值开盾，恢复到阈值+10 以上关盾。
// （滞回避免在阈值附近抖动；盾不可开火是 sim 层规则，此处只表达意图。）
func emergencyShieldSource(cfg Setting) string {
	return fmt.Sprintf(`// 官方 Snippet：紧急护盾（hpThreshold=%.0f）
// 教材要点：护盾减伤 65%% 但不可开火；滞回防止阈值抖动来回切换。
function snippetTick(bot) {
  var hp = bot.self.hp;
  if (hp <= %.0f) bot.shield(true);
  else if (hp >= %.0f) bot.shield(false);
}
`, cfg.P1, cfg.P1, cfg.P1+10)
}

// dangerAvoidSource 危险规避：威胁半径内有敌人或来袭弹丸时朝安全侧移动。
func dangerAvoidSource(cfg Setting) string {
	return fmt.Sprintf(`// 官方 Snippet：危险规避（radius=%.1fm）
// 教材要点：威胁 = 半径内敌人或来袭弹丸；沿威胁合力的反方向脱离。
function snippetTick(bot) {
  var self = bot.self, r = %.1f, fx = 0, fy = 0, threat = false;
  var scan = bot.scan();
  for (var i = 0; i < scan.robots.length; i++) {
    var e = scan.robots[i];
    var dx = self.position.x - e.position.x, dy = self.position.y - e.position.y;
    var d = Math.hypot(dx, dy);
    if (d > r || d < 0.001) continue;
    threat = true; fx += dx / d; fy += dy / d;
  }
  for (var j = 0; j < scan.projectiles.length; j++) {
    var p = scan.projectiles[j];
    var dx = self.position.x - p.x, dy = self.position.y - p.y;
    var d = Math.hypot(dx, dy);
    if (d > r || d < 0.001) continue;
    threat = true; fx += dx / d; fy += dy / d;
  }
  if (!threat) return;
  var n = Math.hypot(fx, fy);
  if (n > 0.001) bot.move(fx / n, fy / n);
}
`, cfg.P1, cfg.P1)
}

// patrolSource 简单巡逻：顺序走向各路径点（到达 1.5m 内切下一个）。
func patrolSource(cfg Setting) string {
	pts, _ := ParseWaypoints(cfg.S1)
	if len(pts) == 0 {
		pts, _ = ParseWaypoints(patrolDefaultS1)
	}
	var js strings.Builder
	js.WriteString("// 官方 Snippet：简单巡逻\n")
	js.WriteString("// 教材要点：moveTo 便利层 + 模块级状态（当前路径点序号）跨 tick 存活。\n")
	js.WriteString("var waypoints = [")
	for i, p := range pts {
		if i > 0 {
			js.WriteString(", ")
		}
		fmt.Fprintf(&js, "{x:%g,y:%g}", p[0], p[1])
	}
	js.WriteString("];\n")
	js.WriteString(`var idx = 0;
function snippetTick(bot) {
  var w = waypoints[idx];
  var self = bot.self;
  if (Math.hypot(w.x - self.position.x, w.y - self.position.y) < 1.5) {
    idx = (idx + 1) % waypoints.length;
    w = waypoints[idx];
  }
  bot.moveTo({ x: w.x, y: w.y });
}
`)
	return js.String()
}

// globalCoreSource 全局 Core 拾取：scan().cores 已全量公开且只含存活 Core。
func globalCoreSource(_ Setting) string {
	return `// 官方 Snippet：全局 Core 拾取
// 教材要点：scan().cores 恒全量公开且只含存活 Core；拾取靠移动接触，
// 不存在 pickup()。navigateTo({x,y}) 是公开的扁平寻路 API。
function snippetTick(bot) {
  var self = bot.self;
  var cores = bot.scan().cores;
  var best = null, bestD = Infinity;
  for (var i = 0; i < cores.length; i++) {
    var c = cores[i];
    var d = Math.hypot(c.x - self.position.x, c.y - self.position.y);
    if (d < bestD) { best = c; bestD = d; }
  }
  if (best) bot.navigateTo({ x: best.x, y: best.y });
}
`
}

// lowHpHealthPackSource 低血量自动拾取血包：HP ≤ 阈值时前往最近可用点。
func lowHpHealthPackSource(cfg Setting) string {
	return fmt.Sprintf(`// 官方 Snippet：低血量自动拾取血包（hpThreshold=%.0f）
// 教材要点：scan().healthPacks 恒全量公开，但只应前往 available 的点；
// 拾取靠移动接触，navigateTo({x,y}) 负责寻路过去。
function snippetTick(bot) {
  var self = bot.self;
  if (self.hp > %.0f) return;
  var packs = bot.scan().healthPacks;
  var best = null, bestD = Infinity;
  for (var i = 0; i < packs.length; i++) {
    var h = packs[i];
    if (!h.available) continue;
    var d = Math.hypot(h.x - self.position.x, h.y - self.position.y);
    if (d < bestD) { best = h; bestD = d; }
  }
  if (best) bot.navigateTo({ x: best.x, y: best.y });
}
`, cfg.P1, cfg.P1)
}
