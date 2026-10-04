// AI 助手面板的纯逻辑：单玩家串行 pending 状态机、配额显示事实、
// 控制通知的消费判定（X-4：结构化 EvControlNotice 优先，旧服务器回退
// robot=0 定向 say 的 AI 前缀解析）。
// 说明文案由服务端下发；ScriptResult(client_script_id=0)表示 AI 改码已热更。

import { EvControlNotice_Code, type EvControlNotice } from '@omb/protocol'

export interface AiQuotaState {
  roundsLeft: number
  tokensUsedK?: number
  tokensLeftK?: number
  globalTokensLeftK?: number
}

/** 合并实时模型增量，完整保留本次响应内容。 */
export function appendAiStreamText(current: string, delta: string): string {
  return delta ? current + delta : current
}

/** AI 面板消息流条目（说明/错误/成功提示；不含 prompt 原文全文回显）。 */
export interface AiFeedItem {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

export type AiPromptCheck = { ok: true } | { ok: false; reason: string }

/** 发送前的本地预检：空文本与串行 pending 兜底；不限制指令长度。 */
export function checkAiPrompt(text: string, pending: boolean): AiPromptCheck {
  if (pending) return { ok: false, reason: '上一个 AI 请求仍在处理中' }
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: '请输入要 AI 修改的内容' }
  return { ok: true }
}

/** 服务端说明前缀（server/internal/glue/ai_bridge.go 定向下发文案；旧服务器回退路径）。 */
const AI_SAY_PREFIXES = ['AI 请求失败：', 'AI 改动说明：', 'AI 未启用：', 'AI 生成脚本编译失败', 'AI 改码未生效'] as const

/** 结构化 AI 通知 code 集（X-4 正解路径；与 server ai_bridge noticeCode 对应）。 */
export const AI_NOTICE_CODES = new Set<EvControlNotice_Code>([
  EvControlNotice_Code.CN_AI_REQUEST_FAILED,
  EvControlNotice_Code.CN_AI_DISABLED,
  EvControlNotice_Code.CN_AI_COMPILE_FAILED,
  EvControlNotice_Code.CN_AI_STALE_SCRIPT,
  EvControlNotice_Code.CN_AI_EXPLAIN,
])

/** 结构化通知是否归属 AI 面板。 */
export function isAiDirectedNotice(notice: EvControlNotice): boolean {
  return AI_NOTICE_CODES.has(notice.code)
}

/** 结构化通知是否错误类（终结面板 pending）；CN_AI_EXPLAIN 为 info。 */
export function isAiNoticeError(notice: EvControlNotice): boolean {
  return notice.code !== EvControlNotice_Code.CN_UNSPECIFIED && notice.code !== EvControlNotice_Code.CN_AI_EXPLAIN && AI_NOTICE_CODES.has(notice.code)
}

/**
 * robot=0 的定向说明是否归属 AI 面板：AI 专用前缀足以区分系统消息。
 * 不依赖 pending，因为 ScriptResult 与说明可能跨帧到达，重连后也可能补到。
 * （旧服务器回退路径；新服务器走结构化 notice，见 isAiDirectedNotice。）
 */
export function isAiDirectedSay(text: string, _pending: boolean): boolean {
  return AI_SAY_PREFIXES.some(prefix => text.startsWith(prefix))
}

/** ScriptResult(client_script_id=0) → AI 改码成功热更（服务器保留 id）。 */
export const AI_SCRIPT_RESULT_ID = 0

/** AI 成功热更后的编辑器安全策略：协议不回传源码，绝不伪造。 */
export function aiHotSwapNotice(draftDirty: boolean): string {
  return draftDirty
    ? 'AI 已热更脚本。服务器未返回新源码，编辑器草稿未改动；确认效果后请自行同步差异。'
    : 'AI 已热更脚本。服务器未返回新源码，编辑器未自动覆盖本地草稿。'
}

/** 配额行文案（千 token 计数换算为 k 显示）。 */
export function aiQuotaText(quota: AiQuotaState | undefined): string {
  if (!quota) return '配额待同步'
  const player = quota.tokensUsedK !== undefined
    ? `已用 ${quota.tokensUsedK}k token`
    : quota.tokensLeftK !== undefined ? `个人余 ${quota.tokensLeftK}k token` : '个人 token 待同步'
  const global = quota.globalTokensLeftK !== undefined ? ` · 全局护栏余 ${quota.globalTokensLeftK}k` : ''
  return `剩余轮次 ${quota.roundsLeft} · ${player}${global}`
}
