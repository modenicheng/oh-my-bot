// 快照消费：decodeServer 后的 SnapshotDelta 合并进本地实体表。
// full=true 重建；delta 按 id 合并；*_gone 为墓碑删除；base_tick 断链 → 请求方发 ResyncRequest。
import {
  ResyncRequestSchema, ClientMsgSchema,
  type ServerMsg, type SnapshotDelta, type SelfState,
  type RobotState, type ProjectileState, type CoreState, type UplinkState,
} from '@omb/protocol'
import { create } from '@bufbuild/protobuf'
import { encodeClient } from '@omb/protocol'

export interface RobotEnt extends RobotState {
  /** 本地渲染帧时间戳（无敌闪烁等动画用） */
  seenAt: number
  /** 本地无敌近似截止（ms）：wire 无 invuln 字段，以 dead→alive 转变近似（重生后 4s + 250ms 容差） */
  invulnUntil?: number
}
export interface ProjEnt extends ProjectileState { seenAt: number }
export interface CoreEnt extends CoreState { seenAt: number }
export interface UplinkEnt extends UplinkState { seenAt: number }

export interface WorldState {
  tick: number
  initialized: boolean
  phase: number
  timeLeftS: number
  self?: SelfState
  robots: Map<number, RobotEnt>
  projectiles: Map<number, ProjEnt>
  cores: Map<number, CoreEnt>
  uplinks: Map<number, UplinkEnt>
  /** 最近 ack 的 input seq（服务器确认到哪） */
  ackSeq: number
}

export function emptyWorld(): WorldState {
  return {
    tick: 0, initialized: false, phase: 0, timeLeftS: 0,
    robots: new Map(), projectiles: new Map(), cores: new Map(), uplinks: new Map(),
    ackSeq: 0,
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
    world.uplinks.clear()
  }

  world.initialized = true
  world.tick = snap.tick
  world.phase = snap.phase
  world.timeLeftS = snap.timeLeftS
  world.ackSeq = snap.ackSeq
  if (snap.self) world.self = snap.self

  for (const r of snap.robots) {
    const prev = world.robots.get(r.base?.id ?? 0)
    // 无敌近似：仅识别 delta 帧上的 dead→alive 转变（重生后 ~4s，服务器 InvulnDuration=240tick=4s）。
    // full 重建时无 prev，不做近似（避免 resync 后全员误闪烁；代价是首帧出生闪烁缺失，可接受）。
    const invulnUntil = prev?.dead && !r.dead ? now + 4250 : prev?.invulnUntil
    // delta 帧不带 nick/color（full 才带），保留旧 meta
    world.robots.set(r.base?.id ?? 0, {
      ...r,
      nick: r.nick || prev?.nick || '',
      color: r.color || prev?.color || '',
      seenAt: now,
      invulnUntil,
    })
  }
  for (const id of snap.robotGone) world.robots.delete(id)

  for (const p of snap.projectiles) {
    const prev = world.projectiles.get(p.base?.id ?? 0)
    world.projectiles.set(p.base?.id ?? 0, {
      ...p, seenAt: now,
      color: p.color || (prev?.ownerId === p.ownerId ? prev.color : '') || world.robots.get(p.ownerId)?.color || '',
    })
  }
  for (const id of snap.projectileGone) world.projectiles.delete(id)

  for (const c of snap.cores) {
    world.cores.set(c.base?.id ?? 0, { ...c, seenAt: now })
  }
  for (const id of snap.coreGone) world.cores.delete(id)

  for (const u of snap.uplinks) {
    world.uplinks.set(u.base?.id ?? 0, { ...u, seenAt: now })
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
