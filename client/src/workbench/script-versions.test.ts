// 脚本版本链纯逻辑：快照替换、current 指针、编辑器同步决策（stash 语义 +
// 语言归一/跨语言比较）、展示辅助（来源/语言标签、相对时间、倒序）。
// DOM 行为属浏览器验收范围。
import { describe, expect, it } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { EvScriptVersionsSchema, EvScriptVersionSchema, ScriptLanguage, ScriptOrigin } from '@omb/protocol'
import {
  applyScriptVersions, currentVersion, displayOrder, emptyScriptVersionState, languageLabel,
  normalizeScriptLanguage, originLabel, planEditorSync, relativeVersionTime, rollbackPayload,
  shouldAutoFillEditor,
} from './script-versions'

function snapshot(
  versions: Array<{ id: number; rev: number; origin: ScriptOrigin; source: string; language?: ScriptLanguage }>,
  currentId: number,
) {
  return create(EvScriptVersionsSchema, {
    versions: versions.map(v => create(EvScriptVersionSchema, {
      id: v.id, scriptRev: v.rev, origin: v.origin, wallMs: BigInt(1000 + v.id), source: v.source,
      ...(v.language !== undefined ? { language: v.language } : {}),
    })),
    currentId,
  })
}

describe('applyScriptVersions / currentVersion', () => {
  it('快照整体替换并拷贝；current 指针可解析；语言随快照落地', () => {
    const state = applyScriptVersions(emptyScriptVersionState(), snapshot([
      { id: 1, rev: 2, origin: ScriptOrigin.ORIGIN_MANUAL, source: 'a' },
      { id: 2, rev: 3, origin: ScriptOrigin.ORIGIN_AI, source: 'b', language: ScriptLanguage.TS },
    ], 2))
    expect(state.currentId).toBe(2)
    expect(currentVersion(state)).toMatchObject({ id: 2, origin: ScriptOrigin.ORIGIN_AI, source: 'b', language: 'ts' })
    expect(state.versions[0]).toMatchObject({ language: 'js' })
  })

  it('空链 currentId=0：currentVersion 为 undefined；重连补空快照清空本地视图', () => {
    const state = applyScriptVersions({ versions: [{ id: 1, scriptRev: 1, origin: ScriptOrigin.ORIGIN_MANUAL, wallMs: 0, source: 'x', language: 'js' }], currentId: 1 }, snapshot([], 0))
    expect(state.versions).toHaveLength(0)
    expect(currentVersion(state)).toBeUndefined()
  })
})

describe('normalizeScriptLanguage / languageLabel', () => {
  it('缺省 / UNSPECIFIED / 未知枚举值一律按 JS（AI 版本与旧服务器兼容）', () => {
    expect(normalizeScriptLanguage(undefined)).toBe('js')
    expect(normalizeScriptLanguage(ScriptLanguage.UNSPECIFIED)).toBe('js')
    expect(normalizeScriptLanguage(ScriptLanguage.JS)).toBe('js')
    expect(normalizeScriptLanguage(ScriptLanguage.TS)).toBe('ts')
    expect(normalizeScriptLanguage(99 as unknown as ScriptLanguage)).toBe('js')
  })

  it('版本行语言短标签', () => {
    expect(languageLabel('js')).toBe('JS')
    expect(languageLabel('ts')).toBe('TS')
  })
})

