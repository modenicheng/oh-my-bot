// @omb/bot-api — 玩家脚本 API（v0.3 §11）。
// L0 原语 + L1 便利层；navigateTo 只基于当前局部观察确定性寻路，不使用隐藏地图，不提供弹道预测/威胁评估。
// 本包是双受众语料：玩家手册 docs/manual/ 引用此处签名，AI Agent 注入此类型定义。
//
// 本文件是公开 Bot API 的唯一权威源（审计 X-1）：Monaco extraLib 直接注入原文；
// 客户端补全表（client/src/workbench/bot-completions.gen.ts）与服务器 AI prompt
// 运行时契约测试（server/internal/botapi，go:embed）由 scripts/gen.mjs 生成。
// 修改 API 面或数值注释后运行：pnpm --filter @omb/bot-api gen。

export interface Vec2 { readonly x: number; readonly y: number }

export interface RobotRef {
  readonly id: number
  readonly position: Vec2
  readonly hp: number
  readonly velocity: Vec2
  /** 升级后血量上限（公开分母，同头顶条；可反推 hp 轨等级）。 */
  readonly maxHp: number
  /** 升级后能量上限（公开分母；可反推 energy 轨等级）。 */
  readonly maxEnergy: number
}

/** 五条升级轨，对应 UpgradeRequest 轨号 1–5：hp/speed/shield/attack/energy。 */
export type UpgradeTrack = 'hp' | 'speed' | 'shield' | 'attack' | 'energy'

/** 本机各轨等级，当前每轨 0–10。 */
export interface UpgradeLevels {
  readonly hp: number
  readonly speed: number
  readonly shield: number
  readonly attack: number
  readonly energy: number
}

/** 本机私密、冻结的升级快照；购买结果以下一 tick 快照为准。 */
export interface UpgradeSelf {
  /**
   * 未花费技能点：普通 Core +2 / Mega +5；每颗新增普通/Mega Core 附带最多 1/2 只各 +1 的环境晶片。
   * 全场环境晶片存量上限为 ceil(参赛机器人席位数 / 4)，含 bot，死亡者仍计席位；满额时只生 Core，额度不足时只发可容纳的只数。
   * 拾取或 30s 过期释放额度，由后续新增 Core 补充；存活 Core 不重复补，不保证固定总收益，也不再守恒旧 5/10 预算。
   * 赏金阵亡散落全部自由点数；赏金晶片不占环境额度、不受该上限约束。
   */
  readonly points: number
  readonly levels: UpgradeLevels
  /** 服务端按赏金门槛派生（当前任一轨 ≥L4）；勿在脚本中硬编码门槛。 */
  readonly bounty: boolean
}

/** 当前可见墙面；可为零厚度 AABB。id 只在该快照内有效，不包含墙背面的尺寸。 */
export interface WallRef { readonly id: number; readonly min: Vec2; readonly max: Vec2 }

/** 当前可见健康包（位置与冷却规则固定，但位置及状态仍按距离和视线裁剪；触碰可用点自动回血）。 */
export interface HealthPackRef {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly available: boolean
  readonly respawnInS: number
}

/** 当前可见的技能点晶片，30s 过期。离开视野不代表已经被拾取。 */
export interface PointDropRef {
  readonly id: number
  readonly x: number
  readonly y: number
  /** 环境晶片每只 1 点，赏金晶片 1–4 点；接触拾取，谁碰归谁，只给技能点不给计分。 */
  readonly points: number
}

/** 当前可见弹丸：owner 为射手 robotID（可含自己发射的）；heading 为当前飞行方向（弧度，含散布后的瞬时值），弹速 36 m/s。 */
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

/** 所有世界对象和地图墙面均按当前视野距离与遮挡裁剪，普通 20m、脉冲一帧 32m。 */
export interface Observation {
  /** 快照对应的模拟帧号。 */
  readonly tick: number
  /** 可见机器人（不含自己）。 */
  readonly robots: readonly RobotRef[]
  /** 当前可见存活 Core（含 id 与实际坐标；每次重生重新随机选合法位置，不是固定刷点）。 */
  readonly cores: readonly (Vec2 & { readonly id: number; readonly value?: number })[]
  /** 可见上行桩（含 ready/holder）。 */
  readonly uplinks: readonly (Vec2 & { readonly id: number; readonly ready: boolean; readonly holder?: number })[]
  /** 可见弹体（id/owner/x/y/heading，弹速 36 m/s）。 */
  readonly projectiles: readonly ProjectileRef[]
  /** 当前可见健康包（id/x/y/available/respawnInS；可能为空数组，不会为 undefined）。触碰可用点自动回血。 */
  readonly healthPacks: readonly HealthPackRef[]
  /** 当前可见的技能点晶片（可能为空数组）。 */
  readonly pointDrops: readonly PointDropRef[]
  /** 当前可见墙面片段，不含隐藏墙背面或完整尺寸；可为零厚度 AABB，id 只在当前快照内有效。 */
  readonly walls: readonly WallRef[]
  /** 当前可见竞技场/未开放锁区的表面线段，按距离与遮挡裁剪，不是完整边界轮廓。 */
  readonly boundaries: readonly { readonly kind: 'arena' | 'lock'; readonly start: Vec2; readonly end: Vec2 }[]
}

