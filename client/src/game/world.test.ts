import { describe, it, expect } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { SnapshotDeltaSchema, RobotStateSchema, EntityBaseSchema, ProjectileStateSchema } from '@omb/protocol'
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

describe('projectile color continuity', () => {
  it('uses projectile color without a visible owner and after robotGone', () => {
    const world = emptyWorld()
    const full = snapshot(1, 0, true)
    full.robots[0]!.color = '#fbbf24'
    full.projectiles = [create(ProjectileStateSchema, { base: { id: 99 }, ownerId: 1, color: '#a78bfa' })]
    applySnapshot(world, full)
    expect(world.projectiles.get(99)?.color).toBe('#a78bfa')
    const delta = snapshot(2, 1); delta.robots = []; delta.robotGone = [1]
    delta.projectiles = [create(ProjectileStateSchema, { base: { id: 99, pos: { x: 2, y: 0 } }, ownerId: 1, color: '#a78bfa' })]
    applySnapshot(world, delta)
    expect(world.robots.size).toBe(0)
    expect(world.projectiles.get(99)?.color).toBe('#a78bfa')
  })
  it('keeps legacy visible-owner colors until full resync and never transfers colors across owner IDs', () => {
    const world = emptyWorld(), full = snapshot(1, 0, true)
    full.robots[0]!.color = '#fbbf24'
    full.projectiles = [create(ProjectileStateSchema, { base: { id: 99 }, ownerId: 1 })]
    applySnapshot(world, full)
    expect(world.projectiles.get(99)?.color).toBe('#fbbf24')
    const delta = snapshot(2, 1); delta.robots = []; delta.robotGone = [1]; delta.projectiles = full.projectiles
    applySnapshot(world, delta)
    expect(world.projectiles.get(99)?.color).toBe('#fbbf24')
    const changedOwner = snapshot(3, 2); changedOwner.robots = []
    changedOwner.projectiles = [create(ProjectileStateSchema, { base: { id: 99 }, ownerId: 2 })]
    applySnapshot(world, changedOwner)
    expect(world.projectiles.get(99)?.color).toBe('')
    const resync = snapshot(4, 0, true); resync.robots = []; resync.projectiles = full.projectiles
    applySnapshot(world, resync)
    expect(world.projectiles.get(99)?.color).toBe('')
  })
})
