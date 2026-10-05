// AI 助手面板纯逻辑：发送预检（空文本/超长/串行 pending）、robot=0 定向
// 说明的消费判定（仅 pending 期间且带 AI 前缀）、配额文案与热更提示分支。
// pending 状态机的完整 DOM 行为属浏览器验收范围，此处不引入真实 DOM 环境。
import { describe, expect, it } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { EvControlNoticeSchema, EvControlNotice_Code } from '@omb/protocol'
import {
  AI_SCRIPT_RESULT_ID, aiHotSwapNotice, aiQuotaText, appendAiStreamText, checkAiPrompt, isAiDirectedSay,
  isAiDirectedNotice, isAiNoticeError,
} from './ai-assist'

const notice = (code: EvControlNotice_Code, text: string) => create(EvControlNoticeSchema, { code, text })

describe('appendAiStreamText', () => {
  it('按增量顺序完整合并且空增量不改变内容', () => {
    const first = appendAiStreamText('', '```js\n')
    const second = appendAiStreamText(first, 'function tick() {}')
    expect(second).toBe('```js\nfunction tick() {}')
    expect(appendAiStreamText(second, '')).toBe(second)
  })

  it('长响应完整保留，不截断头部', () => {
    const prefix = '前'.repeat(20_000)
    const result = appendAiStreamText(prefix, '🤖尾')
    expect(result).toBe(`${prefix}🤖尾`)
  })
})

describe('checkAiPrompt', () => {
  it('空文本与纯空白拒绝', () => {
    expect(checkAiPrompt('', false)).toEqual({ ok: false, reason: '请输入要 AI 修改的内容' })
    expect(checkAiPrompt('   \n\t ', false)).toEqual({ ok: false, reason: '请输入要 AI 修改的内容' })
  })

  it('长指令不做人为长度限制', () => {
    expect(checkAiPrompt('血'.repeat(20_000), false)).toEqual({ ok: true })
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

// X-4：结构化通知分流（新服务器路径；code 集与 server ai_bridge 的下发点一一对应）
describe('isAiDirectedNotice / isAiNoticeError (X-4)', () => {
  it('五类 AI code 归属面板，join/未知 code 不归属', () => {
    expect(isAiDirectedNotice(notice(EvControlNotice_Code.CN_AI_REQUEST_FAILED, 'x'))).toBe(true)
    expect(isAiDirectedNotice(notice(EvControlNotice_Code.CN_AI_DISABLED, 'x'))).toBe(true)
    expect(isAiDirectedNotice(notice(EvControlNotice_Code.CN_AI_COMPILE_FAILED, 'x'))).toBe(true)
    expect(isAiDirectedNotice(notice(EvControlNotice_Code.CN_AI_STALE_SCRIPT, 'x'))).toBe(true)
    expect(isAiDirectedNotice(notice(EvControlNotice_Code.CN_AI_EXPLAIN, 'x'))).toBe(true)
    expect(isAiDirectedNotice(notice(EvControlNotice_Code.CN_JOIN_FAILED, 'x'))).toBe(false)
    expect(isAiDirectedNotice(notice(EvControlNotice_Code.CN_UNSPECIFIED, 'x'))).toBe(false)
  })

  it('错误类 code 终结 pending；EXPLAIN 为 info', () => {
    expect(isAiNoticeError(notice(EvControlNotice_Code.CN_AI_REQUEST_FAILED, 'x'))).toBe(true)
    expect(isAiNoticeError(notice(EvControlNotice_Code.CN_AI_DISABLED, 'x'))).toBe(true)
    expect(isAiNoticeError(notice(EvControlNotice_Code.CN_AI_COMPILE_FAILED, 'x'))).toBe(true)
    expect(isAiNoticeError(notice(EvControlNotice_Code.CN_AI_STALE_SCRIPT, 'x'))).toBe(true)
    expect(isAiNoticeError(notice(EvControlNotice_Code.CN_AI_EXPLAIN, 'x'))).toBe(false)
  })

  it('文案不再参与分流（旧前缀路径仅旧服务器回退）', () => {
    // 新路径即使服务器改措辞也不影响分流：code 是唯一依据
    expect(isAiDirectedNotice(notice(EvControlNotice_Code.CN_AI_EXPLAIN, '任意新文案'))).toBe(true)
    expect(isAiNoticeError(notice(EvControlNotice_Code.CN_AI_REQUEST_FAILED, '任意新文案'))).toBe(true)
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
  it('AI 版本直填语义：脏草稿提示已暂存可找回，干净草稿提示可回退', () => {
    expect(aiHotSwapNotice(true)).toContain('已暂存')
    expect(aiHotSwapNotice(true)).toContain('找回')
    expect(aiHotSwapNotice(false)).toContain('已应用到编辑器')
    expect(aiHotSwapNotice(false)).toContain('回退')
  })

  it('均不伪造源码回传', () => {
    expect(aiHotSwapNotice(true)).not.toContain('```')
    expect(aiHotSwapNotice(false)).not.toContain('```')
  })

  it('服务器保留 id 0 标记 AI 改码回执', () => {
    expect(AI_SCRIPT_RESULT_ID).toBe(0)
  })
})
