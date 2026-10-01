// 编辑器前缀补全种子：纯数据 + 纯函数，供 Monaco completion provider 消费。
// 类型口径与 @omb/bot-api 保持一致；刻意不 import monaco，便于单元测试。

export type CompletionSeedKind = 'method' | 'property' | 'keyword' | 'snippet'

export interface CompletionSeed {
  label: string
  insert: string
  kind: CompletionSeedKind
  /** 补全列表中的中文说明，含签名。 */
  detail: string
}

export interface PrefixContext {
  /** 光标前文本以 '.' 结尾：按接收者成员链补全。 */
  atDot: boolean
  /** 点号前的接收者链（已剥离无参调用括号），如 ['ctx', 'api']。 */
  chain: string[]
  /** 非点号上下文时的标识符前缀；空串表示空白处触发（Ctrl+Space）。 */
  word: string
}

// ---- ctx.api：L0 原语 + L1 便利层（packages/bot-api/src/index.ts） ----
const API_METHODS: CompletionSeed[] = [
  { label: 'move', insert: 'move($1, $2)', kind: 'method', detail: 'move(vx: number, vy: number) — L0 移动' },
  { label: 'aimAt', insert: 'aimAt($1)', kind: 'method', detail: 'aimAt(angle: number) — L0 炮口朝向（弧度）' },
  { label: 'fire', insert: 'fire()', kind: 'method', detail: 'fire() — L0 开火意图' },
  { label: 'dash', insert: 'dash()', kind: 'method', detail: 'dash() — L0 冲刺' },
  { label: 'shield', insert: 'shield($1)', kind: 'method', detail: 'shield(on: boolean) — L0 护盾开关' },
  { label: 'interact', insert: 'interact()', kind: 'method', detail: 'interact() — L0 交互（占核/上行/拾取）' },
  { label: 'say', insert: 'say($1)', kind: 'method', detail: 'say(text: string) — L0 全场发言，3s 冷却' },
  { label: 'moveTo', insert: 'moveTo($1)', kind: 'method', detail: 'moveTo(pos: Vec2) — L1 朝目标点移动' },
  { label: 'nearestEnemy', insert: 'nearestEnemy()', kind: 'method', detail: 'nearestEnemy(): RobotRef | null — L1 最近可见敌人' },
  { label: 'nearestCore', insert: 'nearestCore()', kind: 'method', detail: 'nearestCore(): Vec2 | null — L1 最近核心' },
  { label: 'nearestUplink', insert: 'nearestUplink()', kind: 'method', detail: 'nearestUplink(): Vec2 | null — L1 最近上行桩' },
  { label: 'partner', insert: 'partner()', kind: 'method', detail: 'partner(): RobotRef | null — L1 本局搭档' },
  { label: 'pulseScan', insert: 'pulseScan()', kind: 'method', detail: 'pulseScan(): Observation — L1 请求脉冲扫描' },
]

const CTX_MEMBERS: CompletionSeed[] = [
  { label: 'api', insert: 'api', kind: 'property', detail: 'api: L0 & L1 — 动作接口' },
  { label: 'self', insert: 'self', kind: 'property', detail: 'self: Self — 己方状态（hp/energy/position/velocity）' },
  { label: 'game', insert: 'game', kind: 'property', detail: 'game: GameInfo — 对局信息（time/timeLeft/phase/mapSeed）' },
  { label: 'scan', insert: 'scan()', kind: 'method', detail: 'scan(): Observation — 视野+遮挡裁剪后的快照' },
]

const SELF_MEMBERS: CompletionSeed[] = [
  { label: 'hp', insert: 'hp', kind: 'property', detail: 'hp: number — 当前生命' },
  { label: 'energy', insert: 'energy', kind: 'property', detail: 'energy: number — 当前能量' },
  { label: 'position', insert: 'position', kind: 'property', detail: 'position: Vec2 — 当前位置' },
  { label: 'velocity', insert: 'velocity', kind: 'property', detail: 'velocity: Vec2 — 当前速度' },
]

const GAME_MEMBERS: CompletionSeed[] = [
  { label: 'time', insert: 'time', kind: 'property', detail: 'time: number — 已进行秒数' },
  { label: 'timeLeft', insert: 'timeLeft', kind: 'property', detail: 'timeLeft: number — 剩余秒数' },
  { label: 'phase', insert: 'phase', kind: 'property', detail: 'phase: \'OUTER_RING\' | \'CORE_OPEN\' — 当前阶段' },
  { label: 'mapSeed', insert: 'mapSeed', kind: 'property', detail: 'mapSeed: number — 地图种子' },
]

