import type {
  CoreState, EntityBase, HealthPackState, PointDropState, ProjectileState,
  RobotState, SelfState, UplinkState,
} from '../gen/proto/omb_pb'

export type Entity = RobotState | ProjectileState | CoreState | UplinkState | HealthPackState | PointDropState

export interface Baseline {
  tick?: number
  trusted: boolean
  robots: Map<number, RobotState>
  projectiles: Map<number, ProjectileState>
  cores: Map<number, CoreState>
  uplinks: Map<number, UplinkState>
  healthPacks: Map<number, HealthPackState>
  pointDrops: Map<number, PointDropState>
  self?: SelfState
  visionRadius?: number
}

export function emptyBaseline(): Baseline {
  return { trusted: false, robots: new Map(), projectiles: new Map(), cores: new Map(),
    uplinks: new Map(), healthPacks: new Map(), pointDrops: new Map() }
}

export function copyBaseline(state: Baseline): Baseline {
  // Records are immutable once stored. Only map membership is transactional;
  // changed records and published messages receive their own nested objects.
  return { ...state, robots: new Map(state.robots), projectiles: new Map(state.projectiles),
    cores: new Map(state.cores), uplinks: new Map(state.uplinks),
    healthPacks: new Map(state.healthPacks), pointDrops: new Map(state.pointDrops) }
}

export function entityBase(id: number): EntityBase {
  return { $typeName: 'omb.v1.EntityBase', id, heading: 0, pos: { $typeName: 'omb.v1.Vec2', x: 0, y: 0 } }
}

export function copyEntity<T extends Entity>(entity: T): T {
  return { ...entity, base: entity.base && { ...entity.base, pos: entity.base.pos && { ...entity.base.pos } } }
}

export function copySelf(self: SelfState | undefined): SelfState | undefined {
  return self && { ...self, upgrade: self.upgrade && { ...self.upgrade, levels: [...self.upgrade.levels] } }
}
