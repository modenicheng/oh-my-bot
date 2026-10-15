---
title: 便利层参考（L1）
audience: coder
order: 42
tags: [脚本, L1]
---

# 便利层参考（L1）

L1 是 8 个常用便利方法，帮你省掉重复样板代码。大多数直接组合 [L0 原语](actions.md)；`navigateTo` 由服务器基于当前局部观察计算确定性路径，再输出移动意图。最近查询也只搜索当前观察，不访问隐藏地图或资源。

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

**做什么**：由服务器基于当前观察中的墙面与边界算一条确定性的 A* 路径，沿路径朝目标点移动，不读取完整隐藏地图。

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


**游戏规则**：寻路网格和邻居顺序由服务器固定，相同局部观察、起点、目标和阶段算出相同路径。当前感知半径之外的目标不会借助隐藏地图规划；需分段探索，并随观察更新目标与路线。已观察的墙面、竞技场边界和未开放锁区表面用于避障；这不是对未知区域可通行或目标必达的保证。资源仍靠移动接触自动拾取，没有 `pickup()`。

**边界**：`moveTo` 是直线移动；`navigateTo` 只在当前观察范围内寻路，不能利用浏览器完整静态地形引导包探测隐藏几何。它不做动态机器人避障、威胁评估、弹道预测。路线上有机器人就可能拥堵或碰撞；到点和刹车仍由脚本按距离阈值控制。

## aimAt(target)

**做什么**：<img class="inline-icon" src="../reference/images/icons/target.png" alt=""> 直接瞄一个看得见的机器人，不用自己算角度。这是 `aimAt` 的实体重载：传数字按角度、传机器人按实体，同一个名字，游戏按参数类型自动区分。

| 参数 | 类型 | 含义 |
|---|---|---|
| `target` | RobotRef | 要瞄准的机器人（必须是可见实体） |

完整语义（弧度约定、非法值处理）见[动作参考 aimAt](actions.md)。

**游戏规则**：传**不可见**的机器人（被墙挡住、超出视野）会当场抛异常 `aimAt: entity not visible`。当帧没接住，该帧全部脚本动作作废。

**常见坑**：先确认目标在 `bot.scan().robots` 里再传。

## nearestEnemy()

**做什么**：找当前观察里最近的敌人。候选受当前半径（普通 20m / 脉冲帧 32m）与视线遮挡限制，不含自己、不含死者。一个都看不见时返回 `null`。

返回的 RobotRef 带 `id`、`position`、`hp`、`velocity`、`maxHp`、`maxEnergy`。后两项是公开上限分母，可反推血量/能量轨等级；其余三轨等级与朝向拿不到。算弹道提前量直接用目标 `velocity` 外推，信息边界与映射见[数据结构参考](data.md)。

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

- 把它当全图索敌：它只搜当前观察。返回 `null` 不等于全图安全。
- 返回值是**调用那一刻的快照**：目标下一帧走出视野，你缓存的对象就失效了，再读只会得到过时位置，游戏不保证内容更新。每帧重取，别缓存着长用。

## nearestCore()

**做什么**：找当前观察里最近的**存活** Core 的坐标。与 `scan().cores` 一样受当前感知半径和视线遮挡限制，不用于全图资源探测。

返回值是**纯坐标 `{ x, y }`**，没有 id。要区分是哪颗 Core（比如记住"我在追第 3 颗"），用 `bot.scan().cores`，那里每颗都带 id。当前观察没有存活 Core 时返回 `null`，不代表全图已被捡完；Core 每次重生会在所属环带重新随机选合法位置，血包位置仍固定。

朝当前可见的最近 Core 移动；没有目标时需要另行探索：

```ts
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const core = bot.nearestCore()
  if (core) bot.navigateTo(core)
  else bot.move(0, 0) // 当前观察暂无 Core；最小示例停下，实际策略需另行探索
}
```


**常见坑**：把"最近的 Core"当"下一个必得"。别人也在抢，你到达时它可能刚被捡走。每帧重取就行，别规划太远。

## nearestPointDrop()

**签名**：`nearestPointDrop(): PointDropRef | null`。按当前位置找当前观察里最近的存活技能点晶片，没有返回 `null`。返回冻结快照 `{ id, x, y, points }`，不是纯坐标，也不包含 `ttlS`。

它与 `bot.scan().pointDrops` / `bot.pulseScan().pointDrops` 使用同一份当前观察，均按感知半径与视线遮挡裁剪。环境晶片每只 1 点，赏金晶片每只 1–4 点，生成 30 秒后过期，接触拾取谁碰归谁（含复活本人），只给技能点不给计分。普通/Mega Core 直接给 2/5 SP，每颗新增 Core 附带最多 1/2 只环境晶片，还受全场环境存量上限 `ceil(参赛机器人席位数 / 4)` 约束（含 bot、死亡者仍计席位）。满额时只生 Core，剩余额度不足时只发可容纳的只数；拾取或过期腾额度后由后续新增 Core 补充，存活 Core 不重复补。不保证固定总收益；赏金晶片不占额度、不受该上限约束。

**最近不等于必得**：方法只搜索当前观察，不会显示被墙或未开放锁区遮住的晶片，也不保证路径可达。每帧重取；对象不会随世界更新，到达前可能离开视野、被别人捡走或过期。若需估算寿命，只能自记首次见到的 tick +30 秒作上界近似，不能把首次可见时间当精确生成时间。

## nearestUplink()

**做什么**：找当前观察里最近的**激活** Uplink（桩）的坐标。候选受当前感知半径和视线遮挡限制，未激活的桩不进候选：中央主桩要到 CORE_OPEN（4:00）才算激活。当前观察没有激活桩时返回 `null`，不代表全图没有。

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
