import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { ServerEventSchema, SnapshotDeltaSchema, RobotStateSchema, SelfStateSchema, UplinkStateSchema, CoreStateSchema } from '@omb/protocol'
import { emptyWorld, applySnapshot } from './world'
import { GameFeedback } from './feedback'
import type { MapDefParsed } from './mapdef'

const sound = vi.hoisted(() => ({ play: vi.fn(), setUplink: vi.fn(), stopGame: vi.fn() }))
vi.mock('../audio', () => ({ audio: sound }))

/** 共享测试环境（C-16）：清 mock + 默认 matchMedia/document 桩；
 *  个别用例随后可用 vi.stubGlobal 覆盖 hidden/matches。 */
function stubFeedbackEnv(): void {
  vi.clearAllMocks()
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('document', { hidden: false })
}
const map: MapDefParsed = { version: 1, generatorVer: 2, seed: 1, mapHash: '', extent: 80,
  walls: [], sectors: [], corePads: [{ id: 20, pos: { x: 43, y: 0 }, group: 0, value: 10 }],
  healthPacks: [{ id: 1, pos: { x: 4, y: 5 } }],
  coreZone: { radius: 30, unlockPhase: 2 }, uplinks: [{ id: 10, pos: { x: 40, y: 0 }, main: false, activePhase: 1, interactR: 2.5 }] }
function snap(tick: number, baseTick: number, full = false, hackingId = 0, cd = 0) {
  return create(SnapshotDeltaSchema, { tick, baseTick, full, phase: 1, timeLeftS: 480,
    self: create(SelfStateSchema, { robotId: 1, assistOn: false }),
    robots: [create(RobotStateSchema, { base: { id: 1, pos: { x: 40, y: 0 } }, hpX10: 1000, energyX10: 1000 })],
    uplinks: [create(UplinkStateSchema, { base: { id: 10, pos: { x: 40, y: 0 } }, hackingId, myCooldownS: cd, progressX10: hackingId ? 10 : 0, ready: !hackingId && !cd })],
  })
}

function fixture() {
  const world = emptyWorld(), message = vi.fn(), innerRing = vi.fn(), countdown = vi.fn()
  const feedback = new GameFeedback(message, innerRing, countdown)
  const consume = (s: ReturnType<typeof snap>, active = true) => {
    expect(applySnapshot(world, s)).toBe('applied')
    feedback.snapshot(world, map, s, active)
  }
  const advance = (seconds: number, phase = 1, full = false, active = true) => {
    const s = snap(world.tick + 1, full ? 0 : world.tick, full)
    s.timeLeftS = seconds; s.phase = phase
    consume(s, active)
    return s
  }
  return { world, message, innerRing, countdown, feedback, consume, advance }
}

const cueCount = (cue: string) => sound.play.mock.calls.filter(c => c[0] === cue).length
const opening = (tick: number) => create(ServerEventSchema, { tick, kind: { case: 'phaseChange', value: { from: 1, to: 2 } } })

