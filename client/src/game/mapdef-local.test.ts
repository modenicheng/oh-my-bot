import { describe, expect, it } from 'vitest'
import { parseMapDef } from './mapdef'

describe('local map', () => {
  it('accepts an empty partial map without inventing objects', () => {
    const local = parseMapDef('{"version":1,"partial":true}')
    expect(local.partial).toBe(true)
    expect(local.walls).toEqual([])
    expect(local.uplinks).toEqual([])
    expect(local.arenaRadius).toBe(0)
    expect(local.coreZone.radius).toBe(0)
    expect(local.extent).toBe(Infinity)
  })
  it('parses only supplied local boundary segments', () => {
    const local = parseMapDef(JSON.stringify({ partial: true, boundaries: [{ kind: 'lock', start: { X: 28, Y: 0 }, end: { X: 27.9, Y: 1 } }] }))
    expect(local.boundaries).toEqual([{ kind: 'lock', start: { x: 28, y: 0 }, end: { x: 27.9, y: 1 } }])
  })
  it('keeps the public opening cue when legacy local metadata has a zero phase', () => {
    const local = parseMapDef('{"partial":true,"core_zone":{"radius":0,"unlock_phase":0}}')
    expect(local.coreZone).toEqual({ radius: 0, unlockPhase: 2 })
  })
})