export interface Self {
  readonly shieldOn?: boolean
  readonly shieldReadyTick?: number
  readonly shieldStartedTick?: number
  /** 当前机器人 ID。 */
  readonly id: number
  /** 当前生命（基础上限 100，随 hp 轨升级增长至 250）。 */
  readonly hp: number
  /** 当前能量（基础上限 100，随 energy 轨升级增长至 300，回复恒 10/s）。 */
  readonly energy: number
  /** 当前位置（米）。 */
  readonly position: Vec2
  /** 当前速度（米/秒）。 */
  readonly velocity: Vec2
  /** 本机升级状态，仅自己可见；他人只能从 maxHp/maxEnergy 间接推断部分等级。 */
  readonly upgrade: UpgradeSelf
  // 注：控制轴归属（human/script/snippet）不对脚本暴露（ADR-0009：
  // 脚本不可感知手操状态）；该信息仅下发客户端 UI（SelfState.move_src）。
}

export interface GameInfo {
  readonly time: number          // 已进行秒数
  readonly timeLeft: number      // 剩余秒数
  readonly phase: 'OUTER_RING' | 'CORE_OPEN' // 当前阶段
  /** @deprecated 兼容旧脚本，恒为 0；不暴露地图生成种子，不能据此重建隐藏地图。 */
  readonly mapSeed: number
  /** 本局开局冻结的成本曲线：costs[L] 为 L→L+1 所需点数，长度即满级；当前 [2,3,5,8,12,18,27,40,60,90]。 */
  readonly upgradeCosts: readonly number[]
}

// ---- L0 原语 ----
/** 动作只对当前 tick 生效；省略即中立，持续动作需每 tick 调用；购买按次累积。 */
export interface L0 {
  /** 全向移动意图（向量按方向归一）；速度上限 8 m/s。 */
  move(vx: number, vy: number): void
  /** 炮塔转向绝对角度（弧度）；L1 重载可直接瞄准可见 RobotRef。 */
  aimAt(angle: number): void
  /** 本 tick 开火：间隔 250ms、耗能 5/发、有效射程 16m（16–20m 精度衰减、弹速 36 m/s）；护盾中不可开火。 */
  fire(): void
  /** 持续冲刺 15 m/s、加速度 60 m/s²、耗能 20/秒；与护盾互斥（护盾优先），能量耗尽后至少省略一个 tick 才能重启。 */
  dash(): void
  /** 护盾：减伤 65%、不可开火、移速 80%、耗能约 18/秒；最短 3 tick 后省略或 false 关闭，耗尽也关闭。持续 3–600 tick 的冷却由 12 线性增至 180 tick 并钳制，冷却内请求不延长它。 */
  shield(on: boolean): void
  /** Uplink 引导黑入：普通桩 2.5m / 主桩 3m 内持续引导 4s。 */
  interact(): void
  /** 全场发言，最多 160 字符；空白合并，与 Enter 手动发言共用 3s 冷却。 */
  say(text: string): void
  /**
   * 排队购买一级指定轨，返回 void，下一 tick 快照为准；点数不足/满级/热身静默无效。
   * 同 tick 多次调用累积，排在人类购买之后，按序校验扣点，共享 8 次/tick 上限（超出丢弃）。
   * 非法 track 抛 TypeError；死亡期间可买，复活按新上限；不参与分轴仲裁、不破除复活无敌。
   * 超时或异常 tick 的购买队列随其他脚本意图一并清空。
   */
  buyUpgrade(track: UpgradeTrack): void
}

// ---- L1 便利层 ----
export interface L1 {
  /** 保持直线移动语义，不避障。 */
  moveTo(pos: Vec2): void
  /** 只基于当前观察中的墙面和边界确定性寻路；超出当前感知半径的目标不借助隐藏地图规划，需分段探索，不保证未知区域可达。 */
  navigateTo(pos: Vec2): void
  /** 瞄准可见机器人（按其当前位置计算角度）；不可见实体抛 TypeError。 */
  aimAt(target: RobotRef): void
  /** 视野内最近存活敌人，没有返回 null。 */
  nearestEnemy(): RobotRef | null
  /** 当前观察中最近的存活 Core，没有返回 null；不表示全图没有资源。 */
  nearestCore(): Vec2 | null
  /** 当前观察中最近的存活技能点晶片（含 id/points），无则 null；不探测隐藏或锁区内不可见的晶片。 */
  nearestPointDrop(): PointDropRef | null
  /** 当前观察中最近的激活 Uplink，没有返回 null；不表示全图没有桩。 */
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
  /** 对局只读信息：局时、阶段与升级成本；mapSeed 已弃用且恒为 0。浏览器完整静态地形引导包仅供渲染，不是脚本观察。 */
  readonly game: GameInfo
  /** 免费感知：所有实体、资源、墙面及边界按当前距离与视线遮挡裁剪，普通 20m / 脉冲帧 32m，可任意频次调用；离开视野不等于销毁。 */
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