const OBSERVATION_MEMBERS: CompletionSeed[] = [
  { label: 'tick', insert: 'tick', kind: 'property', detail: 'tick: number — 快照对应的模拟帧' },
  { label: 'robots', insert: 'robots', kind: 'property', detail: 'robots: RobotRef[] — 可见机器人（含 isPartner）' },
  { label: 'cores', insert: 'cores', kind: 'property', detail: 'cores: Vec2[] — 可见核心' },
  { label: 'uplinks', insert: 'uplinks', kind: 'property', detail: 'uplinks: — 可见上行桩（ready/holder）' },
  { label: 'projectiles', insert: 'projectiles', kind: 'property', detail: 'projectiles: Vec2[] — 可见弹体' },
  { label: 'walls', insert: 'walls', kind: 'property', detail: 'walls: WallRef[] — 静态墙 AABB（公开全量，不随视野裁剪）' },
]

// 标识符前缀 / 空白处触发的顶层种子。TS worker 已能补全被推断的成员；
// 这里只补 JSDoc 类型链失效时仍可用的入口与骨架，避免重复刷屏。
const WORD_SEEDS: CompletionSeed[] = [
  { label: 'ctx', insert: 'ctx', kind: 'keyword', detail: 'ctx: TickContext — 每帧参数（self / game / scan() / api）' },
  { label: 'tickfn', insert: 'function tick(ctx) {\n\t$0\n}', kind: 'snippet', detail: 'tick(ctx) 入口骨架 — 服务器每帧调用' },
  { label: 'botmod', insert: 'const bot = {\n\ttick(ctx) {\n\t\t$0\n\t},\n}\n\nexport default bot', kind: 'snippet', detail: 'bot 对象模块骨架（import type / export default 行由服务器剥离）' },
]

const MEMBER_TABLE: Record<string, CompletionSeed[]> = {
  ctx: CTX_MEMBERS,
  'ctx.api': API_METHODS,
  'ctx.self': SELF_MEMBERS,
  'ctx.game': GAME_MEMBERS,
  'ctx.scan': OBSERVATION_MEMBERS,
  'ctx.api.pulseScan': OBSERVATION_MEMBERS,
}

/** 从光标前文本中解析接收者链：仅收集 `a.b.c()` 形式的尾部表达式。 */
function receiverChain(expr: string): string[] {
  let rest = expr.trimEnd()
  const chain: string[] = []
  const IDENT = /^[A-Za-z_$][\w$]*$/
  for (;;) {
    if (rest.endsWith(')')) {
      const open = rest.lastIndexOf('(')
      // 仅剥离空参调用：括号内（不含收尾的 ')' 本身）必须为空。
      if (open < 0 || rest.slice(open + 1, -1).trim() !== '') break
      rest = rest.slice(0, open).trimEnd()
    }
    const id = /([A-Za-z_$][\w$]*)$/.exec(rest)
    if (!id?.[1]) break
    chain.unshift(id[1])
    rest = rest.slice(0, rest.length - id[1].length).trimEnd()
    if (rest.endsWith('.')) {
      rest = rest.slice(0, -1).trimEnd()
      continue
    }
    // 链头：剩余部分本身就是单个标识符才成链，否则不算接收者。
    if (IDENT.test(rest)) chain.unshift(rest)
    break
  }
  return chain
}

/** 把光标前的行内文本解析为补全上下文。 */
export function completionContext(linePrefix: string): PrefixContext {
  const trimmed = linePrefix.replace(/\s+$/, '')
  if (trimmed.endsWith('.')) {
    return { atDot: true, chain: receiverChain(trimmed.slice(0, -1)), word: '' }
  }
  const word = /[A-Za-z_$][\w$]*$/.exec(trimmed)?.[0] ?? ''
  return { atDot: false, chain: [], word }
}

/** 按上下文给出补全种子；无法识别的接收者返回空数组，交给 TS worker。 */
export function seedsForContext(context: PrefixContext): CompletionSeed[] {
  if (context.atDot) return MEMBER_TABLE[context.chain.join('.')] ?? []
  return WORD_SEEDS.filter(seed => seed.label.toLowerCase().startsWith(context.word.toLowerCase()))
}
