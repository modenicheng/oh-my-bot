// @omb/bot-api — 玩家脚本 API（v0.3 §11）。
// L0 原语 + L1 便利层；navigateTo 提供服务器确定性静态寻路，不提供弹道预测/威胁评估。
// 本包是双受众语料：玩家手册 docs/manual/ 引用此处签名，AI Agent 注入此类型定义。
//
// 本文件是公开 Bot API 的唯一权威源（审计 X-1）：Monaco extraLib 直接注入原文；
// 客户端补全表（client/src/workbench/bot-completions.gen.ts）与服务器 AI prompt
// 运行时契约测试（server/internal/botapi，go:embed）由 scripts/gen.mjs 生成。
// 修改 API 面或数值注释后运行：pnpm --filter @omb/bot-api gen。

export interface Vec2 { readonly x: number; readonly y: number }

export interface RobotRef { readonly id: number; readonly position: Vec2; readonly hp: number; readonly velocity: Vec2 }

/** 静态墙 AABB（公开地图结构，不随视野/遮挡裁剪；与碰撞几何一致，只读）。 */
export interface WallRef { readonly id: number; readonly min: Vec2; readonly max: Vec2 }

/** 健康包（公开静态点；触碰后自动回血，冷却状态随快照更新）。 */
export interface HealthPackRef {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly available: boolean
  readonly respawnInS: number
}

/** scan() 返回的感知快照：动态实体按视野+墙体遮挡裁剪；地图对象为静态公开全量。 */
/** 弹丸感知项：owner 为射手 robotID（自己发射的也会出现在列表中）；heading 为当前飞行方向（弧度，含散布后的瞬时值），弹速 30 m/s。 */
export interface ProjectileRef {
  /** 弹体 id（跨 tick 稳定，可差分测速）。 */
  readonly id: number
  /** 射手机器人 id。 */
  readonly owner: number
  /** 当前位置 x（米）。 */
  readonly x: number
  /** 当前位置 y（米）。 */
  readonly y: number
  /** 当前飞行方向（弧度，含散布）。 */
  readonly heading: number
}

export interface Observation {
  /** 快照对应的模拟帧号。 */
  readonly tick: number
  /** 可见机器人（不含自己）。 */
  readonly robots: readonly RobotRef[]
  /** 可见核心（含 id）。 */
  readonly cores: readonly (Vec2 & { readonly id: number })[]
  /** 可见上行桩（含 ready/holder）。 */
  readonly uplinks: readonly (Vec2 & { readonly id: number; readonly ready: boolean; readonly holder?: number })[]
  /** 可见弹体（id/owner/x/y/heading，弹速 30 m/s）。 */
  readonly projectiles: readonly ProjectileRef[]
  /** 公开健康包（id/x/y/available/respawnInS；可能为空数组，不会为 undefined）。触碰可用点自动回血。 */
  readonly healthPacks: readonly HealthPackRef[]
  /** 静态墙列表（可能为空数组，不会为 undefined）。修改返回值不影响地图。 */
  readonly walls: readonly WallRef[]
}

export interface Self {
  /** 当前机器人 ID。 */
  readonly id: number
  /** 当前生命（上限 100）。 */
  readonly hp: number
  /** 当前能量（上限 100，回复 10/s）。 */
  readonly energy: number
  /** 当前位置（米）。 */
  readonly position: Vec2
  /** 当前速度（米/秒）。 */
  readonly velocity: Vec2
  // 注：控制轴归属（human/script/snippet）不对脚本暴露（ADR-0009：
  // 脚本不可感知手操状态）；该信息仅下发客户端 UI（SelfState.move_src）。
}

export interface GameInfo {
  readonly time: number          // 已进行秒数
  readonly timeLeft: number      // 剩余秒数
  readonly phase: 'OUTER_RING' | 'CORE_OPEN' // 当前阶段
  readonly mapSeed: number // 地图种子
}

// ---- L0 原语 ----
/** 动作只对当前 tick 生效；省略即中立，持续动作需每 tick 调用。 */
export interface L0 {
  /** 全向移动意图（向量按方向归一）；速度上限 8 m/s。 */
  move(vx: number, vy: number): void
  /** 炮塔转向绝对角度（弧度）；L1 重载可直接瞄准可见 RobotRef。 */
  aimAt(angle: number): void
  /** 本 tick 开火：间隔 250ms、耗能 5/发、有效射程 16m（16–20m 精度衰减、弹速 30 m/s）；护盾中不可开火。 */
  fire(): void
  /** 持续冲刺 16 m/s、耗能 20/秒；与护盾互斥（护盾优先），能量耗尽后至少省略一个 tick 才能重启。 */
  dash(): void
  /** 护盾：减伤 65%、不可开火、移速 80%、耗能约 18/秒；省略或 false 即关。 */
  shield(on: boolean): void
  /** Uplink 引导黑入：普通桩 2.5m / 主桩 3m 内持续引导 8s。 */
  interact(): void
  /** 全场发言，最多 160 字符；空白合并，与 Enter 手动发言共用 3s 冷却。 */
  say(text: string): void
}

// ---- L1 便利层 ----
export interface L1 {
  /** 保持直线移动语义，不避障。 */
  moveTo(pos: Vec2): void
  /** 使用服务器确定性静态寻路，避开墙、竞技场边界与未开放中央锁区。 */
  navigateTo(pos: Vec2): void
  /** 瞄准可见机器人（按其当前位置计算角度）；不可见实体抛 TypeError。 */
  aimAt(target: RobotRef): void
  /** 视野内最近存活敌人，没有返回 null。 */
  nearestEnemy(): RobotRef | null
  /** 全图最近存活 Core，没有返回 null。 */
  nearestCore(): Vec2 | null
  /** 全图最近激活 Uplink，没有返回 null。 */
  nearestUplink(): Vec2 | null
  /** 请求脉冲扫描：半径 32m、耗能 12、CD 2s，仍不穿墙；始终返回当前感知快照。 */
  pulseScan(): Observation
}

export interface ScriptConsole {
  log(...values: unknown[]): void
  info(...values: unknown[]): void
  warn(...values: unknown[]): void
  error(...values: unknown[]): void
  debug(...values: unknown[]): void
}

/** 每帧重建的只读元数据与动作接口。 */
export interface BotContext extends Omit<L0, 'aimAt'>, Omit<L1, 'aimAt'> {
  /** 己方只读快照。 */
  readonly self: Self
  /** 对局只读信息：局时、阶段、地图种子。 */
  readonly game: GameInfo
  /** 免费感知：视野 20m + 墙体遮挡裁剪后的最近快照，可任意频次调用。 */
  scan(): Observation
  aimAt(angle: number): void
  aimAt(target: RobotRef): void
  /** @deprecated 新脚本直接使用 bot.move()/bot.scan()。 */
  readonly api: L0 & L1
}

/** @deprecated 使用 BotContext；旧脚本类型名继续兼容。 */
export type TickContext = BotContext

export interface BotModule {
  tick(bot: BotContext): void
}
