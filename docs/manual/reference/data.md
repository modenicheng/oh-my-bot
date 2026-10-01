---
title: 数据结构参考
audience: coder
order: 43
tags: [脚本, 数据]
---

# 数据结构参考

Bot Script 里流动的全部数据：每帧递给你的 `bot`（BotContext）、感知快照 `Observation`、以及里面的实体形状。字段名与 `@omb/bot-api` 的类型定义逐字对齐。

## BotContext —— 每帧递给你的信息包

```ts
interface BotContext {
  self: Self          // 你自己，本帧快照
  game: GameInfo      // 对局信息
  scan(): Observation // 感知快照（每次调用都给新对象，零成本）
  move(vx: number, vy: number): void
  aimAt(angle: number | RobotRef): void
  fire(): void
  dash(): void
  shield(on: boolean): void
  interact(): void
  say(text: string): void
  api: L0 & L1        // 旧脚本兼容别名；新脚本使用 bot.xxx()
}
type BotModule = { tick(bot: BotContext): void }
```

`tick(bot: BotContext)` 是统一入口。`bot.api` 只保留旧语法兼容，不改变每 tick 显式意图语义。

**生命周期规则**（完整陷阱分析见[模块语义与陷阱](modules.md)）：

- `bot` **每帧重建**：`bot.self`、`bot.game`、`bot.scan()` 都是本帧快照，帧间不复用、不共享对象；
- **模块级状态跨帧存活**：声明在 `bot` 对象外/内的变量就是你的记忆。热更新成功 → 程序重建 → 状态清零；
- **每帧预算 10ms**（可配置）：超时该帧脚本动作全部作废，下一帧恢复；
- **失败安全**：加载失败（语法错、缺入口）→ 旧版本继续跑、状态保持；tick 内异常 → 只作废该帧，不影响后续帧。

## Self —— 你自己

```ts
interface Self {
  hp: number        // 血量，上限 100
  energy: number    // 能量，上限 100，回复 10/s
  position: Vec2    // 世界坐标（地图中心为原点，单位米）
  velocity: Vec2    // 当前速度
}
```

每帧快照、未裁剪（自己永远对自己可见）。

**刻意不提供**：控制轴归属（human / script）。脚本无法感知"玩家此刻是否在手动开车"——仲裁是游戏层的事（你的指令被抢占的轴自动失效，不需要你配合），详见[写第一个 Bot](../code/bot-scripting.md)。

## GameInfo —— 对局信息

```ts
interface GameInfo {
  time: number      // 已进行秒数（= tick / 60）
  timeLeft: number  // 剩余秒数
  phase: 'OUTER_RING' | 'CORE_OPEN'
  mapSeed: number   // 本局地图种子
}
```

阶段切换发生在 4:00，只改变地图规则（中央区解锁、主桩激活、Core 刷新权重），**不改变任何 API 的语义**。`game.time` 是你自记冷却（黑入 30s、喊话 3s）的计时基准。

## Observation —— 感知快照

`bot.scan()` 的返回值。当前脚本运行时的 `pulseScan()` 也始终返回这份快照，不能据此判断脉冲是否执行成功：

```ts
interface Observation {
  tick: number        // 快照对应的帧号
  robots: RobotRef[]
  cores: (Vec2 & { id: number })[]
  uplinks: (Vec2 & { id: number; ready: boolean; holder?: number })[]
  projectiles: (Vec2 & { id: number })[]
  healthPacks: HealthPackRef[]
  walls: { id: number; min: Vec2; max: Vec2 }[]
}

interface HealthPackRef {
  id: number
  x: number
  y: number
  available: boolean
  respawnInS: number
}
```

各列表的可见性和公开范围：

| 列表 | 可见性规则 |
|---|---|
| `robots` | 其他机器人：中心距 ≤ 20m **且**视线不被墙挡；不含自己；死者过滤 |
| `cores` | **全图存活资源**：不按距离裁剪，但只返回 `Alive=true` 的 Core；被拾取或尚未激活的资源不会出现在列表中 |
| `uplinks` | **恒全量**：全图所有 Uplink。`ready` = 桩激活且无人正在引导；`holder` = 当前引导者的机器人 id（有人正在引导才有值） |
| `projectiles` | 与 robots 同规则（20m + 不穿墙） |
| `healthPacks` | **公开全量**：固定血包点的位置和状态；`available=false` 时 `respawnInS` 是预计恢复秒数 |
| `walls` | **静态公开全量**：不随视野半径/遮挡裁剪，与碰撞几何一致的只读 AABB（改写返回值不影响地图） |

**注意**：个人黑入冷却和喊话冷却不在 Observation 里。可用 `game.time` 控制请求间隔；黑入成功事件也不下发，所以黑入完成时间及冷却只能估算。

## RobotRef —— 一台看得见的机器人

```ts
interface RobotRef {
  id: number
  position: Vec2
  hp: number
}
```

`scan().robots`、`nearestEnemy()` 返回的都是这个形状。

**刻意不提供**：速度和朝向。要做弹道预判，自己差分 `position`（这帧位置减上帧位置，除以帧时长 1/60）。

## Vec2 —— 坐标

```ts
interface Vec2 { x: number; y: number }
```

世界坐标系以**地图中心为原点**、单位米。`nearestCore()` / `nearestUplink()` 返回的是不带 `id` 的纯 `Vec2`。

## 一张速查表

| 想知道 | 去哪拿 |
|---|---|
| 我的血量/能量/位置/速度 | `bot.self` |
| 局时/剩余/阶段 | `bot.game` |
| 看得见哪些敌人 | `bot.scan().robots`（20m + 不穿墙） |
| 全图 Core 在哪 | `bot.scan().cores` 或 `bot.nearestCore()` |
| 桩的状态（激活/被引导中） | `bot.scan().uplinks` 的 `ready` / `holder` |
| 我在这桩的冷却剩几秒 | **没有**，只能按 `game.time` 估算 |
| 血包在哪、能否拾取 | `bot.scan().healthPacks`：`HealthPackRef{id, x, y, available, respawnInS}`；接触可用血包自动回血 |
| 谁在瞄我/弹道预测 | **没有**，自己从 `projectiles` 和位置差分算 |
