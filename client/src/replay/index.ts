// 回放状态索引：把记录数组变成「任意 tick → 可渲染快照」的查询。
//
// 策略（与 stats/replay.go 的投影器同理，但只为可视化）：
//   - match_start/checkpoint 记录重置全量态（robots/cores/uplinks/projectiles）
//   - 事件按 tick 顺序叠加：kill → 受害者 dead；respawn → 复活回出生点；
//     core_pickup/uplink_hack → 分数累计；hit → +1；say → 气泡缓存
//   - 同一 tick 内保持文件序（服务器写入顺序）
//
// 为了 60fps 拖动条不掉帧，预计算每个「关键帧 tick」的完整态，查询时取
// ≤tick 的最近关键帧。关键帧 = checkpoint 或每 60 tick 定时采样。

import {
  ReplayData,
  ReplayEvent,
  ReplayRecord,
  ReplayCheckpoint,
  RobotBrief,
} from './model'

export interface RobotTickState {
  id: number
  nick: string
  color: string
  pos: { x: number; y: number }
  heading: number
  hp: number
  energy: number
  alive: boolean
  respawnAt: number | null
  invulnerable: boolean
}

export interface ReplayFrame {
  tick: number
  phase: number
  /** 查询 tick 时点的机器人态。 */
  robots: RobotTickState[]
  /** 分数表（事件累计）。 */
  scores: Map<number, ScoreAcc>
  /** 最近 4s（240 tick）内的 say 事件，供气泡渲染。 */
  bubbles: SayMark[]
  /** 最近关键帧携带的核心/弹丸（仅 checkpoint 粒度，供参考渲染）。 */
  cores: Array<{ id: number; pos: { x: number; y: number }; value: number; taken: boolean }>
  projectiles: Array<{ id: number; owner: number; pos: { x: number; y: number }; heading: number }>
}

export interface ScoreAcc {
  id: number
  kill: number
  hit: number
  core: number
  uplink: number
  assist: number
  total: number
}

export interface SayMark {
  robot: number
  text: string
  tick: number
}

export type MarkKind = 'kill' | 'core' | 'uplink' | 'phase' | 'end' | 'start'

export interface TimelineMark {
  tick: number
  kind: MarkKind
  color: string
  detail: string
  robot?: number
}

const KIND_COLOR: Record<MarkKind, string> = {
  kill: 'var(--danger)',
  core: 'var(--amber)',
  uplink: 'var(--accent)',
  phase: 'var(--lime)',
  end: 'var(--dim)',
  start: 'var(--dim)',
}

/** 事件分值（与 stats/projector.go 对齐：kill 25 / assist 10 / hit 1）。 */
export const SCORE_RULES = { kill: 25, assist: 10, hit: 1 } as const

/** 每 60 tick（1s）一个采样关键帧。 */
const KEYFRAME_EVERY = 60
/** 气泡保留时长（4s）。 */
const BUBBLE_TTL = 240

export class ReplayIndex {
  readonly endTick: number
  readonly robots: Map<number, RobotBrief>
  /** 时间轴标记（事件点），按 tick 排序。 */
  readonly marks: TimelineMark[]
  private readonly keyframes = new Map<number, FrameState>()
  private readonly keyTicks: number[] = []

  constructor(data: ReplayData) {
    this.endTick = Math.max(data.endTick, 1)
    this.robots = data.robots
    this.marks = []
    this.buildIndex(data.records)
  }

