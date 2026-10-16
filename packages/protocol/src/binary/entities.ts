import type {
  CoreState, EntityBase, HealthPackState, PointDropState, ProjectileState,
  RobotState, UplinkState,
} from '../gen/proto/omb_pb'
import { invalid, Reader } from './reader'
import { copyEntity, entityBase, type Entity } from './state'

interface EntityCodec<T extends Entity> {
  mask: number
  required: number
  empty(id: number): T
  read(reader: Reader, entity: T, mask: number): void
}

function position(reader: Reader, base: EntityBase): void {
  base.pos = { $typeName: 'omb.v1.Vec2', x: reader.i16() / 100, y: reader.i16() / 100 }
}

function heading(reader: Reader, base: EntityBase): void {
  // EntityBase.heading is protobuf float, matching Go's float32 result.
  base.heading = Math.fround(reader.u16() * 2 * Math.PI / 65536)
}

export const robotCodec: EntityCodec<RobotState> = {
  mask: 0x7ff, required: 0x63f,
  empty: id => ({ $typeName: 'omb.v1.RobotState', base: entityBase(id), hpX10: 0, energyX10: 0,
    shieldOn: false, dashing: false, dead: false, respawnInS: 0, nick: '', color: '', isPartner: false }),
  read(r, entity, mask) {
    if (mask & 1) position(r, entity.base!)
    if (mask & 2) heading(r, entity.base!)
    if (mask & 4) entity.hpX10 = r.i16()
    if (mask & 8) entity.energyX10 = r.i16()
    if (mask & 16) {
      const flags = r.u8()
      if (flags & ~7) invalid()
      entity.shieldOn = !!(flags & 1)
      entity.dashing = !!(flags & 2)
      entity.dead = !!(flags & 4)
    }
    if (mask & 32) entity.respawnInS = r.u16()
    if (mask & 64) entity.invulnS = r.u16()
    if (mask & 128) entity.maxHpX10 = r.i16()
    if (mask & 256) entity.maxEnergyX10 = r.i16()
    if (mask & 512) entity.nick = r.string()
    if (mask & 1024) entity.color = r.string()
  },
}

export const projectileCodec: EntityCodec<ProjectileState> = {
  mask: 15, required: 15,
  empty: id => ({ $typeName: 'omb.v1.ProjectileState', base: entityBase(id), ownerId: 0, color: '' }),
  read(r, entity, mask) {
    if (mask & 1) position(r, entity.base!)
    if (mask & 2) heading(r, entity.base!)
    if (mask & 4) entity.ownerId = r.u32()
    if (mask & 8) entity.color = r.string()
  },
}

export const coreCodec: EntityCodec<CoreState> = {
  mask: 3, required: 3,
  empty: id => ({ $typeName: 'omb.v1.CoreState', base: entityBase(id), value: 0 }),
  read(r, entity, mask) {
    if (mask & 1) position(r, entity.base!)
    if (mask & 2) entity.value = r.i32()
  },
}

export const uplinkCodec: EntityCodec<UplinkState> = {
  mask: 31, required: 31,
  empty: id => ({ $typeName: 'omb.v1.UplinkState', base: entityBase(id), ready: false,
    hackingId: 0, progressX10: 0, myCooldownS: 0 }),
  read(r, entity, mask) {
    if (mask & 1) position(r, entity.base!)
    if (mask & 2) entity.ready = r.bool()
    if (mask & 4) entity.hackingId = r.u32()
    if (mask & 8) entity.progressX10 = r.i16()
    if (mask & 16) entity.myCooldownS = r.u16()
  },
}

export const healthPackCodec: EntityCodec<HealthPackState> = {
  mask: 7, required: 7,
  empty: id => ({ $typeName: 'omb.v1.HealthPackState', base: entityBase(id), available: false, respawnInS: 0 }),
  read(r, entity, mask) {
    if (mask & 1) position(r, entity.base!)
    if (mask & 2) entity.available = r.bool()
    if (mask & 4) entity.respawnInS = r.u16()
  },
}

export const pointDropCodec: EntityCodec<PointDropState> = {
  mask: 3, required: 3,
  empty: id => ({ $typeName: 'omb.v1.PointDropState', base: entityBase(id), points: 0 }),
  read(r, entity, mask) {
    if (mask & 1) position(r, entity.base!)
    if (mask & 2) entity.points = r.i32()
  },
}

export function readEntities<T extends Entity>(r: Reader, table: Map<number, T>, out: T[], codec: EntityCodec<T>, usable: boolean): void {
  const count = r.count(6)
  for (let i = 0; i < count; i++) {
    const id = r.u32()
    const mask = r.u16()
    if (mask & ~codec.mask) invalid()
    const previous = usable ? table.get(id) : undefined
    if (usable && !previous && (mask & codec.required) !== codec.required) invalid()
    const entity = previous ? copyEntity(previous) : codec.empty(id)
    codec.read(r, entity, mask)
    if (usable) {
      table.set(id, entity)
      out.push(copyEntity(entity))
    }
  }
}

export function readGone<T extends Entity>(r: Reader, table: Map<number, T>, out: number[], usable: boolean): void {
  const count = r.count(4)
  for (let i = 0; i < count; i++) {
    const id = r.u32()
    if (usable) {
      table.delete(id)
      out.push(id)
    }
  }
}
