// 回放数据模型：NDJSON 记录解析与按 tick 的状态重建。
//
// 服务器 Match Event Log 的 schema 权威源是 protocol/proto/omb.proto（审计
// X-6）：头行版本（ReplaySchemaVersion）、记录 "type" 名（ReplayRecordType）、
// visual 采样行形态（ReplayVisualVersion/ReplayVisualFrame）均从 @omb/protocol
// 生成代码取值 —— 本文件不再手抄这些常量。两侧测试互钉
// （sim/log_schema_test.go ↔ packages/protocol/test/golden.test.ts）。
//
// 磁盘形态（每行一个 JSON 对象，历史文件与新版继续互通）：
//   {"schema_version":1}                                    —— 头（版本校验，未知版本拒绝）
//   {"type":"match_start","tick":0,"state":{...Checkpoint}} —— 初始全量
//   {"type":"event","tick":N,"event":{...ServerEvent}}      —— 事件
//   {"type":"input","tick":N,"robot_id":R,"input":{...}}    —— 输入（UI 忽略）
//   {"type":"checkpoint","tick":N,"state":{...Checkpoint}}  —— 每 60s 全量
//   {"type":"visual","v":2,...ReplayVisualFrame}            —— 浏览器导出行（?visual=1）
//
// Checkpoint（server/internal/sim/sim.go）与 input 载荷（protojson ClientInput）
// 字段名与旧 JSON tag 一致；Vec2/Rect 无 json tag → Go 序列化为大写 X/Y
// （lib/gojson.ts 统一处理）。

import {
  REPLAY_SCHEMA_VERSION,
  ReplayRecordType,
  ReplayVisualVersion,
  ServerEventSchema,
  decodeVisualFrameV2,
  replayRecordDiskName,
  type ReplayVisualFrame as ProtoVisualFrame,
} from '@omb/protocol'
import { fromJson, toJson } from '@bufbuild/protobuf'
import { goNum, goVec2 } from '../lib/gojson'

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
  healthPacks: Array<{ id: number; pos: { x: number; y: number }; readyAt: number }>
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

/** 记录类型：盘上 "type" 字符串的判别值（authority: ReplayRecordType）。 */
export type ReplayRecordTypeUi =
  | 'match_start'
  | 'event'
  | 'input'
  | 'control'
  | 'checkpoint'

export interface ReplayRecord {
  type: ReplayRecordTypeUi
  tick: number
  event?: ReplayEvent
  state?: ReplayCheckpoint
}

export interface ReplayVisualRobot {
  id: number
  pos: { x: number; y: number }
  heading: number
  hp: number
  energy: number
  alive: boolean
  invulnerable: boolean
}

export interface ReplayVisualProjectile {
  id: number
  owner: number
  pos: { x: number; y: number }
  heading: number
}

export interface ReplayVisualFrame {
  tick: number
  phase: number
  robots: ReplayVisualRobot[]
  projectiles: ReplayVisualProjectile[]
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
  /** 服务端确定性重放生成的紧凑视觉采样；旧接口可为空。 */
  visualFrames: ReplayVisualFrame[]
}

export class ReplayParseError extends Error {}

/**
 * 当前客户端可解读的回放 NDJSON schema 版本（权威源 omb.proto
 * ReplaySchemaVersion，经 @omb/protocol 生成枚举取值）；更高版本可能含未知
 * 记录形态，显式拒绝而非静默错读。
 */
export const REPLAY_SCHEMA_VERSION_UI: number = REPLAY_SCHEMA_VERSION

/** 记录类型盘上名（authority: ReplayRecordType）：与服务器 sim.RecordTypeDiskName 同规则。 */
const DISK_MATCH_START = replayRecordDiskName(ReplayRecordType.REPLAY_MATCH_START)
const DISK_EVENT = replayRecordDiskName(ReplayRecordType.REPLAY_EVENT)
const DISK_INPUT = replayRecordDiskName(ReplayRecordType.REPLAY_INPUT)
const DISK_CONTROL = replayRecordDiskName(ReplayRecordType.REPLAY_CONTROL)
const DISK_CHECKPOINT = replayRecordDiskName(ReplayRecordType.REPLAY_CHECKPOINT)
const DISK_VISUAL = replayRecordDiskName(ReplayRecordType.REPLAY_VISUAL)

/** 占据时间轴的记录类型（input-only 段也推进 endTick）。 */
const TIMEKEEPING_TYPES = new Set<string>([DISK_MATCH_START, DISK_CHECKPOINT, DISK_EVENT, DISK_INPUT, DISK_CONTROL])

