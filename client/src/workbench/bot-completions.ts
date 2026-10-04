// 编辑器前缀补全种子：纯数据 + 纯函数，供 Monaco completion provider 消费。
// 类型口径与 @omb/bot-api 保持一致；刻意不 import monaco，便于单元测试。

export type CompletionSeedKind = 'method' | 'property' | 'keyword' | 'snippet'

export interface CompletionSeed {
  label: string
  insert: string
  kind: CompletionSeedKind
  detail: string
}

export interface PrefixContext {
  atDot: boolean
  chain: string[]
  word: string
}

const API_METHODS: CompletionSeed[] = [
  { label: 'move', insert: 'move($1, $2)', kind: 'method', detail: 'move(vx: number, vy: number) — L0 移动' },
  { label: 'aimAt', insert: 'aimAt($1)', kind: 'method', detail: 'aimAt(angle | RobotRef) — L0/L1 瞄准' },
  { label: 'fire', insert: 'fire()', kind: 'method', detail: 'fire() — 本 tick 开火意图，省略即停' },
  { label: 'dash', insert: 'dash()', kind: 'method', detail: 'dash() — 本 tick 冲刺，持续耗能 20/s，护盾优先' },
  { label: 'shield', insert: 'shield($1)', kind: 'method', detail: 'shield(on: boolean) — 本 tick 护盾意图，省略即关' },
  { label: 'interact', insert: 'interact()', kind: 'method', detail: 'interact() — 本 tick 引导 Uplink，持续引导需每 tick 调用' },
  { label: 'say', insert: 'say($1)', kind: 'method', detail: 'say(text: string) — L0 全场发言，3s 冷却' },
  { label: 'moveTo', insert: 'moveTo($1)', kind: 'method', detail: 'moveTo(pos: Vec2) — L1 朝目标点移动' },
  { label: 'navigateTo', insert: 'navigateTo($1)', kind: 'method', detail: 'navigateTo(pos: Vec2) — L1 服务器确定性寻路，避开墙与未开放锁区' },
  { label: 'nearestEnemy', insert: 'nearestEnemy()', kind: 'method', detail: 'nearestEnemy(): RobotRef | null — L1 最近可见敌人' },
  { label: 'nearestCore', insert: 'nearestCore()', kind: 'method', detail: 'nearestCore(): Vec2 | null — L1 最近核心' },
  { label: 'nearestUplink', insert: 'nearestUplink()', kind: 'method', detail: 'nearestUplink(): Vec2 | null — L1 最近上行桩' },
  { label: 'pulseScan', insert: 'pulseScan()', kind: 'method', detail: 'pulseScan(): Observation — L1 请求脉冲扫描' },
]

const BOT_MEMBERS: CompletionSeed[] = [
  ...API_METHODS,
  { label: 'self', insert: 'self', kind: 'property', detail: 'self: Self — 己方只读快照' },
  { label: 'game', insert: 'game', kind: 'property', detail: 'game: GameInfo — 对局只读信息' },
  { label: 'scan', insert: 'scan()', kind: 'method', detail: 'scan(): Observation — 视野+遮挡裁剪后的快照' },
]

const SELF_MEMBERS: CompletionSeed[] = [
  { label: 'id', insert: 'id', kind: 'property', detail: 'id: number — 当前机器人 ID' },
  { label: 'hp', insert: 'hp', kind: 'property', detail: 'hp: number — 当前生命' },
  { label: 'energy', insert: 'energy', kind: 'property', detail: 'energy: number — 当前能量' },
  { label: 'position', insert: 'position', kind: 'property', detail: 'position: Vec2 — 当前位置' },
  { label: 'velocity', insert: 'velocity', kind: 'property', detail: 'velocity: Vec2 — 当前速度' },
]

const GAME_MEMBERS: CompletionSeed[] = [
  { label: 'time', insert: 'time', kind: 'property', detail: 'time: number — 已进行秒数' },
  { label: 'timeLeft', insert: 'timeLeft', kind: 'property', detail: 'timeLeft: number — 剩余秒数' },
  { label: 'phase', insert: 'phase', kind: 'property', detail: "phase: 'OUTER_RING' | 'CORE_OPEN' — 当前阶段" },
  { label: 'mapSeed', insert: 'mapSeed', kind: 'property', detail: 'mapSeed: number — 地图种子' },
]

