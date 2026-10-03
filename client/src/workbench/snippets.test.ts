// Snippet 驾驶辅助纯逻辑：storage 键约定、上行 payload、路径点预检、
// 草稿与服务器 applied 确认态对比。上行用 create message 类型，
// 与 workbench.ts 真实编码路径一致；范围以 SNIPPET_ROWS 常量为预期。
import { describe, expect, it, vi } from 'vitest'
import {
  PATROL_ARENA_RADIUS, PATROL_MAX_WAYPOINTS, SNIPPET_ROWS, clampSnippetNumber,
  defaultSnippetDraft, loadSnippetDraft, saveSnippetDraft, snippetDraftKey,
  snippetDraftMatchesApplied, snippetSettingsFor, validateWaypoints, type SnippetDraft,
} from './snippets'

function draftWith(key: 'autoAim' | 'shield' | 'avoid' | 'patrol' | 'globalCore' | 'lowHpHealthPack', patch: Partial<{ enabled: boolean; p1: number; s1: string }>): SnippetDraft {
  const draft = defaultSnippetDraft()
  draft[key] = { ...draft[key], ...patch }
  return draft
}

describe('snippetDraftKey', () => {
  it('按身份（room+nick）JSON 编码为独立键', () => {
    expect(snippetDraftKey('ABC123', '凯')).toBe('omb.bot.snippets:["ABC123","凯"]')
    expect(snippetDraftKey('ABC123', '凯')).not.toBe(snippetDraftKey('ABC123', '波'))
    expect(snippetDraftKey('ABC123', '凯')).not.toBe(snippetDraftKey('DDD999', '凯'))
  })

  it('空房间码不共享草稿空间（宿主在未进房时不持久化）', () => {
    expect(snippetDraftKey('', '凯')).toBe('omb.bot.snippets:["","凯"]')
  })
})

describe('snippet row model', () => {
  it('六行固定：autoAim=1、shield=4、avoid=5、patrol=6、globalCore=7、lowHpHealthPack=8（2/3 移除不复用）', () => {
    expect(SNIPPET_ROWS.map(row => [row.key, row.kind])).toEqual([
      ['autoAim', 1], ['shield', 4], ['avoid', 5], ['patrol', 6], ['globalCore', 7], ['lowHpHealthPack', 8],
    ])
  })

  it('autoAim 无参数纯直瞄；全局 Core 无参数；低血量血包为 1..100 整数百分比且默认 45', () => {
    const autoAim = SNIPPET_ROWS.find(row => row.key === 'autoAim')!
    expect(autoAim).toMatchObject({ kind: 1, param: { type: 'none' }, defaultP1: 0 })
    const globalCore = SNIPPET_ROWS.find(row => row.key === 'globalCore')!
    expect(globalCore).toMatchObject({ kind: 7, param: { type: 'none' }, defaultP1: 0 })
    const healthPack = SNIPPET_ROWS.find(row => row.key === 'lowHpHealthPack')!
    expect(healthPack).toMatchObject({
      kind: 8, param: { type: 'number', min: 1, max: 100, step: 1, unit: '%' }, defaultP1: 45,
    })
  })
})

describe('snippetSettingsFor', () => {
  it('只上行启用行，kind/enabled/p1/s1 按 catalog 常量填充', () => {
    const settings = snippetSettingsFor(draftWith('shield', { enabled: true, p1: 40 }))
    expect(settings).toHaveLength(1)
    expect(settings[0]).toMatchObject({ kind: 4, enabled: true, p1: 40, s1: '' })
  })

  it('无参数行 p1 清零，数值行经夹取', () => {
    const aim = snippetSettingsFor(draftWith('autoAim', { enabled: true, p1: 7 }))
    expect(aim[0]).toMatchObject({ kind: 1, p1: 0, p2: 0, s1: '' })
    const avoid = snippetSettingsFor(draftWith('avoid', { enabled: true, p1: 999 }))
    expect(avoid[0]).toMatchObject({ kind: 5, p1: 20 })
  })

  it('无参数行固定清空 p1/p2/s1，低血量血包保留整数阈值', () => {
    const globalCore = snippetSettingsFor(draftWith('globalCore', { enabled: true, p1: 99, s1: 'ignored' }))
    expect(globalCore[0]).toMatchObject({ kind: 7, enabled: true, p1: 0, p2: 0, s1: '' })
    const healthPack = snippetSettingsFor(draftWith('lowHpHealthPack', { enabled: true, p1: 44.6 }))
    expect(healthPack[0]).toMatchObject({ kind: 8, enabled: true, p1: 45, p2: 0, s1: '' })
  })

  it('patrol 仅上行启用行并携带 s1 路径点文本', () => {
    const settings = snippetSettingsFor(draftWith('patrol', { enabled: true, s1: '30,0; 0,30' }))
    expect(settings).toHaveLength(1)
    expect(settings[0]).toMatchObject({ kind: 6, enabled: true, s1: '30,0; 0,30' })
  })

  it('全部默认关：上行 payload 为空数组', () => {
    expect(snippetSettingsFor(defaultSnippetDraft())).toEqual([])
  })
})

