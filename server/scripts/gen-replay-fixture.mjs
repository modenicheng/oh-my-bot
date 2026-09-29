// 验证脚本：合成一份符合 server/internal/sim/log.go 磁盘格式的回放日志，
// 用于回放 UI 端到端验收（现有 data/matches 全是空 stub，无 checkpoint 态）。
// 生成：node scripts/gen-replay-fixture.mjs <matchId> [seconds]
// 写入 server/data/matches/<matchId>.jsonl
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const matchId = process.argv[2] || 'REPLAY1-000000001'
const seconds = Number(process.argv[3] || 480)
const TICK = 60
const TICKS = seconds * TICK
const CKPT_EVERY = 60 * 60 // 服务器 CheckpointInterval = 60s

const robots = [
  { id: 1, nick: 'ALICE', color: '#22d3ee', sector: 0 },
  { id: 2, nick: 'BOB', color: '#a3e635', sector: 2 },
  { id: 3, nick: 'CAROL', color: '#f472b6', sector: 4 },
  { id: 4, nick: 'DAVE', color: '#fbbf24', sector: 6 },
]

// 简单圆周运动：四人绕中环逆时针，相位错开
function posAt(id, tick) {
  const r = 40 + (id % 2) * 8
  const w = (2 * Math.PI) / (24 + id * 3) // 角速度
  const a = (id * Math.PI) / 2 + w * (tick / TICK)
  return { X: +(r * Math.cos(a)).toFixed(3), Y: +(r * Math.sin(a)).toFixed(3) }
}
function headingAt(id, tick) {
  const w = (2 * Math.PI) / (24 + id * 3)
  const a = (id * Math.PI) / 2 + w * (tick / TICK)
  return +(a + Math.PI / 2).toFixed(4)
}

function robotState(id, tick, dead = false) {
  const p = posAt(id, tick)
  const v = posAt(id, tick + 1)
  return {
    id,
    nick: robots[id - 1].nick,
    color: robots[id - 1].color,
    position: p,
    velocity: { X: +(v.X - p.X).toFixed(3), Y: +(v.Y - p.Y).toFixed(3) },
    hp: dead ? 0 : 80 + (id * 7) % 21,
    energy: 50 + (tick / 10) % 50,
    state: dead ? 'dead' : 'alive',
    heading: headingAt(id, tick),
    spawn_position: posAt(id, 0),
    sector: robots[id - 1].sector,
  }
}

// 地图：对齐 contract.go MapDef（json tag 小写；Vec2/Rect 大写）
const map = {
  version: 1,
  generator_ver: 1,
  seed: 6653221315087878000,
  map_hash: 'fixture',
  walls: [
    { id: 1, Min: { X: -20, Y: -20 }, Max: { X: -16, Y: 20 } },
    { id: 2, Min: { X: 16, Y: -20 }, Max: { X: 20, Y: 20 } },
    { id: 3, Min: { X: -8, Y: -8 }, Max: { X: 8, Y: -6 } },
    { id: 4, Min: { X: -8, Y: 6 }, Max: { X: 8, Y: 8 } },
  ],
  sectors: Array.from({ length: 8 }, (_, i) => ({
    id: i,
    spawn_area: { Min: { X: -70, Y: -70 }, Max: { X: 70, Y: 70 } },
    center: { X: Math.round(60 * Math.cos((i * Math.PI) / 4)), Y: Math.round(60 * Math.sin((i * Math.PI) / 4)) },
  })),
  uplinks: [
    { id: 1, pos: { X: 0, Y: 55 }, main: true, interact_r: 2.5, active_phase: 1 },
    { id: 2, pos: { X: 47.6, Y: -27.5 }, main: false, interact_r: 2.5, active_phase: 2 },
    { id: 3, pos: { X: -47.6, Y: -27.5 }, main: false, interact_r: 2.5, active_phase: 2 },
    { id: 4, pos: { X: 0, Y: -55 }, main: false, interact_r: 2.5, active_phase: 1 },
  ],
  core_pads: [
    { id: 1, pos: { X: 10, Y: 0 }, group: 1, value: 10 },
    { id: 2, pos: { X: -10, Y: 0 }, group: 1, value: 10 },
    { id: 3, pos: { X: 0, Y: 12 }, group: 2, value: 25 },
  ],
  core_zone: { radius: 30, unlock_phase: 2 },
}