const OBSERVATION_MEMBERS: CompletionSeed[] = [
  { label: 'tick', insert: 'tick', kind: 'property', detail: 'tick: number — 快照对应的模拟帧' },
  { label: 'robots', insert: 'robots', kind: 'property', detail: 'robots: readonly RobotRef[] — 可见机器人' },
  { label: 'cores', insert: 'cores', kind: 'property', detail: 'cores: readonly Vec2[] — 可见核心' },
  { label: 'uplinks', insert: 'uplinks', kind: 'property', detail: 'uplinks — 可见上行桩（ready/holder）' },
  { label: 'projectiles', insert: 'projectiles', kind: 'property', detail: 'projectiles: readonly ProjectileRef[] — 可见弹体（id/owner/x/y/heading，弹速 30 m/s）' },
  { label: 'healthPacks', insert: 'healthPacks', kind: 'property', detail: 'healthPacks: readonly HealthPackRef[] — 公开健康包（id/x/y/available/respawnInS，触碰自动回血）' },
  { label: 'walls', insert: 'walls', kind: 'property', detail: 'walls: readonly WallRef[] — 静态墙 AABB（公开全量）' },
]

const WORD_SEEDS: CompletionSeed[] = [
  { label: 'bot', insert: 'bot', kind: 'keyword', detail: 'bot: BotContext — self / game / scan() / 动作方法' },
  { label: 'tickfn', insert: 'function tick(bot) {\n\t$0\n}', kind: 'snippet', detail: 'tick(bot) 入口骨架 — 服务器每帧调用' },
  { label: 'botmod', insert: 'const bot = {\n\ttick(bot) {\n\t\t$0\n\t},\n}\n\nexport default bot', kind: 'snippet', detail: 'bot 对象模块骨架（import type / export default 行由服务器剥离）' },
]

const PROJECTILE_MEMBERS: CompletionSeed[] = [
  { label: 'id', insert: 'id', kind: 'property', detail: 'id: number — 弹体 id（跨 tick 稳定，可差分测速）' },
  { label: 'owner', insert: 'owner', kind: 'property', detail: 'owner: number — 射手机器人 id' },
  { label: 'x', insert: 'x', kind: 'property', detail: 'x: number — 当前位置 x（米）' },
  { label: 'y', insert: 'y', kind: 'property', detail: 'y: number — 当前位置 y（米）' },
  { label: 'heading', insert: 'heading', kind: 'property', detail: 'heading: number — 当前飞行方向（弧度，含散布）' },
]

const MEMBER_TABLE: Record<string, CompletionSeed[]> = {
  bot: BOT_MEMBERS,
  'bot.self': SELF_MEMBERS,
  'bot.game': GAME_MEMBERS,
  'bot.scan': OBSERVATION_MEMBERS,
  'bot.pulseScan': OBSERVATION_MEMBERS,
  'bot.scan.projectiles': PROJECTILE_MEMBERS,
  'bot.pulseScan.projectiles': PROJECTILE_MEMBERS,
}

function receiverChain(expr: string): string[] {
  let rest = expr.trimEnd()
  const chain: string[] = []
  const IDENT = /^[A-Za-z_$][\w$]*$/
  for (;;) {
    if (rest.endsWith(')')) {
      const open = rest.lastIndexOf('(')
      if (open < 0 || rest.slice(open + 1, -1).trim() !== '') break
      rest = rest.slice(0, open).trimEnd()
    }
    const id = /([A-Za-z_$][\w$]*)$/.exec(rest)
    if (!id?.[1]) break
    chain.unshift(id[1])
    rest = rest.slice(0, rest.length - id[1].length).trimEnd()
    if (rest.endsWith('.')) { rest = rest.slice(0, -1).trimEnd(); continue }
    if (IDENT.test(rest)) chain.unshift(rest)
    break
  }
  return chain
}

export function completionContext(linePrefix: string): PrefixContext {
  const trimmed = linePrefix.replace(/\s+$/, '')
  if (trimmed.endsWith('.')) return { atDot: true, chain: receiverChain(trimmed.slice(0, -1)), word: '' }
  return { atDot: false, chain: [], word: /[A-Za-z_$][\w$]*$/.exec(trimmed)?.[0] ?? '' }
}

export function seedsForContext(context: PrefixContext): CompletionSeed[] {
  if (context.atDot) return MEMBER_TABLE[context.chain.join('.')] ?? []
  return WORD_SEEDS.filter(seed => seed.label.toLowerCase().startsWith(context.word.toLowerCase()))
}
