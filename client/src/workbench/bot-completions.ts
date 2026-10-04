// 编辑器前缀补全种子：消费 bot-completions.gen.ts（由 @omb/bot-api 权威源
// 生成，审计 X-1），此处只保留词法上下文路由与手写骨架片段。
// 类型口径与 @omb/bot-api 保持一致；刻意不 import monaco，便于单元测试。

import {
  BOT_MEMBER_SEEDS,
  GAME_MEMBER_SEEDS,
  OBSERVATION_MEMBER_SEEDS,
  PROJECTILE_MEMBER_SEEDS,
  SELF_MEMBER_SEEDS,
  type CompletionSeed,
} from './bot-completions.gen'

export type { CompletionSeed, CompletionSeedKind } from './bot-completions.gen'

export interface PrefixContext {
  atDot: boolean
  chain: string[]
  word: string
}

// 词前缀种子（tick 骨架等模板片段）：非 API 面，随编辑器体验维护。
const WORD_SEEDS: CompletionSeed[] = [
  { label: 'bot', insert: 'bot', kind: 'keyword', detail: 'bot: BotContext — self / game / scan() / 动作方法' },
  { label: 'tickfn', insert: 'function tick(bot) {\n\t$0\n}', kind: 'snippet', detail: 'tick(bot) 入口骨架 — 服务器每帧调用' },
  { label: 'botmod', insert: 'const bot = {\n\ttick(bot) {\n\t\t$0\n\t},\n}\n\nexport default bot', kind: 'snippet', detail: 'bot 对象模块骨架（import type / export default 行由服务器剥离）' },
]

// 成员表：键为接收者链（bot.、bot.scan(). 等）。表内容全部来自生成物；
// deprecated 的 api 属性刻意不出现在生成表中（与 bot-completions.test.ts 约定一致）。
const MEMBER_TABLE: Record<string, CompletionSeed[]> = {
  bot: BOT_MEMBER_SEEDS,
  'bot.self': SELF_MEMBER_SEEDS,
  'bot.game': GAME_MEMBER_SEEDS,
  'bot.scan': OBSERVATION_MEMBER_SEEDS,
  'bot.pulseScan': OBSERVATION_MEMBER_SEEDS,
  'bot.scan.projectiles': PROJECTILE_MEMBER_SEEDS,
  'bot.pulseScan.projectiles': PROJECTILE_MEMBER_SEEDS,
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
