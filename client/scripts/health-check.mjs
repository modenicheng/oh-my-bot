import { startClient } from './startup-helpers.mjs'
import { parseReplayNDJSON } from '../src/replay/model.ts'
import { ReplayIndex } from '../src/replay/index.ts'
import { chromium } from 'playwright'
import WebSocket from 'ws'
import { create, fromBinary } from '@bufbuild/protobuf'
import {
  ClientInputSchema, ClientMsgSchema, JoinRoomSchema, ResyncRequestSchema,
  RoomActionSchema, RoomAction_Kind, ServerMsgSchema, encodeClient,
} from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve('..')
const work = mkdtempSync(join(tmpdir(), 'omb-health-'))
const shots = resolve(process.env.OMB_SHOTS || '../.artifacts/health')
mkdirSync(shots, { recursive: true })
const addr = `127.0.0.1:${process.env.OMB_E2E_PORT || 18448}`
const base = `http://${addr}`
const serverLog = join(shots, 'server.log')
const logChunks = []
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', addr], {
  cwd: work,
  env: {
    ...process.env,
    OMB_WEB_DIR: resolve(root, 'client/dist'),
    OMB_MANUAL_DIR: resolve(root, 'docs/manual'),
    OMB_DATA: join(work, 'data'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', chunk => logChunks.push(chunk))
server.stderr.on('data', chunk => logChunks.push(chunk))
let spawnError
server.on('error', error => { spawnError = error })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, label, timeout = 20_000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    if (spawnError) throw spawnError
    if (server.exitCode !== null) throw new Error(`server exited with ${server.exitCode}: ${Buffer.concat(logChunks).toString().slice(-2000)}`)
    try { const value = await fn(); if (value) return value } catch (error) { last = error }
    await sleep(50)
  }
  throw new Error(`timed out: ${label}${last ? ` (${last})` : ''}`)
}

function parseMap(raw) {
  const source = JSON.parse(raw)
  const vec = value => ({ x: Number(value?.X ?? value?.x ?? 0), y: Number(value?.Y ?? value?.y ?? 0) })
  return {
    generatorVer: Number(source.generator_ver),
    walls: source.walls.map(wall => ({ min: vec(wall.min), max: vec(wall.max) })),
    healthPacks: source.health_packs.map(pack => ({ id: Number(pack.id), pos: vec(pack.pos) })),
  }
}

function blocked(map, x, y, margin = 0.78) {
  if (Math.hypot(x, y) > 78.8) return true
  return map.walls.some(wall => x >= wall.min.x - margin && x <= wall.max.x + margin && y >= wall.min.y - margin && y <= wall.max.y + margin)
}

function pathTo(map, start, goal) {
  const step = 1
  const key = (x, y) => `${x},${y}`
  const snap = value => Math.round(value / step)
  const begin = { x: snap(start.x), y: snap(start.y) }
  const end = { x: snap(goal.x), y: snap(goal.y) }
  const queue = [begin]
  const previous = new Map([[key(begin.x, begin.y), null]])
  const moves = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  let found
  for (let at = 0; at < queue.length && at < 40_000; at++) {
    const current = queue[at]
    if (current.x === end.x && current.y === end.y) { found = current; break }
    for (const [dx, dy] of moves) {
      const next = { x: current.x + dx, y: current.y + dy }
      const k = key(next.x, next.y)
      if (previous.has(k) || blocked(map, next.x * step, next.y * step)) continue
      previous.set(k, current)
      queue.push(next)
    }
  }
  if (!found) throw new Error(`no path from ${JSON.stringify(start)} to ${JSON.stringify(goal)}`)
  const path = []
  for (let current = found; current; current = previous.get(key(current.x, current.y))) path.push({ x: current.x * step, y: current.y * step })
  path.reverse()
  path[0] = start
  path[path.length - 1] = goal
  return path
}

function nextWaypoint(path, position) {
  let nearest = 0
  for (let i = 1; i < path.length; i++) {
    if (Math.hypot(path[i].x - position.x, path[i].y - position.y) < Math.hypot(path[nearest].x - position.x, path[nearest].y - position.y)) nearest = i
  }
  return path[Math.min(path.length - 1, nearest + 2)]
}

