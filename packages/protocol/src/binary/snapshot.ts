import type { ControlSource, Phase, SelfState, SnapshotDelta } from '../gen/proto/omb_pb'
import {
  coreCodec, healthPackCodec, pointDropCodec, projectileCodec, readEntities, readGone, robotCodec, uplinkCodec,
} from './entities'
import { invalid, Reader } from './reader'
import { copySelf, emptyBaseline, type Baseline } from './state'

function source(r: Reader): ControlSource {
  return r.u8() as ControlSource
}

function readSelf(r: Reader): SelfState {
  const presence = r.u16()
  if (presence & ~0x3ff) invalid()
  const self: SelfState = { $typeName: 'omb.v1.SelfState', robotId: r.u32(), moveSrc: source(r),
    turretSrc: source(r), aiRoundsLeft: r.u32(), aiTokensLeftK: r.u32() }
  if (presence & 1) self.assistOn = r.bool()
  if (presence & 2) self.dashReadyTick = r.u32()
  if (presence & 4) self.fireReadyTick = r.u32()
  if (presence & 8) self.fireSrc = source(r)
  if (presence & 16) self.abilitySrc = source(r)
  if (presence & 32) self.manualAxesMask = r.u32()
  if (presence & 64) {
    const points = r.u32()
    const count = r.u8()
    if (count > 5) invalid()
    const levels: number[] = []
    for (let i = 0; i < count; i++) {
      const level = r.u8()
      if (level > 10) invalid()
      levels.push(level)
    }
    self.upgrade = { $typeName: 'omb.v1.UpgradeSelf', points, levels }
  }
  if (presence & 128) self.shieldReadyTick = r.u32()
  if (presence & 256) self.shieldStartedTick = r.u32()
  if (presence & 512) self.inputGeneration = r.u32()
  return self
}

export function readSnapshot(r: Reader, previous: Baseline): { snapshot: SnapshotDelta; state: Baseline } {
  if (r.u8() !== 1) invalid()
  const flags = r.u8()
  if (flags & ~7) invalid()
  const snapshot: SnapshotDelta = { $typeName: 'omb.v1.SnapshotDelta', full: !!(flags & 1),
    tick: r.u32(), baseTick: r.u32(), ackSeq: r.u32(), phase: r.u8() as Phase, timeLeftS: r.u32(),
    robots: [], robotGone: [], projectiles: [], projectileGone: [], cores: [], coreGone: [],
    uplinks: [], uplinkGone: [], healthPacks: [], healthPackGone: [], pointDrops: [], pointDropGone: [] }
  const sections = r.u16()
  if (sections & ~0xfff) invalid()
  const state = snapshot.full ? emptyBaseline() : previous
  const usable = snapshot.full || state.trusted && state.tick === snapshot.baseTick

  if (sections & 1) readEntities(r, state.robots, snapshot.robots, robotCodec, usable)
  if (sections & 2) readGone(r, state.robots, snapshot.robotGone, usable)
  if (sections & 4) readEntities(r, state.projectiles, snapshot.projectiles, projectileCodec, usable)
  if (sections & 8) readGone(r, state.projectiles, snapshot.projectileGone, usable)
  if (sections & 16) readEntities(r, state.cores, snapshot.cores, coreCodec, usable)
  if (sections & 32) readGone(r, state.cores, snapshot.coreGone, usable)
  if (sections & 64) readEntities(r, state.uplinks, snapshot.uplinks, uplinkCodec, usable)
  if (sections & 128) readGone(r, state.uplinks, snapshot.uplinkGone, usable)
  if (sections & 256) readEntities(r, state.healthPacks, snapshot.healthPacks, healthPackCodec, usable)
  if (sections & 512) readGone(r, state.healthPacks, snapshot.healthPackGone, usable)
  if (sections & 1024) readEntities(r, state.pointDrops, snapshot.pointDrops, pointDropCodec, usable)
  if (sections & 2048) readGone(r, state.pointDrops, snapshot.pointDropGone, usable)

  const self = flags & 2 ? readSelf(r) : undefined
  const radius = flags & 4 ? r.u16() / 100 : undefined
  r.end()
  if (usable) {
    if (flags & 2) {
      state.self = self
      snapshot.self = copySelf(self)
    }
    if (flags & 4) {
      state.visionRadius = radius
      snapshot.visionRadius = radius
    }
    state.tick = snapshot.tick
    state.trusted = true
  } else {
    // A syntactically valid gap requests resync without applying any payload.
    // Even a later delta matching the old tick cannot make this baseline safe.
    state.trusted = false
  }
  return { snapshot, state }
}
