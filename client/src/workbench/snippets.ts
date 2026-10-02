// Snippet 驾驶辅助面板的纯逻辑（v0.3 §9-2）：八条官方模块的行模型、
// 参数范围（与服务端 catalog 对齐的客户端预检）、上行 payload 组装、
// 每身份（room+nick）本地草稿与服务器 applied 确认态。
// 不依赖 DOM 与协议实现，便于单元测试；范围校验以服务端回执为权威。

import { create } from '@bufbuild/protobuf'
import { SnippetSettingSchema, type SnippetKind, type SnippetSetting } from '@omb/protocol'

/** 参数控件形态：无参数 / bool 开关 / 数值范围 / 文本（路径点）。 */
export type SnippetParam =
  | { type: 'none' }
  | { type: 'lead' }
  | { type: 'number'; min: number; max: number; step: number; unit: string }
  | { type: 'waypoints' }

export interface SnippetRowDef {
  kind: SnippetKind
  key: 'autoAim' | 'autoFire' | 'autoPickup' | 'shield' | 'avoid' | 'patrol' | 'globalCore' | 'lowHpHealthPack'
  title: string
  hint: string
  param: SnippetParam
  defaultEnabled: boolean
  defaultP1: number
  defaultS1: string
}

/** 与 server/internal/snippet/catalog.go 常量对齐（漂移由服务端回执兜底）。 */
export const SNIPPET_ROWS: readonly SnippetRowDef[] = [
  {
    kind: 1, key: 'autoAim', title: '自动瞄准', hint: '炮塔持续锁定最近敌人',
    param: { type: 'lead' }, defaultEnabled: false, defaultP1: 1, defaultS1: '',
  },
  {
    kind: 2, key: 'autoFire', title: '自动开火', hint: '目标进入射程且已对准时开火',
    param: { type: 'number', min: 2, max: 20, step: 0.5, unit: 'm' }, defaultEnabled: false, defaultP1: 16, defaultS1: '',
  },
  {
    kind: 3, key: 'autoPickup', title: '自动拾取', hint: '半径内朝最近 Core/健康包移动',
    param: { type: 'number', min: 0.5, max: 20, step: 0.5, unit: 'm' }, defaultEnabled: false, defaultP1: 6, defaultS1: '',
  },
  {
    kind: 4, key: 'shield', title: '紧急护盾', hint: 'HP 低于阈值自动开盾（恢复后关闭）',
    param: { type: 'number', min: 0, max: 100, step: 5, unit: '%' }, defaultEnabled: false, defaultP1: 30, defaultS1: '',
  },
  {
    kind: 5, key: 'avoid', title: '危险规避', hint: '威胁半径内有敌人/弹丸时脱离',
    param: { type: 'number', min: 2, max: 20, step: 1, unit: 'm' }, defaultEnabled: false, defaultP1: 8, defaultS1: '',
  },
  {
    kind: 6, key: 'patrol', title: '简单巡逻', hint: '顺序巡逻路径点（x,y;… 最多 8 点，±80m）',
    param: { type: 'waypoints' }, defaultEnabled: false, defaultP1: 0, defaultS1: '30,0;0,30;-30,0;0,-30',
  },
  {
    kind: 7, key: 'globalCore', title: '全局 Core 拾取', hint: '朝全图最近的存活 Core 寻路移动（接触即拾取）',
    param: { type: 'none' }, defaultEnabled: false, defaultP1: 0, defaultS1: '',
  },
  {
    kind: 8, key: 'lowHpHealthPack', title: '低血量自动拾取血包', hint: 'HP 不高于阈值时朝最近可用血包寻路移动',
    param: { type: 'number', min: 1, max: 100, step: 1, unit: '%' }, defaultEnabled: false, defaultP1: 45, defaultS1: '',
  },
] as const

/** 行状态：仅启用行参与上行（全量替换语义，disabled 可省略）。 */
export interface SnippetRowState {
  enabled: boolean
  /** lead 行 0/1；number 行数值；none/waypoints 行忽略。 */
  p1: number
  /** patrol 行路径点文本。 */
  s1: string
}

export type SnippetDraft = Record<SnippetRowDef['key'], SnippetRowState>

export function defaultSnippetDraft(): SnippetDraft {
  const draft = {} as SnippetDraft
  for (const row of SNIPPET_ROWS) {
    draft[row.key] = { enabled: row.defaultEnabled, p1: row.defaultP1, s1: row.defaultS1 }
  }
  return draft
}

/** 数值参数夹取到范围并按步进取整（显示与发送一致；服务端仍权威校验）。 */
export function clampSnippetNumber(def: SnippetRowDef, value: number): number {
  if (def.param.type !== 'number') return def.defaultP1
  if (!Number.isFinite(value)) return def.defaultP1
  const clamped = Math.min(def.param.max, Math.max(def.param.min, value))
  const stepped = Math.round(clamped / def.param.step) * def.param.step
  // 消除步进取整的浮点尾差（0.5 步进常见 15.500000000000002）。
  return Math.round(stepped * 1e6) / 1e6
}

