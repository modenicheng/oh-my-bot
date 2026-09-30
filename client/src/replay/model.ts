// 回放数据模型：NDJSON 记录解析与按 tick 的状态重建。
//
// 服务器 Match Event Log（server/internal/sim/log.go）每行一个 JSON 对象：
//   {"schema_version":1}                                    —— 头
//   {"type":"match_start","tick":0,"state":{...Checkpoint}} —— 初始全量
//   {"type":"event","tick":N,"event":{...ServerEvent}}      —— 事件
//   {"type":"input","tick":N,"robot_id":R,"input":{...}}    —— 输入（UI 忽略）
//   {"type":"checkpoint","tick":N,"state":{...Checkpoint}}  —— 每 60s 全量
//
// Checkpoint（server/internal/sim/sim.go）字段：tick/seed/phase/ended/robots/
// walls/map/rng/next_projectile/projectiles/cores/uplinks。
// Vec2/Rect 无 json tag → Go 序列化为大写 X/Y（mapdef.ts 同样处理）。

export interface ReplayVec2 {
  X?: number
  Y?: number
  x?: number
  y?: number
}

export interface ReplayRobotState {
  id: number
  nick: string
  color: string
  position: ReplayVec2
  velocity: ReplayVec2
  hp: number
  energy: number
  state: 'alive' | 'dead'
  heading: number
  sector: number
  respawnPending: boolean
  invulnerable: boolean
}

/** checkpoint 里渲染所需的实体快照。 */
export interface ReplayCheckpoint {
  tick: number
  phase: number
  ended: boolean
  robots: ReplayRobotState[]
  cores: Array<{ id: number; pos: { x: number; y: number }; value: number; taken: boolean }>
  uplinks: Array<{ id: number; pos: { x: number; y: number }; hackingId: number }>
  projectiles: Array<{ id: number; owner: number; pos: { x: number; y: number }; heading: number }>
  /** MapDef 原始对象（json tag "map"；序列化为字符串供 parseMapDef）。 */
  mapJson: string | null
}

/** 事件记录（omb.proto ServerEvent oneof kind 的 protojson 形态）。 */
export interface ReplayEvent {
  tick: number
  kind: string // kill | core_pickup | uplink_hack | phase_change | respawn | say | hit | match_start | match_end | wall_hit | ...
  payload: any
}

export interface ReplayRecord {
  type: 'match_start' | 'event' | 'input' | 'checkpoint'
  tick: number
  event?: ReplayEvent
  state?: ReplayCheckpoint
}

/** HUD 展示用机器人摘要。 */
export interface RobotBrief {
  id: number
  nick: string
  color: string
}

/** 载入结果：全部记录（按 tick 稳定排序）+ 元信息。 */
export interface ReplayData {
  records: ReplayRecord[]
  /** 首个 match_start（无则首个 checkpoint）。 */
  initCheckpoint: ReplayCheckpoint
  /** 对局末 tick。 */
  endTick: number
  /** 机器人 id → 昵称/颜色（初始 robots）。 */
  robots: Map<number, RobotBrief>
}

export class ReplayParseError extends Error {}

