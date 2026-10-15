// 自动生成（审计 X-1）：由 packages/bot-api/src/index.ts 生成，勿手改。
// 再生成：pnpm --filter @omb/bot-api gen（新鲜度由 bot-api-drift.test.ts 对拍）。

export type CompletionSeedKind = 'method' | 'property' | 'keyword' | 'snippet'

export interface CompletionSeed {
  label: string
  insert: string
  kind: CompletionSeedKind
  detail: string
}
export const BOT_MEMBER_SEEDS: CompletionSeed[] = [
  { label: "move", insert: "move($1, $2)", kind: 'method', detail: "move(vx: number, vy: number): void — 全向移动意图（向量按方向归一）；速度上限 8 m/s" },
  { label: "aimAt", insert: "aimAt($1)", kind: 'method', detail: "aimAt(angle: number | RobotRef): void — 炮塔转向绝对角度（弧度）；L1 重载可直接瞄准可见 RobotRef；瞄准可见机器人（按其当前位置计算角度）；不可见实体抛 TypeError" },
  { label: "fire", insert: "fire()", kind: 'method', detail: "fire(): void — 本 tick 开火：间隔 250ms、耗能 5/发、有效射程 16m（16–20m 精度衰减、弹速 36 m/s）；护盾中不可开火" },
  { label: "dash", insert: "dash()", kind: 'method', detail: "dash(): void — 持续冲刺 15 m/s、加速度 60 m/s²、耗能 20/秒；与护盾互斥（护盾优先），能量耗尽后至少省略一个 tick 才能重启" },
  { label: "shield", insert: "shield($1)", kind: 'method', detail: "shield(on: boolean): void — 护盾：减伤 65%、不可开火、移速 80%、耗能约 18/秒；最短 3 tick 后省略或 false 关闭，耗尽也关闭。持续 3–600 tick 的冷却由 12 线性增至 180 tick 并钳制，冷却内请求不延长它" },
  { label: "interact", insert: "interact()", kind: 'method', detail: "interact(): void — Uplink 引导黑入：普通桩 2.5m / 主桩 3m 内持续引导 4s" },
  { label: "say", insert: "say($1)", kind: 'method', detail: "say(text: string): void — 全场发言，最多 160 字符；空白合并，与 Enter 手动发言共用 3s 冷却" },
  { label: "buyUpgrade", insert: "buyUpgrade($1)", kind: 'method', detail: "buyUpgrade(track: UpgradeTrack): void — 排队购买一级指定轨，返回 void，下一 tick 快照为准；点数不足/满级/热身静默无效。 同 tick 多次调用累积，排在人类购买之后，按序校验扣点，共享 8 次/tick 上限（超出丢弃）。 非法 track 抛 TypeError；死亡期间可买，复活按新上限；不参与分轴仲裁、不破除复活无敌。 超时或异常 tick 的购买队列随其他脚本意图一并清空" },
  { label: "moveTo", insert: "moveTo($1)", kind: 'method', detail: "moveTo(pos: Vec2): void — 保持直线移动语义，不避障" },
  { label: "navigateTo", insert: "navigateTo($1)", kind: 'method', detail: "navigateTo(pos: Vec2): void — 只基于当前观察中的墙面和边界确定性寻路；超出当前感知半径的目标不借助隐藏地图规划，需分段探索，不保证未知区域可达" },
  { label: "nearestEnemy", insert: "nearestEnemy()", kind: 'method', detail: "nearestEnemy(): RobotRef | null — 视野内最近存活敌人，没有返回 null" },
  { label: "nearestCore", insert: "nearestCore()", kind: 'method', detail: "nearestCore(): Vec2 | null — 当前观察中最近的存活 Core，没有返回 null；不表示全图没有资源" },
  { label: "nearestPointDrop", insert: "nearestPointDrop()", kind: 'method', detail: "nearestPointDrop(): PointDropRef | null — 当前观察中最近的存活技能点晶片（含 id/points），无则 null；不探测隐藏或锁区内不可见的晶片" },
  { label: "nearestUplink", insert: "nearestUplink()", kind: 'method', detail: "nearestUplink(): Vec2 | null — 当前观察中最近的激活 Uplink，没有返回 null；不表示全图没有桩" },
  { label: "pulseScan", insert: "pulseScan()", kind: 'method', detail: "pulseScan(): Observation — 请求脉冲扫描：半径 32m、耗能 12、CD 2s，仍不穿墙；始终返回当前感知快照" },
  { label: "self", insert: "self", kind: 'property', detail: "self: Self — 己方只读快照" },
  { label: "game", insert: "game", kind: 'property', detail: "game: GameInfo — 对局只读信息：局时、阶段与升级成本；mapSeed 已弃用且恒为 0。浏览器完整静态地形引导包仅供渲染，不是脚本观察" },
  { label: "scan", insert: "scan()", kind: 'method', detail: "scan(): Observation — 免费感知：所有实体、资源、墙面及边界按当前距离与视线遮挡裁剪，普通 20m / 脉冲帧 32m，可任意频次调用；离开视野不等于销毁" },
]

