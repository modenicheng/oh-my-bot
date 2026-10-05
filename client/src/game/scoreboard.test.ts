import { describe, expect, it } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { RobotStateSchema, Title } from '@omb/protocol'
import { rankedScores, Scoreboard, titleName, titleDetails } from './scoreboard'
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

  it('maps active settlement titles while hiding deprecated BEST_PARTNER', () => {
    const active = [...Array.from({ length: 9 }, (_, i) => i + 1), 11, 12, 13, 14, 15]
    expect(active.every((id) => titleName(id as Title).length > 0)).toBe(true)
    expect(titleName(Title.BEST_PARTNER)).toBe('')
    expect(titleName(999 as Title)).toBe('')
  })
})
