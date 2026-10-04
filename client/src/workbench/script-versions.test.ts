// 脚本版本链纯逻辑：快照替换、current 指针、编辑器同步决策（stash 语义）、
// 展示辅助（来源标签/相对时间/倒序）。DOM 行为属浏览器验收范围。
import { describe, expect, it } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { EvScriptVersionsSchema, EvScriptVersionSchema, ScriptOrigin } from '@omb/protocol'
import {
  applyScriptVersions, currentVersion, displayOrder, emptyScriptVersionState,
  originLabel, planEditorSync, relativeVersionTime, rollbackPayload, shouldAutoFillEditor,
} from './script-versions'

function snapshot(versions: Array<{ id: number; rev: number; origin: ScriptOrigin; source: string }>, currentId: number) {
  return create(EvScriptVersionsSchema, {
    versions: versions.map(v => create(EvScriptVersionSchema, {
      id: v.id, scriptRev: v.rev, origin: v.origin, wallMs: BigInt(1000 + v.id), source: v.source,
    })),
    currentId,
  })
}

describe('applyScriptVersions / currentVersion', () => {
  it('快照整体替换并拷贝；current 指针可解析', () => {
    const state = applyScriptVersions(emptyScriptVersionState(), snapshot([
      { id: 1, rev: 2, origin: ScriptOrigin.ORIGIN_MANUAL, source: 'a' },
      { id: 2, rev: 3, origin: ScriptOrigin.ORIGIN_AI, source: 'b' },
    ], 2))
    expect(state.currentId).toBe(2)
    expect(currentVersion(state)).toMatchObject({ id: 2, origin: ScriptOrigin.ORIGIN_AI, source: 'b' })
  })

  it('空链 currentId=0：currentVersion 为 undefined；重连补空快照清空本地视图', () => {
    const state = applyScriptVersions({ versions: [{ id: 1, scriptRev: 1, origin: ScriptOrigin.ORIGIN_MANUAL, wallMs: 0, source: 'x' }], currentId: 1 }, snapshot([], 0))
    expect(state.versions).toHaveLength(0)
    expect(currentVersion(state)).toBeUndefined()
  })
})

describe('planEditorSync', () => {
  it('干净草稿：直接覆盖填充', () => {
    const plan = planEditorSync('same', 'same', 'incoming')
    expect(plan).toEqual({ kind: 'fill', source: 'incoming' })
  })

  it('脏草稿：先 stash 手改再填充（手改不丢失）', () => {
    const plan = planEditorSync('loaded', 'my-edit', 'ai-code')
    expect(plan).toEqual({ kind: 'fill', source: 'ai-code', stashed: 'my-edit' })
  })

  it('无已装载态（首版 AI）：非空编辑器视为脏，空编辑器直接填充', () => {
    expect(planEditorSync(undefined, '', 'first')).toEqual({ kind: 'fill', source: 'first' })
    expect(planEditorSync(undefined, 'scratch', 'first')).toEqual({ kind: 'fill', source: 'first', stashed: 'scratch' })
  })

  it('空 incoming 忽略（防御：不伪造填充）', () => {
    expect(planEditorSync('a', 'b', '')).toEqual({ kind: 'ignore' })
  })
})

describe('display helpers', () => {
  it('displayOrder 最新在上；originLabel/relativeVersionTime 稳定', () => {
    const state = applyScriptVersions(emptyScriptVersionState(), snapshot([
      { id: 1, rev: 1, origin: ScriptOrigin.ORIGIN_MANUAL, source: 'a' },
      { id: 2, rev: 2, origin: ScriptOrigin.ORIGIN_AI, source: 'b' },
      { id: 3, rev: 3, origin: ScriptOrigin.ORIGIN_ROLLBACK, source: 'a' },
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
  const ai = { id: 2, scriptRev: 4, origin: ScriptOrigin.ORIGIN_AI, wallMs: 0, source: 'ai' }
  const manual = { id: 1, scriptRev: 3, origin: ScriptOrigin.ORIGIN_MANUAL, wallMs: 0, source: 'm' }
  const rolled = { id: 3, scriptRev: 5, origin: ScriptOrigin.ORIGIN_ROLLBACK, wallMs: 0, source: 'm' }

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
