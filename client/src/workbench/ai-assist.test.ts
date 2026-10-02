// AI 助手面板纯逻辑：发送预检（空文本/超长/串行 pending）、robot=0 定向
// 说明的消费判定（仅 pending 期间且带 AI 前缀）、配额文案与热更提示分支。
// pending 状态机的完整 DOM 行为属浏览器验收范围，此处不引入真实 DOM 环境。
import { describe, expect, it } from 'vitest'
import {
  AI_MAX_PROMPT_CHARS, AI_SCRIPT_RESULT_ID, aiHotSwapNotice, aiQuotaText,
  checkAiPrompt, isAiDirectedSay,
} from './ai-assist'

describe('checkAiPrompt', () => {
  it('空文本与纯空白拒绝', () => {
    expect(checkAiPrompt('', false)).toEqual({ ok: false, reason: '请输入要 AI 修改的内容' })
    expect(checkAiPrompt('   \n\t ', false)).toEqual({ ok: false, reason: '请输入要 AI 修改的内容' })
  })

  it(`超过 ${AI_MAX_PROMPT_CHARS} 字（按码点）拒绝，上限内通过`, () => {
    expect(checkAiPrompt('血'.repeat(AI_MAX_PROMPT_CHARS + 1), false).ok).toBe(false)
    expect(checkAiPrompt('血'.repeat(AI_MAX_PROMPT_CHARS), false)).toEqual({ ok: true })
  })

  it('pending 期间一律拒绝（单玩家串行）', () => {
    expect(checkAiPrompt('把巡逻改成方形', true)).toEqual({ ok: false, reason: '上一个 AI 请求仍在处理中' })
  })
})

describe('isAiDirectedSay', () => {
  it('AI 前缀且 pending 时消费', () => {
    expect(isAiDirectedSay('AI 改动说明：已把血量阈值改为 50', true)).toBe(true)
    expect(isAiDirectedSay('AI 生成脚本编译失败：line 3', true)).toBe(true)
  })

  it('跨帧到达仍消费：AI 专用前缀不会混入系统消息', () => {
    expect(isAiDirectedSay('AI 改动说明：已修改', false)).toBe(true)
  })

  it('非 AI 前缀即使 pending 也不消费', () => {
    expect(isAiDirectedSay('join failed: room full', true)).toBe(false)
  })
})

describe('aiQuotaText', () => {
  it('未同步、已用、剩余与全局护栏各分支', () => {
    expect(aiQuotaText(undefined)).toBe('配额待同步')
    expect(aiQuotaText({ roundsLeft: 3, tokensUsedK: 2 })).toBe('剩余轮次 3 · 已用 2k token')
    expect(aiQuotaText({ roundsLeft: 3, tokensLeftK: 8 })).toBe('剩余轮次 3 · 个人余 8k token')
    expect(aiQuotaText({ roundsLeft: 3 })).toBe('剩余轮次 3 · 个人 token 待同步')
    expect(aiQuotaText({ roundsLeft: 3, tokensUsedK: 2, globalTokensLeftK: 500 }))
      .toBe('剩余轮次 3 · 已用 2k token · 全局护栏余 500k')
  })
})

describe('aiHotSwapNotice', () => {
  it('草稿脏时提示差异未同步；不脏时说明未覆盖', () => {
    expect(aiHotSwapNotice(true)).toContain('草稿未改动')
    expect(aiHotSwapNotice(false)).toContain('未自动覆盖')
  })

  it('均不伪造源码回传', () => {
    expect(aiHotSwapNotice(true)).not.toContain('```')
    expect(aiHotSwapNotice(false)).not.toContain('```')
  })

  it('服务器保留 id 0 标记 AI 改码回执', () => {
    expect(AI_SCRIPT_RESULT_ID).toBe(0)
  })
})
