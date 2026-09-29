---
title: Bot Script 编程指南
audience: both
---

# Bot Script 编程指南

Bot Script 是你为 Robot 写的控制程序（JS/TS，唯一脚本语言）。它和 AI Agent 严格无关——这一页教你从五行代码写到有模有样。

## 五行代码起步

导出一个 `tick` 函数，每秒被调用 60 次（60Hz，与模拟同频）：

```ts
import type { BotModule } from '@omb/bot-api'

const bot: BotModule = {
  tick(ctx) {
    const core = ctx.api.nearestCore()
    if (core) ctx.api.moveTo(core)
  },
}
export default bot
```

粘贴进编辑器即生效；对局中提交则走 Hot Swap，**下一 tick 生效**。

## tick 模型

```ts
interface TickContext {
  self: Self        // 自己的状态
  game: GameInfo    // 局时、阶段等
  scan(): Observation
  api: L0 & L1      // 全部动作
}
```

- **60Hz 单时钟**：模拟、脚本 tick、Observation、网络快照全部同频。
- **模块级状态跨 tick 存活**：顶层变量就是你的记忆（上次目标、巡逻序号等），不用挂全局单例。
- **单 tick 配额 10ms**（可配置）：超时该 tick 被强制中断、机器人 idle，并计入异常统计——「人工智障」称号的来源。配额是防死循环的正确性机制，不是性能预算，正常写法远碰不到上限。

## scan()：免费感知

服务器每 tick 已为你的机器人按视野（20m）+ 墙体遮挡算好 Observation，`scan()` 只是读取最近一份快照：**零 Energy、零动作成本、任意频次**。

```ts
const obs = ctx.scan()
obs.robots     // 可见机器人：{ id, position, hp, isPartner }
obs.cores      // 可见 Core：{ id, x, y }
obs.uplinks    // 可见 Uplink：{ id, x, y, ready, holder? }
obs.projectiles// 可见炮弹：{ id, x, y }
obs.tick       // 快照对应的 tick
```

看不见的敌人不在这里——被墙挡住或超出 20m 的机器人不会出现。搭档是唯一例外，恒可见（`isPartner: true`）。需要更大范围时用 `api.pulseScan()`：半径 32m、耗能 12、CD 2s，仍不穿墙。

## API 一览

### L0 原语（自己组合策略）

| 方法 | 说明 |
|---|---|
| `move(vx, vy)` | 全向移动（速度向量；上限 8 m/s） |
| `aimAt(angle)` | 炮塔转向指定角度（弧度） |
| `fire()` | 开火：250ms 间隔、耗能 5/发、有效射程 16m（弹丸最大飞行 20m，16–20m 精度衰减） |
| `dash()` | 冲刺：位移约 4.8m、耗能 20、CD 2.5s、无无敌帧 |
| `shield(on)` | 护盾开关：减伤 65%、不可开火、移速约 80%、耗能约 18/s |
| `interact()` | Uplink 引导黑入（需 2.5m 内；引导 8s，每玩家每桩 30s 个人 CD） |
| `say(text)` | 喊话：3s 冷却，自由文本 |

### L1 便利层（常用组合）

| 方法 | 说明 |
|---|---|
| `moveTo(pos)` | 朝目标点移动 |
| `aimAt(target)` | 炮塔瞄准一个 RobotRef |
| `nearestEnemy()` | 最近的可见敌人，没有则 `null` |
| `nearestCore()` | 最近的可见 Core 坐标 |
| `nearestUplink()` | 最近的可见 Uplink 坐标 |
| `partner()` | 本局搭档（RobotRef）；无搭档时返回 `null`（奇数人数配对方案待定） |
| `pulseScan()` | 主动增强感知，返回新 Observation 或 `null`（CD 中） |

### 状态读取

```ts
ctx.self    // { hp, energy, position, velocity,
            //   control: { move: 'human'|'script'|'snippet',
            //              turret: 'human'|'script'|'snippet' } }
ctx.game    // { time, timeLeft, phase: 'OUTER_RING'|'CORE_OPEN', mapSeed }
```

**刻意不提供**：寻路、弹道预测、威胁评估。这些是你要自己写的天花板，也是高手脚本与模板的差距所在。

## 能量预算速查

能量上限 100、回复 10/s，所有动作都在花它：

| 动作 | 消耗 |
|---|---|
| 开火 | 5/发 |
| Dash | 20 |
| 护盾 | 约 18/s |
| pulseScan | 12 |

脚本里别无条件开盾 + 冲刺——能量见底时你既跑不掉也打不了。

## 与手操共存（分轴仲裁）

你的脚本运行时，玩家按键按**控制轴**（移动/炮塔/开火/技能）即时抢占：手按 WASD 时移动轴归人，炮塔轴可能还是你在 `aimAt`。抢占不自动归还，玩家按 Space 显式交还。注意：**脚本感知不到手操状态**（v1 无 playerDriving），不要试图"检测玩家在开车然后让位"——那不是你的职责，仲裁层已经处理好了。

## 热更新（Hot Swap）

- 整局任意时刻（含热身场）可提交新版脚本，**下一 tick 生效**。
- 提交失败（编译错 / 超配额）时**旧版本继续运行**，场上表现不会中断。
- 编辑器（Monaco）本地做 lint + 类型检查；行为对不对，热更后直接看战场。
- 浏览器端没有完整模拟器——想验证抢 Uplink 的手感，去热身场或实战热更。

## 递进路线

1. 五行捡 Core（上文）。
2. 加开火：`nearestEnemy()` + 距离 < 16m 才 `fire()`。
3. 加阶段判断：`game.phase === 'CORE_OPEN'` 后转向中央。
4. 加状态机：巡逻点序列、残血撤退（`self.hp < 30` 开盾跑路）。
5. 精细弹道：自己写提前量预测（API 不给，正是乐趣所在）。

嫌手写麻烦？下一页：让 [AI Agent](ai-agent.md) 替你改。