export interface ReplayParser {
  pushLine(line: string, lineNo: number): void
  /**
   * 文件末个非空行的推送（C-45）：NDJSON 由服务器增量写盘，进程被杀/磁盘满的
   * 典型产物是尾部截断的半行（非法 JSON）——丢最后一秒远好于丢整局存档。
   * 仅末行、仅语法失败时跳过；该行若是合法 JSON 仍走严格路径（未知版本/坏记录
   * 语义与中间行完全一致）。
   */
  pushTailLine(line: string, lineNo: number): void
  finish(): ReplayData
}

/** 行解析器：供同步解析与分片异步解析共用（错误行号 0-based 传入、1-based 展示）。 */
export function createReplayParser(): ReplayParser {
  const records: ReplayRecord[] = []
  const visualFrames: ReplayVisualFrame[] = []
  let initCheckpoint: ReplayCheckpoint | null = null
  let endTick = 0
  const pushLine = (line: string, lineNo: number): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    let obj: any
    try {
      obj = JSON.parse(trimmed)
    } catch (e) {
      throw new ReplayParseError(`第 ${lineNo + 1} 行不是合法 JSON: ${(e as Error).message}`)
    }
    if (obj && typeof obj.schema_version === 'number') {
      // 头行：只认已知版本，未知版本显式报错（插位/改形态会全错，不能静默跳过）。
      // 缺头行保持旧宽容行为——历史文件与测试的行内片段仍可解析。
      if (obj.schema_version !== REPLAY_SCHEMA_VERSION_UI) {
        throw new ReplayParseError(
          `不支持的回放版本 schema_version=${obj.schema_version}（支持 ${REPLAY_SCHEMA_VERSION_UI}），请升级客户端`)
      }
      return
    }
    if (!obj || typeof obj.type !== 'string') return
    // 权威枚举校验：未知记录类型（未来 schema）不静默吞掉时间轴语义。
    if (TIMEKEEPING_TYPES.has(obj.type)) {
      endTick = Math.max(endTick, goNum(obj.tick, 0))
    }
    if (obj.type === DISK_MATCH_START || obj.type === DISK_CHECKPOINT) {
      const st = normalizeCheckpoint(obj.state)
      const type: ReplayRecordTypeUi = obj.type === DISK_MATCH_START ? 'match_start' : 'checkpoint'
      records.push({ type, tick: st.tick, state: st })
      if (obj.type === DISK_MATCH_START && !initCheckpoint) initCheckpoint = st
      return
    }
    if (obj.type === DISK_EVENT) {
      const ev = normalizeEvent(obj)
      records.push({ type: 'event', tick: ev.tick, event: ev })
      return
    }
    if (obj.type === DISK_VISUAL) {
      visualFrames.push(normalizeVisualFrame(obj, lineNo))
      return
    }
    // input/control 与未知类型向前兼容，忽略
  }
  const tailSyntaxOk = (line: string): boolean => {
    try {
      JSON.parse(line.trim())
      return true
    } catch {
      return false
    }
  }
  return {
    pushLine,
    pushTailLine(line: string, lineNo: number): void {
      // 只放宽语法失败：截断只会产生非法 JSON（外层对象未闭合）；合法 JSON 行的
      // 语义错误（未知 schema/visual 版本、坏 checkpoint）在任何位置都显式报错。
      if (tailSyntaxOk(line)) pushLine(line, lineNo)
    },
    finish(): ReplayData {
      if (!initCheckpoint) {
        const cp = records.find((r) => r.type === DISK_CHECKPOINT)?.state
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
      visualFrames.sort((a, b) => a.tick - b.tick)
      for (const r of sorted) endTick = Math.max(endTick, r.tick)
      for (const frame of visualFrames) endTick = Math.max(endTick, frame.tick)
      return { records: sorted, initCheckpoint, endTick, robots, visualFrames }
    },
  }
}

/** 末个非空行的下标（可能不存在则 -1）：唯一允许「截断尾行」语义的位置。 */
function tailLineIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? '').trim()) return i
  }
  return -1
}

/** 解析完整 NDJSON 文本。头行（schema_version，未知版本拒绝）跳过；空行容错；
 *  末个非空行按截断尾行容忍（C-45）。 */