function axisToward(position, target) {
  const dx = target.x - position.x, dy = target.y - position.y
  const length = Math.hypot(dx, dy)
  if (length < 0.25) return { x: 0, y: 0 }
  return { x: Math.round(dx / length * 1000), y: Math.round(dy / length * 1000) }
}

function applySnapshot(world, snapshot) {
  world.tick = snapshot.tick
  if (snapshot.full) { world.robots.clear(); world.healthPacks.clear(); world.fulls++ }
  for (const robot of snapshot.robots) {
    const id = robot.base?.id
    if (!id) continue
    const old = world.robots.get(id)
    world.robots.set(id, { ...old, ...robot, base: robot.base ?? old?.base, nick: robot.nick || old?.nick })
  }
  for (const id of snapshot.robotGone) world.robots.delete(id)
  for (const pack of snapshot.healthPacks) if (pack.base?.id) world.healthPacks.set(pack.base.id, pack)
  if (snapshot.self) world.selfId = snapshot.self.robotId
}

class RawPlayer {
  constructor(nick, room) {
    this.nick = nick
    this.room = room
    this.world = { tick: 0, selfId: 0, fulls: 0, robots: new Map(), healthPacks: new Map() }
    this.events = []
    this.seq = 0
  }
  async connect() {
    this.socket = new WebSocket(`ws://${addr}/ws`)
    this.socket.on('message', data => {
      const frame = new Uint8Array(data)
      if (frame[0] === 0) { this.socket.send(Uint8Array.of(1)); return }
      if (frame[0] !== 3) return
      const msg = fromBinary(ServerMsgSchema, frame.subarray(1))
      if (msg.payload.case === 'snapshot') applySnapshot(this.world, msg.payload.value)
      else if (msg.payload.case === 'event') {
        this.events.push(msg.payload.value)
        if (msg.payload.value.kind.case === 'roomState') this.joined = true
      }
    })
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject) })
    this.send({ case: 'join', value: create(JoinRoomSchema, { roomCode: this.room, nick: this.nick, color: '#ff756d' }) })
    await until(() => this.joined, `${this.nick} join`)
  }
  send(payload) { this.socket.send(encodeClient(create(ClientMsgSchema, { payload }))) }
  input({ moveX = 0, moveY = 0, aim = 0, fire = false }) {
    this.send({ case: 'input', value: create(ClientInputSchema, {
      seq: ++this.seq, moveX, moveY, aim, fire,
      axisMask: 1 | 2 | 4,
    }) })
  }
  close() { this.socket?.close() }
}

async function driveBrowser(page, observed, map, target, label, timeout = 45_000) {
  const path = pathTo(map, observed.robot.base.pos, target)
  let held = new Set()
  const setKeys = async axis => {
    const wanted = new Set()
    if (axis.x < -180) wanted.add('KeyA'); if (axis.x > 180) wanted.add('KeyD')
    if (axis.y < -180) wanted.add('KeyW'); if (axis.y > 180) wanted.add('KeyS')
    for (const key of held) if (!wanted.has(key)) await page.keyboard.up(key)
    for (const key of wanted) if (!held.has(key)) await page.keyboard.down(key)
    held = wanted
  }
  try {
    await until(async () => {
      const position = observed.robot?.base?.pos
      if (!position) return false
      if (Math.hypot(position.x - target.x, position.y - target.y) < 0.25) { await setKeys({ x: 0, y: 0 }); return true }
      await setKeys(axisToward(position, nextWaypoint(path, position)))
      return false
    }, label, timeout)
  } finally { await setKeys({ x: 0, y: 0 }) }
}

async function driveRaw(player, map, target, label, timeout = 45_000) {
  const own = () => player.world.robots.get(player.world.selfId)
  const path = pathTo(map, own().base.pos, target)
  try {
    await until(() => {
      const position = own()?.base?.pos
      if (!position) return false
      if (Math.hypot(position.x - target.x, position.y - target.y) < 0.25) return true
      const axis = axisToward(position, nextWaypoint(path, position))
      player.input({ moveX: axis.x, moveY: axis.y })
      return false
    }, label, timeout)
  } finally { player.input({}) }
}