describe('planEditorSync', () => {
  it('干净草稿（源码 + 语言均一致）：直接覆盖填充为 incoming 语言', () => {
    const plan = planEditorSync({ source: 'same', language: 'js' }, { source: 'same', language: 'js' }, { source: 'incoming', language: 'js' })
    expect(plan).toEqual({ kind: 'fill', source: 'incoming', language: 'js' })
  })

  it('同源码但语言不同：视为脏（跨语言草稿不可比），先 stash 再填充', () => {
    const plan = planEditorSync({ source: 'same', language: 'js' }, { source: 'same', language: 'ts' }, { source: 'incoming', language: 'js' })
    expect(plan).toEqual({ kind: 'fill', source: 'incoming', language: 'js', stashed: { source: 'same', language: 'ts' } })
  })

  it('脏草稿：先 stash 手改（含语言）再填充（手改不丢失，可切回其语言）', () => {
    const plan = planEditorSync({ source: 'loaded', language: 'ts' }, { source: 'my-edit', language: 'ts' }, { source: 'ai-code', language: 'js' })
    expect(plan).toEqual({ kind: 'fill', source: 'ai-code', language: 'js', stashed: { source: 'my-edit', language: 'ts' } })
  })

  it('无已装载态（首版 AI）：非空编辑器视为脏，空编辑器直接填充', () => {
    expect(planEditorSync(undefined, { source: '', language: 'js' }, { source: 'first', language: 'js' })).toEqual({ kind: 'fill', source: 'first', language: 'js' })
    expect(planEditorSync(undefined, { source: 'scratch', language: 'js' }, { source: 'first', language: 'js' })).toEqual({ kind: 'fill', source: 'first', language: 'js', stashed: { source: 'scratch', language: 'js' } })
  })

  it('空 incoming 忽略（防御：不伪造填充）', () => {
    expect(planEditorSync({ source: 'a', language: 'js' }, { source: 'b', language: 'js' }, { source: '', language: 'js' })).toEqual({ kind: 'ignore' })
  })
})

describe('display helpers', () => {
  it('displayOrder 最新在上；originLabel/relativeVersionTime 稳定', () => {
    const state = applyScriptVersions(emptyScriptVersionState(), snapshot([
      { id: 1, rev: 1, origin: ScriptOrigin.ORIGIN_MANUAL, source: 'a' },
      { id: 2, rev: 2, origin: ScriptOrigin.ORIGIN_AI, source: 'b' },
      { id: 3, rev: 3, origin: ScriptOrigin.ORIGIN_ROLLBACK, source: 'a', language: ScriptLanguage.TS },
    ], 3))
    expect(displayOrder(state).map(v => v.id)).toEqual([3, 2, 1])
    expect(originLabel(ScriptOrigin.ORIGIN_MANUAL)).toBe('手动')
    expect(originLabel(ScriptOrigin.ORIGIN_AI)).toBe('AI')
    expect(originLabel(ScriptOrigin.ORIGIN_ROLLBACK)).toBe('回退')
    expect(originLabel(ScriptOrigin.SCRIPT_ORIGIN_UNSPECIFIED)).toBe('手动')
    const now = 1_000_000
    expect(relativeVersionTime(now - 59_000, now)).toBe('59s 前')
    expect(relativeVersionTime(now - 90_000, now)).toBe('1m 前')
    expect(relativeVersionTime(now, now)).toBe('0s 前')
  })

  it('rollbackPayload 传版本 id', () => {
    expect(rollbackPayload(7)).toEqual({ versionId: 7 })
  })
})

describe('shouldAutoFillEditor', () => {
  const ai = { id: 2, scriptRev: 4, origin: ScriptOrigin.ORIGIN_AI, wallMs: 0, source: 'ai', language: 'js' as const }
  const manual = { id: 1, scriptRev: 3, origin: ScriptOrigin.ORIGIN_MANUAL, wallMs: 0, source: 'm', language: 'js' as const }
  const rolled = { id: 3, scriptRev: 5, origin: ScriptOrigin.ORIGIN_ROLLBACK, wallMs: 0, source: 'm', language: 'ts' as const }

  it('新出现的 AI 当前版本直填；重复快照（重连补发）不覆盖', () => {
    expect(shouldAutoFillEditor(0, ai)).toBe(true)
    expect(shouldAutoFillEditor(1, ai)).toBe(true)
    expect(shouldAutoFillEditor(2, ai)).toBe(false) // 同 id：重连补发
  })

  it('手动/回退/空版本不触发直填（回退走显式回执路径）', () => {
    expect(shouldAutoFillEditor(0, manual)).toBe(false)
    expect(shouldAutoFillEditor(1, rolled)).toBe(false)
    expect(shouldAutoFillEditor(0, undefined)).toBe(false)
    expect(shouldAutoFillEditor(0, { ...ai, source: '' })).toBe(false)
  })
})