function coresAt(tick) {
  // 开局 3 核；120s 时 id=2 被拾取
  const list = map.core_pads.map((p, i) => ({
    ID: p.id,
    Pos: { X: p.pos.X, Y: p.pos.Y },
    Value: p.value,
    Alive: !(tick >= 120 * 60 && p.id === 2) && !(tick >= 300 * 60 && p.id === 3),
  }))
  void i_unused
  return list
}
function i_unused() {}

function uplinksAt(tick) {
  return map.uplinks.map((u) => ({
    def: { ID: u.id, Pos: { X: u.pos.X, Y: u.pos.Y }, Main: u.main, InteractR: u.interact_r, ActivePhase: u.active_phase },
    hacking_id: 0,
    progress_ticks: 0,
    ready_at: 0,
  }))
}

function checkpoint(tick) {
  const dead = new Set()
  if (tick >= 60 * 60) dead.add(3)
  if (tick >= 200 * 60) dead.delete(3)
  return {
    tick,
    seed: 6653221315087878000,
    phase: tick >= 240 * 60 ? 2 : 1,
    ended: tick >= TICKS,
    robots: robots.map((r) => robotState(r.id, tick, dead.has(r.id))),
    walls: [],
    map,
    rng: { state: 123456789n.toString() },
    next_projectile: 1,
    projectiles: [],
    cores: coresAt(tick),
    uplinks: uplinksAt(tick),
  }
}

const lines = []
lines.push(JSON.stringify({ schema_version: 1 }))
lines.push(JSON.stringify({ type: 'match_start', tick: 0, state: checkpoint(0) }))
lines.push(JSON.stringify({ type: 'event', tick: 1, event: { tick: 1, match_start: { map_seed: '6653221315087878442', players: 4 } } }))

// 事件脚本：击杀/核心/上行链路/说/阶段/重生，均匀散布
const events = []
events.push({ tick: 30 * 60, kill: { killer: 1, victim: 2, assist: 3, at: { X: 20, Y: 10 } } })
events.push({ tick: 60 * 60 + 30, kill: { killer: 4, victim: 3, assist: 0, at: { X: -20, Y: 0 } } })
events.push({ tick: 63 * 60, respawn: { robot: 3, sector: 4 } })
events.push({ tick: 120 * 60, core_pickup: { by: 2, core_id: 2, value: 10 } })
events.push({ tick: 150 * 60, say: { robot: 1, text: '核心区开门了！' } })
events.push({ tick: 240 * 60, phase_change: { from: 'OUTER_RING', to: 'CORE_OPEN' } })
events.push({ tick: 260 * 60, hit: { from: 1, to: 4, dmg: 120 } })
events.push({ tick: 300 * 60, core_pickup: { by: 1, core_id: 3, value: 25 } })
events.push({ tick: 330 * 60, uplink_hack: { by: 4, uplink_id: 2, value: 15 } })
events.push({ tick: 400 * 60, kill: { killer: 3, victim: 4, assist: 1, at: { X: 0, Y: 40 } } })
events.push({ tick: 403 * 60, respawn: { robot: 4, sector: 6 } })
events.push({ tick: 450 * 60, say: { robot: 2, text: '防守外环' } })
for (const ev of events) {
  const kind = Object.keys(ev).filter((k) => k !== 'tick')[0]
  const payload = { tick: ev.tick, [kind]: ev[kind] }
  lines.push(JSON.stringify({ type: 'event', tick: ev.tick, event: payload }))
}

// checkpoint：每 60s（对齐服务器 CheckpointInterval）
for (let t = CKPT_EVERY; t <= TICKS; t += CKPT_EVERY) {
  lines.push(JSON.stringify({ type: 'checkpoint', tick: t, state: checkpoint(t) }))
}
lines.push(JSON.stringify({ type: 'event', tick: TICKS, event: { tick: TICKS, match_end: {} } }))

const out = join(process.cwd(), 'data', 'matches', `${matchId}.jsonl`)
mkdirSync(join(process.cwd(), 'data', 'matches'), { recursive: true })
writeFileSync(out, lines.join('\n') + '\n', 'utf8')
console.log(`wrote ${out}: ${lines.length} lines, ${TICKS} ticks`)
