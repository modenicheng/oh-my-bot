import { create, toBinary } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ServerMsgSchema, SnapshotDeltaSchema, ServerEventSchema, EvMapBootstrapSchema, EvSaySchema,
  type ServerMsg, type SnapshotDelta,
} from '../src/gen/proto/omb_pb'
import { BINARY_SUBPROTOCOL, FRAME_SNAPSHOT, FRAME_BATCH, ServerFrameDecoder, isBinarySnapshot } from '../src/binary'

class Wire {
  bytes: number[] = []
  u8(n: number): this { this.bytes.push(n & 255); return this }
  u16(n: number): this { return this.u8(n).u8(n >>> 8) }
  u32(n: number): this { return this.u16(n).u16(n >>> 16) }
  text(s: string): this { const b = new TextEncoder().encode(s); return this.u16(b.length).raw(b) }
  raw(bytes: Iterable<number>): this { this.bytes.push(...bytes); return this }
  done(): Uint8Array { return Uint8Array.from(this.bytes) }
}

type Section = [bit: number, records: Wire[]]
const record = (id: number, mask: number) => new Wire().u32(id).u16(mask)
const robot = (id = 7, nick = 'Pilot', color = '#12abef') => record(id, 0x7ff)
  .u16(-125).u16(250).u16(16384).u16(1000).u16(900).u8(3).u16(0)
  .u16(2).u16(1200).u16(1100).text(nick).text(color)
const self = (presence = 0x3ff, aiRoundsLeft = 3) => {
  const w = new Wire().u16(presence).u32(7).u8(1).u8(2).u32(aiRoundsLeft).u32(4)
  if (presence & 1) w.u8(0)
  if (presence & 2) w.u32(0)
  if (presence & 4) w.u32(0)
  if (presence & 8) w.u8(0)
  if (presence & 16) w.u8(0)
  if (presence & 32) w.u32(0)
  if (presence & 64) w.u32(0).u8(5).raw([0, 1, 2, 3, 10])
  if (presence & 128) w.u32(0)
  if (presence & 256) w.u32(0)
  if (presence & 512) w.u32(0)
  return w
}

function snapshot({ tick = 10, baseTick = 0, flags = 1, ackSeq = 42, phase = 2, timeLeftS = 480, sections = [], privateState, radius }: {
  tick?: number; baseTick?: number; flags?: number; ackSeq?: number; phase?: number; timeLeftS?: number
  sections?: Section[]; privateState?: Wire; radius?: number
} = {}): Uint8Array {
  const mask = sections.reduce((m, [bit]) => m | (1 << bit), 0)
  const w = new Wire().u8(4).u8(1).u8(flags).u32(tick).u32(baseTick).u32(ackSeq).u8(phase).u32(timeLeftS).u16(mask)
  for (const [, records] of [...sections].sort(([a], [b]) => a - b)) {
    w.u16(records.length)
    for (const r of records) w.raw(r.bytes)
  }
  if (privateState) w.raw(privateState.bytes)
  if (radius !== undefined) w.u16(radius)
  return w.done()
}

function batch(...children: Uint8Array[]): Uint8Array {
  const w = new Wire().u8(5).u8(1).u16(children.length)
  for (const c of children) w.u32(c.length).raw(c)
  return w.done()
}

function legacy(msg: ServerMsg): Uint8Array {
  const body = toBinary(ServerMsgSchema, msg)
  const out = new Uint8Array(body.length + 1)
  out[0] = 3
  out.set(body, 1)
  return out
}
function controlWithLength(length: number): Uint8Array {
  const message = create(ServerMsgSchema, { payload: { case: 'event', value: create(ServerEventSchema, {
    kind: { case: 'say', value: create(EvSaySchema, { text: 'x'.repeat(length) }) },
  }) } })
  const overhead = legacy(message).length - length
  if (message.payload.case !== 'event' || message.payload.value.kind.case !== 'say') throw new Error('Expected say')
  message.payload.value.kind.value.text = 'x'.repeat(length - overhead)
  const bytes = legacy(message)
  expect(bytes.length).toBe(length)
  return bytes
}
const bootstrap = () => legacy(create(ServerMsgSchema, { payload: { case: 'event', value: create(ServerEventSchema, {
  kind: { case: 'mapBootstrap', value: create(EvMapBootstrapSchema) },
}) } }))
const legacyFull = () => legacy(create(ServerMsgSchema, { payload: { case: 'snapshot', value: create(SnapshotDeltaSchema, {
  tick: 15, full: true,
}) } }))
function decoded(decoder: ServerFrameDecoder, data: Uint8Array): SnapshotDelta {
  const out = decoder.decode(data)
  expect(out).toHaveLength(1)
  const msg = out[0]!
  expect(msg.$typeName).toBe('omb.v1.ServerMsg')
  if (msg.payload.case !== 'snapshot') throw new Error('Expected snapshot')
  return msg.payload.value
}
function patch(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const result = bytes.slice(); result[offset] = value; return result
}
const full = () => snapshot({ sections: [[0, [robot()]]] })
const delta = (tick = 11, baseTick = 10) => snapshot({ tick, baseTick, flags: 0, sections: [[0, [record(7, 1).u16(0).u16(-1)]]] })

