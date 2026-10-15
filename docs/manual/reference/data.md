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
  scan(): Observation // 本帧感知快照，免费
  move(vx: number, vy: number): void
  aimAt(angle: number | RobotRef): void
  fire(): void
  dash(): void
  shield(on: boolean): void
  interact(): void
  say(text: string): void
  buyUpgrade(track: UpgradeTrack): void
  nearestPointDrop(): PointDropRef | null
  api: L0 & L1        // 旧脚本兼容别名；新脚本使用 bot.xxx()
}
type BotModule = { tick(bot: BotContext): void }
```

`tick(bot: BotContext)` 是统一入口。`bot.api` 只保留旧语法兼容，不改变每 tick 显式意图的语义。

生命周期四条，详细的坑见[模块语义与陷阱](modules.md)：

- `bot` 每帧重建。`bot.self`、`bot.game`、`bot.scan()` 描述本帧快照，旧对象不会自动更新。同 tick 重复读取不保证得到不同对象；开局冻结的 `game.upgradeCosts` 可跨帧复用。
- 模块级状态跨帧存活。写在 `tick` 外面的变量就是你的记忆。热更成功后程序重建，状态清零。
- 每帧预算 10ms，可配置。超时这一帧的脚本动作全部作废，下一帧恢复。
- 失败安全。加载失败（语法错、缺入口）时旧版本继续跑，状态保持；tick 内抛异常只作废这一帧，不影响后续帧。

## Self：你自己

```ts
interface Self {
  id: number        // 自己的机器人 id
  hp: number        // 血量，基础上限 100，升级后最高 250
  energy: number    // 能量，基础上限 100，升级后最高 300，回复恒 10/s
  position: Vec2    // 世界坐标（地图中心为原点，单位米）
  velocity: Vec2    // 当前速度（米/秒）
  readonly upgrade: UpgradeSelf
}
```

每帧快照，从不裁剪，自己永远看得见自己。

### UpgradeTrack / UpgradeLevels / UpgradeSelf

```ts
type UpgradeTrack = 'hp' | 'speed' | 'shield' | 'attack' | 'energy'

interface UpgradeLevels {
  readonly hp: number
  readonly speed: number
  readonly shield: number
  readonly attack: number
  readonly energy: number
}

interface UpgradeSelf {
  readonly points: number
  readonly levels: UpgradeLevels
  readonly bounty: boolean
}
```

`points` 是未花费的技能点（普通 Core +2、Mega +5，环境晶片每只 +1），与计分、能量分开。每颗新增普通/Mega Core 附带最多 1/2 只环境晶片，还受下述全场人数存量上限约束，不保证固定总收益。五轨当前各为 0–10 级。`self.upgrade` 与嵌套 `levels` 都是冻结、只读的本机私密快照，其他机器人读不到你的点数与五轨等级。调用 `buyUpgrade()` 只排队，不会原地更新这些对象；下一 tick 重读才确认结果，详见[动作参考](actions.md#buyupgradetrack)。

`bounty` 是**服务端按 `sim.BountyStateLevel` 派生的赏金布尔值**：当前任一轨 ≥L4 时为 `true`，阵亡会散落全部自由点数，余额低时还可能掉 1 级。门槛可能调参，脚本判断自身赏金应读取 `bounty`，不要把 `levels >= 4` 写死。

刻意不提供：控制轴归属（human / script）。脚本查不到玩家此刻是否在手动开车，这是有意设计。仲裁归游戏层，你的指令被抢占的轴自动失效，不用你配合。详见[写第一个 Bot](../code/bot-scripting.md)。

## GameInfo：对局信息

```ts
interface GameInfo {
  time: number      // 已进行秒数（= tick / 60）
  timeLeft: number  // 剩余秒数
  phase: 'OUTER_RING' | 'CORE_OPEN'
  mapSeed: number   // 已弃用，恒为 0；不暴露生成种子
  readonly upgradeCosts: readonly number[]
}
```

4:00 切阶段，只改地图规则：中央区解锁、主桩激活、Core 刷新权重变化。任何 API 的语义都不跟着变。自记冷却（黑入 30s、喊话 3s）拿 `game.time` 做计时基准。

`upgradeCosts` 是开局冻结、五轨共用的只读成本数组：`upgradeCosts[L]` 是 L→L+1 的点数，数组长度就是满级。当前为 `[2, 3, 5, 8, 12, 18, 27, 40, 60, 90]`，单轨累计 265；以服务端下发数组为准，不要硬编码。它是局级常量，不随购买改变；`phase` 则只表示地图阶段，不暴露 Warmup/Running 房间状态。

`mapSeed` 仅为旧脚本保留，已弃用且恒为 `0`，不能据此重建地图。浏览器可靠引导包中的完整静态地形只供稳定渲染与相机定位；客户端实体、HUD、反馈仍使用局部观察，脚本 API 不因此获得完整墙体、隐藏资源或生成元数据。观战与离线回放使用独立全知数据流。

## Observation：感知快照

`bot.scan()` 的返回值。脚本里的 `pulseScan()` 也始终返回这份快照，不能拿它判断脉冲是否执行成功。

```ts
interface Observation {
  tick: number        // 快照对应的帧号
  robots: RobotRef[]
  cores: (Vec2 & { id: number; value?: number })[]
  uplinks: (Vec2 & { id: number; ready: boolean; holder?: number })[]
  projectiles: ProjectileRef[]
  healthPacks: HealthPackRef[]
  readonly pointDrops: readonly PointDropRef[]
  walls: { id: number; min: Vec2; max: Vec2 }[]
  boundaries: { kind: 'arena' | 'lock'; start: Vec2; end: Vec2 }[]
}

