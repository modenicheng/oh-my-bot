// 快照消费：decodeServer 后的 SnapshotDelta 合并进本地实体表。
// full=true 重建；delta 按 id 合并；*_gone 为墓碑删除；base_tick 断链 → 请求方发 ResyncRequest。
import {
  ResyncRequestSchema, ClientMsgSchema,
  type ServerMsg, type SnapshotDelta, type SelfState,
  type RobotState, type ProjectileState, type CoreState, type UplinkState, type HealthPackState, type SimTuning,
} from '@omb/protocol'
import { create } from '@bufbuild/protobuf'
import { encodeClient } from '@omb/protocol'
import { FALLBACK_TUNING, invulnWindowMs } from './tuning'

export interface RobotEnt extends RobotState {
  /** 本地渲染帧时间戳（无敌闪烁等动画用） */
  seenAt: number
  /** 无敌显示截止（ms）：优先使用权威 invuln_s；旧服务器缺失时以 dead→alive 近似。 */
  invulnUntil?: number
}
export interface ProjEnt extends ProjectileState { seenAt: number }
export interface CoreEnt extends CoreState { seenAt: number }
export interface UplinkEnt extends UplinkState { seenAt: number }
export interface HealthPackEnt extends HealthPackState { seenAt: number }

export interface WorldState {
  tick: number
  initialized: boolean
  phase: number
  timeLeftS: number
  self?: SelfState
  robots: Map<number, RobotEnt>
  projectiles: Map<number, ProjEnt>
  cores: Map<number, CoreEnt>
  healthPacks: Map<number, HealthPackEnt>
  uplinks: Map<number, UplinkEnt>
  /** 最近 ack 的 input seq（服务器确认到哪） */
  ackSeq: number
  /** 服务器下发的对局数值（X-3）；未收到 bootstrap 时为兜底值（旧服务器） */
  tuning: Readonly<SimTuning>
}

export function emptyWorld(): WorldState {
  return {
    tick: 0, initialized: false, phase: 0, timeLeftS: 0,
    robots: new Map(), projectiles: new Map(), cores: new Map(), healthPacks: new Map(), uplinks: new Map(),
    ackSeq: 0,
    tuning: FALLBACK_TUNING,
  }
}

export type SnapshotResult = 'applied' | 'resync-needed' | 'stale'

/**
 * 应用一帧快照到 world。
 * 断链时保留最后一份完整状态，等待 full；旧帧不能回退时钟或实体。
 */
export function applySnapshot(world: WorldState, snap: SnapshotDelta): SnapshotResult {
  const now = performance.now()

  if (world.initialized && snap.tick < world.tick) return 'stale'
  if (!snap.full && (!world.initialized || snap.baseTick !== world.tick)) return 'resync-needed'
  if (snap.full) {
    world.robots.clear()
    world.projectiles.clear()
    world.cores.clear()
    world.healthPacks.clear()
    world.uplinks.clear()
  }

  world.initialized = true
  world.tick = snap.tick
  world.phase = snap.phase
  world.timeLeftS = snap.timeLeftS
  world.ackSeq = snap.ackSeq
  if (snap.self) world.self = snap.self

  // 60Hz 快照逐实体到达：复用已有实体对象原地更新（派生字段先于 assign 求值，
  // 避免覆盖后语义变化），仅 full 重建/首见时新建——消除每秒数千个小对象分配。
  const invulnMs = invulnWindowMs(world.tuning)
  for (const r of snap.robots) {
    const id = r.base?.id ?? 0
    const prev = world.robots.get(id)
    // 新服务器每帧状态携带 optional invuln_s，full/resync 也能恢复显示；
    // 字段存在且为 0 时立即关闭。只有旧服务器缺失字段时才走 dead→alive 兜底。
    const invulnUntil = r.invulnS !== undefined
      ? r.invulnS > 0 ? now + r.invulnS * 1000 + 250 : undefined
      : prev?.dead && !r.dead ? now + invulnMs : prev?.invulnUntil
    // delta 帧不带 nick/color（full 才带），保留旧 meta
    const nick = r.nick || prev?.nick || ''
    const color = r.color || prev?.color || ''
    const ent = prev ?? ({} as RobotEnt)
    Object.assign(ent, r)
    ent.nick = nick
    ent.color = color
    ent.seenAt = now
    ent.invulnUntil = invulnUntil
    world.robots.set(id, ent)
  }
  for (const id of snap.robotGone) world.robots.delete(id)

  for (const p of snap.projectiles) {
    const id = p.base?.id ?? 0
    const prev = world.projectiles.get(id)
    const color = p.color || (prev?.ownerId === p.ownerId ? prev.color : '') || world.robots.get(p.ownerId)?.color || ''
    const ent = prev ?? ({} as ProjEnt)
    Object.assign(ent, p)
    ent.seenAt = now
    ent.color = color
    world.projectiles.set(id, ent)
  }
  for (const id of snap.projectileGone) world.projectiles.delete(id)

  for (const c of snap.cores) {
    const id = c.base?.id ?? 0
    const ent = world.cores.get(id) ?? ({} as CoreEnt)
    Object.assign(ent, c)
    ent.seenAt = now
    world.cores.set(id, ent)
  }
  for (const id of snap.coreGone) world.cores.delete(id)

  for (const u of snap.uplinks) {
    const id = u.base?.id ?? 0
    const ent = world.uplinks.get(id) ?? ({} as UplinkEnt)
    Object.assign(ent, u)
    ent.seenAt = now
    world.uplinks.set(id, ent)
  }
  for (const pack of snap.healthPacks) {
    const id = pack.base?.id ?? 0
    const ent = world.healthPacks.get(id) ?? ({} as HealthPackEnt)
    Object.assign(ent, pack)
    ent.seenAt = now
    world.healthPacks.set(id, ent)
  }

  return 'applied'
}

/** 构造 ResyncRequest 的上行帧（Uint8Array，直接 ws.send） */
export function buildResync(): Uint8Array {
  return encodeClient(create(ClientMsgSchema, {
    payload: { case: 'resyncRequest', value: create(ResyncRequestSchema, {}) },
  }))
}

/** 从 ServerMsg 提取快照（payload.event 快照帧在 ServerMsg.snapshot） */
export function extractSnapshot(msg: ServerMsg): SnapshotDelta | null {
  return msg.payload.case === 'snapshot' ? msg.payload.value : null
}