describe('clampSnippetNumber', () => {
  it('夹取到 [min, max] 并按步进取整，消除浮点尾差', () => {
    const avoid = SNIPPET_ROWS.find(row => row.key === 'avoid')!
    expect(clampSnippetNumber(avoid, 999)).toBe(20)
    expect(clampSnippetNumber(avoid, 0)).toBe(2)
    expect(clampSnippetNumber(avoid, 7.3)).toBe(7)
    expect(clampSnippetNumber(avoid, 8.0000000001)).toBe(8)
  })

  it('低血量阈值夹取到 1..100 并按整数步进', () => {
    const healthPack = SNIPPET_ROWS.find(row => row.key === 'lowHpHealthPack')!
    expect(clampSnippetNumber(healthPack, 0)).toBe(1)
    expect(clampSnippetNumber(healthPack, 101)).toBe(100)
    expect(clampSnippetNumber(healthPack, 44.6)).toBe(45)
  })

  it('非数值输入回退行默认值', () => {
    const shield = SNIPPET_ROWS.find(row => row.key === 'shield')!
    expect(clampSnippetNumber(shield, Number.NaN)).toBe(shield.defaultP1)
  })
})

describe('validateWaypoints', () => {
  it('合法路径点通过（含空白分隔与正负号）', () => {
    expect(validateWaypoints('30,0;0,30;-30,0;0,-30')).toBeUndefined()
    expect(validateWaypoints(' 30,0 ;  0,30 ')).toBeUndefined()
    expect(validateWaypoints('')).toBeUndefined()
  })

  it(`超过 ${PATROL_MAX_WAYPOINTS} 点拒绝`, () => {
    const text = Array.from({ length: PATROL_MAX_WAYPOINTS + 1 }, (_, i) => `${i},0`).join(';')
    expect(validateWaypoints(text)).toContain('最多 8 个')
  })

  it('格式错误指出具体坏点', () => {
    expect(validateWaypoints('30,0;x,9')).toContain('x,9')
    expect(validateWaypoints('30')).toContain('30')
  })

  it(`超出 ±${PATROL_ARENA_RADIUS}m 竞技场拒绝`, () => {
    expect(validateWaypoints('81,0')).toContain('±80')
    expect(validateWaypoints('0,-99.5')).toContain('±80')
    expect(validateWaypoints('80,80')).toBeUndefined()
  })
})

describe('snippetDraftMatchesApplied', () => {
  it('与 applied 完全一致返回 true（复用上行组装）', () => {
    const draft = draftWith('avoid', { enabled: true, p1: 9 })
    expect(snippetDraftMatchesApplied(draft, snippetSettingsFor(draft))).toBe(true)
  })

  it('开关/数值/文本任一漂移返回 false', () => {
    const applied = snippetSettingsFor(draftWith('avoid', { enabled: true, p1: 9 }))
    expect(snippetDraftMatchesApplied(draftWith('avoid', { enabled: false }), applied)).toBe(false)
    expect(snippetDraftMatchesApplied(draftWith('avoid', { enabled: true, p1: 10 }), applied)).toBe(false)
    const patrolApplied = snippetSettingsFor(draftWith('patrol', { enabled: true }))
    expect(snippetDraftMatchesApplied(draftWith('patrol', { enabled: true, s1: '1,2' }), patrolApplied)).toBe(false)
  })

  it('服务器 applied 为空而草稿仍有启用行返回 false', () => {
    expect(snippetDraftMatchesApplied(draftWith('shield', { enabled: true }), [])).toBe(false)
  })
})

describe('draft persistence', () => {
  /** node 环境无 localStorage：内存 Map 桩覆盖存取/序列化路径。 */
  function stubStorage(): Map<string, string> {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)) },
      removeItem: (key: string) => { store.delete(key) },
    })
    return store
  }

  it('保存后按身份读回一致；损坏或缺行回退默认', () => {
    const store = stubStorage()
    const draft = draftWith('patrol', { enabled: true, s1: '10,20' })
    expect(saveSnippetDraft('RM1', '测试', draft)).toBe(true)
    expect(loadSnippetDraft('RM1', '测试')).toEqual(draft)
    const badKey = snippetDraftKey('RM2', '坏')
    store.set(badKey, '{broken')
    expect(loadSnippetDraft('RM2', '坏')).toEqual(defaultSnippetDraft())
    store.set(badKey, JSON.stringify({ draft: { shield: { enabled: true, p1: 1, s1: '' } } }))
    expect(loadSnippetDraft('RM2', '坏')).toEqual(defaultSnippetDraft())
    vi.unstubAllGlobals()
  })

  it('未保存的身份返回默认草稿', () => {
    stubStorage()
    expect(loadSnippetDraft('NOPE', 'none')).toEqual(defaultSnippetDraft())
    vi.unstubAllGlobals()
  })
})
