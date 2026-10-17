// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { SelfStateSchema } from '@omb/protocol'
import { Hud } from './hud'
import { Scoreboard, type ScoreEntry } from './scoreboard'
import { emptyWorld } from './world'

vi.mock('./render', () => ({ phaseName: () => 'phase' }))

const html = readFileSync('client/index.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
const active = new Set<Hud>()

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)![1]!
})

afterEach(() => {
  for (const hud of active) hud.dispose()
  active.clear()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function enter(root: HTMLElement): Hud {
  const hud = new Hud(root)
  active.add(hud)
  return hud
}

function exit(hud: Hud): void {
  hud.dispose()
  active.delete(hud)
}

function render(hud: Hud, rows?: ScoreEntry[]): void {
  const world = emptyWorld()
  world.self = create(SelfStateSchema, { robotId: 1 })
  const board = new Scoreboard()
  if (rows) board.accept(rows, 1)
  hud.update(world, undefined, board)
}

describe('HUD scoreboard lifecycle', () => {
  it('does not retain former self leaders when re-entering the same battle DOM', () => {
    const root = document.getElementById('hud')!
    for (let i = 0; i < 2; i++) {
      const hud = enter(root)
      render(hud, [{ robot: 1, nick: 'modenicheng', score: 0 }])
      exit(hud)
    }

    const hud = enter(root)
    render(hud, [
      { robot: 1, nick: 'modenicheng', score: 0 },
      { robot: 174, nick: 'TEST-BOT-174', score: 311 },
      { robot: 29, nick: 'TEST-BOT-29', score: 292 },
      { robot: 100, nick: 'TEST-BOT-100', score: 284 },
      { robot: 169, nick: 'TEST-BOT-169', score: 249 },
      { robot: 5, nick: 'TEST-BOT-5', score: 248 },
    ])

    const list = root.querySelector('#hud-score-rows')!
    expect(list.querySelectorAll('.score-row')).toHaveLength(6)
    expect([...list.querySelectorAll<HTMLElement>('.score-row')].map(row => row.dataset.robot))
      .toEqual(['174', '29', '100', '169', '5', '1'])
    expect([...list.querySelectorAll('.score-rank-number')].map(row => row.textContent))
      .toEqual(['1', '2', '3', '4', '5', '6'])
    expect(list.querySelectorAll('.score-self')).toHaveLength(1)
    expect(list.querySelector('.score-self .score-rank-number')?.textContent).toBe('6')
    expect(list.querySelectorAll('.score-first')).toHaveLength(1)
    expect(list.querySelectorAll('[data-icon="crown"]')).toHaveLength(1)
    expect(list.querySelector('.score-first .score-name')?.textContent).toBe('TEST-BOT-174')
  })

  it('clears results on exit before the next battle receives scores', () => {
    const root = document.getElementById('hud')!
    const previous = enter(root)
    render(previous, [{ robot: 1, nick: 'modenicheng', score: 100 }])
    exit(previous)
    expect(root.querySelector('#hud-score-rows')?.childElementCount).toBe(0)

    const hud = enter(root)
    render(hud)
    expect(root.querySelectorAll('.score-row')).toHaveLength(0)
    expect(root.querySelectorAll('.score-waiting')).toHaveLength(1)
    expect(root.querySelector('.score-waiting')?.textContent).toBe('等待积分同步')
    exit(hud)
    expect(root.querySelector('#hud-score-rows')?.childElementCount).toBe(0)
  })
})