const WAYPOINT_SPLIT = /[\s;]+/
const WAYPOINT_PAIR = /^[+-]?\d+(?:\.\d+)?,[+-]?\d+(?:\.\d+)?$/
export const PATROL_MAX_WAYPOINTS = 8
export const PATROL_ARENA_RADIUS = 80

/**
 * 路径点文本客户端预检：与 server ParseWaypoints 同规则
 * （最多 8 点、每点 x,y、坐标 ±80）。返回错误文案或 undefined。
 */
export function validateWaypoints(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const parts = trimmed.split(WAYPOINT_SPLIT).filter(Boolean)
  if (parts.length > PATROL_MAX_WAYPOINTS) return `路径点最多 ${PATROL_MAX_WAYPOINTS} 个`
  for (const part of parts) {
    if (!WAYPOINT_PAIR.test(part)) return `路径点格式应为 x,y（当前「${part}」）`
    const [x, y] = part.split(',')
    if (Math.abs(Number(x)) > PATROL_ARENA_RADIUS || Math.abs(Number(y)) > PATROL_ARENA_RADIUS) {
      return `路径点超出 ±${PATROL_ARENA_RADIUS}m 竞技场（当前「${part}」）`
    }
  }
  return undefined
}

/** 草稿 → 上行条目（仅启用行；lead 规范化 0/1）。 */
export function snippetSettingsFor(draft: SnippetDraft): SnippetSetting[] {
  const out: SnippetSetting[] = []
  for (const row of SNIPPET_ROWS) {
    const state = draft[row.key]
    if (!state.enabled) continue
    const lead = row.param.type === 'lead' ? (state.p1 !== 0 ? 1 : 0) : 0
    const p1 = row.param.type === 'lead' ? lead : row.param.type === 'number' ? clampSnippetNumber(row, state.p1) : 0
    out.push(create(SnippetSettingSchema, {
      kind: row.kind,
      enabled: true,
      p1,
      p2: 0,
      s1: row.param.type === 'waypoints' ? state.s1.trim() : '',
    }))
  }
  return out
}

/** 本地草稿是否与服务器 applied 确认态一致（不一致时提示“未应用的修改”）。 */
export function snippetDraftMatchesApplied(draft: SnippetDraft, applied: SnippetSetting[]): boolean {
  const mine = snippetSettingsFor(draft)
  if (mine.length !== applied.length) return false
  const byKind = new Map(applied.map(setting => [setting.kind, setting]))
  for (const setting of mine) {
    const server = byKind.get(setting.kind)
    if (!server || !server.enabled) return false
    const p1Delta = Math.abs(server.p1 - setting.p1)
    if (p1Delta > 1e-6) return false
    if ((server.s1 ?? '') !== setting.s1) return false
  }
  return true
}

const SNIPPET_DRAFT_PREFIX = 'omb.bot.snippets:'

/** 每身份（room+nick）草稿键；与 bot.draft 键约定同构。 */
export function snippetDraftKey(roomCode: string, nick: string): string {
  return `${SNIPPET_DRAFT_PREFIX}${JSON.stringify([roomCode, nick])}`
}

export interface StoredSnippetDraft { draft: SnippetDraft }

/** 读取草稿；键缺省/损坏/缺行时回退默认（不部分合并，避免半坏状态）。 */
export function loadSnippetDraft(roomCode: string, nick: string): SnippetDraft {
  const fallback = defaultSnippetDraft()
  try {
    const raw = localStorage.getItem(snippetDraftKey(roomCode, nick))
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as StoredSnippetDraft | null
    if (!parsed || typeof parsed !== 'object' || parsed.draft === null || typeof parsed.draft !== 'object') return fallback
    for (const row of SNIPPET_ROWS) {
      const entry = (parsed.draft as Record<string, unknown>)[row.key]
      if (typeof entry !== 'object' || entry === null) return fallback
      const { enabled, p1, s1 } = entry as Record<string, unknown>
      if (typeof enabled !== 'boolean' || typeof s1 !== 'string') return fallback
      if (typeof p1 !== 'number' || !Number.isFinite(p1)) return fallback
    }
    const merged = defaultSnippetDraft()
    for (const row of SNIPPET_ROWS) {
      const entry = (parsed.draft as Record<string, SnippetRowState>)[row.key]!
      merged[row.key] = { enabled: entry.enabled, p1: entry.p1, s1: entry.s1 }
    }
    return merged
  } catch {
    return fallback
  }
}

export function saveSnippetDraft(roomCode: string, nick: string, draft: SnippetDraft): boolean {
  try {
    localStorage.setItem(snippetDraftKey(roomCode, nick), JSON.stringify({ draft } satisfies StoredSnippetDraft))
    return true
  } catch {
    return false
  }
}