  private buildIndex(records: ReplayRecord[]): void {
    let phase = 1
    const robots = new Map<number, RobotTickState>()
    const scores = new Map<number, ScoreAcc>()
    const bubbles: SayMark[] = []
    let cores: ReplayCheckpoint['cores'] = []
    let projectiles: ReplayCheckpoint['projectiles'] = []

    const snapshot = (tick: number): FrameState => ({
      tick,
      phase,
      robots: cloneRobots(robots),
      scores: cloneScores(scores),
      bubbles: bubbles.filter((b) => tick - b.tick <= BUBBLE_TTL),
      cores: cores.map((c) => ({ ...c, pos: { ...c.pos } })),
      projectiles: projectiles.map((p) => ({ ...p, pos: { ...p.pos } })),
    })

    const commit = (f: FrameState) => {
      this.keyframes.set(f.tick, f)
    }

    // 初始态来自 match_start（或首个 checkpoint）
    const init = records.find((r) => r.type === 'match_start')?.state
      ?? records.find((r) => r.type === 'checkpoint')?.state
    if (init) {
      phase = numOr(init.phase, 1)
      for (const r of init.robots) {
        robots.set(r.id, {
          id: r.id,
          nick: r.nick,
          color: r.color,
          pos: vec(r.position),
          heading: r.heading,
          hp: r.hp,
          energy: r.energy,
          alive: r.state === 'alive',
          respawnAt: null,
          invulnerable: r.invulnerable,
        })
        scores.set(r.id, emptyScore(r.id))
      }
    }
    commit(snapshot(0))

    let nextSample = KEYFRAME_EVERY
    for (const rec of records) {
      if (rec.type === 'input') continue
      if (rec.state) {
        // checkpoint / 后续 match_start：重置全量态
        const st = rec.state
        phase = numOr(st.phase, phase)
        cores = st.cores.map((c) => ({ ...c }))
        projectiles = st.projectiles.map((p) => ({ ...p }))
        robots.clear()
        for (const r of st.robots) {
          robots.set(r.id, {
            id: r.id,
            nick: r.nick,
            color: r.color,
            pos: vec(r.position),
            heading: r.heading,
            hp: r.hp,
            energy: r.energy,
            alive: r.state === 'alive',
            respawnAt: null,
            invulnerable: r.invulnerable,
          })
          if (!scores.has(r.id)) scores.set(r.id, emptyScore(r.id))
        }
        commit(snapshot(st.tick))
        if (st.tick >= nextSample) nextSample = st.tick + KEYFRAME_EVERY
        continue
      }
      const ev = rec.event!
      applyEvent(ev, robots, scores, bubbles, this.marks, this.robots)
      while (ev.tick >= nextSample) {
        commit(snapshot(nextSample))
        nextSample += KEYFRAME_EVERY
      }
    }
    // 末尾补帧，保证 endTick 可查
    commit(snapshot(this.endTick))
    this.keyTicks.push(...this.keyframes.keys())
    this.keyTicks.sort((a, b) => a - b)
  }