export function parseReplayNDJSON(text: string): ReplayData {
  const parser = createReplayParser()
  const lines = text.split('\n')
  const tail = tailLineIndex(lines)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (i === tail) parser.pushTailLine(line, i)
    else parser.pushLine(line, i)
  }
  return parser.finish()
}

/**
 * 分片异步解析：整段同步 parse 在长录像（数十万行）下会冻结主线程数秒。
 * 按 ~1MB 文本切片逐片推进，片间让出事件循环；行号与同步版完全一致；
 * 末片末个非空行按截断尾行容忍（C-45）。
 */
export async function parseReplayNDJSONAsync(text: string): Promise<ReplayData> {
  const parser = createReplayParser()
  const CHUNK = 1 << 20
  let start = 0
  let lineNo = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK)
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end)
      if (nl > start) {
        end = nl + 1
      } else {
        const hard = text.indexOf('\n', start)
        end = hard === -1 ? text.length : hard + 1
      }
    }
    const piece = text.slice(start, end).split('\n')
    // 最后一片（end 已到文本末尾）的末个非空行即整文件的截断尾行。
    const tailLocal = end >= text.length ? tailLineIndex(piece) : -1
    for (let i = 0; i < piece.length; i++) {
      const line = piece[i] ?? ''
      if (i === tailLocal) parser.pushTailLine(line, lineNo + i)
      else parser.pushLine(line, lineNo + i)
    }
    lineNo += piece.length
    start = end
    await new Promise<void>(resolve => setTimeout(resolve))
  }
  return parser.finish()
}

function normalizeCheckpoint(st: any): ReplayCheckpoint {
  if (!st || typeof st !== 'object') throw new ReplayParseError('checkpoint 缺少 state')
  return {
    tick: goNum(st.tick, 0),
    phase: goNum(st.phase, 1),
    ended: !!st.ended,
    robots: (st.robots || []).map((r: any) => normalizeRobot(r)),
    // CoreView 无 json tag → 大写键 ID/Pos/Value/Alive
    cores: (st.cores || []).map((c: any) => ({
      id: goNum(c.ID ?? c.id, 0),
      pos: goVec2(c.Pos ?? c.pos),
      value: goNum(c.Value ?? c.value, 0),
      taken: !(c.Alive ?? c.alive ?? true),
    })),
    healthPacks: (st.health_packs || st.healthPacks || []).map((h: any) => ({
      id: goNum(h.id ?? h.ID, 0),
      pos: goVec2(h.pos ?? h.Pos),
      readyAt: goNum(h.ready_at ?? h.readyAt ?? h.ReadyAt, 0),
    })),
    // Uplink{def, hacking_id}；def（UplinkDef）带 id/pos
    uplinks: (st.uplinks || []).map((u: any) => {
      const def = u.def || {}
      return {
        id: goNum(def.id != null ? def.id : u.id, 0),
        pos: goVec2(def.pos ?? u.Pos),
        hackingId: goNum(u.hacking_id, 0),
      }
    }),
    projectiles: (st.projectiles || []).map((p: any) => ({
      id: goNum(p.id ?? p.ID, 0),
      owner: goNum(p.owner ?? p.Owner, 0),
      pos: goVec2(p.pos ?? p.Pos),
      heading: goNum(p.heading ?? p.Heading, 0),
    })),
    mapJson: st.map != null ? JSON.stringify(st.map) : null,
  }
}

function normalizeRobot(r: any): ReplayRobotState {
  return {
    id: goNum(r.id, 0),
    nick: typeof r.nick === 'string' && r.nick ? r.nick : `ROBOT-${goNum(r.id, 0)}`,
    color: typeof r.color === 'string' && r.color ? r.color : '#22d3ee',
    position: r.position || { X: 0, Y: 0 },
    velocity: r.velocity || { X: 0, Y: 0 },
    hp: goNum(r.hp, 0),
    energy: goNum(r.energy, 0),
    state: r.state === 'dead' ? 'dead' : 'alive',
    heading: goNum(r.heading, 0),
    sector: goNum(r.sector, 0),
    respawnPending: !!r.respawn_pending,
    invulnerable: !!r.invulnerable,
  }
}