/** 解析完整 NDJSON 文本。头行（schema_version）跳过；空行容错。 */
export function parseReplayNDJSON(text: string): ReplayData {
  const records: ReplayRecord[] = []
  let initCheckpoint: ReplayCheckpoint | null = null
  let endTick = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (!line) continue
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch (e) {
      throw new ReplayParseError(`第 ${i + 1} 行不是合法 JSON: ${(e as Error).message}`)
    }
    if (obj && typeof obj.schema_version === 'number') continue // 头行
    if (!obj || typeof obj.type !== 'string') continue
    // Input-only stretches still occupy time, even though this visual index
    // does not execute the authoritative server simulation.
    if (['match_start', 'checkpoint', 'event', 'input', 'control'].includes(obj.type)) {
      endTick = Math.max(endTick, num(obj.tick, 0))
    }
    switch (obj.type) {
      case 'match_start':
      case 'checkpoint': {
        const st = normalizeCheckpoint(obj.state)
        records.push({ type: obj.type, tick: st.tick, state: st })
        if (obj.type === 'match_start' && !initCheckpoint) initCheckpoint = st
        break
      }
      case 'event': {
        const ev = normalizeEvent(obj)
        records.push({ type: 'event', tick: ev.tick, event: ev })
        break
      }
      default:
        break // input 与未知类型向前兼容，忽略
    }
  }
  if (!initCheckpoint) {
    const cp = records.find((r) => r.type === 'checkpoint')?.state
    if (!cp) throw new ReplayParseError('回放缺少 match_start/checkpoint 初始状态')
    initCheckpoint = cp
  }
  // 机器人花名册来自初始 robots
  const robots = new Map<number, RobotBrief>()
  for (const r of initCheckpoint.robots) {
    robots.set(r.id, { id: r.id, nick: r.nick, color: r.color })
  }
  // 记录按 tick 稳定排序（文件内同 tick 保持出现顺序）
  const sorted = records.slice().sort((a, b) => a.tick - b.tick)
  for (const r of sorted) endTick = Math.max(endTick, r.tick)
  return { records: sorted, initCheckpoint, endTick, robots }
}

function normalizeCheckpoint(st: any): ReplayCheckpoint {
  if (!st || typeof st !== 'object') throw new ReplayParseError('checkpoint 缺少 state')
  return {
    tick: num(st.tick, 0),
    phase: num(st.phase, 1),
    ended: !!st.ended,
    robots: (st.robots || []).map((r: any) => normalizeRobot(r)),
    // CoreView 无 json tag → 大写键 ID/Pos/Value/Alive
    cores: (st.cores || []).map((c: any) => ({
      id: num(c.ID ?? c.id, 0),
      pos: vec(c.Pos ?? c.pos),
      value: num(c.Value ?? c.value, 0),
      taken: !(c.Alive ?? c.alive ?? true),
    })),
    // Uplink{def, hacking_id}；def（UplinkDef）带 id/pos
    uplinks: (st.uplinks || []).map((u: any) => {
      const def = u.def || {}
      return {
        id: num(def.id != null ? def.id : u.id, 0),
        pos: vec(def.pos ?? def.Pos),
        hackingId: num(u.hacking_id, 0),
      }
    }),
    projectiles: (st.projectiles || []).map((p: any) => ({
      id: num(p.id ?? p.ID, 0),
      owner: num(p.owner ?? p.Owner, 0),
      pos: vec(p.pos ?? p.Pos),
      heading: num(p.heading ?? p.Heading, 0),
    })),
    mapJson: st.map != null ? JSON.stringify(st.map) : null,
  }
}

function normalizeRobot(r: any): ReplayRobotState {
  return {
    id: num(r.id, 0),
    nick: typeof r.nick === 'string' && r.nick ? r.nick : `ROBOT-${num(r.id, 0)}`,
    color: typeof r.color === 'string' && r.color ? r.color : '#22d3ee',
    position: r.position || { X: 0, Y: 0 },
    velocity: r.velocity || { X: 0, Y: 0 },
    hp: num(r.hp, 0),
    energy: num(r.energy, 0),
    state: r.state === 'dead' ? 'dead' : 'alive',
    heading: num(r.heading, 0),
    sector: num(r.sector, 0),
    respawnPending: !!r.respawn_pending,
    invulnerable: !!r.invulnerable,
  }
}

function normalizeEvent(obj: any): ReplayEvent {
  const ev = obj.event || {}
  // ServerEvent protojson：{tick, kill:{...}} / {tick, say:{...}} ...
  const kind = Object.keys(ev).find((k) => k !== 'tick' && k !== 'wall' && ev[k] !== null) || ''
  return {
    tick: num(ev.tick != null ? ev.tick : obj.tick, num(obj.tick, 0)),
    kind,
    payload: kind ? ev[kind] : null,
  }
}

function num(v: any, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

/** Vec2 无 json tag：Go 大写 X/Y；兼容小写。 */
function vec(v: any): { x: number; y: number } {
  return { x: num(v?.X ?? v?.x, 0), y: num(v?.Y ?? v?.y, 0) }
}
