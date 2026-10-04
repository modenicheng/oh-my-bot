// 脚本版本链纯逻辑（TODO：AI 代码直接填入编辑器 + 版本回退）。
//
// 服务器是版本链唯一 owner：EvScriptVersions 全量快照（升序 + current_id）
// 到达即整体替换本地视图；本地不预测、不合并——重连/接管后由 bootstrap
// 补发对齐。Editor sync 决策（planEditorSync）集中在这里，供 workbench
// 与 Vitest 共用，DOM 行为留在视图层。

import { ScriptOrigin, type EvScriptVersions } from '@omb/protocol'

export interface ScriptVersionView {
  id: number
  scriptRev: number
  origin: ScriptOrigin
  wallMs: number
  source: string
}

export interface ScriptVersionState {
  versions: ScriptVersionView[] // 升序（旧 → 新）
  currentId: number
}

/** 空状态：无已记录版本。 */
export function emptyScriptVersionState(): ScriptVersionState {
  return { versions: [], currentId: 0 }
}

/** 服务器快照 → 本地视图（整体替换；防御性拷贝，不信任引用复用）。 */
export function applyScriptVersions(state: ScriptVersionState, snapshot: EvScriptVersions): ScriptVersionState {
  return {
    currentId: snapshot.currentId,
    versions: snapshot.versions.map(v => ({ id: v.id, scriptRev: v.scriptRev, origin: v.origin, wallMs: Number(v.wallMs), source: v.source })),
  }
}

/** 当前生效版本（currentId=0 或找不到 = 无，例：服务器未推送过版本链）。 */
export function currentVersion(state: ScriptVersionState): ScriptVersionView | undefined {
  return state.versions.find(v => v.id === state.currentId)
}

/**
 * 编辑器同步决策：服务器权威版本写入成功后，是否用其源码覆盖编辑器草稿。
 *
 * 规则：
 * - source 为空（不应发生）→ 忽略，保编辑器现状；
 * - 编辑器草稿干净（与上次已装载源码一致，或尚无已装载态）→ 覆盖填充；
 * - 草稿脏（有未提交手改）→ 先 stash（保存到未暂存草稿槽，见 stashDraft），
 *   再覆盖填充。手改永不丢失：可从「未提交改动」一键找回编辑器。
 */
export type EditorSyncPlan =
  | { kind: 'fill'; source: string; stashed?: string }
  | { kind: 'ignore' }

export function planEditorSync(loadedSource: string | undefined, editorSource: string, incoming: string): EditorSyncPlan {
  if (!incoming) return { kind: 'ignore' }
  const dirty = loadedSource === undefined ? editorSource !== '' : loadedSource !== editorSource
  if (!dirty) return { kind: 'fill', source: incoming }
  return { kind: 'fill', source: incoming, stashed: editorSource }
}

/** 版本来源文案（战术终端风格短标签）。 */
export function originLabel(origin: ScriptOrigin): string {
  switch (origin) {
    case ScriptOrigin.ORIGIN_AI: return 'AI'
    case ScriptOrigin.ORIGIN_ROLLBACK: return '回退'
    case ScriptOrigin.ORIGIN_MANUAL:
    case ScriptOrigin.SCRIPT_ORIGIN_UNSPECIFIED:
    default: return '手动'
  }
}

/** 版本行相对时间（与 wallMs 的差值 → 简短中文；非权威时序，仅展示）。 */
export function relativeVersionTime(wallMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - wallMs)
  const s = Math.floor(delta / 1000)
  if (s < 60) return `${s}s 前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m 前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h 前`
  return `${Math.floor(h / 24)}d 前`
}

/** 展示用列表：最新在上（与时间线阅读方向一致），current 标记由调用方渲染。 */
export function displayOrder(state: ScriptVersionState): ScriptVersionView[] {
  return [...state.versions].reverse()
}

/** 回退上行帧 payload。 */
export function rollbackPayload(versionId: number): { versionId: number } {
  return { versionId }
}

/**
 * 版本链快照是否应触发编辑器直填：仅「新出现的 AI 当前版本」直填。
 * 手动提交的源码本就来自编辑器（无需回写）；回退版本走
 * EvScriptRollbackResult 的显式回执路径；重连补发（previousCurrentId 相同）
 * 不重复覆盖（用户可能已基于 AI 版本开始修改）。
 */
export function shouldAutoFillEditor(previousCurrentId: number, current: ScriptVersionView | undefined): boolean {
  if (!current || !current.source) return false
  if (current.origin !== ScriptOrigin.ORIGIN_AI) return false
  return current.id !== previousCurrentId
}
