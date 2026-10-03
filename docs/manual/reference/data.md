---
title: 数据结构参考
audience: coder
order: 43
tags: [脚本, 数据]
---

# 数据结构参考

这页收齐 Bot Script 里流动的全部数据：每帧递给你的 `bot`（BotContext）、感知快照 `Observation`，以及里面的实体形状。字段名与 `@omb/bot-api` 的类型定义逐字对齐。

## BotContext：每帧递给你的信息包

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

`tick(bot: BotContext)` 是统一入口。`bot.api` 只保留旧语法兼容，不改变每 tick 显式意图的语义。

生命周期四条，详细的坑见[模块语义与陷阱](modules.md)：

- `bot` 每帧重建。`bot.self`、`bot.game`、`bot.scan()` 都是本帧快照，帧间不复用，也不共享对象。
- 模块级状态跨帧存活。写在 `tick` 外面的变量就是你的记忆。热更成功后程序重建，状态清零。
- 每帧预算 10ms，可配置。超时这一帧的脚本动作全部作废，下一帧恢复。
- 失败安全。加载失败（语法错、缺入口）时旧版本继续跑，状态保持；tick 内抛异常只作废这一帧，不影响后续帧。

## Self：你自己

```ts
interface Self {
  id: number        // 自己的机器人 id
  hp: number        // 血量，上限 100
  energy: number    // 能量，上限 100，回复 10/s
  position: Vec2    // 世界坐标（地图中心为原点，单位米）
  velocity: Vec2    // 当前速度（米/秒）
}
```

每帧快照，从不裁剪，自己永远看得见自己。

刻意不提供：控制轴归属（human / script）。脚本查不到玩家此刻是否在手动开车，这是有意设计。仲裁归游戏层，你的指令被抢占的轴自动失效，不用你配合。详见[写第一个 Bot](../code/bot-scripting.md)。

## GameInfo：对局信息

```ts
interface GameInfo {
  time: number      // 已进行秒数（= tick / 60）
  timeLeft: number  // 剩余秒数
  phase: 'OUTER_RING' | 'CORE_OPEN'
  mapSeed: number   // 本局地图种子
}
```

4:00 切阶段，只改地图规则：中央区解锁、主桩激活、Core 刷新权重变化。任何 API 的语义都不跟着变。自记冷却（黑入 30s、喊话 3s）拿 `game.time` 做计时基准。

## Observation：感知快照

`bot.scan()` 的返回值。脚本里的 `pulseScan()` 也始终返回这份快照，不能拿它判断脉冲是否执行成功。

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

哪个列表裁剪、哪个列表全量：

| 列表 | 可见性规则 |
|---|---|
| `robots` | 其他机器人：中心距 ≤ 20m 且视线不被墙挡。不含自己，已死的不在里面 |
| `cores` | 全图存活资源，不按距离裁剪，只返回活着的 Core。被拾取或尚未激活的不会出现 |
| `uplinks` | 恒全量，全图所有 Uplink。`ready` 指桩激活且无人正在引导；`holder` 是当前引导者的机器人 id，有人引导才有值 |
| `projectiles` | 与 `robots` 同规则：20m 内且不穿墙 |
| `healthPacks` | 公开全量，固定血包点的位置和状态。`available=false` 时 `respawnInS` 是预计恢复秒数 |
| `walls` | 静态公开全量，不随视野半径和遮挡裁剪。与碰撞几何一致的只读 AABB，改写返回值动不了地图 |

个人黑入冷却和喊话冷却都不在 Observation 里，黑入成功事件也不下发。请求间隔拿 `game.time` 控制；黑入完成时间和冷却只能估算。

## RobotRef：一台看得见的机器人

```ts
interface RobotRef {
  id: number
  position: Vec2
  hp: number
  velocity: Vec2    // 目标的当前速度（米/秒）
}
```

`scan().robots` 和 `nearestEnemy()` 返回的都是这个形状。

刻意不提供：**朝向**（炮塔角度）。弹道预判可以拿 `velocity` 自己外推：用距离除以弹速算出飞行时间，再加到目标位置上。游戏不会替你算提前量。

## Vec2：坐标

```ts
interface Vec2 { x: number; y: number }
```

世界坐标以地图中心为原点，单位米。`nearestCore()` 和 `nearestUplink()` 返回的是不带 `id` 的纯 `Vec2`。

## 速查表

| 想知道 | 去哪拿 |
|---|---|
| 我的 id/血量/能量/位置/速度 | `bot.self` |
| 局时/剩余/阶段 | `bot.game` |
| 看得见哪些敌人 | `bot.scan().robots`（20m + 不穿墙） |
| 全图 Core 在哪 | `bot.scan().cores` 或 `bot.nearestCore()` |
| <img class="inline-icon" src="../reference/images/icons/uplink.png" alt=""> 桩的状态（激活/被引导中） | `bot.scan().uplinks` 的 `ready` / `holder` |
| 我在这桩的冷却剩几秒 | 没有，只能按 `game.time` 估算 |
| <img class="inline-icon" src="../reference/images/icons/heart.png" alt=""> 血包在哪、能否拾取 | `bot.scan().healthPacks`，形状 `HealthPackRef{id, x, y, available, respawnInS}`；碰到可用血包自动回血 |
| 谁在瞄我、弹道提前量 | **没有**。拿目标 `velocity` 自己外推，游戏不给现成答案 |
