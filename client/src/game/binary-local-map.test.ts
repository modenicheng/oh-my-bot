import { describe, expect, it, vi } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { isBinarySnapshot, ServerFrameDecoder, SnapshotDeltaSchema, type SnapshotDelta } from '@omb/protocol'
import { projectBinaryLocalMap } from './binary-local-map'
import type { MapDefParsed } from './mapdef'
import { applySnapshot, emptyWorld, setWorldStaticMap } from './world'

// Synthetic frames isolate world lifecycle tests; the real codec path is tested too.
// Only the marker is augmented; protobuf messages and world merging are real.
const binarySnapshots = vi.hoisted(() => new WeakSet<object>())
vi.mock('@omb/protocol', async importOriginal => {
  const protocol = await importOriginal<typeof import('@omb/protocol')>()
  return {
    ...protocol,
    isBinarySnapshot: (snapshot: SnapshotDelta) => binarySnapshots.has(snapshot) || protocol.isBinarySnapshot(snapshot),
  }
})

function binary(tick: number, baseTick: number, full = false): SnapshotDelta {
  const snap = create(SnapshotDeltaSchema, { tick, baseTick, full, phase: 1, timeLeftS: 100 })
  binarySnapshots.add(snap)
  return snap
}

function playerFull(tick = 1): SnapshotDelta {
  const snap = binary(tick, 0, true)
  const state = create(SnapshotDeltaSchema, {
    self: { robotId: 1 },
    uplinks: [{ base: { id: 10, pos: { x: 10, y: 0 } }, ready: true }],
    healthPacks: [{ base: { id: 30, pos: { x: 30, y: 0 } }, available: true }],
  })
  snap.self = state.self
  snap.visionRadius = 20
  snap.uplinks = state.uplinks
  snap.healthPacks = state.healthPacks
  return snap
}

const staticMap = (): MapDefParsed => ({
  partial: false,
  version: 1,
  generatorVer: 8,
  seed: 42,
  mapHash: 'stable',
  walls: [{ id: 1, min: { x: -2, y: -2 }, max: { x: 2, y: 2 } }],
  boundaries: [{ kind: 'arena', start: { x: 1, y: 0 }, end: { x: 0, y: 1 } }],
  sectors: [{ id: 1, spawnArea: { min: { x: -1, y: -1 }, max: { x: 1, y: 1 } }, center: { x: 0, y: 0 } }],
  uplinks: [
    { id: 10, pos: { x: 10, y: 0 }, main: true, interactR: 2.5, activePhase: 1 },
    { id: 11, pos: { x: -10, y: 0 }, main: false, interactR: 2.5, activePhase: 1 },
  ],
  corePads: [{ id: 20, pos: { x: 0, y: 20 }, group: 1, value: 10 }],
  healthPacks: [{ id: 30, pos: { x: 30, y: 0 } }, { id: 31, pos: { x: -30, y: 0 } }],
  coreZone: { radius: 28, unlockPhase: 2 },
  arenaRadius: 80,
  extent: 80,
})

describe('compact local map projection', () => {
  it('projects only current resource IDs and preserves public phase metadata', () => {
    const map = staticMap()
    const projected = projectBinaryLocalMap(map, new Set([11]), new Set([30]))

    expect(projected.partial).toBe(true)
    expect(projected.uplinks).toEqual([map.uplinks[1]])
    expect(projected.healthPacks).toEqual([map.healthPacks[0]])
    expect(projected.coreZone).toEqual({ radius: 0, unlockPhase: 2 })
    expect(projected.corePads).toEqual([])
    expect(projected.walls).toEqual([])
    expect(projected.boundaries).toEqual([])
    expect(projected.sectors).toEqual([])
    expect(projected.arenaRadius).toBe(0)
    expect(projected.extent).toBe(Infinity)
  })

  it('does not mutate the bootstrap map across full, delta, and exit projections', () => {
    const map = staticMap()
    const initial = projectBinaryLocalMap(map, new Set([10, 11]), new Set([30, 31]))
    const delta = projectBinaryLocalMap(map, new Set([10]), new Set([31]))
    const exit = projectBinaryLocalMap(map, new Set(), new Set())

    expect(initial.uplinks.map(u => u.id)).toEqual([10, 11])
    expect(initial.healthPacks.map(h => h.id)).toEqual([30, 31])
    expect(delta.uplinks.map(u => u.id)).toEqual([10])
    expect(delta.healthPacks.map(h => h.id)).toEqual([31])
    expect(exit.uplinks).toEqual([])
    expect(exit.healthPacks).toEqual([])
    expect(map.partial).toBe(false)
    expect(map.walls).toHaveLength(1)
    expect(map.uplinks.map(u => u.id)).toEqual([10, 11])
    expect(map.healthPacks.map(h => h.id)).toEqual([30, 31])
  })

  it('does not invent definitions for unknown visible IDs or require JSON work', () => {
    const map = staticMap()
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('unexpected parse') })
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('unexpected stringify') })
    let projected: MapDefParsed
    try {
      projected = projectBinaryLocalMap(map, new Map([[11, {}], [99, {}]]), new Map([[31, {}], [98, {}]]))
    } finally {
      parse.mockRestore()
      stringify.mockRestore()
    }
    expect(projected.uplinks).toEqual([map.uplinks[1]])
    expect(projected.healthPacks).toEqual([map.healthPacks[1]])
  })
})