const AUDIO_INIT = () => {
  window.__healthAudio = { started: [] }
  window.__healthSockets = []
  const wrap = (proto, key, tag) => {
    if (!proto?.[key]) return
    const original = proto[key]
    proto[key] = function (...args) {
      window.__healthAudio.started.push({ tag, at: performance.now() })
      return original.apply(this, args)
    }
  }
  wrap(window.OscillatorNode?.prototype, 'start', 'osc')
  wrap(window.AudioBufferSourceNode?.prototype, 'start', 'buffer')
  const NativeWebSocket = window.WebSocket
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) { super(...args); window.__healthSockets.push(this) }
  }
}

let browser, shooter, host
const pageErrors = []
const observed = { robot: undefined, map: undefined, mapHash: '', events: [], fulls: 0, packs: new Map(), hud: [] }
try {
  await until(() => fetch(`${base}/healthz`).then(response => response.ok).catch(() => false), 'server health')
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addInitScript(AUDIO_INIT)
  host = await context.newPage()
  host.on('pageerror', error => pageErrors.push(String(error)))
  let hostId = 0
  host.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
    const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
    if (msg.payload.case === 'event') {
      observed.events.push(msg.payload.value)
      if (msg.payload.value.kind.case === 'mapBootstrap') {
        observed.map = parseMap(msg.payload.value.kind.value.mapJson)
        observed.mapHash = msg.payload.value.kind.value.mapHash
      }
    } else if (msg.payload.case === 'snapshot') {
      const snapshot = msg.payload.value
      if (snapshot.full) observed.fulls++
      if (snapshot.self) hostId = snapshot.self.robotId
      for (const robot of snapshot.robots) if (robot.base?.id === hostId) observed.robot = { ...observed.robot, ...robot, base: robot.base ?? observed.robot?.base }
      for (const pack of snapshot.healthPacks) if (pack.base?.id) observed.packs.set(pack.base.id, pack)
    }
  }))

  await host.goto(base)
  await startClient(host)
  await host.fill('#in-room', 'HEALTH')
  await host.fill('#in-nick', 'health-owner')
  await host.click('#btn-join')
  await host.locator('#btn-warmup').waitFor({ state: 'visible' })
  await host.evaluate(() => {
    const root = document.querySelector('#hud-msg')
    if (!root) return
    new MutationObserver(() => window.__healthHud = [...(window.__healthHud || []), root.textContent || '']).observe(root, { childList: true, subtree: true, characterData: true })
    window.__healthHud = []
  })

  shooter = new RawPlayer('health-shooter', 'HEALTH')
  await shooter.connect()
  await until(() => observed.events.some(event => event.kind.case === 'roomState' && event.kind.value.robotsOnline === 2), 'two real players')
  const startFrame = [...encodeClient(create(ClientMsgSchema, { payload: { case: 'roomAction', value: create(RoomActionSchema, { kind: RoomAction_Kind.START }) } }))]
  await host.evaluate(bytes => window.__healthSockets.at(-1).send(Uint8Array.from(bytes)), startFrame)
  await until(() => observed.map?.healthPacks.length === 4 && observed.robot?.base?.pos && shooter.world.robots.get(shooter.world.selfId)?.base?.pos, 'match bootstrap', 20_000)
  assert.equal(observed.map.generatorVer, 6, 'actual match uses gen6')

  const pack = observed.map.healthPacks
    .map(value => ({ ...value, distance: Math.hypot(value.pos.x - observed.robot.base.pos.x, value.pos.y - observed.robot.base.pos.y) }))
    .sort((a, b) => a.distance - b.distance)[0]
  const radial = { x: pack.pos.x / Math.hypot(pack.pos.x, pack.pos.y), y: pack.pos.y / Math.hypot(pack.pos.x, pack.pos.y) }
  const victimWait = { x: pack.pos.x + radial.x * 3.4, y: pack.pos.y + radial.y * 3.4 }
  const shooterWait = { x: pack.pos.x + radial.x * 9.0, y: pack.pos.y + radial.y * 9.0 }

  await Promise.all([
    driveBrowser(host, observed, observed.map, victimWait, 'victim reaches health approach'),
    driveRaw(shooter, observed.map, shooterWait, 'shooter reaches firing position'),
  ])
  const beforeDamage = observed.robot.hpX10
  assert.equal(beforeDamage, 1000, 'victim begins at full HP')

  const fireDeadline = Date.now() + 12_000
  while (Date.now() < fireDeadline && observed.robot.hpX10 === beforeDamage) {
    const from = shooter.world.robots.get(shooter.world.selfId).base.pos
    const to = observed.robot.base.pos
    shooter.input({ aim: Math.atan2(to.y - from.y, to.x - from.x), fire: true })
    await sleep(80)
  }
  shooter.input({})
  await until(() => observed.robot.hpX10 < beforeDamage && observed.robot.hpX10 > 0, 'real projectile damages victim', 5_000)
  const damagedHP = observed.robot.hpX10

  const eventCountBefore = observed.events.filter(event => event.kind.case === 'heal').length
  await host.evaluate(() => { window.__healthAudio.started = [] })
  await driveBrowser(host, observed, observed.map, pack.pos, 'victim physically enters health pack', 10_000)
  const healEvent = await until(() => observed.events.find(event => event.kind.case === 'heal' && event.kind.value.by === hostId), 'authoritative EvHeal', 10_000)
  const heal = healEvent.kind.value
  assert.equal(heal.id, pack.id)
  assert.ok(heal.healX10 > 0 && heal.healX10 <= 300, 'heal is positive and capped at 30 HP')
  assert.ok(heal.at && Math.hypot(heal.at.x - pack.pos.x, heal.at.y - pack.pos.y) < 0.01)
  await until(() => observed.robot.hpX10 > damagedHP, 'HP increases after heal')
  assert.ok(observed.robot.hpX10 <= 1000, 'healed HP stays capped at 100')
  await until(() => observed.packs.get(pack.id)?.available === false && observed.packs.get(pack.id)?.respawnInS > 0, 'pack unavailable with respawn countdown')
  await until(() => host.evaluate(() => (window.__healthHud || []).some(text => text.includes('生命回灌'))), 'owner heal HUD')
  const healthAudio = await until(() => host.evaluate(() => {
    const entries = window.__healthAudio.started
    return entries.filter(entry => entry.tag === 'osc').length >= 3 ? entries : false
  }), 'owner health sound')
  assert.equal(healthAudio.filter(entry => entry.tag === 'osc').length, 3, 'owner health sound starts once')

  const fullsBefore = observed.fulls
  const resyncFrame = [...encodeClient(create(ClientMsgSchema, { payload: { case: 'resyncRequest', value: create(ResyncRequestSchema) } }))]
  await host.evaluate(bytes => window.__healthSockets.at(-1).send(Uint8Array.from(bytes)), resyncFrame)
  await until(() => observed.fulls > fullsBefore, 'browser full resync')
  await sleep(750)
  const healEventsAfter = observed.events.filter(event => event.kind.case === 'heal').length
  const audioCountAfter = await host.evaluate(() => window.__healthAudio.started.filter(entry => entry.tag === 'osc').length)
  const hudMessages = await host.evaluate(() => window.__healthHud || [])
  assert.equal(healEventsAfter, eventCountBefore + 1, 'one authoritative heal event')
  assert.equal(audioCountAfter, 3, 'full resync does not replay health sound')
  assert.equal(hudMessages.filter(text => text.includes('生命回灌')).length, 1, 'owner HUD shown once')
  assert.equal(observed.packs.get(pack.id).available, false, 'full resync preserves unavailable pack')
  assert.ok(observed.packs.get(pack.id).respawnInS > 0, 'full resync preserves cooldown')

  await host.screenshot({ path: join(shots, 'picked-up.png') })
  const abortFrame = [...encodeClient(create(ClientMsgSchema, { payload: { case: 'roomAction', value: create(RoomActionSchema, { kind: RoomAction_Kind.ABORT }) } }))]
  await host.evaluate(bytes => window.__healthSockets.at(-1).send(Uint8Array.from(bytes)), abortFrame)
  await until(() => observed.events.some(event => event.kind.case === 'roomState' && event.kind.value.state === 0), 'abort returns room')
  await sleep(500)

  const files = []
  const walk = dir => { for (const name of readdirSync(dir, { withFileTypes: true })) name.isDirectory() ? walk(join(dir, name.name)) : files.push(join(dir, name.name)) }
  walk(work)
  const jsonl = files.find(file => file.endsWith('.jsonl') && readFileSync(file, 'utf8').includes('"heal"'))
  assert.ok(jsonl, `heal event JSONL absent under ${work}`)
  const logText = readFileSync(jsonl, 'utf8')
  writeFileSync(join(shots, 'health-match.jsonl'), logText)
  const records = logText.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const healRecords = records.filter(record => record.type === 'event' && record.event?.heal)
  assert.equal(healRecords.length, 1, 'JSONL contains exactly one heal event')
  const healRecord = healRecords[0]
  assert.equal(healRecord.event.heal.by, hostId, 'JSONL heal owner')
  assert.equal(healRecord.event.heal.id, pack.id, 'JSONL heal pack')
  const replayIndex = new ReplayIndex(parseReplayNDJSON(logText))
  // The visual reader samples once per second; query the first sample after
  // the heal (or the final frame for a short aborted match).
  const replayFrame = replayIndex.frameAt(Math.min(replayIndex.endTick, Math.ceil(healRecord.tick / 60) * 60))
  const replayRobot = replayFrame.robots.find(robot => robot.id === hostId)
  const replayPack = replayFrame.healthPacks.find(item => item.id === pack.id)
  assert.ok(replayRobot && replayPack, 'actual replay index contains owner and health pack')
  assert.equal(replayRobot.hp, observed.robot.hpX10 / 10, 'actual replay reader matches healed HP')
  assert.equal(replayPack.readyAt, healRecord.tick + 1800, 'actual replay reader preserves 30s cooldown')

  const matches = await fetch(`${base}/api/matches`).then(response => response.json())
  const replayId = matches.find(item => typeof item === 'string' && item.startsWith('HEALTH-')) ?? matches.at(-1)
  assert.ok(replayId, 'finished match appears in replay list')
  await host.goto(`${base}/?view=replay-player&replay=${encodeURIComponent(replayId)}`)
  await startClient(host)
  await until(() => host.locator('#view-replay-player').isVisible(), 'replay interface')
  await host.locator('#rp-timeline').waitFor({ state: 'visible' })
  const replayDuration = Number(await host.locator('#rp-timeline').getAttribute('max'))
  assert.ok(replayDuration >= healEvent.tick, 'replay includes heal tick')
  await host.locator('#rp-timeline').evaluate((element, tick) => {
    element.value = String(tick); element.dispatchEvent(new Event('input', { bubbles: true }))
  }, healEvent.tick)
  assert.ok(await host.locator('#replay-canvas').screenshot({ path: join(shots, 'replay-heal.png') }))
  assert.deepEqual(pageErrors, [])

  const evidence = {
    generatorVer: observed.map.generatorVer,
    robotId: hostId,
    packId: pack.id,
    damagedHP: damagedHP / 10,
    healedHP: observed.robot.hpX10 / 10,
    healX10: heal.healX10,
    healTick: healEvent.tick,
    eventCount: healEventsAfter,
    respawnInS: observed.packs.get(pack.id).respawnInS,
    fullSnapshots: observed.fulls,
    jsonl,
    replayId,
  }
  writeFileSync(join(shots, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  if (host) await host.screenshot({ path: join(shots, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  shooter?.close()
  await browser?.close().catch(() => {})
  writeFileSync(serverLog, Buffer.concat(logChunks))
  if (server.exitCode === null) server.kill()
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(2000)])
  rmSync(work, { recursive: true, force: true })
}