interface HealthPackRef {
  id: number
  x: number
  y: number
  available: boolean
  respawnInS: number
}

interface ProjectileRef {
  id: number
  owner: number    // 射手机器人 id（自己的弹也在列表里）
  x: number
  y: number
  heading: number  // 当前飞行方向（弧度，含散布后的瞬时值）；弹速 36 m/s
}
```

所有列表均按当前感知半径和视线遮挡裁剪：普通 20m，成功执行脉冲的帧为 32m，墙体和未开放锁区都会遮挡。实体消失不等于被拾取或销毁；固定血包位置也不意味着状态全图公开。

| 列表 | 可见性规则 |
|---|---|
| `robots` | 当前半径内、视线可达的其他存活机器人，不含自己 |
| `cores` | 当前可见的存活 Core，带实际坐标及可选 `value`；被拾取、未激活、超距或被遮挡的不会出现 |
| `uplinks` | 当前可见的 Uplink。`ready` 指桩激活且无人正在引导；`holder` 是当前引导者的机器人 id，有人引导才有值 |
| `projectiles` | 当前可见弹丸；`owner` 是射手 id，`heading` 是含散布后的瞬时飞行方向 |
| `healthPacks` | 当前可见的固定血包点及状态。`available=false` 时 `respawnInS` 是预计恢复秒数 |
| `pointDrops` | 当前可见的存活晶片；`scan()` / `pulseScan()` 同享当前观察，已捡、过期、超距或被遮挡的不会出现 |
| `walls` | 当前可见墙面片段，以可为零厚度的 AABB 表示，不包含隐藏墙背面或完整墙体尺寸；id 只在该快照内有效 |
| `boundaries` | 当前可见的竞技场（`arena`）或未开放锁区（`lock`）边界表面线段，不是完整边界轮廓 |

个人黑入冷却和喊话冷却都不在 Observation 里，黑入成功事件也不下发。请求间隔拿 `game.time` 控制；黑入完成时间和冷却只能估算。

### PointDropRef：技能点晶片

```ts
interface PointDropRef {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly points: number
}
```

环境补货或赏金阵亡生成的晶片：环境晶片每只 1 点，赏金晶片每只 1–4 点，生成 30 秒（1800 tick）后过期。接触拾取谁碰归谁（含复活本人），只给技能点不给计分；锁区内未开放时不能拾取。`pointDrops` 数组和其中的晶片对象都是冻结快照，没晶片时是空数组，不会是 `undefined`。

全场环境晶片存量上限为 `ceil(参赛机器人席位数 / 4)`（含 bot、死亡者仍计席位）：4/64/200/256 人分别为 1/16/50/64 只。每颗新增普通/Mega Core 只在剩余额度内附带最多 1/2 只，满额时只生 Core；拾取或过期腾额度后由后续新增 Core 补充，存活 Core 不重复补。赏金晶片不占额度、不受该上限约束。内部 checkpoint 用 `PointDrop.Ambient` 区分来源，`PointDropRef` 不暴露此字段，也不能从局部观察推断全场存量。

没有 `ttlS` 或精确出生时间字段。可以自记首次见到的 tick +30 秒作寿命上界近似，但首次进入视野、迟加入或热更后的首次见到都不等于生成。`nearestPointDrop()` 只在当前观察的晶片中返回最近的完整 `PointDropRef` 或 `null`，不会探测隐藏或锁区内不可见的晶片；离开观察范围也不代表被拾取。

## RobotRef：一台看得见的机器人

```ts
interface RobotRef {
  id: number
  position: Vec2
  hp: number
  velocity: Vec2    // 目标的当前速度（米/秒）
  readonly maxHp: number
  readonly maxEnergy: number
}
```

`scan().robots` 和 `nearestEnemy()` 返回的都是这个形状。

`maxHp` / `maxEnergy` 是人类头顶条同样可见的公开分母，不是他人的完整 build。当前成长曲线可唯一反推这两条轨：

| 等级 | `maxHp`（hp 轨） | `maxEnergy`（energy 轨） |
|---|---|---|
| L0 | 100 | 100 |
| L1 | 120 | 125 |
| L2 | 140 | 150 |
| L3 | 160 | 175 |
| L4 | 180 | 200 |
| L5 | 200 | 225 |
| L6 | 210 | 240 |
| L7 | 220 | 255 |
| L8 | 230 | 270 |
| L9 | 240 | 285 |
| L10 | 250 | 300 |

按**当前** L4 门槛，`maxHp >= 180` 或 `maxEnergy >= 200` 足以推断对手已携带赏金；低于这两值不代表没有赏金，可能是其余三轨触发。shield/attack/speed 等级没有公开字段，不能推断，也不提供 `inferLevel()` 帮手。自己的赏金状态始终以服务端派生的 `self.upgrade.bounty` 为准。

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
| 我的技能点/五轨等级/是否赏金 | `bot.self.upgrade.points` / `levels` / `bounty`（仅本人可见） |
| 下一级升级价格/满级 | `bot.game.upgradeCosts[level]` / `upgradeCosts.length` |
| 局时/剩余/阶段 | `bot.game` |
| 看得见哪些敌人 | `bot.scan().robots`（普通 20m / 脉冲帧 32m + 视线遮挡） |
| 当前可见 Core 在哪 | `bot.scan().cores` 或 `bot.nearestCore()`；每次重生重新选合法位置 |
| 当前可见技能点晶片在哪、值几点 | `bot.scan().pointDrops` 或 `bot.nearestPointDrop()`；生成 30 秒后过期，环境每只 1 点、赏金每只 1–4 点 |
| 当前可见墙面与边界 | `bot.scan().walls` / `boundaries`；只有表面片段，不是完整隐藏几何 |
| 可见对手血量/能量上限 | `RobotRef.maxHp` / `maxEnergy`；不暴露完整 build |
| <img class="inline-icon" src="../reference/images/icons/uplink.png" alt=""> 桩的状态（激活/被引导中） | `bot.scan().uplinks` 的 `ready` / `holder` |
| 我在这桩的冷却剩几秒 | 没有，只能按 `game.time` 估算 |
| <img class="inline-icon" src="../reference/images/icons/heart.png" alt=""> 血包在哪、能否拾取 | `bot.scan().healthPacks`，形状 `HealthPackRef{id, x, y, available, respawnInS}`；碰到可用血包自动回血 |
| 谁在瞄我、弹道提前量 | **没有**。拿目标 `velocity` 自己外推，游戏不给现成答案 |
