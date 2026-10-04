// Bot Script API 漂移对拍（审计 X-1/D1）：编辑器补全种子必须覆盖
// @omb/bot-api 声明的全部可调用方法与只读属性，防止四处平行定义
// （bot-api ↔ provider_prompt.go ↔ 本补全表 ↔ script/context.go）漂移。
// bot-api 源经 vite ?raw 注入（与 editor.ts 同路径），不依赖 node:fs。
import { describe, it, expect } from 'vitest'
import botApiSource from '../../../packages/bot-api/src/index.ts?raw'
import { seedsForContext, completionContext } from './bot-completions'

/** 从 interface 块提取成员名（含 JSDoc 注释容错；不看签名细节）。 */
function interfaceMembers(name: string): string[] {
  const re = new RegExp(`interface ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`, 'm')
  const body = re.exec(botApiSource)?.[1] ?? ''
  const members: string[] = []
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('/') || t.startsWith('*') || t.startsWith('@')) continue
    const m = /^readonly\s+([A-Za-z_$][\w$]*)|^(?:\(\.\.\.\w+\)?:\s*)?([A-Za-z_$][\w$]*)\s*(?:\(|:)/.exec(t)
    const hit = m?.[1] ?? m?.[2]
    if (hit && !members.includes(hit)) members.push(hit)
  }
  return members
}

/** BotContext 的方法面 = L0 ∪ L1 ∪ scan；属性面 = self/game/api。 */
const callable = new Set<string>([
  ...interfaceMembers('L0'), ...interfaceMembers('L1'), 'scan',
])
const properties = new Set<string>(['self', 'game', 'api'])

const botSeeds = seedsForContext(completionContext('bot.'))
const botLabels = new Set(botSeeds.map(s => s.label))

describe('bot-completions ↔ @omb/bot-api 对拍（X-1/D1）', () => {
  it('补全覆盖 bot 的全部可调用方法（L0 ∪ L1 ∪ scan）', () => {
    const missing = [...callable].filter(name => !botLabels.has(name))
    // api 是 deprecated 兼容入口，补全刻意不推荐（详见 bot-completions.test.ts）。
    expect(missing.filter(name => name !== 'api')).toEqual([])
  })

  it('补全不虚构 bot-api 之外的成员', () => {
    const phantom = [...botLabels].filter(label => !callable.has(label) && !properties.has(label))
    expect(phantom).toEqual([])
  })

  it('self/game 属性种子与接口成员一致', () => {
    const selfSeeds = seedsForContext(completionContext('bot.self.')).map(s => s.label)
    expect(selfSeeds).toEqual(interfaceMembers('Self'))
    const gameSeeds = seedsForContext(completionContext('bot.game.')).map(s => s.label)
    expect(gameSeeds).toEqual(interfaceMembers('GameInfo'))
  })
})
