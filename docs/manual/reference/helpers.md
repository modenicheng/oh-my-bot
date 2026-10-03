---
title: 便利层参考（L1）
audience: coder
order: 42
tags: [脚本, L1]
---

# 便利层参考（L1）

L1 是 7 个常用便利方法，帮你省掉重复样板代码。大多数直接组合 [L0 原语](actions.md)；`navigateTo` 由服务器算确定性的静态 A* 路径，再输出移动意图。

## moveTo(pos)

**做什么**：沿当前位置到目标点的直线移动。内部把"我到目标点的连线"归一成方向，调用 `move(dx/L, dy/L)`；不检查、也不绕开障碍。

| 参数 | 类型 | 含义 |
|---|---|---|
| `pos` | `{ x, y }` | 目标点世界坐标 |

距离小于一亿分之一米（数学意义上的原地）时不发 move，机器人不动。

朝最近的 Core 直线移动：

```ts
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const core = bot.nearestCore()
  if (core) bot.moveTo(core)
}
```


**游戏规则**：继承 `move` 的全部约束：加速度、限速、非法值拒绝。参数不是 `{ x, y }` 形状时抛异常 `moveTo: expected { x, y }`。

**常见坑**：

- 期待自动绕墙：`moveTo` 是直线移动，墙、竞技场边界或尚未开放的中央区都会挡住它。需要静态寻路时用 `navigateTo`。
- 期待"贴点停靠"：`moveTo` 只表达"朝这走"，不会自动刹车，也不保证到达。到点判定自己写：留个阈值，比如距离 < 2m 就算到了，再留一拍延迟的余量。示例库 `patrol.ts` 是标准写法。

## navigateTo(pos)

**做什么**：由服务器在静态地图上算一条确定性的 A* 路径，沿路径朝目标点移动。

| 参数 | 类型 | 含义 |
|---|---|---|
| `pos` | `{ x, y }` | 目标点世界坐标 |

每帧朝路径的下一步走：

```ts
/** @param {import('@omb/bot-api').BotContext} bot */
function tick(bot) {
  const core = bot.nearestCore()
  if (core) bot.navigateTo(core)
}
```


**游戏规则**：寻路网格和邻居顺序由服务器固定，相同地图、起点、目标和阶段算出相同路径。它避开实体墙、竞技场边界，以及 4:00 前尚未解锁的中央区；中央区开放后按当前阶段重新寻路。资源仍靠移动接触自动拾取，没有 `pickup()`。

**边界**：`moveTo` 是直线移动；`navigateTo` 是服务器确定性的静态 A*，避开实体墙、竞技场边界和尚未解锁的中央区。它不做动态机器人避障、威胁评估、弹道预测。路线上有机器人就可能拥堵或碰撞；到点和刹车仍由脚本按距离阈值控制。

## aimAt(target)

**做什么**：<img class="inline-icon" src="../reference/images/icons/target.png" alt=""> 直接瞄一个看得见的机器人，不用自己算角度。这是 `aimAt` 的实体重载：传数字按角度、传机器人按实体，同一个名字，游戏按参数类型自动区分。

| 参数 | 类型 | 含义 |
|---|---|---|
| `target` | RobotRef | 要瞄准的机器人（必须是可见实体） |

完整语义（弧度约定、非法值处理）见[动作参考 aimAt](actions.md)。

**游戏规则**：传**不可见**的机器人（被墙挡住、超出视野）会当场抛异常 `aimAt: entity not visible`。当帧没接住，该帧全部脚本动作作废。

**常见坑**：先确认目标在 `bot.scan().robots` 里再传。

## nearestEnemy()

**做什么**：找视野内最近的敌人。只搜 20m 视野内，不含自己、不含死者。一个都看不见时返回 `null`。

返回的 RobotRef 带 `id`、`position`、`hp`、`velocity`。朝向拿不到；算弹道提前量直接用目标 `velocity` 外推。

看到敌人才转向开火：

```ts
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const enemy = bot.nearestEnemy()
  if (enemy) {
    bot.aimAt(enemy)
    bot.fire()
  }
}
```


**常见坑**：

- 把它当全图索敌：它只搜 20m 视野。20m 外没有敌人不等于全图安全。
- 返回值是**调用那一刻的快照**：目标下一帧走出视野，你缓存的对象就失效了，再读只会得到过时位置，游戏不保证内容更新。每帧重取，别缓存着长用。

## nearestCore()

**做什么**：找全图最近的**存活** Core 的坐标。Core 不受视野限制，恒全量可见，所以这个方法可以拿来做全局导航。

返回值是**纯坐标 `{ x, y }`**，没有 id。要区分是哪颗 Core（比如记住"我在追第 3 颗"），用 `bot.scan().cores`，那里每颗都带 id。全被捡完时返回 `null`。

全图 Core 都可见，直接朝最近的去：

```ts
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const core = bot.nearestCore()
  if (core) bot.navigateTo(core)
  else bot.move(0, 0) // 暂无 Core，原地待刷
}
```


**常见坑**：把"最近的 Core"当"下一个必得"。别人也在抢，你到达时它可能刚被捡走。每帧重取就行，别规划太远。

## nearestUplink()

**做什么**：找全图最近的**激活** Uplink（桩）的坐标。Uplink 恒全量可见，但未激活的桩不进候选：中央主桩要到 CORE_OPEN（4:00）才算激活。没有激活桩时返回 `null`。

返回值同样是**纯坐标 `{ x, y }`**：没有 id、没有 ready 状态、没有持有者，也没有你的个人冷却。桩的详细状态在 `bot.scan().uplinks` 里查，那里有 `id`、`ready`、`holder`。脚本拿不到你的 30 秒个人冷却和成功事件，只能用 `game.time` 估算等待时间，且不能据此确认成功（示例库 `uplink-rusher.ts` 演示这一限制）。

接近最近激活桩并刹车引导；成功后的真实冷却仍由服务器强制：

```ts
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const uplink = bot.nearestUplink()
  if (!uplink) { bot.move(0, 0); return }
  const me = bot.self.position
  const dist = Math.hypot(uplink.x - me.x, uplink.y - me.y)
  if (dist > 1) bot.move((uplink.x - me.x) / 3, (uplink.y - me.y) / 3)
  else { bot.move(0, 0); bot.interact() }
}
```


**常见坑**：只看 `nearestUplink()` 就冲过去。它不含"这桩现在能不能黑"的信息：`ready` 要查 `scan().uplinks`，你的个人冷却要自己记。

## pulseScan()

**做什么**：主动增强感知，返回调用当帧的感知快照，和 `scan()` 同源同刻。

数值：耗 12 能量、冷却 2 秒、设计半径 32m，仍不穿墙。

```ts
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const obs = bot.pulseScan() // 请求脉冲；返回值仍是调用当帧的快照
  // 扩展后的视野从下一帧的 scan() / pulseScan() 里才能读到
}
```


**游戏规则**：脚本调用始终返回当前快照，同时提交脉冲意图。服务端构建脚本观察和客户端快照时使用本帧的感知半径：普通扫描 20m，成功执行脉冲的帧为 32m，都受墙体遮挡。能量不足或冷却未到时，服务器不执行脉冲、也不扣能量。

**常见坑**：把非空返回值当作脉冲成功的凭据。调用拿到的是当时已有的快照，不是执行后的新视野；冷却中的重复请求不会扩大视野，判断成功要看下一帧快照里多了什么。