/** visual 行解码：v2（命名字段，权威 ReplayVisualFrame）或 v1（历史位置数组）。 */
function normalizeVisualFrame(obj: any, lineNo: number): ReplayVisualFrame {
  const version = obj.v == null ? ReplayVisualVersion.REPLAY_VISUAL_V1 : goNum(obj.v, 0)
  if (version === ReplayVisualVersion.REPLAY_VISUAL_V2) {
    // v2：权威 proto 消息的 protojson 形态，经生成 schema 校验。
    let frame: ProtoVisualFrame
    try {
      frame = decodeVisualFrameV2(obj)
    } catch (e) {
      throw new ReplayParseError(`第 ${lineNo + 1} 行 visual v2 记录不合法: ${(e as Error).message}`)
    }
    return {
      tick: frame.tick,
      phase: frame.phase,
      robots: frame.robots.map((r) => ({
        id: r.id, pos: { x: r.pos?.x ?? 0, y: r.pos?.y ?? 0 }, heading: r.heading,
        hp: r.hp, energy: r.energy, alive: r.alive, invulnerable: r.invulnerable,
      })),
      projectiles: frame.projectiles.map((p) => ({
        id: p.id, owner: p.owner, pos: { x: p.pos?.x ?? 0, y: p.pos?.y ?? 0 }, heading: p.heading,
      })),
    }
  }
  if (version !== ReplayVisualVersion.REPLAY_VISUAL_V1) {
    // 未知形态版本（如 v3）：显式拒绝，不静默错读位置数组语义。
    throw new ReplayParseError(
      `第 ${lineNo + 1} 行不支持的 visual 版本 v=${version}（支持 1/2），请升级客户端`)
  }
  // v1（历史）：位置数组 [id,x,y,heading,hp,energy,alive,invuln] /
  // [id,owner,x,y,heading]；字段含义只由位置约定（审计 X-6 的二义性来源）。
  const robots = Array.isArray(obj.robots) ? obj.robots : []
  const projectiles = Array.isArray(obj.projectiles) ? obj.projectiles : []
  return {
    tick: goNum(obj.tick, 0),
    phase: goNum(obj.phase, 1),
    robots: robots.map((row: unknown) => {
      const values = Array.isArray(row) ? row : []
      return {
        id: goNum(values[0], 0),
        pos: { x: goNum(values[1], 0), y: goNum(values[2], 0) },
        heading: goNum(values[3], 0),
        hp: goNum(values[4], 0),
        energy: goNum(values[5], 0),
        alive: goNum(values[6], 0) !== 0,
        invulnerable: goNum(values[7], 0) !== 0,
      }
    }),
    projectiles: projectiles.map((row: unknown) => {
      const values = Array.isArray(row) ? row : []
      return {
        id: goNum(values[0], 0), owner: goNum(values[1], 0),
        pos: { x: goNum(values[2], 0), y: goNum(values[3], 0) },
        heading: goNum(values[4], 0),
      }
    }),
  }
}

/**
 * 事件行解码。优先按权威 ServerEvent schema 严格解码（protojson，
 * useProtoFieldName 键名 → 下游继续消费 snake_case 事件名/字段名，与历史
 * 行为一致）；坏事件回退旧宽松扫描（历史录像与测试内联片段可能带非规范键形）。
 * tick 不一致时以事件自身 tick 为准（旧行为）。
 */
function normalizeEvent(obj: any): ReplayEvent {
  const ev = obj.event || {}
  if (ev && typeof ev === 'object') {
    try {
      const decoded = fromJson(ServerEventSchema, ev)
      if (decoded.kind.case !== undefined) {
        // kind.case 是 camelCase（生成 oneof 判别名）；盘上/权威名是 proto 字段
        // 名（snake_case）。toJson(useProtoFieldName) 还原权威键名，下游
        // applyEvent/scoreboard 无需同时认两套拼写。
        const normalized = toJson(ServerEventSchema, decoded, { useProtoFieldName: true }) as Record<string, unknown>
        delete normalized['tick']
        delete normalized['wall']
        const entries = Object.entries(normalized)
        if (entries.length === 1) {
          const [kind, payload] = entries[0]!
          // 历史行可能省略 event.tick（protojson 默认 0）；回退信封 tick
          // ——与旧宽松扫描同一家族，保持时间轴语义不变。
          const fallbackTick = goNum(obj.tick, 0)
          const tick = 'tick' in ev ? goNum(decoded.tick, fallbackTick) : fallbackTick
          return { tick, kind, payload }
        }
      }
    } catch {
      // fall through to legacy lenient scan
    }
  }
  const kind = Object.keys(ev).find((k) => k !== 'tick' && k !== 'wall' && ev[k] !== null) || ''
  return {
    tick: goNum(ev.tick != null ? ev.tick : obj.tick, goNum(obj.tick, 0)),
    kind,
    payload: kind ? ev[kind] : null,
  }
}
