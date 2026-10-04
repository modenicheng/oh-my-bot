---
title: 模块语义与陷阱
audience: coder
order: 44
tags: [脚本, 语义]
---

# 模块语义与陷阱

这页按主题拆解 Bot Script 的运行语义。每个主题讲三件事：游戏怎么运行，什么时候用，陷阱在哪。逐 API 签名见[动作参考](actions.md)与[便利层参考](helpers.md)，逐字段见[数据结构](data.md)。

## 1. tick 生命周期

游戏以 60Hz 调用你的 `tick(bot)`，与模拟同频。一帧的标准流程：读感知，做决策，调 API 表达意图。

- `bot` 每帧重建。`bot.self`、`bot.game`、`bot.scan()` 都是本帧快照，帧间不复用。
- 模块级状态跨帧存活。写在 `tick` 外面的变量就是你的记忆：计数器、路标索引、自记冷却。热更成功后程序重建，状态清零。
- 每帧预算 10ms。超时这一帧的脚本动作被清空，人的手操不受影响，下一帧照常恢复。这是打断，不是禁赛。
- 一拍延迟。第 T 帧读到的世界是 T 时刻的，产出的指令 T+1 帧才生效。所有"到点判定"留阈值。

示例库 `patrol.ts` 是这个主题的标准教材，只用到模块级状态和距离阈值：

```ts
import type { BotContext } from '@omb/bot-api'

let idx = 0 // 模块级状态：当前目标路标（写 tick 里就每帧清零了）

function tick(bot: BotContext) {
  const me = bot.self.position
  const target = waypoints[idx]
  const dx = target.x - me.x
  const dy = target.y - me.y
  if (dx * dx + dy * dy < 4) {
    idx = (idx + 1) % waypoints.length // 距离 < 2m 算到点，切下一个
    return
  }
  bot.moveTo(target)
}
```

陷阱：

- 别在 tick 里写阻塞循环，比如"等到达再返回"的 while。配额中断没有恢复点，这一帧直接作废。tick 的正确姿势是看一眼、决策、退出，下一帧再来。
- 状态声明在 `tick` 函数内部等于每帧清零。要跨帧，放模块级。

## 2. 感知

`bot.scan()` 返回游戏裁剪好的可见实体集合，零成本，每帧可读，每次调用都给新对象。

- 可见性规则，对机器人和弹丸一致：中心距 ≤ 20m，且视线不被墙拦截。
- <img class="inline-icon" src="../reference/images/icons/target.png" alt=""> cores 与 uplinks 恒全量：不受距离和墙限制，全图目标位置都查得到。这是全局导航（`nearestCore` / `nearestUplink`）的底气。
- 自己不在 `robots` 里，用 `bot.self`；已死的被过滤。
- `pulseScan()` 耗 12 能量，冷却 2 秒。执行成功的帧用 32m 感知，普通帧仍是 20m，同样受墙体遮挡。请求执行成功才扣能量、进冷却；调用始终返回请求前已有的当前快照。

陷阱：

- 20m 外的敌人不可见，不等于不存在。贴墙走位能减少暴露面；cores / uplinks 恒全量，拿来做全局导航。
- 弹丸与机器人同规则裁剪。你看到弹丸时，它可能已经在 20m 内飞了几帧。侧移比硬吃划算。

## 3. 移动与战斗

`move` 表达期望速度方向，`aimAt` 定炮口，`fire` 发射；`moveTo` 沿直线朝点走，`navigateTo` 用服务器确定性的静态 A*。

- `move(vx, vy)` 是期望速度向量，不是位移。两个数合起来 ≤1 按比例走，>1 自动归一成满速。实际速度受加速度 24 m/s² 与限速 8 m/s 约束，起步和转向有惯性，没有瞬移。
- `moveTo` 是直线移动；`navigateTo` 是服务器确定性的静态 A*，避开实体墙、竞技场边界和尚未解锁的中央区。它不做动态机器人避障，不做威胁评估，不做弹道预测。
- 开火节流是游戏强制的，250ms 一发。脚本连点无效；能量不足 5 时安静地不打。
- 有效射程 16m，弹丸最远飞 20m。超过 16m 弹道开始散布，最大 ±0.12 弧度；伤害不衰减，每发都是 12。远距命中率靠距离换，伤害不打折，也打不准。
- <img class="inline-icon" src="../reference/images/icons/shield.png" alt=""> 开盾期间不能开火，二选一。

陷阱：

- 每 tick 显式意图。脚本这一 tick 没调用的轴就是中立，不延续上一 tick。持续开火、Dash、护盾或黑入，都要在条件成立时每 tick 调用；脚本异常、超时或没跑完时，这一 tick 就没有动作。
- 朝向例外。`aimAt()` 的调用是本 tick 意图，但物理炮塔朝向是状态。省略瞄准，炮口不会重置到零角度。
- 开火意图与黑入互斥。本 tick 最终开火意图为 `true` 时不能引导，即使这一帧没有实际射击。抢桩分支不要调用 `fire()`。
- `aimAt` 同名两种用法：传数字按角度，传机器人按实体。传不可见的机器人当场抛异常 `aimAt: entity not visible`。先确认目标在 `scan().robots` 里。

## 4. 目标交互

Core 和可用血包都靠移动接触自动拾取；Uplink 要站桩引导黑入，+15 分，主桩 +25。Bot API 没有 `pickup()`。

