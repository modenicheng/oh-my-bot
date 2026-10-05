// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { RobotStateSchema, Title } from '@omb/protocol'
import { rankedScores, Scoreboard, ScoreRowRenderer, scoreRow, titleName, titleDetails } from './scoreboard'
import { deathStatus } from './death'
import type { RobotEnt } from './world'

const robot = (id: number, nick: string): RobotEnt => ({ ...create(RobotStateSchema, { base: { id }, nick }), seenAt: 0 })

describe('authoritative scoreboard', () => {
  it('sorts by descending score and stable robot id without mutating input', () => {
    const rows = [{ robot: 3, score: 0 }, { robot: 2, score: 10 }, { robot: 1, score: 10 }]
    expect(rankedScores(rows).map(row => row.robot)).toEqual([1, 2, 3])
    expect(rows.map(row => row.robot)).toEqual([3, 2, 1])
  })

  it('distinguishes zero from not received and retains names outside AOI', () => {
    const board = new Scoreboard()
    const robots = new Map([[1, robot(1, '甲')], [2, robot(2, '<b>乙</b>')]])
    expect(board.hasScores).toBe(false)
    expect(board.score(1)).toBeUndefined()
    board.observe(robots)
    board.accept([{ robot: 1, score: 0 }, { robot: 2, score: 25 }, { robot: 3, score: 5 }], 60)
    robots.delete(2)
    const rows = board.display(robots, 1)
    expect(board.hasScores).toBe(true)
    expect(board.score(1)).toBe(0)
    expect(rows[0]?.nick).toBe('<b>乙</b>')
    expect(rows[1]?.nick).toBe('robot-3')
    expect(rows[2]?.self).toBe(true)
    expect(rows).toHaveLength(3)
  })

  it('invalidates display cache when life state changes', () => {
    const board = new Scoreboard()
    const robots = new Map([[1, { ...robot(1, '甲'), dead: true, respawnInS: 3 }]])
    board.accept([{ robot: 1, score: 10 }], 1)
    const first = board.display(robots)
    robots.get(1)!.dead = false
    const second = board.display(robots)
    expect(second).not.toBe(first)
    expect(second[0]?.dead).toBe(false)
  })

  it('ignores stale live scores and makes final results authoritative', () => {
    const board = new Scoreboard()
    const final = [{ robot: 1, score: 99, titles: [Title.WAR_MACHINE] }]
    board.accept([{ robot: 1, score: 25 }], 120)
    board.accept([{ robot: 1, score: 0 }], 60)
    expect(board.score(1)).toBe(25)
    board.accept(final, 121, true)
    final[0]!.titles.push(Title.SCAVENGER)
    board.accept([{ robot: 1, score: 2 }], 200)
    expect(board.score(1)).toBe(99)
    expect(board.display(new Map())[0]?.titles).toEqual([Title.WAR_MACHINE])
    expect(board.ended).toBe(true)
  })

  it('resets scores titles and identity before a new bootstrap', () => {
    const board = new Scoreboard()
    board.observe(new Map([[1, robot(1, '旧局')]]))
    board.accept([{ robot: 1, score: 30, titles: [Title.RUNNER] }], 100, true)
    board.reset()
    expect(board.hasScores).toBe(false)
    expect(board.ended).toBe(false)
    expect(board.names.size).toBe(0)
    board.accept([{ robot: 1, score: 0 }], 1)
    expect(board.score(1)).toBe(0)
    expect(board.display(new Map())[0]?.titles).toEqual([])
  })

  it('describes every active award without inventing absent protocol counters', () => {
    const active = [...Array.from({ length: 9 }, (_, i) => i + 1), 11, 12, 13, 14, 15]
    for (const id of active) {
      const detail = titleDetails(id, -12)!
      expect(detail.name).toBe(titleName(id))
      expect(detail.rule.length).toBeGreaterThan(5)
      expect(detail.evidence).toContain('未提供；最终积分：-12')
      expect(detail.source).toContain('不从积分或局部事件反推')
    }
    expect(titleDetails(Title.BEST_PARTNER, 0)).toBeUndefined()
    expect(titleDetails(999, 0)).toBeUndefined()
    expect(titleDetails(Title.SURVIVOR, 0)?.rule).toContain('单次连续存活')
    expect(titleDetails(Title.BARRAGE, 0)?.rule).toContain('并非开火次数')
    expect(titleDetails(Title.OLD_SCHOOL, 0)?.rule).not.toContain('全场为零不授予')
  })

  it('scopes available replay counters to recorded events, not complete award totals', () => {
    const replay = { kill: 0, hit: 12, core: 3, uplink: 2 }
    for (const [id, count] of [[Title.WAR_MACHINE, 0], [Title.PEACEMAKER, 0], [Title.BARRAGE, 12], [Title.SCAVENGER, 3], [Title.SIGNAL_THIEF, 2]]) {
      const detail = titleDetails(id!, 80, replay)!
      expect(detail.evidence).toContain(`${count}（录像已记录）`)
      expect(detail.source).toContain('不替代服务器完整评选统计')
    }
    expect(titleDetails(Title.SURVIVOR, 80, replay)?.evidence).toContain('未提供')
    expect(titleDetails(Title.WAR_MACHINE, 80, { ...replay, kill: -1 })?.evidence).toContain('未提供')
    expect(titleDetails(Title.WAR_MACHINE, 80, { ...replay, kill: NaN })?.evidence).toContain('未提供')
    expect(titleDetails(Title.WAR_MACHINE, 80, { ...replay, kill: 1.5 })?.evidence).toContain('未提供')
  })

  it('shows snapshot respawn status only for a dead player in an active match', () => {
    const self = { ...robot(1, '甲'), dead: true, respawnInS: 3 }
    expect(deathStatus(self, true, false)).toBe('3 秒后重生')
    for (const respawnInS of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deathStatus({ ...self, respawnInS }, true, false)).toBe('等待重生同步')
    }
    expect(deathStatus(undefined, true, false)).toBeUndefined()
    expect(deathStatus(self, false, false)).toBeUndefined()
    expect(deathStatus(self, true, true)).toBeUndefined()
    expect(deathStatus({ ...self, dead: false }, true, false)).toBeUndefined()
  })

  it('renders rank highlights, crown and long names without HTML injection', () => {
    const make = (rank: number, robot: number, extra: Partial<import('./scoreboard').ScoreDisplay> = {}) => ({
      robot, score: 100 - rank, rank, nick: '<长昵称>', self: robot === 4, dead: extra.dead ?? false,
      status: extra.status ?? 'alive', titles: extra.titles,
    })
    const first = scoreRow(make(1, 1), 'div')
    const second = scoreRow(make(2, 2), 'div')
    const third = scoreRow(make(3, 3), 'div')
    const dead = scoreRow(make(4, 4, { dead: true, status: 'dead' }), 'div')
    expect(first.querySelector('[data-icon="crown"]')).not.toBeNull()
    expect(first.classList.contains('score-first')).toBe(true)
    expect(second.classList.contains('score-second')).toBe(true)
    expect(third.classList.contains('score-third')).toBe(true)
    expect(dead.classList.contains('score-dead')).toBe(true)
    expect(dead.querySelector('.score-name')?.textContent).toBe('<长昵称>')
    expect(dead.querySelector('.score-state')).toBeNull()
  })

  it('reuses 64 keyed row nodes and keeps the node set bounded while reordering', () => {
    const parent = document.createElement('div')
    const renderer = new ScoreRowRenderer()
    const values = (offset = 0) => Array.from({ length: 64 }, (_, i) => ({
      robot: i + 1, score: i + offset, rank: i + 1, nick: `机器人-${i + 1}`,
      self: i === 0, dead: i % 7 === 0, status: (i % 7 === 0 ? 'dead' : 'alive') as 'dead' | 'alive',
    }))
    renderer.update(parent, values(), { titles: true })
    const identity = new Map([...parent.children].map(node => [Number((node as HTMLElement).dataset.robot), node]))
    for (let i = 0; i < 20; i++) renderer.update(parent, values(i), { titles: true })
    expect(renderer.nodeCount).toBe(64)
    expect(parent.children).toHaveLength(64)
    expect(renderer.createdCount).toBe(64)
    expect(renderer.removedCount).toBe(0)
    for (const [robot, node] of identity) expect(parent.querySelector(`[data-robot="${robot}"]`)).toBe(node)
    renderer.update(parent, [...values(20)].reverse(), { titles: true })
    expect(renderer.nodeCount).toBe(64)
    expect(renderer.createdCount).toBe(64)
    expect(parent.children).toHaveLength(64)
  })

  it('reuses title and replay evidence nodes and never appends duplicate evidence', () => {
    const parent = document.createElement('div')
    const renderer = new ScoreRowRenderer()
    const row = (score: number) => ({ robot: 1, score, rank: 1, nick: '甲', self: false, dead: false, status: 'unknown' as const,
      titles: [Title.WAR_MACHINE], replayEvidence: { kill: score, hit: 2, core: 3, uplink: 4, assist: 1 } })
    renderer.update(parent, [row(1)], { titles: true })
    const element = parent.firstElementChild!
    const badge = element.querySelector('.score-award')
    const button = element.querySelector<HTMLButtonElement>('.score-title')!
    const detail = document.getElementById(button.getAttribute('aria-controls')!)!
    const evidence = element.querySelector('.score-replay-evidence')
    expect(detail.parentElement).toBe(document.body)
    renderer.update(parent, [row(2)], { titles: true })
    expect(element.querySelectorAll('.score-replay-evidence')).toHaveLength(1)
    expect(element.querySelector('.score-replay-evidence')?.textContent).toContain('K2')
    expect(element.querySelector('.score-award')).toBe(badge)
    expect(document.getElementById(detail.id)).toBe(detail)
    expect(detail.textContent).toContain('2（录像已记录）')
    expect(element.querySelector('.score-replay-evidence')).toBe(evidence)
    renderer.update(parent, [{ ...row(2), titles: [] }], { titles: false })
    expect(element.querySelectorAll('.score-title')).toHaveLength(0)
    expect(element.querySelector('.score-titles')?.childElementCount).toBe(0)
    expect(document.getElementById(detail.id)).toBeNull()
  })

  it('maps active settlement titles while hiding deprecated BEST_PARTNER', () => {
    const active = [...Array.from({ length: 9 }, (_, i) => i + 1), 11, 12, 13, 14, 15]
    expect(active.every((id) => titleName(id as Title).length > 0)).toBe(true)
    expect(titleName(Title.BEST_PARTNER)).toBe('')
    expect(titleName(999 as Title)).toBe('')
  })
})