describe('confirmed feedback transitions', () => {
  beforeEach(() => {
    stubFeedbackEnv()
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
    expect(message).toHaveBeenCalledWith(expect.stringContaining('黑入完成'), 'uplink')
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

  it('deduplicates banners by tick, kind and payload while keeping distinct kills and remote uplinks', () => {
    const f = fixture(); f.consume(snap(10, 0, true))
    f.world.robots.get(1)!.nick = '阿甲'
    f.world.robots.set(2, { ...create(RobotStateSchema, { base: { id: 2, pos: { x: 42, y: 0 } }, nick: '阿乙' }), seenAt: 0 })
    const kill = create(ServerEventSchema, { tick: 11, kind: { case: 'kill', value: { killer: 1, victim: 2, at: { x: 42, y: 0 } } } })
    const other = create(ServerEventSchema, { tick: 11, kind: { case: 'kill', value: { killer: 1, victim: 3, at: { x: 42, y: 0 } } } })
    const hack = create(ServerEventSchema, { tick: 11, kind: { case: 'uplinkHack', value: { by: 2, uplinkId: 10, value: 15 } } })
    for (const ev of [kill, kill, other, other, hack, hack]) f.feedback.event(ev, f.world, map, true)
    expect(f.message.mock.calls).toEqual([
      ['阿甲 击毁 阿乙', 'kill', { id: 1, name: '阿甲' }],
      ['阿甲 击毁 robot-3', 'kill', { id: 1, name: '阿甲' }], ['阿乙 黑入完成 · +15 分', 'uplink'],
    ])
    expect(cueCount('death')).toBe(2)
    expect(cueCount('uplinkSuccess')).toBe(1)
    f.feedback.event(create(ServerEventSchema, { tick: 12, kind: kill.kind }), f.world, map, true)
    expect(cueCount('death')).toBe(3)
  })

  it('shakes only for an authoritative self kill, decays by tick, and ignores duplicates', () => {
    const f = fixture(); f.consume(snap(10, 0, true))
    f.world.robots.set(2, { ...create(RobotStateSchema, { base: { id: 2, pos: { x: 42, y: 0 } }, nick: '阿乙' }), seenAt: 0 })
    const remote = create(ServerEventSchema, { tick: 11, kind: { case: 'kill', value: { killer: 1, victim: 2, at: { x: 42, y: 0 } } } })
    f.feedback.event(remote, f.world, map, true)
    expect(f.feedback.cameraShake(11)).toEqual({ x: 0, y: 0 })

    const own = create(ServerEventSchema, { tick: 12, kind: { case: 'kill', value: { killer: 2, victim: 1, at: { x: 40, y: 0 } } } })
    f.feedback.event(own, f.world, map, true)
    const first = f.feedback.cameraShake(12)
    const middle = f.feedback.cameraShake(20)
    expect(Math.hypot(first.x, first.y)).toBeGreaterThan(Math.hypot(middle.x, middle.y))
    expect(middle).not.toEqual({ x: 0, y: 0 })
    expect(f.feedback.cameraShake(28)).toEqual({ x: 0, y: 0 })

    f.feedback.event(own, f.world, map, true)
    expect(f.feedback.cameraShake(28)).toEqual({ x: 0, y: 0 })
  })

  it('suppresses camera shake while inactive, hidden, resyncing, paused, or reduced', () => {
    const f = fixture(); f.consume(snap(10, 0, true))
    f.world.robots.set(2, { ...create(RobotStateSchema, { base: { id: 2, pos: { x: 42, y: 0 } } }), seenAt: 0 })
    const own = (tick: number) => create(ServerEventSchema, { tick, kind: { case: 'kill', value: { killer: 2, victim: 1, at: { x: 40, y: 0 } } } })

    f.feedback.event(own(11), f.world, map, false)
    expect(f.feedback.cameraShake(11)).toEqual({ x: 0, y: 0 })

    vi.stubGlobal('document', { hidden: true })
    f.feedback.event(own(12), f.world, map, true)
    expect(f.feedback.cameraShake(12)).toEqual({ x: 0, y: 0 })

    vi.stubGlobal('document', { hidden: false })
    f.feedback.reset(); f.consume(snap(20, 0, true))
    f.feedback.event(own(20), f.world, map, true)
    expect(f.feedback.cameraShake(20)).toEqual({ x: 0, y: 0 })

    f.feedback.event(own(21), f.world, map, true)
    expect(f.feedback.cameraShake(21)).not.toEqual({ x: 0, y: 0 })
    f.feedback.pause()
    expect(f.feedback.cameraShake(21)).toEqual({ x: 0, y: 0 })

    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const reduced = new GameFeedback(vi.fn())
    reduced.event(own(22), f.world, map, true)
    expect(reduced.cameraShake(22)).toEqual({ x: 0, y: 0 })
  })

  it('keeps successful hacking silent of cancellation when its delta arrives before the event', () => {
    const f = fixture(); f.consume(snap(10, 0, true))
    f.consume(snap(11, 10, false, 1))
    sound.play.mockClear(); f.message.mockClear()
    f.consume(snap(12, 11, false, 0, 30))
    const ev = create(ServerEventSchema, { tick: 12, kind: { case: 'uplinkHack', value: { by: 1, uplinkId: 10, value: 15 } } })
    f.feedback.event(ev, f.world, map, true); f.feedback.event(ev, f.world, map, true)
    expect(cueCount('uplinkCancel')).toBe(0)
    expect(cueCount('uplinkSuccess')).toBe(1)
    expect(f.feedback.cameraShake(12)).toEqual({ x: 0, y: 0 })
    expect(f.feedback.cameraShake(20)).toEqual({ x: 0, y: 0 })
    expect(f.message).toHaveBeenCalledExactlyOnceWith('黑入完成 · +15 分 · 本桩冷却 30s', 'uplink')
  })

  it('plays authoritative healing once and keeps resync or hidden delivery silent', () => {
    const f = fixture(); f.consume(snap(10, 0, true))
    const heal = create(ServerEventSchema, { tick: 11, kind: { case: 'heal', value: { by: 1, id: 1, healX10: 50, at: { x: 40, y: 0 } } } })
    f.feedback.event(heal, f.world, map, true); f.feedback.event(heal, f.world, map, true)
    expect(cueCount('healthPickup')).toBe(1)
    expect(f.message).toHaveBeenCalledExactlyOnceWith('生命回灌 · +5 HP', 'status')

    f.feedback.reset(); vi.clearAllMocks(); f.consume(snap(20, 0, true))
    const stale = create(ServerEventSchema, { tick: 20, kind: { case: 'heal', value: { by: 1, id: 1, healX10: 300, at: { x: 40, y: 0 } } } })
    f.feedback.event(stale, f.world, map, true)
    expect(sound.play).not.toHaveBeenCalled(); expect(f.message).not.toHaveBeenCalled()

    vi.stubGlobal('document', { hidden: true })
    f.feedback.event(create(ServerEventSchema, { tick: 21, kind: stale.kind }), f.world, map, true)
    expect(sound.play).not.toHaveBeenCalled(); expect(f.message).not.toHaveBeenCalled()
  })

  it('plays self pickup once after a dynamic core tombstone, even with no remaining position', () => {
    const f = fixture(), first = snap(10, 0, true)
    first.cores = [create(CoreStateSchema, { base: { id: 9020, pos: { x: 41, y: 0 } }, value: 10 })]
    f.consume(first)
    const removed = snap(11, 10); removed.coreGone = [9020]
    f.consume(removed)
    const ev = create(ServerEventSchema, { tick: 11, kind: { case: 'corePickup', value: { by: 1, coreId: 9020, value: 10 } } })
    f.feedback.event(ev, f.world, map, true); f.feedback.event(ev, f.world, map, true)
    expect(sound.play).toHaveBeenCalledExactlyOnceWith('corePickup')
    expect(f.message).toHaveBeenCalledExactlyOnceWith('拾取 Core · +10 分')
    f.world.robots.clear()
    f.feedback.event(create(ServerEventSchema, { tick: 12, kind: { case: 'corePickup', value: { by: 1, coreId: 9021, value: 10 } } }), f.world, map, true)
    expect(cueCount('corePickup')).toBe(2)
  })

  it('uses the picker position for a nearby remote pickup whose core and pad no longer exist', () => {
    const f = fixture(); f.consume(snap(10, 0, true))
    f.world.robots.set(2, { ...create(RobotStateSchema, { base: { id: 2, pos: { x: 42, y: 0 } } }), seenAt: 0 })
    f.feedback.event(create(ServerEventSchema, { tick: 11, kind: { case: 'corePickup', value: { by: 2, coreId: 9020, value: 10 } } }), f.world, map, true)
    expect(sound.play).toHaveBeenCalledExactlyOnceWith('corePickup', expect.any(Number), expect.any(Number), false)
    expect(f.message).not.toHaveBeenCalled()
  })

  it('keeps full resyncs quiet even when entering range and consuming reliable events at the resync tick', () => {
    const f = fixture(), first = snap(10, 0, true)
    first.robots[0]!.base!.pos!.x = 20
    f.consume(first)
    f.consume(snap(20, 0, true))
    const stale = create(ServerEventSchema, { tick: 20, kind: { case: 'uplinkHack', value: { by: 1, uplinkId: 10, value: 15 } } })
    f.feedback.event(stale, f.world, map, true)
    expect(sound.play).not.toHaveBeenCalled()
    expect(f.message).not.toHaveBeenCalled()
    f.consume(snap(21, 20))
    f.feedback.event(create(ServerEventSchema, { tick: 21, kind: stale.kind }), f.world, map, true)
    expect(cueCount('uplinkSuccess')).toBe(1)
  })

  it.each(['event-first', 'snapshot-first', 'delta-only'] as const)('opens the inner ring once with %s ordering', order => {
    const f = fixture(); f.advance(181, 1, true)
    const ev = opening(f.world.tick + 1)
    if (order === 'event-first') f.feedback.event(ev, f.world, map, true)
    f.advance(180, 2)
    if (order !== 'delta-only') {
      f.feedback.event(ev, f.world, map, true)
      f.feedback.event(ev, f.world, map, true)
    }
    f.advance(179, 2)
    f.feedback.event(opening(f.world.tick + 1), f.world, map, true)
    expect(f.innerRing).toHaveBeenCalledTimes(1)
    expect(cueCount('innerOpen')).toBe(1)
    expect(cueCount('phase')).toBe(0)
  })

  it('uses the map unlock phase and keeps both initial and full unlocked baselines silent', () => {
    const f = fixture(); f.advance(180, 2, true)
    f.feedback.event(opening(f.world.tick), f.world, map, true)
    f.advance(179, 2)
    f.feedback.event(opening(f.world.tick + 1), f.world, map, true)
    expect(f.innerRing).not.toHaveBeenCalled()
    f.feedback.reset(); f.consume(snap(10, 0, true))
    f.advance(180, 2, true)
    f.feedback.event(opening(f.world.tick), f.world, map, true)
    expect(f.innerRing).not.toHaveBeenCalled()
    expect(cueCount('innerOpen')).toBe(0)

    f.feedback.reset()
    const earlyMap = { ...map, coreZone: { ...map.coreZone, unlockPhase: 1 } }
    const first = snap(20, 0, true); first.phase = 0
    applySnapshot(f.world, first); f.feedback.snapshot(f.world, earlyMap, first, true)
    const unlock = create(ServerEventSchema, { tick: 21, kind: { case: 'phaseChange', value: { from: 0, to: 1 } } })
    f.feedback.event(unlock, f.world, earlyMap, true)
    expect(f.innerRing).toHaveBeenCalledTimes(1)
    expect(cueCount('innerOpen')).toBe(1)
  })

  it('does not replay background events, including an inner opening before the resume baseline', () => {
    const f = fixture(); f.advance(181, 1, true)
    vi.stubGlobal('document', { hidden: true })
    const ev = opening(f.world.tick + 1)
    const pickup = create(ServerEventSchema, { tick: f.world.tick + 1, kind: { case: 'corePickup', value: { by: 1, coreId: 9020, value: 10 } } })
    f.feedback.event(ev, f.world, map, true); f.feedback.event(pickup, f.world, map, true)
    vi.stubGlobal('document', { hidden: false })
    f.advance(180, 2)
    f.feedback.event(ev, f.world, map, true); f.feedback.event(pickup, f.world, map, true)
    expect(f.innerRing).not.toHaveBeenCalled()
    expect(f.message).not.toHaveBeenCalled()
    expect(sound.play).not.toHaveBeenCalled()
  })

  it('warns once at thirty and ticks ten through one once each, skipping warmup and repeated seconds', () => {
    const f = fixture(); f.advance(480, 0, true)
    f.advance(480, 0); f.advance(480, 1); f.advance(31)
    expect(f.countdown).not.toHaveBeenCalled()
    f.advance(30); f.advance(30); f.advance(29); f.advance(11)
    for (let seconds = 10; seconds >= 1; seconds--) { f.advance(seconds); f.advance(seconds) }
    f.advance(0); f.advance(0)
    expect(f.countdown.mock.calls.map(c => c[0])).toEqual([30, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    expect(cueCount('countdownWarning')).toBe(1)
    expect(cueCount('countdownTick')).toBe(10)
  })

  it('skips missing seconds on lag and does not repeat cues after a clock correction', () => {
    const f = fixture(); f.advance(31, 1, true)
    f.advance(8)
    expect(f.countdown).toHaveBeenCalledExactlyOnceWith(8)
    expect(cueCount('countdownWarning')).toBe(1)
    expect(cueCount('countdownTick')).toBe(0)
    f.advance(5); f.advance(5); f.advance(2)
    f.advance(31); f.advance(30); f.advance(8); f.advance(5); f.advance(2); f.advance(0)
    expect(f.countdown.mock.calls.map(c => c[0])).toEqual([8, 5, 2])
    expect(cueCount('countdownWarning')).toBe(1)
    expect(cueCount('countdownTick')).toBe(2)
  })

  it.each([30, 10, 5, 0])('establishes a silent first countdown baseline at %i seconds', seconds => {
    const f = fixture(); f.advance(seconds, 1, true); f.advance(seconds)
    expect(sound.play).not.toHaveBeenCalled()
    expect(f.countdown).not.toHaveBeenCalled()
    if (seconds >= 2 && seconds <= 10) {
      f.advance(seconds - 1)
      expect(f.countdown).toHaveBeenCalledExactlyOnceWith(seconds - 1)
    }
  })

  it('silences countdown full resync, hidden, inactive, and first resumed frames', () => {
    const f = fixture(); f.advance(31, 1, true)
    f.advance(30, 1, true); f.advance(10, 1, true); f.advance(10)
    expect(f.countdown).not.toHaveBeenCalled()
    f.advance(9)
    expect(f.countdown).toHaveBeenCalledExactlyOnceWith(9)
    sound.play.mockClear(); f.countdown.mockClear()
    vi.stubGlobal('document', { hidden: true }); f.advance(8); f.advance(7)
    vi.stubGlobal('document', { hidden: false }); f.advance(6); f.advance(6)
    expect(f.countdown).not.toHaveBeenCalled()
    f.advance(5)
    expect(f.countdown).toHaveBeenCalledExactlyOnceWith(5)
    f.feedback.pause(); f.advance(4)
    f.advance(3, 1, false, false); f.advance(2)
    expect(f.countdown).toHaveBeenCalledTimes(1)
    f.advance(1)
    expect(f.countdown.mock.calls.map(c => c[0])).toEqual([5, 1])
    expect(cueCount('countdownTick')).toBe(2)
  })

  it('resets all one-shot cue and event state for a subsequent match', () => {
    const f = fixture()
    const ev = opening(11)
    for (let match = 0; match < 2; match++) {
      f.feedback.reset()
      Object.assign(f.world, emptyWorld())
      const first = snap(10, 0, true); first.timeLeftS = 31
      f.consume(first)
      f.feedback.event(ev, f.world, map, true)
      f.advance(30, 2); f.advance(10, 2); f.advance(1, 2)
    }
    expect(f.innerRing).toHaveBeenCalledTimes(2)
    expect(cueCount('innerOpen')).toBe(2)
    expect(cueCount('countdownWarning')).toBe(2)
    expect(cueCount('countdownTick')).toBe(4)
    expect(f.countdown.mock.calls.map(c => c[0])).toEqual([30, 10, 1, 30, 10, 1])
  })
})

describe('combat motion presentation', () => {
  beforeEach(() => {
    stubFeedbackEnv()
  })

  it.each([false, true])('draws restrained seamless red edge rings (reduced=%s)', reduced => {
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
    const f = fixture(), initial = snap(10, 0, true)
    initial.robots[0]!.hpX10 = 200; f.consume(initial)
    const paths: Array<{ rects: number[][]; alpha: number; color: unknown; rule: unknown }> = []
    let current: number[][] = []
    const ctx = { globalAlpha: 1, fillStyle: '' as unknown, save() {}, restore() {}, strokeRect() {},
      beginPath() { current = [] }, rect(...args: number[]) { current.push(args) },
      fill(rule?: unknown) { paths.push({ rects: current.map(r => [...r]), alpha: this.globalAlpha, color: this.fillStyle, rule }) },
    }
    const camera = { cw: 800, ch: 600, scale: 10 }
    f.feedback.draw(ctx as unknown as CanvasRenderingContext2D, camera as Parameters<GameFeedback['draw']>[1])
    expect(paths).toHaveLength(3)
    expect(paths.every(p => p.rule === 'evenodd' && p.color === '#ff756d' && p.rects.length === 2)).toBe(true)
    if (reduced) {
      expect(paths.map(p => p.alpha)).toEqual([expect.closeTo(0.306), expect.closeTo(0.1768), expect.closeTo(0.0816)])
    } else expect(paths.map(p => p.alpha)).toEqual(expect.arrayContaining([expect.any(Number)]))
    for (const path of paths) {
      const [outer, inner] = path.rects
      expect(outer![0]).toBeLessThanOrEqual(inner![0]!)
      expect(outer![1]).toBeLessThanOrEqual(inner![1]!)
      expect(outer![0]! + outer![2]!).toBeGreaterThanOrEqual(inner![0]! + inner![2]!)
      expect(outer![1]! + outer![3]!).toBeGreaterThanOrEqual(inner![1]! + inner![3]!)
    }
    // Each band is a single rectangular ring, so all four corners belong to one path with no seams.
    expect(paths[0]!.rects[0]).toEqual([0, 0, 800, 600])
    expect(Math.max(...paths.map(p => p.alpha))).toBeLessThanOrEqual(0.52)
    const healthy = snap(11, 10); f.consume(healthy); paths.length = 0
    f.feedback.draw(ctx as unknown as CanvasRenderingContext2D, camera as Parameters<GameFeedback['draw']>[1])
    expect(paths).toHaveLength(0)
  })

  it('briefly brightens and expands the red frame when hit again at low health', () => {
    let now = 1_000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const f = fixture(), initial = snap(10, 0, true)
      initial.robots[0]!.hpX10 = 200; f.consume(initial)
      const paths: Array<{ rects: number[][]; alpha: number }> = []
      let current: number[][] = []
      const ctx = { globalAlpha: 1, fillStyle: '' as unknown, save() {}, restore() {}, strokeRect() {}, fillText() {},
        beginPath() { current = [] }, rect(...args: number[]) { current.push(args) },
        fill() { paths.push({ rects: current.map(r => [...r]), alpha: this.globalAlpha }) },
      }
      const camera = { cw: 800, ch: 600, scale: 10, toPxX: (x: number) => x * 10, toPxY: (y: number) => y * 10 }
      f.feedback.draw(ctx as unknown as CanvasRenderingContext2D, camera as Parameters<GameFeedback['draw']>[1])
      const base = paths.map(p => ({ rects: p.rects.map(r => [...r]), alpha: p.alpha }))

      const hit = snap(11, 10); hit.robots[0]!.hpX10 = 100; f.consume(hit)
      paths.length = 0
      f.feedback.draw(ctx as unknown as CanvasRenderingContext2D, camera as Parameters<GameFeedback['draw']>[1])
      const active = paths.map(p => ({ rects: p.rects.map(r => [...r]), alpha: p.alpha }))
      expect(active[0]!.rects[1]![0]).toBeGreaterThan(base[0]!.rects[1]![0]!)
      expect(active[0]!.rects[1]![1]).toBeGreaterThan(base[0]!.rects[1]![1]!)
      expect(active[0]!.alpha).toBeGreaterThan(base[0]!.alpha)

      now += 241; paths.length = 0
      f.feedback.draw(ctx as unknown as CanvasRenderingContext2D, camera as Parameters<GameFeedback['draw']>[1])
      expect(paths.map(p => p.rects)).toEqual(base.map(p => p.rects))
    } finally { clock.mockRestore() }
  })

  it('holds the previous health as a delayed white-bar value across continuous hits', () => {
    const f = fixture(); f.consume(snap(10, 0, true))
    const first = snap(11, 10); first.robots[0]!.hpX10 = 800; f.consume(first)
    expect(f.feedback.delayedHealth(1, 800)).toBe(100)
    const second = snap(12, 11); second.robots[0]!.hpX10 = 650; f.consume(second)
    expect(f.feedback.delayedHealth(1, 650)).toBe(100)
  })

  it('eases camera out while dashing and restores it afterwards', () => {
    const f = fixture(); f.consume(snap(10, 0, true))
    const start = f.feedback.cameraZoom(10, false)
    const dash = f.feedback.cameraZoom(11, true)
    const deeper = f.feedback.cameraZoom(14, true)
    const restore = f.feedback.cameraZoom(20, false)
    expect(start).toBe(1)
    expect(dash).toBeLessThan(1)
    expect(deeper).toBeLessThan(dash)
    expect(restore).toBeGreaterThan(deeper)
  })

  it('pulls the camera back while hacking, lets dash take priority, and restores afterwards', () => {
    const f = fixture(); f.consume(snap(10, 0, true))
    const start = f.feedback.cameraZoom(10, false, false)
    const hack = f.feedback.cameraZoom(11, false, true)
    const deeper = f.feedback.cameraZoom(14, false, true)
    const dash = f.feedback.cameraZoom(15, true, true)
    const restore = f.feedback.cameraZoom(22, false, false)
    expect(start).toBe(1)
    expect(hack).toBeLessThan(1)
    expect(deeper).toBeLessThan(hack)
    expect(dash).toBeLessThan(deeper)
    expect(restore).toBeGreaterThan(dash)

    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    expect(new GameFeedback(vi.fn()).cameraZoom(11, false, true)).toBe(1)
  })

  it('advances zoom once per tick when draw and input loops call it twice on the same tick', () => {
    // C-4：rAF drawFrame 与 60Hz sampleAndSend 同 tick 各调一次；同 tick 的第二次
    // 调用必须返回缓存，否则每 tick 走两步、收敛速度随刷新率漂移（144Hz≈204 步/s）。
    const f = fixture(); f.consume(snap(10, 0, true))
    const draw = f.feedback.cameraZoom(11, false, true)
    const sample = f.feedback.cameraZoom(11, false, true)
    expect(sample).toBe(draw)
    const once = new GameFeedback(vi.fn())
    once.cameraZoom(11, false, true)
    const single = once.cameraZoom(12, false, true)
    const twice: number[] = []
    for (let tick = 11; tick <= 12; tick++) twice.push(f.feedback.cameraZoom(tick, false, true), f.feedback.cameraZoom(tick, false, true))
    expect(twice[3]).toBe(single)
  })

  it('raises hit pitch during a short confirmed impact chain', () => {
    const f = fixture(); f.consume(snap(10, 0, true)); f.feedback.reset()
    f.world.robots.set(2, { ...create(RobotStateSchema, { base: { id: 2, pos: { x: 42, y: 0 } } }), seenAt: 0 })
    for (let tick = 11; tick <= 13; tick++) {
      f.feedback.event(create(ServerEventSchema, { tick, kind: { case: 'projectileImpact', value: { projectile: tick, owner: 1, target: 2, at: { x: 42, y: 0 } } } }), f.world, map, true)
    }
    const pitches = sound.play.mock.calls.filter(call => call[0] === 'hit').map(call => call[4] ?? 1)
    expect(pitches).toHaveLength(3)
    expect(pitches[0]).toBe(1)
    expect(pitches[1]).toBeCloseTo(1.07)
    expect(pitches[2]).toBeCloseTo(1.14)
    expect(pitches[2]!).toBeGreaterThan(pitches[1]!)
  })
})

describe('projectile impact presentation', () => {
  beforeEach(() => {
    stubFeedbackEnv()
  })
  function painted(feedback: GameFeedback): string[] {
    const colors: string[] = []
    const ctx = { fillStyle: '', save() {}, restore() {}, fillRect() { colors.push(this.fillStyle) } }
    const camera = { toPxX: (n: number) => n, toPxY: (n: number) => n, cw: 200, ch: 200, scale: 10 }
    feedback.draw(ctx as unknown as CanvasRenderingContext2D, camera as Parameters<GameFeedback['draw']>[1])
    return colors
  }
  it.each(['#a78bfa', '#fbbf24'])('uses %s at a visible wall even when owner and projectile are absent', color => {
    const f = fixture(); f.consume(snap(10, 0, true)); f.feedback.reset()
    const event = create(ServerEventSchema, { tick: 11, kind: { case: 'projectileImpact', value: { projectile: 99, owner: 42, at: { x: 42, y: 0 }, color } } })
    f.feedback.event(event, f.world, map, true)
    expect(painted(f.feedback)).toEqual(Array(7).fill(color))
  })
  it('does not reveal distant or wall-occluded impacts from global events', () => {
    const f = fixture(); f.consume(snap(10, 0, true)); f.feedback.reset()
    const event = (x: number) => create(ServerEventSchema, { tick: x, kind: { case: 'projectileImpact', value: { projectile: x, owner: 42, at: { x, y: 0 }, color: '#a78bfa' } } })
    f.feedback.event(event(100), f.world, map, true)
    const blocked = { ...map, walls: [{ id: 1, min: { x: 41, y: -1 }, max: { x: 41.1, y: 1 } }] }
    f.feedback.event(event(42), f.world, blocked, true)
    expect(painted(f.feedback)).toEqual([])
    f.feedback.event(event(41), f.world, blocked, true)
    expect(painted(f.feedback)).toEqual(Array(7).fill('#a78bfa'))
  })
  it('keeps shield feedback white and supports legacy payload fallback', () => {
    const f = fixture(); f.consume(snap(10, 0, true)); f.feedback.reset()
    f.feedback.event(create(ServerEventSchema, { tick: 11, kind: { case: 'projectileImpact', value: { projectile: 99, owner: 1, target: 1, at: { x: 40, y: 0 }, shield: true, color: '#a78bfa' } } }), f.world, map, true)
    expect(painted(f.feedback)).toEqual(Array(7).fill('#f4fbff'))
    f.feedback.reset()
    f.world.robots.get(1)!.color = '#fbbf24'
    f.feedback.event(create(ServerEventSchema, { tick: 12, kind: { case: 'projectileImpact', value: { projectile: 100, owner: 1, at: { x: 42, y: 0 } } } }), f.world, map, true)
    expect(painted(f.feedback)).toEqual(Array(7).fill('#fbbf24'))
  })
})