export const SELF_MEMBER_SEEDS: CompletionSeed[] = [
  { label: "id", insert: "id", kind: 'property', detail: "id: number — 当前机器人 ID" },
  { label: "hp", insert: "hp", kind: 'property', detail: "hp: number — 当前生命（基础上限 100，随 hp 轨升级增长至 250）" },
  { label: "energy", insert: "energy", kind: 'property', detail: "energy: number — 当前能量（基础上限 100，随 energy 轨升级增长至 300，回复恒 10/s）" },
  { label: "position", insert: "position", kind: 'property', detail: "position: Vec2 — 当前位置（米）" },
  { label: "velocity", insert: "velocity", kind: 'property', detail: "velocity: Vec2 — 当前速度（米/秒）" },
  { label: "upgrade", insert: "upgrade", kind: 'property', detail: "upgrade: UpgradeSelf — 本机升级状态，仅自己可见；他人只能从 maxHp/maxEnergy 间接推断部分等级" },
]

export const GAME_MEMBER_SEEDS: CompletionSeed[] = [
  { label: "time", insert: "time", kind: 'property', detail: "time: number — 已进行秒数" },
  { label: "timeLeft", insert: "timeLeft", kind: 'property', detail: "timeLeft: number — 剩余秒数" },
  { label: "phase", insert: "phase", kind: 'property', detail: "phase: 'OUTER_RING' | 'CORE_OPEN' — 当前阶段" },
  { label: "mapSeed", insert: "mapSeed", kind: 'property', detail: "mapSeed: number — @deprecated 兼容旧脚本，恒为 0；不暴露地图生成种子，不能据此重建隐藏地图" },
  { label: "upgradeCosts", insert: "upgradeCosts", kind: 'property', detail: "upgradeCosts: readonly number[] — 本局开局冻结的成本曲线：costs[L] 为 L→L+1 所需点数，长度即满级；当前 [2,3,5,8,12,18,27,40,60,90]" },
]

export const OBSERVATION_MEMBER_SEEDS: CompletionSeed[] = [
  { label: "tick", insert: "tick", kind: 'property', detail: "tick: number — 快照对应的模拟帧号" },
  { label: "robots", insert: "robots", kind: 'property', detail: "robots: readonly RobotRef[] — 可见机器人（不含自己）" },
  { label: "cores", insert: "cores", kind: 'property', detail: "cores: readonly (Vec2 & { readonly id: number; readonly value?: number })[] — 当前可见存活 Core（含 id 与实际坐标；每次重生重新随机选合法位置，不是固定刷点）" },
  { label: "uplinks", insert: "uplinks", kind: 'property', detail: "uplinks: readonly (Vec2 & { readonly id: number; readonly ready: boolean; readonly holder?: number })[] — 可见上行桩（含 ready/holder）" },
  { label: "projectiles", insert: "projectiles", kind: 'property', detail: "projectiles: readonly ProjectileRef[] — 可见弹体（id/owner/x/y/heading，弹速 36 m/s）" },
  { label: "healthPacks", insert: "healthPacks", kind: 'property', detail: "healthPacks: readonly HealthPackRef[] — 当前可见健康包（id/x/y/available/respawnInS；可能为空数组，不会为 undefined）。触碰可用点自动回血" },
  { label: "pointDrops", insert: "pointDrops", kind: 'property', detail: "pointDrops: readonly PointDropRef[] — 当前可见的技能点晶片（可能为空数组）" },
  { label: "walls", insert: "walls", kind: 'property', detail: "walls: readonly WallRef[] — 当前可见墙面片段，不含隐藏墙背面或完整尺寸；可为零厚度 AABB，id 只在当前快照内有效" },
  { label: "boundaries", insert: "boundaries", kind: 'property', detail: "boundaries: readonly { readonly kind: 'arena' | 'lock'; readonly start: Vec2; readonly end: Vec2 }[] — 当前可见竞技场/未开放锁区的表面线段，按距离与遮挡裁剪，不是完整边界轮廓" },
]

export const PROJECTILE_MEMBER_SEEDS: CompletionSeed[] = [
  { label: "id", insert: "id", kind: 'property', detail: "id: number — 弹体 id（跨 tick 稳定，可差分测速）" },
  { label: "owner", insert: "owner", kind: 'property', detail: "owner: number — 射手机器人 id" },
  { label: "x", insert: "x", kind: 'property', detail: "x: number — 当前位置 x（米）" },
  { label: "y", insert: "y", kind: 'property', detail: "y: number — 当前位置 y（米）" },
  { label: "heading", insert: "heading", kind: 'property', detail: "heading: number — 当前飞行方向（弧度，含散布）" },
]