// This vector is deliberately built independently of the production decoder.
export const BINARY_GOLDEN_HEX = '040107640000000000000007000000012c0100005505010001000000ff0783fffa000040e80300000500000000b00400000300426f740400236162630100020000000f00000038ff00c001000000040023616263010003000000030000000000f6ffffff0100040000001f0064009cff0000000000000000000100050000000700c80038ff0100000100060000000300f3ff0d002a000000ff03010000000102030000000400000000000000000a000000000300000000050000000500010a0002140000000000000009000000d007'
const golden = () => snapshot({ flags: 7, sections: [
  [0, [robot()]], [2, [record(8, 15).u16(0).u16(-1).u16(32768).u32(7).text('#12abef')]],
  [4, [record(9, 3).u16(100).u16(-200).u32(25)]],
  [6, [record(10, 31).u16(300).u16(400).u8(1).u32(7).u16(80).u16(30)]],
  [8, [record(11, 7).u16(500).u16(600).u8(0).u16(5)]],
  [10, [record(12, 3).u16(-700).u16(800).u32(99)]],
], privateState: self(), radius: 1234 })

describe('binary v1 decoder', () => {
  it('exports negotiated constants and accepts offset Uint8Array views', () => {
    expect([BINARY_SUBPROTOCOL, FRAME_SNAPSHOT, FRAME_BATCH]).toEqual(['omb.binary.v1', 4, 5])
    const bytes = full(); const padded = new Uint8Array(bytes.length + 4); padded.set(bytes, 2)
    expect(decoded(new ServerFrameDecoder(), padded.subarray(2, -2)).robots[0]?.nick).toBe('Pilot')
  })

  it('decodes warmup 86400 seconds and the complete u32 time range without clamping', () => {
    const d = new ServerFrameDecoder()
    const warmup = snapshot({ phase: 0, timeLeftS: 86400, sections: [[0, [robot()]]] })
    expect(new DataView(warmup.buffer).getUint32(16, true)).toBe(86400)
    expect(new DataView(warmup.buffer).getUint16(20, true)).toBe(1)
    expect(decoded(d, warmup)).toMatchObject({ timeLeftS: 86400, robots: [{ nick: 'Pilot' }] })
    expect(decoded(d, snapshot({ tick: 11, baseTick: 10, flags: 0, timeLeftS: 0xffffffff })).timeLeftS).toBe(0xffffffff)
    expect(decoded(d, snapshot({ tick: 12, baseTick: 11, flags: 0, timeLeftS: 0 })).timeLeftS).toBe(0)
  })

  it('decodes self AI round quotas 65536 and the complete u32 range without shifting optional fields', () => {
    const d = new ServerFrameDecoder()
    for (const [index, rounds] of [65536, 0xffffffff, 0].entries()) {
      const s = decoded(d, snapshot({ tick: 10 + index, baseTick: 9 + index, flags: index === 0 ? 7 : 6,
        privateState: self(0x3ff, rounds), radius: 1234 }))
      expect(s.self).toMatchObject({ aiRoundsLeft: rounds, aiTokensLeftK: 4, assistOn: false,
        inputGeneration: 0, upgrade: { points: 0, levels: [0, 1, 2, 3, 10] } })
      expect(s.visionRadius).toBe(12.34)
    }
  })

  it('matches Go goldenSnapshot and the shared fixture including f32 heading and negative half rounding', () => {
    const fixture = readFileSync(new URL('../../../server/internal/wire/testdata/snapshot-v1.hex', import.meta.url), 'utf8').replace(/\s/g, '')
    expect(fixture).toBe(BINARY_GOLDEN_HEX)
    const cm = (n: number) => Math.sign(n) * Math.floor(Math.abs(n * 100) + 0.5)
    const heading = (n: number) => Math.round(((Math.fround(n) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) * 65536 / (2 * Math.PI)) % 65536
    const bytes = snapshot({ tick: 100, ackSeq: 7, phase: 1, timeLeftS: 300, flags: 7, sections: [
      [0, [record(1, 0x7ff).u16(-125).u16(250).u16(heading(Math.PI / 2)).u16(1000).u16(0).u8(5).u16(0)
        .u16(0).u16(1200).u16(0).text('Bot').text('#abc')]],
      [2, [record(2, 15).u16(0).u16(-200).u16(heading(-Math.PI / 2)).u32(1).text('#abc')]],
      [4, [record(3, 3).u16(0).u16(0).u32(-10)]],
      [6, [record(4, 31).u16(100).u16(-100).u8(0).u32(0).u16(0).u16(0)]],
      [8, [record(5, 7).u16(200).u16(-200).u8(1).u16(0)]],
      [10, [record(6, 3).u16(cm(-0.125)).u16(cm(0.125)).u32(42)]],
    ], privateState: new Wire().u16(0x3ff).u32(1).u8(1).u8(2).u32(3).u32(4)
      .u8(0).u32(0).u32(10).u8(0).u8(3).u32(0).u32(5).u8(5).raw([0, 1, 10, 0, 2]).u32(20).u32(0).u32(9), radius: 2000 })
    expect(Buffer.from(bytes).toString('hex')).toBe(fixture)
    const s = decoded(new ServerFrameDecoder(), Buffer.from(fixture, 'hex'))
    expect(s).toMatchObject({ tick: 100, ackSeq: 7, phase: 1, timeLeftS: 300, full: true, visionRadius: 20 })
    expect(s.robots[0]).toMatchObject({ nick: 'Bot', color: '#abc', hpX10: 1000, energyX10: 0, shieldOn: true, dead: true,
      invulnS: 0, maxHpX10: 1200, maxEnergyX10: 0, base: { heading: Math.fround(Math.PI / 2) } })
    expect(s.projectiles[0]?.base?.heading).toBe(Math.fround(3 * Math.PI / 2))
    expect(s.cores[0]?.value).toBe(-10)
    expect(s.pointDrops[0]?.base?.pos).toMatchObject({ x: -0.13, y: 0.13 })
    expect(s.self).toMatchObject({ inputGeneration: 9, assistOn: false, fireReadyTick: 10, abilitySrc: 3,
      shieldReadyTick: 20, shieldStartedTick: 0, upgrade: { points: 5, levels: [0, 1, 10, 0, 2] } })
    expect(s.mapJson).toBeUndefined()
  })

  it('decodes every entity kind into typed protobuf shapes', () => {
    const snap = decoded(new ServerFrameDecoder(), golden())
    expect(isBinarySnapshot(snap)).toBe(true)
    expect(snap).toMatchObject({ $typeName: 'omb.v1.SnapshotDelta', tick: 10, baseTick: 0,
      ackSeq: 42, phase: 2, timeLeftS: 480, full: true, visionRadius: 12.34 })
    expect(snap.robots[0]).toEqual({ $typeName: 'omb.v1.RobotState',
      base: { $typeName: 'omb.v1.EntityBase', id: 7, pos: { $typeName: 'omb.v1.Vec2', x: -1.25, y: 2.5 }, heading: Math.fround(Math.PI / 2) },
      hpX10: 1000, energyX10: 900, shieldOn: true, dashing: true, dead: false,
      respawnInS: 0, invulnS: 2, maxHpX10: 1200, maxEnergyX10: 1100, nick: 'Pilot', color: '#12abef', isPartner: false })
    expect(snap.projectiles[0]).toMatchObject({ $typeName: 'omb.v1.ProjectileState', ownerId: 7, color: '#12abef',
      base: { id: 8, heading: Math.fround(Math.PI), pos: { x: 0, y: -0.01 } } })
    expect(snap.cores[0]).toMatchObject({ $typeName: 'omb.v1.CoreState', value: 25, base: { id: 9, heading: 0 } })
    expect(snap.uplinks[0]).toMatchObject({ $typeName: 'omb.v1.UplinkState', ready: true, hackingId: 7, progressX10: 80, myCooldownS: 30 })
    expect(snap.healthPacks[0]).toMatchObject({ $typeName: 'omb.v1.HealthPackState', available: false, respawnInS: 5 })
    expect(snap.pointDrops[0]).toMatchObject({ $typeName: 'omb.v1.PointDropState', points: 99 })
    expect(snap.mapJson).toBeUndefined()
    expect(snap.robotGone).toEqual([])
    expect(toBinary(SnapshotDeltaSchema, snap).length).toBeGreaterThan(0)
  })

  it('hydrates sparse updates, preserves optional metadata and explicit zero', () => {
    const d = new ServerFrameDecoder(); decoded(d, full())
    const s = decoded(d, snapshot({ tick: 11, baseTick: 10, flags: 0, sections: [[0, [
      record(7, 0x1fc).u16(0).u16(0).u8(0).u16(0).u16(0).u16(0).u16(0),
    ]]] }))
    expect(s.robots[0]).toMatchObject({ hpX10: 0, energyX10: 0, shieldOn: false, dashing: false, dead: false,
      invulnS: 0, maxHpX10: 0, maxEnergyX10: 0, nick: 'Pilot', color: '#12abef', base: { pos: { x: -1.25, y: 2.5 } } })
    const next = decoded(d, delta(12, 11)).robots[0]!
    expect(next.nick).toBe('Pilot')
    expect(next.hpX10).toBe(0)
    expect(next.base?.pos).toMatchObject({ x: 0, y: -0.01 })
  })

  it('leaves never-known optionals absent and accepts required fields set to zero', () => {
    const s = decoded(new ServerFrameDecoder(), snapshot({ sections: [[0, [record(0, 0x63f)
      .u16(0).u16(0).u16(0).u16(0).u16(0).u8(0).u16(0).text('').text('')]]] }))
    expect(s.robots[0]).toMatchObject({ nick: '', color: '', hpX10: 0, isPartner: false })
    expect(s.robots[0]?.invulnS).toBeUndefined()
    expect(s.robots[0]?.maxHpX10).toBeUndefined()
    expect(s.robots[0]?.maxEnergyX10).toBeUndefined()
  })

  it('hydrates all entity kinds and removes gone entity baselines', () => {
    const d = new ServerFrameDecoder(); decoded(d, golden())
    const s = decoded(d, snapshot({ tick: 11, baseTick: 10, flags: 0, sections: [
      [1, [new Wire().u32(7)]], [2, [record(8, 1).u16(1).u16(2)]],
      [4, [record(9, 2).u32(0)]], [6, [record(10, 2).u8(0)]],
      [8, [record(11, 2).u8(1)]], [10, [record(12, 2).u32(0)]],
    ] }))
    expect(s.robotGone).toEqual([7])
    expect(s.projectiles[0]).toMatchObject({ ownerId: 7, color: '#12abef', base: { heading: Math.fround(Math.PI) } })
    expect(s.cores[0]).toMatchObject({ value: 0, base: { pos: { x: 1, y: -2 } } })
    expect(s.uplinks[0]).toMatchObject({ ready: false, hackingId: 7, progressX10: 80 })
    expect(s.healthPacks[0]).toMatchObject({ available: true, respawnInS: 5 })
    expect(s.pointDrops[0]).toMatchObject({ points: 0, base: { pos: { x: -7, y: 8 } } })
    expect(d.decode(delta(12, 11))).toEqual([])
    expect(decoded(d, snapshot({ tick: 12, baseTick: 11, flags: 0, sections: [[0, [robot(7, 'New')]]] })).robots[0]?.nick).toBe('New')
  })

  it('preserves self zero fields and generation while retaining sparse self/radius delivery', () => {
    const d = new ServerFrameDecoder(); const a = decoded(d, golden())
    expect(a.self).toEqual({ $typeName: 'omb.v1.SelfState', robotId: 7, moveSrc: 1, turretSrc: 2, aiRoundsLeft: 3, aiTokensLeftK: 4,
      assistOn: false, dashReadyTick: 0, fireReadyTick: 0, fireSrc: 0, abilitySrc: 0, manualAxesMask: 0,
      upgrade: { $typeName: 'omb.v1.UpgradeSelf', points: 0, levels: [0, 1, 2, 3, 10] },
      shieldReadyTick: 0, shieldStartedTick: 0, inputGeneration: 0 })
    const b = decoded(d, snapshot({ tick: 11, baseTick: 10, flags: 0 }))
    expect(b.self).toBeUndefined()
    expect(b.visionRadius).toBeUndefined()
    const c = decoded(d, snapshot({ tick: 12, baseTick: 11, flags: 2, privateState: self(0) }))
    expect(c.self?.inputGeneration).toBeUndefined()
    expect(c.self?.upgrade).toBeUndefined()
    decoded(d, snapshot({ tick: 20 }))
    const spectator = decoded(d, snapshot({ tick: 21, baseTick: 20, flags: 0 }))
    expect(spectator.self).toBeUndefined()
    expect(spectator.visionRadius).toBeUndefined()
  })

  it('does not share mutable entity, position, arrays or upgrade metadata with callers or later snapshots', () => {
    const d = new ServerFrameDecoder(); const a = decoded(d, golden())
    const original = structuredClone(a)
    a.robots[0]!.nick = 'MUTATED'; a.robots[0]!.base!.pos!.y = 999
    a.projectiles[0]!.color = 'MUTATED'; a.self!.upgrade!.levels[0] = 10
    a.robotGone.push(123)
    const b = decoded(d, snapshot({ tick: 11, baseTick: 10, flags: 2, privateState: self(),
      sections: [[0, [record(7, 4).u16(0)]], [2, [record(8, 1).u16(1).u16(1)]]] }))
    expect(b.robots[0]?.nick).toBe('Pilot'); expect(b.robots[0]?.base?.pos?.y).toBe(2.5)
    expect(b.projectiles[0]?.color).toBe('#12abef'); expect(b.self).toEqual(original.self)
    expect(b.robotGone).toEqual([])
    const c = decoded(d, snapshot({ tick: 12, baseTick: 11, flags: 2, privateState: self(),
      sections: [[0, [record(7, 1).u16(0).u16(-1)]]] }))
    expect(b.robots[0]?.base?.pos?.x).toBe(-1.25)
    expect(c.robots[0]?.base?.pos?.x).toBe(0)
    expect(c.self).not.toBe(b.self)
    expect(c.self?.upgrade?.levels).not.toBe(b.self?.upgrade?.levels)
  })

  it('returns header-only on gaps and trusts no further deltas until a full snapshot', () => {
    const d = new ServerFrameDecoder(); decoded(d, full())
    const missing = decoded(d, delta(12, 11))
    expect(missing).toMatchObject({ tick: 12, baseTick: 11, robots: [], full: false })
    expect(missing.self).toBeUndefined()
    expect(decoded(d, delta()).robots).toEqual([])
    expect(decoded(d, snapshot({ tick: 13, baseTick: 12, flags: 0 })).robots).toEqual([])
    expect(decoded(d, full()).robots).toHaveLength(1)
    expect(decoded(d, delta()).robots).toHaveLength(1)
    expect(decoded(new ServerFrameDecoder(), delta()).robots).toEqual([])
  })

  it('resets on explicit reset, bootstrap and legacy full, while preserving legacy delivery', () => {
    for (const reset of [(d: ServerFrameDecoder) => d.reset(),
      (d: ServerFrameDecoder) => expect(d.decode(bootstrap())[0]?.payload.case).toBe('event'),
      (d: ServerFrameDecoder) => {
        const old = decoded(d, legacyFull()); expect(old.full).toBe(true); expect(isBinarySnapshot(old)).toBe(false)
      }]) {
      const d = new ServerFrameDecoder(); decoded(d, full()); reset(d)
      expect(decoded(d, delta()).robots).toEqual([])
      decoded(d, full()); expect(decoded(d, delta()).robots[0]?.nick).toBe('Pilot')
    }
    const d = new ServerFrameDecoder()
    expect(d.decode(batch(bootstrap(), full(), delta())).map(m => m.payload.case)).toEqual(['event', 'snapshot', 'snapshot'])
  })

  it('keeps separate decoder connections isolated', () => {
    const a = new ServerFrameDecoder(); const b = new ServerFrameDecoder()
    decoded(a, full()); expect(decoded(b, delta()).robots).toEqual([])
    expect(decoded(a, delta()).robots[0]?.nick).toBe('Pilot')
  })

  it('delivers valid batches in order and commits only a completely valid batch', () => {
    const d = new ServerFrameDecoder()
    const out = d.decode(batch(full(), delta(), snapshot({ tick: 12, baseTick: 11, flags: 0 })))
    expect(out.map(m => m.payload.case === 'snapshot' && m.payload.value.tick)).toEqual([10, 11, 12])
    expect(d.decode(batch(snapshot({ tick: 13, baseTick: 12, flags: 0 }), Uint8Array.of(3, 255)))).toEqual([])
    expect(decoded(d, delta(13, 12)).robots[0]?.nick).toBe('Pilot')
    expect(d.decode(batch(bootstrap(), legacyFull(), Uint8Array.of(4)))).toEqual([])
    expect(decoded(d, delta(14, 13)).robots[0]?.nick).toBe('Pilot')
    expect(d.decode(batch(delta(16, 15), Uint8Array.of(4)))).toEqual([])
    expect(decoded(d, delta(15, 14)).robots).toHaveLength(1)
  })

  it('rejects every truncated compact or batch prefix without changing the baseline', () => {
    const frames = [golden(), Buffer.from(BINARY_GOLDEN_HEX, 'hex'), delta(), batch(full(), delta())]
    for (const bytes of frames) {
      for (let i = 0; i < bytes.length; i++) {
        const d = new ServerFrameDecoder(); decoded(d, full())
        expect(d.decode(bytes.subarray(0, i)), `prefix ${i}/${bytes.length}`).toEqual([])
        expect(decoded(d, delta()).robots[0]?.nick).toBe('Pilot')
      }
    }
  })

  it('rejects unknown versions, flags, sections, masks, invalid booleans and trailing bytes', () => {
    const malformed = [
      patch(full(), 1, 2), patch(full(), 2, 8), patch(full(), 21, 16), patch(full(), 29, 8),
      new Wire().raw(full()).u8(0).done(),
      snapshot({ sections: [[0, [patchWire(robot(), 16, 8)]]] }),
      snapshot({ sections: [[6, [record(1, 31).u16(0).u16(0).u8(2).u32(0).u16(0).u16(0)]]] }),
      snapshot({ sections: [[8, [record(1, 7).u16(0).u16(0).u8(255).u16(0)]]] }),
      snapshot({ flags: 3, privateState: self(1024) }),
      snapshot({ flags: 3, privateState: patchWire(self(1), 16, 2) }),
      snapshot({ flags: 3, privateState: patchWire(self(64), 20, 6) }),
      snapshot({ flags: 3, privateState: patchWire(self(64), 21, 11) }),
    ]
    for (const bytes of malformed) {
      const d = new ServerFrameDecoder(); decoded(d, full())
      expect(d.decode(bytes), Buffer.from(bytes).toString('hex')).toEqual([])
      expect(decoded(d, delta()).robots).toHaveLength(1)
    }
  })

  it('matches Go u8 enum ranges and accepts empty valid protobuf messages', () => {
    const d = new ServerFrameDecoder()
    const privateState = self(24)
    for (const offset of [6, 7, 16, 17]) privateState.bytes[offset] = 255
    const s = decoded(d, snapshot({ phase: 255, flags: 3, privateState }))
    expect(s.phase).toBe(255)
    expect(s.self).toMatchObject({ moveSrc: 255, turretSrc: 255, fireSrc: 255, abilitySrc: 255 })
    expect(d.decode(Uint8Array.of(3))).toEqual([{ $typeName: 'omb.v1.ServerMsg', payload: { case: undefined } }])
  })

  it('validates malformed gap payloads completely without invalidating a good baseline', () => {
    for (const bad of [new Wire().raw(delta(12, 11)).u8(0).done(),
      patch(delta(12, 11), 29, 128),
      snapshot({ tick: 12, baseTick: 11, flags: 2, privateState: self(1024) })]) {
      const d = new ServerFrameDecoder(); decoded(d, full())
      expect(d.decode(bad)).toEqual([])
      expect(decoded(d, delta()).robots[0]?.nick).toBe('Pilot')
    }
  })

  it('removes all tombstone baselines and accepts complete zero-valued reentry metadata', () => {
    const d = new ServerFrameDecoder(); decoded(d, golden())
    const s = decoded(d, snapshot({ tick: 11, baseTick: 10, flags: 0, sections: [
      [1, [new Wire().u32(7)]], [3, [new Wire().u32(8)]], [5, [new Wire().u32(9)]],
      [7, [new Wire().u32(10)]], [9, [new Wire().u32(11)]], [11, [new Wire().u32(12)]],
    ] }))
    expect([s.robotGone, s.projectileGone, s.coreGone, s.uplinkGone, s.healthPackGone, s.pointDropGone])
      .toEqual([[7], [8], [9], [10], [11], [12]])
    for (const [bit, id] of [[0, 7], [2, 8], [4, 9], [6, 10], [8, 11], [10, 12]]) {
      expect(d.decode(snapshot({ tick: 12, baseTick: 11, flags: 0, sections: [[bit!, [record(id!, 0)]]] }))).toEqual([])
    }
    const reentry = decoded(d, snapshot({ tick: 12, baseTick: 11, flags: 0, sections: [[0, [record(7, 0x63f)
      .u16(0).u16(0).u16(0).u16(0).u16(0).u8(0).u16(0).text('').text('')]]] }))
    expect(reentry.robots[0]).toMatchObject({ nick: '', color: '', hpX10: 0 })
    expect(reentry.robots[0]?.invulnS).toBeUndefined()
    expect(reentry.robots[0]?.maxHpX10).toBeUndefined()
  })

  it('keeps earlier batch results independent and rolls back record changes and tombstones', () => {
    const d = new ServerFrameDecoder()
    const out = d.decode(batch(full(), delta()))
    const a = out[0]!.payload; const b = out[1]!.payload
    if (a.case !== 'snapshot' || b.case !== 'snapshot') throw new Error('Expected snapshots')
    expect(a.value.robots[0]?.base?.pos?.x).toBe(-1.25)
    b.value.robots[0]!.base!.pos!.x = 100
    a.value.robots[0]!.nick = 'mutated'
    const bad = snapshot({ tick: 12, baseTick: 11, flags: 0, sections: [
      [0, [record(7, 512).text('uncommitted')]], [1, [new Wire().u32(7)]],
    ] })
    expect(d.decode(batch(bad, Uint8Array.of(4)))).toEqual([])
    const after = decoded(d, snapshot({ tick: 12, baseTick: 11, flags: 0, sections: [[0, [record(7, 4).u16(1)]]] }))
    expect(after.robots[0]?.nick).toBe('Pilot')
    expect(after.robots[0]?.base?.pos).toMatchObject({ x: 0, y: -0.01 })
  })

  it('bounds strings by byte length and accepts exactly the maximum frame length', () => {
    const oversized = robot(7, 'x'.repeat(65536 - 60))
    const exact = snapshot({ sections: [[0, [oversized]]] })
    expect(exact.length).toBe(65536)
    expect(decoded(new ServerFrameDecoder(), exact).robots[0]?.nick.length).toBe(65536 - 60)
    const tooLong = new Wire().raw(exact).u8(0).done()
    expect(new ServerFrameDecoder().decode(tooLong)).toEqual([])
    expect(new ServerFrameDecoder().decode(patch(patch(full(), 49, 255), 50, 255))).toEqual([])
  })

  it('validates UTF-8 strictly without swallowing BOM or embedded NUL', () => {
    const d = new ServerFrameDecoder()
    for (const invalid of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xff]]) {
      const badRobot = record(7, 0x63f).u16(0).u16(0).u16(0).u16(0).u16(0).u8(0).u16(0)
        .u16(invalid.length).raw(invalid).text('')
      expect(d.decode(snapshot({ sections: [[0, [badRobot]]] }))).toEqual([])
    }
    const s = decoded(d, snapshot({ sections: [[0, [robot(7, '\ufeffA\0\u{1f916}')]]] }))
    expect(s.robots[0]?.nick).toBe('\ufeffA\0\u{1f916}')
  })

  it('rejects missing first-sight required fields, including after full reset', () => {
    for (const [bit, r] of [[0, record(7, 1).u16(0).u16(0)], [2, record(8, 1).u16(0).u16(0)],
      [4, record(9, 1).u16(0).u16(0)], [6, record(10, 1).u16(0).u16(0)],
      [8, record(11, 1).u16(0).u16(0)], [10, record(12, 1).u16(0).u16(0)]] as const) {
      const d = new ServerFrameDecoder(); decoded(d, golden())
      expect(d.decode(snapshot({ tick: 20, sections: [[bit, [r]]] }))).toEqual([])
      expect(decoded(d, delta()).robots).toHaveLength(1)
    }
  })

  it('enforces frame, record and batch bounds and child type restrictions', () => {
    const malformed = [new Uint8Array(65537), Uint8Array.of(3, 255), Uint8Array.of(0), Uint8Array.of(2),
      batch(batch(full())), batch(Uint8Array.of(0)), batch(Uint8Array.of(1)), batch(new Uint8Array()),
      patch(batch(full()), 1, 2), patch(batch(full()), 2, 65),
      new Wire().u8(5).u8(1).u16(1).u32(0xffffffff).done(),
      new Wire().raw(snapshot({ sections: [[0, []]] }).subarray(0, 22)).u16(65535).done(),
      new Wire().raw(batch(full())).u8(0).done()]
    for (const bytes of malformed) expect(new ServerFrameDecoder().decode(bytes)).toEqual([])
    expect(new ServerFrameDecoder().decode(batch(...Array.from({ length: 64 }, () => snapshot())))).toHaveLength(64)
  })

  it('accepts reliable standalone script history larger than 64 KiB without resetting compact state', () => {
    const d = new ServerFrameDecoder(); decoded(d, full())
    const message = create(ServerMsgSchema, { payload: { case: 'event', value: {
      kind: { case: 'scriptVersions', value: { currentId: 32,
        versions: Array.from({ length: 32 }, (_, i) => ({ id: i + 1, source: 'x'.repeat(4096) })) } },
    } } })
    const bytes = legacy(message)
    expect(bytes.length).toBeGreaterThan(65536)
    expect(d.decode(bytes)).toEqual([message])
    expect(decoded(d, delta()).robots[0]?.nick).toBe('Pilot')
  })

  it('preserves legacy acceptance of standalone controls larger than 8 MiB', () => {
    const d = new ServerFrameDecoder(); decoded(d, full())
    const bytes = controlWithLength(8 * 1024 * 1024 + 1)
    const accepted = d.decode(bytes)
    expect(accepted).toHaveLength(1)
    const payload = accepted[0]!.payload
    if (payload.case !== 'event' || payload.value.kind.case !== 'say') throw new Error('Expected say')
    expect(payload.value.kind.value.text.length).toBeGreaterThan(8 * 1024 * 1024 - 32)
    const malformed = new Uint8Array(bytes.length + 1)
    malformed.set(bytes)
    malformed[bytes.length] = 255
    expect(d.decode(malformed)).toEqual([])
    expect(decoded(d, delta()).robots[0]?.nick).toBe('Pilot')
  })

  it('keeps compact and batch caps at 64 KiB and malformed mixed batches atomic', () => {
    const control = controlWithLength(65536)
    const d = new ServerFrameDecoder(); decoded(d, full())
    expect(d.decode(control)).toHaveLength(1)
    expect(d.decode(batch(bootstrap(), control))).toEqual([])
    expect(d.decode(patch(control, 0, 4))).toEqual([])
    expect(d.decode(patch(controlWithLength(65537), 0, 4))).toEqual([])
    const smallControl = controlWithLength(4096)
    expect(d.decode(batch(delta(), smallControl, Uint8Array.of(3, 255)))).toEqual([])
    expect(decoded(d, delta()).robots[0]?.nick).toBe('Pilot')
    expect(d.decode(batch(bootstrap(), smallControl, Uint8Array.of(4)))).toEqual([])
    expect(decoded(d, delta(12, 11)).robots[0]?.nick).toBe('Pilot')
  })

  it('accepts finite signed wire limits without interpreting fixed-point bytes as floats', () => {
    const s = decoded(new ServerFrameDecoder(), snapshot({ sections: [[0, [record(0xffffffff, 0x63f)
      .u16(-32768).u16(32767).u16(65535).u16(-32768).u16(32767).u8(7).u16(65535).text('').text('')]],
      [4, [record(1, 3).u16(0).u16(0).u32(-2147483648)]],
      [10, [record(2, 3).u16(0).u16(0).u32(2147483647)]]] }))
    expect(s.robots[0]).toMatchObject({ hpX10: -32768, energyX10: 32767, respawnInS: 65535,
      base: { id: 0xffffffff, pos: { x: -327.68, y: 327.67 } } })
    expect(s.robots[0]?.base?.heading).toBeLessThan(2 * Math.PI)
    expect(s.cores[0]?.value).toBe(-2147483648)
    expect(s.pointDrops[0]?.points).toBe(2147483647)
  })

  it('carries no JSON and shows sparse motion wire size against protobuf', () => {
    const d = new ServerFrameDecoder(); decoded(d, golden())
    const compact = delta(); const s = decoded(d, compact)
    const protobuf = legacy(create(ServerMsgSchema, { payload: { case: 'snapshot', value: s } }))
    expect(compact.length).toBe(34)
    expect(compact.length).toBeLessThan(protobuf.length)
    expect(s.mapJson).toBeUndefined()
    const source = readFileSync(new URL('../src/binary/snapshot.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\b(?:create|fromBinary|JSON\.parse|JSON\.stringify)\s*\(/)
  })

  it.each([1, 32, 256])('measures compact full and sparse motion size for %i robots', count => {
    const d = new ServerFrameDecoder()
    const initial = snapshot({ sections: [[0, Array.from({ length: count }, (_, i) => robot(i + 1))]] })
    const fullSnapshot = decoded(d, initial)
    const motion = snapshot({ tick: 11, baseTick: 10, flags: 0, sections: [[0,
      Array.from({ length: count }, (_, i) => record(i + 1, 1).u16(1).u16(2))]] })
    const update = decoded(d, motion)
    const legacySize = (s: SnapshotDelta) => legacy(create(ServerMsgSchema, { payload: { case: 'snapshot', value: s } })).length
    // The existing producer omits moving-robot metadata in protobuf deltas too.
    const legacyMotion = { ...update, robots: update.robots.map(r => ({ ...r, nick: '', color: '' })) }
    expect(initial.length).toBe(24 + 41 * count)
    expect(motion.length).toBe(24 + 10 * count)
    expect(initial.length).toBeLessThan(legacySize(fullSnapshot))
    expect(motion.length).toBeLessThan(legacySize(legacyMotion) * 0.6)
    console.info(`binary size (${count} robots): full ${initial.length}/${legacySize(fullSnapshot)} B, motion ${motion.length}/${legacySize(legacyMotion)} B (compact/protobuf)`)
  })
})

function patchWire(w: Wire, offset: number, value: number): Wire { return new Wire().raw(patch(w.done(), offset, value)) }
