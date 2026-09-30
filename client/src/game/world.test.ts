import { describe, it, expect } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { SnapshotDeltaSchema, RobotStateSchema, EntityBaseSchema } from '@omb/protocol'
import { emptyWorld, applySnapshot } from './world'

const snapshot = (tick: number, baseTick: number, full = false) => create(SnapshotDeltaSchema, {
  tick, baseTick, full, phase: 1, timeLeftS: 480 - Math.floor(tick / 60),
  robots: [create(RobotStateSchema, { base: create(EntityBaseSchema, { id: 1 }), hpX10: 1000 })],
})

describe('snapshot continuity', () => {
  it('does not rewind the clock or entities on a stale full frame', () => {
    const world = emptyWorld()
    applySnapshot(world, snapshot(120, 0, true))
    applySnapshot(world, snapshot(60, 0, true))
    expect(world.tick).toBe(120)
    expect(world.timeLeftS).toBe(478)
  })
  it('keeps the last coherent state until a full resync arrives', () => {
    const world = emptyWorld()
    applySnapshot(world, snapshot(60, 0, true))
    expect(applySnapshot(world, snapshot(90, 89))).toBe('resync-needed')
    expect(world.tick).toBe(60)
    expect(applySnapshot(world, snapshot(91, 90))).toBe('resync-needed')
    expect(world.tick).toBe(60)
    expect(applySnapshot(world, snapshot(92, 0, true))).toBe('applied')
    expect(world.tick).toBe(92)
  })
  it('does not treat the first delta as a full snapshot', () => {
    const world = emptyWorld()
    expect(applySnapshot(world, snapshot(40, 39))).toBe('resync-needed')
    expect(world.robots.size).toBe(0)
  })
})