  /** 查询 tick（含）时刻的状态。 */
  frameAt(queryTick: number): ReplayFrame {
    const q = Math.max(0, Math.min(queryTick, this.endTick))
    // 二分找 ≤q 的最大关键帧
    let lo = 0
    let hi = this.keyTicks.length - 1
    let best = this.keyTicks[0] ?? 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const t = this.keyTicks[mid] ?? 0
      if (t <= q) {
        best = t
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    const kf = this.keyframes.get(best)!
    return {
      tick: q,
      phase: kf.phase,
      robots: [...kf.robots.values()],
      scores: cloneScores(kf.scores),
      bubbles: kf.bubbles.filter((b) => q - b.tick <= BUBBLE_TTL),
      cores: kf.cores.map((c) => ({ ...c, pos: { ...c.pos } })),
      projectiles: kf.projectiles.map((p) => ({ ...p, pos: { ...p.pos } })),
    }
  }
}

interface FrameState {
  tick: number
  phase: number
  robots: Map<number, RobotTickState>
  scores: Map<number, ScoreAcc>
  bubbles: SayMark[]
  cores: ReplayCheckpoint['cores']
  projectiles: ReplayCheckpoint['projectiles']
}

function emptyScore(id: number): ScoreAcc {
  return { id, kill: 0, hit: 0, core: 0, uplink: 0, assist: 0, total: 0 }
}

function addScore(
  scores: Map<number, ScoreAcc>,
  id: number,
  field: 'kill' | 'hit' | 'core' | 'uplink' | 'assist',
  pts: number,
): void {
  const s = scores.get(id) ?? emptyScore(id)
  s[field] += 1
  s.total += pts
  scores.set(id, s)
}

function cloneRobots(m: Map<number, RobotTickState>): Map<number, RobotTickState> {
  const out = new Map()
  for (const [k, v] of m) out.set(k, { ...v, pos: { ...v.pos } })
  return out
}

function cloneScores(m: Map<number, ScoreAcc>): Map<number, ScoreAcc> {
  const out = new Map()
  for (const [k, v] of m) out.set(k, { ...v })
  return out
}

function vec(v: any): { x: number; y: number } {
  return { x: Number(v?.X ?? v?.x ?? 0), y: Number(v?.Y ?? v?.y ?? 0) }
}

/** 事件叠加：更新工作态并产出时间轴标记。 */
function applyEvent(
  ev: ReplayEvent,
  robots: Map<number, RobotTickState>,
  scores: Map<number, ScoreAcc>,
  bubbles: SayMark[],
  marks: TimelineMark[],
  roster: Map<number, RobotBrief>,
): void {
  const nickOf = (id: number) => roster.get(id)?.nick ?? `ROBOT-${id}`
  switch (ev.kind) {
    case 'kill': {
      const killer = numOr(ev.payload?.killer, 0)
      const victim = numOr(ev.payload?.victim, 0)
      const assist = numOr(ev.payload?.assist, 0)
      const v = robots.get(victim)
      if (v) {
        v.alive = false
        v.respawnAt = ev.tick + 180 // RespawnDelay=180t=3s
        v.hp = 0
      }
      addScore(scores, killer, 'kill', SCORE_RULES.kill)
      if (assist) addScore(scores, assist, 'assist', SCORE_RULES.assist)
      marks.push({
        tick: ev.tick,
        kind: 'kill',
        color: KIND_COLOR.kill,
        detail: `${nickOf(killer)} 击毁 ${nickOf(victim)}${assist ? `（助攻 ${nickOf(assist)}）` : ''}`,
        robot: victim,
      })
      break
    }
    case 'hit': {
      addScore(scores, numOr(ev.payload?.from, 0), 'hit', SCORE_RULES.hit)
      break
    }
    case 'core_pickup': {
      const by = numOr(ev.payload?.by, 0)
      const value = numOr(ev.payload?.value, 0)
      addScore(scores, by, 'core', value)
      marks.push({
        tick: ev.tick,
        kind: 'core',
        color: KIND_COLOR.core,
        detail: `${nickOf(by)} 拾取核心 +${value}`,
        robot: by,
      })
      break
    }
    case 'uplink_hack': {
      const by = numOr(ev.payload?.by, 0)
      const value = numOr(ev.payload?.value, 0)
      addScore(scores, by, 'uplink', value)
      marks.push({
        tick: ev.tick,
        kind: 'uplink',
        color: KIND_COLOR.uplink,
        detail: `${nickOf(by)} 攻破上行链路 +${value}`,
        robot: by,
      })
      break
    }
    case 'phase_change':
      marks.push({
        tick: ev.tick,
        kind: 'phase',
        color: KIND_COLOR.phase,
        detail: `阶段切换：${phaseName(ev.payload?.to)}`,
      })
      break
    case 'respawn': {
      const id = numOr(ev.payload?.robot, 0)
      const r = robots.get(id)
      if (r) {
        r.alive = true
        r.invulnerable = true
        r.hp = 100
        r.respawnAt = null
      }
      break
    }
    case 'say': {
      bubbles.push({ robot: numOr(ev.payload?.robot, 0), text: String(ev.payload?.text ?? ''), tick: ev.tick })
      if (bubbles.length > 64) bubbles.shift()
      break
    }
    case 'match_start':
      marks.push({ tick: ev.tick, kind: 'start', color: KIND_COLOR.start, detail: '对局开始' })
      break
    case 'match_end':
      marks.push({ tick: ev.tick, kind: 'end', color: KIND_COLOR.end, detail: '对局结束' })
      break
    default:
      break
  }
}

export function numOr(v: any, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

/** phase 归一为数字（事件/快照里可能是字符串枚举名）。 */
export function phaseNum(p: any): number {
  if (typeof p === 'number') return p
  if (p === 'OUTER_RING' || p === 'PHASE_OUTER_RING') return 1
  if (p === 'CORE_OPEN' || p === 'PHASE_CORE_OPEN') return 2
  return numOr(p, 0)
}

export function phaseName(p: any): string {
  const n = phaseNum(p)
  if (n === 1) return '外环'
  if (n === 2) return '核心开放'
  return '—'
}
