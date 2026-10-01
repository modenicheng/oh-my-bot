// @omb/bot-api — 玩家脚本 API（v0.3 §11）。
// L0 原语 + L1 便利层，到此为止：不提供寻路/弹道预测/威胁评估（那是玩家的天花板）。
// 本包是双受众语料：玩家手册 docs/manual/ 引用此处签名，AI Agent 注入此类型定义。

export interface Vec2 { readonly x: number; readonly y: number }

export interface RobotRef { readonly id: number; readonly position: Vec2; readonly hp: number }

/** 静态墙 AABB（公开地图结构，不随视野/遮挡裁剪；与碰撞几何一致，只读）。 */
export interface WallRef { readonly id: number; readonly min: Vec2; readonly max: Vec2 }

/** scan() 返回的感知快照：动态实体按视野+墙体遮挡裁剪；walls 为静态公开全量。 */
export interface Observation {
  readonly tick: number
  readonly robots: readonly RobotRef[]
  readonly cores: readonly (Vec2 & { readonly id: number })[]
  readonly uplinks: readonly (Vec2 & { readonly id: number; readonly ready: boolean; readonly holder?: number })[]
  readonly projectiles: readonly (Vec2 & { readonly id: number })[]
  /** 静态墙列表（可能为空数组，不会为 undefined）。修改返回值不影响地图。 */
  readonly walls: readonly WallRef[]
}

export interface Self {
  readonly id: number
  readonly hp: number
  readonly energy: number
  readonly position: Vec2
  readonly velocity: Vec2
  // 注：控制轴归属（human/script/snippet）不对脚本暴露（ADR-0009：
  // 脚本不可感知手操状态）；该信息仅下发客户端 UI（SelfState.move_src）。
}

export interface GameInfo {
  readonly time: number          // 已进行秒数
  readonly timeLeft: number      // 剩余秒数
  readonly phase: 'OUTER_RING' | 'CORE_OPEN'
  readonly mapSeed: number
}

// ---- L0 原语 ----
export interface L0 {
  move(vx: number, vy: number): void
  aimAt(angle: number): void
  fire(): void
  dash(): void
  shield(on: boolean): void
  interact(): void
  /** 全场发言，最多 160 字符；空白合并，与 Enter 手动发言共用 3s 冷却。 */
  say(text: string): void
}

// ---- L1 便利层 ----
export interface L1 {
  moveTo(pos: Vec2): void
  aimAt(target: RobotRef): void
  nearestEnemy(): RobotRef | null
  nearestCore(): Vec2 | null
  nearestUplink(): Vec2 | null
  /** 请求脉冲扫描，始终返回当前感知快照。 */
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
  readonly self: Self
  readonly game: GameInfo
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