describe('binary world local map lifecycle', () => {
  it('projects real decoded binary frames, applies tombstones, and clears a full spectator baseline', () => {
    const decoder = new ServerFrameDecoder(), world = emptyWorld()
    world.staticMap = staticMap()
    // Independent V1 fixtures (22-byte header, u32 timeLeft/aiRounds):
    // full uplink/pack + self/radius, resource
    // tombstones, then a full spectator frame with no private metadata.
    const fixtures = [
      '0401070100000000000000000000000164000000400101000a0000001f00e803000001000000000000000001001e0000000700b80b000001000000000100000001010000000000000000d007',
      '0401000200000001000000000000000164000000800201000a00000001001e000000',
      '04010103000000020000000000000002640000000000',
    ]
    for (const [index, hex] of fixtures.entries()) {
      const bytes = Uint8Array.from(hex.match(/../g)!, byte => Number.parseInt(byte, 16))
      const messages = decoder.decode(bytes)
      expect(messages).toHaveLength(1)
      const message = messages[0]!
      if (message.payload.case !== 'snapshot') throw new Error('expected decoded snapshot')
      expect(binarySnapshots.has(message.payload.value)).toBe(false)
      expect(isBinarySnapshot(message.payload.value)).toBe(true)
      expect(applySnapshot(world, message.payload.value)).toBe('applied')
      if (index === 0) {
        expect(world.localMap?.uplinks.map(u => u.id)).toEqual([10])
        expect(world.localMap?.healthPacks.map(h => h.id)).toEqual([30])
      } else if (index === 1) {
        expect(world.localMap?.uplinks).toEqual([])
        expect(world.localMap?.healthPacks).toEqual([])
      } else {
        expect(world.localMap).toBeUndefined()
        expect(world.self).toBeUndefined()
        expect(world.visionRadius).toBeUndefined()
      }
    }
  })

  it('projects after entity merging and retains unchanged resource definitions on sparse deltas', () => {
    const world = emptyWorld(), map = staticMap()
    setWorldStaticMap(world, map)
    expect(applySnapshot(world, playerFull())).toBe('applied')
    expect(world.staticMap).toBe(map)
    expect(world.localMap?.uplinks).toEqual([map.uplinks[0]])
    expect(world.localMap?.healthPacks).toEqual([map.healthPacks[0]])

    const self = world.self
    applySnapshot(world, binary(2, 1))
    expect(world.self).toBe(self)
    expect(world.visionRadius).toBe(20)
    expect(world.localMap?.uplinks.map(u => u.id)).toEqual([10])
    expect(world.localMap?.healthPacks.map(h => h.id)).toEqual([30])

    const next = binary(3, 2)
    next.phase = 2
    next.visionRadius = 32
    next.uplinks = create(SnapshotDeltaSchema, { uplinks: [{ base: { id: 11 } }] }).uplinks
    next.healthPacks = create(SnapshotDeltaSchema, { healthPacks: [{ base: { id: 31 } }] }).healthPacks
    applySnapshot(world, next)
    expect(world.localMap?.uplinks.map(u => u.id)).toEqual([10, 11])
    expect(world.localMap?.healthPacks.map(h => h.id)).toEqual([30, 31])
    expect(world.phase).toBe(2)
    expect(world.localMap?.coreZone.unlockPhase).toBe(map.coreZone.unlockPhase)
    expect(world.visionRadius).toBe(32)
    expect(world.staticMap?.walls).toBe(map.walls)
  })

  it('removes exited resources, supports re-entry, and rebuilds on full resync', () => {
    const world = emptyWorld()
    world.staticMap = staticMap()
    applySnapshot(world, playerFull())
    const exit = binary(2, 1)
    exit.uplinkGone = [10]
    exit.healthPackGone = [30]
    applySnapshot(world, exit)
    expect(world.localMap?.uplinks).toEqual([])
    expect(world.localMap?.healthPacks).toEqual([])
    const entry = playerFull(3)
    entry.full = false
    entry.baseTick = 2
    applySnapshot(world, entry)
    expect(world.localMap?.uplinks.map(u => u.id)).toEqual([10])
    expect(world.localMap?.healthPacks.map(h => h.id)).toEqual([30])
    const resync = playerFull(9)
    resync.uplinks = []
    resync.healthPacks = []
    applySnapshot(world, resync)
    expect(world.uplinks.size).toBe(0)
    expect(world.healthPacks.size).toBe(0)
    expect(world.localMap?.uplinks).toEqual([])
    expect(world.localMap?.healthPacks).toEqual([])
  })

  it('does not project stale frames or deltas across a gap', () => {
    const world = emptyWorld()
    world.staticMap = staticMap()
    expect(applySnapshot(world, binary(2, 1))).toBe('resync-needed')
    expect(world.localMap).toBeUndefined()
    applySnapshot(world, playerFull(10))
    const local = world.localMap
    expect(local?.partial).toBe(true)
    const stale = playerFull(9)
    stale.healthPacks = []
    expect(applySnapshot(world, stale)).toBe('stale')
    const gap = binary(12, 11)
    gap.healthPackGone = [30]
    expect(applySnapshot(world, gap)).toBe('resync-needed')
    expect(world.localMap).toBe(local)
    expect(world.healthPacks.has(30)).toBe(true)
    expect(world.tick).toBe(10)
  })

  it('retains visible pack definitions when availability and cooldown change to zero', () => {
    const world = emptyWorld()
    world.staticMap = staticMap()
    const first = playerFull()
    first.healthPacks[0]!.available = false
    first.healthPacks[0]!.respawnInS = 5
    applySnapshot(world, first)
    const next = binary(2, 1)
    next.healthPacks = playerFull().healthPacks
    applySnapshot(world, next)
    expect(world.healthPacks.get(30)?.available).toBe(true)
    expect(world.healthPacks.get(30)?.respawnInS).toBe(0)
    expect(world.localMap?.healthPacks.map(h => h.id)).toEqual([30])
    applySnapshot(world, binary(3, 2))
    expect(world.healthPacks.get(30)?.available).toBe(true)
    expect(world.localMap?.healthPacks.map(h => h.id)).toEqual([30])
  })

  it.each(['self', 'visionRadius', 'both'] as const)('clears omitted %s on full snapshots instead of retaining a partial spectator view', missing => {
    const world = emptyWorld()
    world.staticMap = staticMap()
    applySnapshot(world, playerFull())
    const spectator = playerFull(2)
    if (missing !== 'visionRadius') spectator.self = undefined
    if (missing !== 'self') spectator.visionRadius = undefined
    applySnapshot(world, spectator)
    expect(world.localMap).toBeUndefined()
    if (missing !== 'visionRadius') expect(world.self).toBeUndefined()
    if (missing !== 'self') expect(world.visionRadius).toBeUndefined()
  })

  it('does not create a partial map for a fresh spectator or before bootstrap', () => {
    const world = emptyWorld()
    world.staticMap = staticMap()
    applySnapshot(world, binary(1, 0, true))
    expect(world.localMap).toBeUndefined()
    const unbootstrapped = emptyWorld()
    applySnapshot(unbootstrapped, playerFull())
    expect(unbootstrapped.localMap).toBeUndefined()
    expect(emptyWorld().staticMap).toBeUndefined()
  })

  it('does not serialize or parse JSON while applying compact snapshots', () => {
    const world = emptyWorld()
    world.staticMap = staticMap()
    const snap = playerFull()
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('unexpected parse') })
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('unexpected stringify') })
    try {
      applySnapshot(world, snap)
    } finally {
      parse.mockRestore()
      stringify.mockRestore()
    }
    expect(world.localMap?.partial).toBe(true)
  })

  it('keeps legacy mapJson authoritative and preserves it when omitted', () => {
    const world = emptyWorld(), map = staticMap()
    world.staticMap = map
    const first = create(SnapshotDeltaSchema, { tick: 1, full: true, visionRadius: 20, self: { robotId: 1 },
      mapJson: '{"partial":true,"uplinks":[{"id":99,"pos":{"X":4,"Y":5}}],"core_zone":{"unlock_phase":3}}',
    })
    applySnapshot(world, first)
    expect(world.localMap?.uplinks.map(u => u.id)).toEqual([99])
    expect(world.localMap?.coreZone.unlockPhase).toBe(3)
    const local = world.localMap
    applySnapshot(world, create(SnapshotDeltaSchema, { tick: 2, baseTick: 1 }))
    expect(world.localMap).toBe(local)
    applySnapshot(world, create(SnapshotDeltaSchema, { tick: 3, baseTick: 2, mapJson: '{"partial":true}' }))
    expect(world.localMap?.uplinks).toEqual([])
    expect(world.staticMap).toBe(map)
  })
})
