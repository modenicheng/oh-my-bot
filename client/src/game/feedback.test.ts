import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { ServerEventSchema, SnapshotDeltaSchema, RobotStateSchema, SelfStateSchema, UplinkStateSchema, CoreStateSchema } from '@omb/protocol'
import { emptyWorld, applySnapshot } from './world'
import { GameFeedback } from './feedback'
import type { MapDefParsed } from './mapdef'

const sound = vi.hoisted(() => ({ play: vi.fn(), setUplink: vi.fn(), stopGame: vi.fn() }))
vi.mock('../audio', () => ({ audio: sound }))
const map: MapDefParsed = { version: 1, generatorVer: 2, seed: 1, mapHash: '', extent: 80,
  walls: [], sectors: [], corePads: [{ id: 20, pos: { x: 43, y: 0 }, group: 0, value: 10 }],
  coreZone: { radius: 30, unlockPhase: 2 }, uplinks: [{ id: 10, pos: { x: 40, y: 0 }, main: false, activePhase: 1, interactR: 2.5 }] }
function snap(tick: number, baseTick: number, full = false, hackingId = 0, cd = 0) {
  return create(SnapshotDeltaSchema, { tick, baseTick, full, phase: 1,
    self: create(SelfStateSchema, { robotId: 1, assistOn: false }),
    robots: [create(RobotStateSchema, { base: { id: 1, pos: { x: 40, y: 0 } }, hpX10: 1000, energyX10: 1000 })],
    uplinks: [create(UplinkStateSchema, { base: { id: 10, pos: { x: 40, y: 0 } }, hackingId, myCooldownS: cd, progressX10: hackingId ? 10 : 0, ready: !hackingId && !cd })],
  })
}

describe('confirmed feedback transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('document', { hidden: false })
  })

  it('emits start/cancel but never labels successful hacking as interrupted', () => {
    const world = emptyWorld(), message = vi.fn(), feedback = new GameFeedback(message)
    const consume = (s: ReturnType<typeof snap>) => { applySnapshot(world, s); feedback.snapshot(world, map, s, true) }
    consume(snap(10, 0, true))
    sound.play.mockClear()
    consume(snap(11, 10, false, 1))
    expect(sound.play).toHaveBeenCalledWith('uplinkStart')
    consume(snap(12, 11))
    expect(sound.play).toHaveBeenCalledWith('uplinkCancel')
    consume(snap(13, 12, false, 1))
    sound.play.mockClear(); message.mockClear()
    const success = create(ServerEventSchema, { tick: 14, kind: { case: 'uplinkHack', value: { by: 1, uplinkId: 10, value: 15 } } })
    feedback.event(success, world, map, true)
    consume(snap(14, 13, false, 0, 30))
    feedback.event(success, world, map, true)
    expect(sound.play.mock.calls.filter(c => c[0] === 'uplinkSuccess')).toHaveLength(1)
    expect(sound.play.mock.calls.some(c => c[0] === 'uplinkCancel')).toBe(false)
    expect(message).toHaveBeenCalledWith(expect.stringContaining('黑入完成'))
  })

  it('only cues new core appearances in continuous deltas, never full resyncs', () => {
    const world = emptyWorld(), feedback = new GameFeedback(vi.fn())
    const first = snap(10, 0, true); applySnapshot(world, first); feedback.snapshot(world, map, first, true)
    sound.play.mockClear()
    const next = snap(11, 10)
    next.cores = [create(CoreStateSchema, { base: { id: 20, pos: { x: 43, y: 0 } }, value: 10 })]
    applySnapshot(world, next); feedback.snapshot(world, map, next, true)
    expect(sound.play).toHaveBeenCalledWith('coreSpawn', expect.any(Number), expect.any(Number))
    sound.play.mockClear()
    const resync = snap(20, 0, true); resync.cores = next.cores
    applySnapshot(world, resync); feedback.snapshot(world, map, resync, true)
    expect(sound.play).not.toHaveBeenCalled()
  })

  it('does not infer bullet hits from a tombstone or replay events while inactive', () => {
    const world = emptyWorld(), feedback = new GameFeedback(vi.fn())
    const s = snap(10, 0, true); applySnapshot(world, s); feedback.snapshot(world, map, s, true)
    sound.play.mockClear()
    const gone = snap(11, 10); gone.projectileGone = [99]
    applySnapshot(world, gone); feedback.snapshot(world, map, gone, true)
    expect(sound.play).not.toHaveBeenCalled()
    const hit = create(ServerEventSchema, { tick: 12, kind: { case: 'projectileImpact', value: { projectile: 99, owner: 1, target: 2, at: { x: 42, y: 0 }, shield: true } } })
    feedback.event(hit, world, map, false)
    expect(sound.play).not.toHaveBeenCalled()
    feedback.event(hit, world, map, true)
    feedback.event(hit, world, map, true)
    expect(sound.play.mock.calls.filter(c => c[0] === 'shieldHit')).toHaveLength(1)
  })
})
