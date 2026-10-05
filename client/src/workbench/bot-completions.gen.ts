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
  { label: "fire", insert: "fire()", kind: 'method', detail: "fire(): void — 本 tick 开火：间隔 250ms、耗能 5/发、有效射程 16m（16–20m 精度衰减、弹速 30 m/s）；护盾中不可开火" },
  { label: "dash", insert: "dash()", kind: 'method', detail: "dash(): void — 持续冲刺 16 m/s、耗能 20/秒；与护盾互斥（护盾优先），能量耗尽后至少省略一个 tick 才能重启" },
  { label: "shield", insert: "shield($1)", kind: 'method', detail: "shield(on: boolean): void — 护盾：减伤 65%、不可开火、移速 80%、耗能约 18/秒；省略或 false 即关" },
  { label: "interact", insert: "interact()", kind: 'method', detail: "interact(): void — Uplink 引导黑入：普通桩 2.5m / 主桩 3m 内持续引导 8s" },
  { label: "say", insert: "say($1)", kind: 'method', detail: "say(text: string): void — 全场发言，最多 160 字符；空白合并，与 Enter 手动发言共用 3s 冷却" },
  { label: "moveTo", insert: "moveTo($1)", kind: 'method', detail: "moveTo(pos: Vec2): void — 保持直线移动语义，不避障" },
  { label: "navigateTo", insert: "navigateTo($1)", kind: 'method', detail: "navigateTo(pos: Vec2): void — 使用服务器确定性静态寻路，避开墙、竞技场边界与未开放中央锁区" },
  { label: "nearestEnemy", insert: "nearestEnemy()", kind: 'method', detail: "nearestEnemy(): RobotRef | null — 视野内最近存活敌人，没有返回 null" },
  { label: "nearestCore", insert: "nearestCore()", kind: 'method', detail: "nearestCore(): Vec2 | null — 全图最近存活 Core，没有返回 null" },
  { label: "nearestUplink", insert: "nearestUplink()", kind: 'method', detail: "nearestUplink(): Vec2 | null — 全图最近激活 Uplink，没有返回 null" },
  { label: "pulseScan", insert: "pulseScan()", kind: 'method', detail: "pulseScan(): Observation — 请求脉冲扫描：半径 32m、耗能 12、CD 2s，仍不穿墙；始终返回当前感知快照" },
  { label: "self", insert: "self", kind: 'property', detail: "self: Self — 己方只读快照" },
  { label: "game", insert: "game", kind: 'property', detail: "game: GameInfo — 对局只读信息：局时、阶段、地图种子" },
  { label: "scan", insert: "scan()", kind: 'method', detail: "scan(): Observation — 免费感知：视野 20m + 墙体遮挡裁剪后的最近快照，可任意频次调用" },
]

export const SELF_MEMBER_SEEDS: CompletionSeed[] = [
  { label: "id", insert: "id", kind: 'property', detail: "id: number — 当前机器人 ID" },
  { label: "hp", insert: "hp", kind: 'property', detail: "hp: number — 当前生命（上限 100）" },
  { label: "energy", insert: "energy", kind: 'property', detail: "energy: number — 当前能量（上限 100，回复 10/s）" },
  { label: "position", insert: "position", kind: 'property', detail: "position: Vec2 — 当前位置（米）" },
  { label: "velocity", insert: "velocity", kind: 'property', detail: "velocity: Vec2 — 当前速度（米/秒）" },
]

export const GAME_MEMBER_SEEDS: CompletionSeed[] = [
  { label: "time", insert: "time", kind: 'property', detail: "time: number — 已进行秒数" },
  { label: "timeLeft", insert: "timeLeft", kind: 'property', detail: "timeLeft: number — 剩余秒数" },
  { label: "phase", insert: "phase", kind: 'property', detail: "phase: 'OUTER_RING' | 'CORE_OPEN' — 当前阶段" },
  { label: "mapSeed", insert: "mapSeed", kind: 'property', detail: "mapSeed: number — 地图种子" },
]

export const OBSERVATION_MEMBER_SEEDS: CompletionSeed[] = [
  { label: "tick", insert: "tick", kind: 'property', detail: "tick: number — 快照对应的模拟帧号" },
  { label: "robots", insert: "robots", kind: 'property', detail: "robots: readonly RobotRef[] — 可见机器人（不含自己）" },
  { label: "cores", insert: "cores", kind: 'property', detail: "cores: readonly (Vec2 & { readonly id: number })[] — 可见核心（含 id）" },
  { label: "uplinks", insert: "uplinks", kind: 'property', detail: "uplinks: readonly (Vec2 & { readonly id: number; readonly ready: boolean; readonly holder?: number })[] — 可见上行桩（含 ready/holder）" },
  { label: "projectiles", insert: "projectiles", kind: 'property', detail: "projectiles: readonly ProjectileRef[] — 可见弹体（id/owner/x/y/heading，弹速 30 m/s）" },
  { label: "healthPacks", insert: "healthPacks", kind: 'property', detail: "healthPacks: readonly HealthPackRef[] — 公开健康包（id/x/y/available/respawnInS；可能为空数组，不会为 undefined）。触碰可用点自动回血" },
  { label: "walls", insert: "walls", kind: 'property', detail: "walls: readonly WallRef[] — 静态墙列表（可能为空数组，不会为 undefined）。修改返回值不影响地图" },
]

export const PROJECTILE_MEMBER_SEEDS: CompletionSeed[] = [
  { label: "id", insert: "id", kind: 'property', detail: "id: number — 弹体 id（跨 tick 稳定，可差分测速）" },
  { label: "owner", insert: "owner", kind: 'property', detail: "owner: number — 射手机器人 id" },
  { label: "x", insert: "x", kind: 'property', detail: "x: number — 当前位置 x（米）" },
  { label: "y", insert: "y", kind: 'property', detail: "y: number — 当前位置 y（米）" },
  { label: "heading", insert: "heading", kind: 'property', detail: "heading: number — 当前飞行方向（弧度，含散布）" },
]