- Core：机器人圆和 Core 圆一接触就自动拾取，这一帧的移动路径扫过也算，+10，Mega +25，不需要任何 API。`nearestCore()` 给全图最近存活 Core，配合 `navigateTo()` 可以绕开静态障碍。
- 血包：受伤且存活时接触可用血包，自动恢复 30 HP。位置和可用状态在 `bot.scan().healthPacks`；满血不会消耗。
- Uplink 黑入：距桩 ≤2.5m，主桩 3m，持续引导 8 秒。期间每帧都要满足：存活、interact 按住、未开火、未出圈。中断后保留 0.5 秒，随后每 1 秒回退 0.5 秒进度；只有成功才进入个人冷却。
- 个人冷却 30 秒。黑入成功后，你对这根桩 30s 内不能再黑。按机器人记，跨桩独立，死亡不清。
- `nearestUplink()` 不含 ready / 冷却信息，只给位置。桩的激活状态查 `scan().uplinks` 的 `ready`；你的个人冷却自记。

示例库 `uplink-rusher.ts` 演示减速站桩、计时和等待。成功事件不对脚本开放，只能估算；例子用全局等待简化了真实的逐桩冷却：

```ts
let cdUntil = -1 // 估算的等待截止时间（秒）
let started = -1 // 估算的引导起始时间，-1 = 未在计时

// ……（减速、刹车和离开范围时重置 started 见完整示例）
if (started >= 0 && bot.game.time - started > 8.5) {
  // 无法确认成功：仅按预计时长等待，服务器仍强制真实冷却
  cdUntil = bot.game.time + 30
  started = -1
}
```

陷阱：

- fire 意图与黑入互斥，同上一节。抢桩分支不要调用 `fire()`。
- 引导被打断的原因：本 tick fire 输出、未继续调用 `interact()`、被位移出圈、死亡。扛伤可以继续，还手就断。
- 主桩在中央区，CORE_OPEN（4:00）才激活。`uplinks[i].ready` 指"桩激活且无人正在引导"，与你的个人冷却是两码事。
- 成功 / 失败不给脚本事件，感知里没有"引导完成了"的字段。`game.time` 只能估算；即使多等半秒，也不能排除争抢、中断和手操接管导致的失败。

## 5. 存活

护盾减伤，dash 位移，能量是一切技能的货币，上限 100，回复 10/s。

- 护盾：受伤 ×0.35（减伤 65%），耗能 18/s，移速 ×0.8，不能开火。每帧按"当前开关 + 能量"重新结算，能量见底那帧盾自动灭；死亡强制熄盾；复活重置。
- dash：按住时速度 16 m/s，持续消耗 20 能量/秒，无无敌帧、无冷却。方向取当前仲裁后的移动向量，零向量则用炮口朝向。释放、开盾或能量不足立即停止；盾与 Dash 同 tick 时盾优先。
- 能量经济：仅持续开盾净耗约 8/s；仅持续 Dash 净耗约 10/s，20/s 消耗减 10/s 回复。无条件调用会很快耗空。
- 复活：死亡 3s 后在本扇区出生点重生，满血满能量带无敌。无敌 4 秒从首次有效操作起算，挂机一直无敌；`fire` / `interact` 输出立即解除无敌。跨死亡保留个人桩冷却和喊话冷却；本 tick 脚本意图始终重新计算。

示例库 `shield-brawler.ts` 是这个主题的教材：低血时在举盾和 Dash 撤离之间二选一，两者不能同时用：

```ts
const me = bot.self.position
if (bot.self.hp < 30 && bot.self.energy >= 20) {
  bot.shield(false)  // Dash 撤离时不举盾
  bot.move(me.x - enemy.position.x, me.y - enemy.position.y) // 反向推杆
  bot.dash()         // 撤离分支每 tick 调用；离开分支即停止
  dashing = 1.5
  return
}
```

被动换主动：`predictive-shield.ts` 演示按弹道预测开盾——拿 `scan().projectiles` 的 `heading`（含散布后的瞬时方向）外推最近距离，再用上一帧位置差分复核方向，只在「2~8 tick 内命中」时才 `shield(true)`，平时关盾把能量留给 Dash。注意管线延迟：脚本看到的快照比结算旧 2 tick，窗口要提前。

陷阱：

- Dash 取本 tick 仲裁后的 move 向量。脚本省略移动时该向量中立，人类 held 移动不受影响，最终向量为零才取炮口方向。
- 复活保护从首次有效操作开始计时，瞄准、切换辅助、有效脚本指令等都会触发，并非只有移动才开始计时。fire / interact 输出立即解除保护。

## 6. 通信

`say(text)` 发全房间可见的公开文本，互信内网，无屏蔽。

- 喊话 3 秒冷却，游戏强制。冷却内的调用安静地丢掉，无错误、无事件。文本最多 160 个 Unicode 字符，空白和控制字符会归一化。
- 没有队内频道。纯乱斗没有队友，喊话对全场公开，慎用战术情报。

示例库 `flank-strike.ts` 演示发现敌人时喊话，自记 3.5 秒间隔：

```ts
let lastSay = -99 // 上次喊话时间（秒）

// 接敌时报点，且至少隔 3.5 秒（游戏层还有 3s 强制冷却双保险）
if (bot.game.time - lastSay > 3.5) {
  bot.say('enemy ' + enemy.id)
  lastSay = bot.game.time
}
```

陷阱：

- tick 里每帧喊话：冷却就绪时首条会发出，之后 180 帧内的调用被丢弃。自记间隔能减少重复请求。
- 喊话太长会被截断，别指望消息末尾一定能送到别人眼前。
