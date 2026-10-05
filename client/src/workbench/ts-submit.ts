// TypeScript 提交的纯工具：诊断按 TS 原始行列格式化、发射产物清理、
// 草稿键按语言分离、ScriptSubmit payload 组装。不依赖 Monaco 与 DOM，
// 便于单元测试。

import { ScriptLanguage, TransportTiming } from '@omb/protocol'

export type BotLanguage = 'js' | 'ts'

export interface TsDiagnosticChain {
  messageText: string
  next?: TsDiagnosticChain[]
}

/** Monaco TS worker 诊断的最小结构（与 typescript 诊断对齐的字段子集）。 */
export interface TsWorkerDiagnostic {
  category?: number // 1 = Error，0 = Warning，2 = Suggestion，3 = Message
  code?: number
  messageText: string | TsDiagnosticChain
  start?: number
  length?: number
}

export interface TsEmitFile {
  name: string
  text: string
}

export function isBotLanguage(value: unknown): value is BotLanguage {
  return value === 'js' || value === 'ts'
}

/** 展开诊断的 messageText 链（语义错误的详细信息挂在 next 上）。 */
export function flattenTsMessage(messageText: string | TsDiagnosticChain): string {
  if (typeof messageText === 'string') return messageText
  const parts: string[] = []
  const walk = (chain: TsDiagnosticChain) => {
    parts.push(chain.messageText)
    for (const item of chain.next ?? []) walk(item)
  }
  walk(messageText)
  return parts.join(' ')
}

/** 每行起始偏移（0 基）；首行恒为 0。模型内容只含 \n。 */
export function lineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 把 0 基偏移换算成 1 基行列，指向原始 TS 源码而非编译产物。 */
export function offsetToLineColumn(offset: number, starts: number[]): { line: number; column: number } {
  if (!Number.isFinite(offset) || offset < 0) return { line: 1, column: 1 }
  let line = 1
  while (line < starts.length && starts[line]! <= offset) line++
  const lineStart = starts[line - 1] ?? 0
  return { line, column: offset - lineStart + 1 }
}

const TS_ERROR_CATEGORY = 1

/** 只保留错误，按原始 TS 行列格式化，最多展示 limit 条并附剩余计数。 */
export function formatTsErrors(source: string, diagnostics: TsWorkerDiagnostic[], limit = 3): string[] {
  const starts = lineStarts(source)
  const lines: string[] = []
  let total = 0
  for (const diagnostic of diagnostics) {
    if ((diagnostic.category ?? TS_ERROR_CATEGORY) !== TS_ERROR_CATEGORY) continue
    total++
    if (lines.length >= limit) continue
    const position = offsetToLineColumn(diagnostic.start ?? 0, starts)
    const code = diagnostic.code !== undefined ? ` TS${diagnostic.code}:` : ':'
    lines.push(`第 ${position.line} 行第 ${position.column} 列${code} ${flattenTsMessage(diagnostic.messageText)}`)
  }
  if (total > limit) lines.push(`…以及另外 ${total - limit} 个错误`)
  return lines
}

const EXPORT_LIST_LINE = /^[ \t]*export[ \t]*\{[^}]*\}[ \t]*;?[ \t]*$/

/**
 * 清理 TS 发射产物里服务器无法加载的模块标记。module: ESNext 下，仅有
 * 类型导入的文件会发射 `export {};`（以及 `export { name };` 导出列表），
 * 服务器 stripModuleSyntax 只剥 import/export 关键字，不处理这两种行，
 * Goja 脚本模式会直接语法错误。命名声明前的 `export` 保留给服务器剥。
 */
export function cleanEmittedJs(js: string): string {
  return js
    .split('\n')
    .filter(line => !EXPORT_LIST_LINE.test(line))
    .join('\n')
    .trim()
}

/** JS 沿用旧版两元组键：历史草稿不迁移也不丢失；TS 用三元组键独立保存。 */
export function draftKeyFor(roomCode: string, nick: string, language: BotLanguage): string {
  const identity = language === 'ts' ? [roomCode, nick, 'ts'] : [roomCode, nick]
  return `omb.bot.draft:${JSON.stringify(identity)}`
}

/** 语言偏好按房间码 + 昵称记忆；键缺省或不可读时按 JS。 */
export function languagePrefKey(roomCode: string, nick: string): string {
  return `omb.bot.lang:${JSON.stringify([roomCode, nick])}`
}

/** 取发射产物中的 JavaScript（跳过 .d.ts / map）。 */
export function pickEmitJs(files: TsEmitFile[]): string | undefined {
  return files.find(file => /\.js$/i.test(file.name))?.text
}

/** 语言 → 协议枚举（ScriptSubmit.language）。 */
export function languageToProto(language: BotLanguage): ScriptLanguage {
  return language === 'ts' ? ScriptLanguage.TS : ScriptLanguage.JS
}

/** 单帧字节上限（64 KiB）：生成协议 TransportTiming 单一权威源，
 * 与服务器 websocket 读上限互钉（golden.test.ts / timing_test.go 对拍）。 */
export const MAX_FRAME_BYTES = TransportTiming.MAX_FRAME_BYTES

/** 客户端提交前预检：按编码后整帧字节数（非字符数）判定。 */
export function scriptFrameTooLarge(byteLength: number): boolean {
  return byteLength > MAX_FRAME_BYTES
}

/** 超限文案：显示实际字节数、上限与检测阶段；TS 附双源码计入说明。 */
export function oversizeScriptMessage(frameBytes: number, language: BotLanguage): string {
  const hint = language === 'ts'
    ? 'TS 提交同帧携带编译 JS 与 TS 原文，两条源码都计入帧大小；'
    : ''
  return `脚本过大：编码后整帧 ${frameBytes} 字节，超过单帧上限 ${MAX_FRAME_BYTES} 字节（64 KiB）。${hint}已在本地预检拦截，未发送到服务器；请精简后重试。`
}

/**
 * 组装 ScriptSubmit payload（纯函数，workbench 与 Vitest 共用）：
 * - JS：source = editorSource = 编辑器原文，language = JS；
 * - TS：source = 编译产物 JS（服务器执行），editorSource = TS 原文，
 *   language = TS。
 * 发送侧不得直接内联此逻辑：编译产物与编辑原文必须成对出现。
 */
export function scriptSubmitPayload(
  language: BotLanguage,
  editorSource: string,
  compiledJs?: string,
): { clientScriptId: number; source: string; editorSource: string; language: ScriptLanguage } | { error: string } {
  if (language === 'ts') {
    if (compiledJs === undefined) return { error: 'TypeScript 编译未产出 JavaScript。' }
    if (!compiledJs) return { error: 'TypeScript 编译产物为空，未提交。' }
    return { clientScriptId: 0, source: compiledJs, editorSource: editorSource || '', language: languageToProto('ts') }
  }
  return { clientScriptId: 0, source: editorSource, editorSource, language: languageToProto('js') }
}
