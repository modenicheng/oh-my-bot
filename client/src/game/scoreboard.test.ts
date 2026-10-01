import { describe, expect, it } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { RobotStateSchema, Title } from '@omb/protocol'
import { rankedScores, Scoreboard, titleName } from './scoreboard'
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

  it('maps all thirteen settlement titles and ignores unknown ids', () => {
    expect(Array.from({ length: 13 }, (_, i) => titleName(i + 1)).every(Boolean)).toBe(true)
    expect(titleName(999)).toBe('')
  })
})
