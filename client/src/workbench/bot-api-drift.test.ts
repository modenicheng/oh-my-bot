// Bot Script API 漂移对拍（审计 X-1）：权威源 packages/bot-api/src/index.ts
// 生成补全表（bot-completions.gen.ts）与服务器 embed 副本
//（server/internal/botapi/bot_api.gen.ts，Go 侧 TestGeneratedSourceIsFresh
// 对拍权威源）。本测试用生成器纯函数在内存中重放权威源，断言检入的
// 生成物与权威源逐字节一致——index.ts 改动后未跑
// `pnpm --filter @omb/bot-api gen` 时在此失败。
import { describe, expect, it } from 'vitest'
import botApiSource from '../../../packages/bot-api/src/index.ts?raw'
import { renderCompletionModule } from '../../../packages/bot-api/scripts/lib.mjs'
import { seedsForContext, completionContext } from './bot-completions'
import generatedSeedsSource from './bot-completions.gen.ts?raw'

describe('bot-api 单源扇出新鲜度（X-1）', () => {
  it('bot-completions.gen.ts 与权威源生成结果逐字节一致', () => {
    const want = renderCompletionModule(botApiSource)
    expect(generatedSeedsSource).toBe(want)
  })

  it('权威源 interface 面覆盖 BotContext/L0/L1/Observation（结构性防线）', () => {
    for (const name of ['BotContext', 'L0', 'L1', 'Observation', 'Self', 'GameInfo', 'ProjectileRef']) {
      expect(botApiSource).toContain(`export interface ${name}`)
    }
  })
})

// 生成物源码可追溯：检入文件必须带自动生成头注释（防手工覆写冒充生成物）。
describe('补全表来源约束', () => {
  it('gen 文件以自动生成头注释开头', () => {
    expect(generatedSeedsSource.startsWith('// 自动生成（审计 X-1）')).toBe(true)
  })
})

// 成员路由冒烟：生成表经 seedsForContext 正常暴露（详细行为见 bot-completions.test.ts）。
describe('生成种子路由冒烟', () => {
  it('bot. 暴露全部方法与 self/game/scan，不含 api', () => {
    const labels = seedsForContext(completionContext('bot.')).map(s => s.label)
    for (const want of ['move', 'navigateTo', 'pulseScan', 'nearestEnemy', 'self', 'game', 'scan']) {
      expect(labels).toContain(want)
    }
    expect(labels).not.toContain('api')
  })
})
