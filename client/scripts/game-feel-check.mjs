// game-feel-check.mjs — focused browser regression for ongoing game-feel UI.
//
// Scope: client/scripts/game-feel-check.mjs + package.json "test:feel" only.
//
// Unlike test:e2e (round2-check.mjs), which drives the REAL server binary, this
// harness serves client/dist over plain HTTP on 127.0.0.1:18421 and mounts a
// deterministic protobuf WebSocket fixture on /ws. The browser joins through
// the actual form, the client's real WsTransport/RoomSession/InputSampler run
// against the fixture, and every authoritative message (roomState acceptance,
// mapBootstrap, full snapshot, deltas, events) is emitted under the test's
// explicit control — no wall-clock simulation loop, fully repeatable timing.
//
// Real-server behavior is NOT covered here (that is round2-check's job); real
// disconnect/reconnect is covered separately by scripts/reconnect-check.mjs.
//
// Prerequisite: `npm run build` in client/ (serves dist/). Fails fast otherwise.
// Screenshots: OMB_SHOTS || ../.artifacts/feel  (document.fonts.ready awaited per shot)
//
// Covered protocol surface (omb.v1):
//   SelfState.optional assist_on/dash_ready_tick/fire_ready_tick
//   ServerEvent.shot{projectile,owner,at,heading}
//   ServerEvent.projectile_impact{projectile,owner,target,at,shield,invulnerable}

import { chromium } from 'playwright'
import { create, toBinary, fromBinary } from '@bufbuild/protobuf'
import {
  ServerMsgSchema, ClientMsgSchema, ServerEventSchema, SnapshotDeltaSchema,
  EvRoomStateSchema, EvMapBootstrapSchema, EvShotSchema, EvProjectileImpactSchema,
  EvUplinkHackSchema, Vec2Schema,
} from '../../packages/protocol/src/index.ts'
import http from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { WebSocketServer } from 'ws'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------- constants
const PORT = 18421
const BASE = `http://127.0.0.1:${PORT}`
const CLIENT_DIR = resolve(import.meta.dirname, '..')
const DIST = join(CLIENT_DIR, 'dist')
const SHOTS = resolve(process.env.OMB_SHOTS || '../.artifacts/feel')

const CS_HUMAN = 1
const PHASE_OUTER = 1
const R_WARMUP = 1

const SELF_ID = 101
const ENEMY_ID = 202
const UPLINK_ID = 900
const SELF_POS = { x: 0, y: 0 }
const ENEMY_POS = { x: 8, y: -3 }

// gen2 minimal valid map: walls non-empty but far away and never blocking,
// one uplink with interactR 2.5 m ~1.8 m from self, one core pad, core zone.
// Vec2/Rect use Go-style uppercase keys (mapdef.ts accepts both cases).
const MAP_JSON = JSON.stringify({
  version: 1,
  generator_ver: 2,
  seed: 20260206,
  map_hash: 'feelfix01',
  walls: [
    { id: 1, min: { X: -66, Y: -60 }, max: { X: -58, Y: 60 } },
    { id: 2, min: { X: 58, Y: -60 }, max: { X: 66, Y: 60 } },
  ],
  sectors: [
    { id: 1, spawn_area: { Min: { X: -50, Y: -40 }, Max: { X: -35, Y: -25 } }, center: { X: -42, Y: -32 } },
    { id: 2, spawn_area: { Min: { X: 35, Y: 25 }, Max: { X: 50, Y: 40 } }, center: { X: 42, Y: 32 } },
  ],
  uplinks: [{ id: UPLINK_ID, pos: { X: 1.5, Y: 1.0 }, main: false, interact_r: 2.5, active_phase: 1 }],
  core_pads: [{ id: 1, pos: { X: 3, Y: 3 }, group: 0, value: 10 }],
  core_zone: { radius: 30, unlock_phase: 2 },
})

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return true; await sleep(50) }
  throw new Error(`Timed out: ${label}`)
}

// ---------------------------------------------------------------- fixture
function freshState() {
  return {
    tick: 600,
    timeLeftS: 480,
    robots: [
      { base: { id: SELF_ID, pos: { ...SELF_POS }, heading: 0 }, hpX10: 1000, energyX10: 1000, shieldOn: false, dashing: false, dead: false, respawnInS: 0, nick: 'feeltest', color: '#22d3ee', isPartner: false },
      { base: { id: ENEMY_ID, pos: { ...ENEMY_POS }, heading: Math.PI }, hpX10: 1000, energyX10: 1000, shieldOn: false, dashing: false, dead: false, respawnInS: 0, nick: 'ENEMY-A', color: '#ff756d', isPartner: false },
    ],
    projectiles: [], cores: [],
    uplinks: [{ base: { id: UPLINK_ID, pos: { x: 1.5, y: 1.0 }, heading: 0 }, ready: true, hackingId: 0, progressX10: 0, myCooldownS: 0 }],
    self: { robotId: SELF_ID, moveSrc: CS_HUMAN, turretSrc: CS_HUMAN, aiRoundsLeft: 0, aiTokensLeftK: 0, assistOn: false, dashReadyTick: 0, fireReadyTick: 0 },
    gone: { robots: [], projectiles: [], cores: [] },
  }
}

class Fixture {
  constructor() {
    this.conns = new Set()
    this.inputs = []
    this.joins = 0
    this.assistToggles = 0
    this.st = freshState()
  }

  attach(server) {
    const wss = new WebSocketServer({ noServer: true })
    this.wss = wss
    server.on('upgrade', (req, sock, head) => {
      const { pathname } = new URL(req.url, 'http://localhost')
      if (pathname !== '/ws') { sock.destroy(); return }
      wss.handleUpgrade(req, sock, head, ws => this.onWs(ws))
    })
  }

  onWs(ws) {
    const conn = { ws, joined: false }
    this.conns.add(conn)
    ws.on('message', data => this.onFrame(conn, Buffer.from(data)))
    ws.on('close', () => this.conns.delete(conn))
    ws.on('error', () => {})
  }

  onFrame(conn, buf) {
    if (buf[0] === 0x00) { conn.ws.send(Buffer.from([0x01])); return } // ping -> pong (net.ts 4s watchdog)
    if (buf[0] !== 0x02) return
    let msg
    try { msg = fromBinary(ClientMsgSchema, buf.subarray(1)) } catch { return }
    const c = msg.payload
    if (c.case === 'join') { this.joins++; this.accept(conn) }
    else if (c.case === 'input') {
      const v = c.value
      this.inputs.push({ seq: v.seq, moveX: v.moveX, moveY: v.moveY, fire: v.fire, aim: v.aim, dash: v.dash, shield: v.shield, interact: v.interact, axisMask: v.axisMask })
    }
    else if (c.case === 'assistToggle') {
      this.assistToggles++
      this.st.self.assistOn = !this.st.self.assistOn
      // authoritative echo: broadcast a delta carrying the new assist_on
      this.pushDelta()
    }
    else if (c.case === 'resyncRequest') { this.sendFull() }
    // roomAction / scriptSubmit / aiPrompt: ignored by fixture
  }

  send(conn, msg) { if (conn.ws.readyState === 1) conn.ws.send(Buffer.concat([Buffer.from([0x03]), toBinary(ServerMsgSchema, msg)])) }
  bcast(msg) { for (const c of this.conns) this.send(c, msg) }

  event(kindCase, schema, val, tick = this.st.tick) {
    return create(ServerMsgSchema, { payload: { case: 'event', value: create(ServerEventSchema, { tick, kind: { case: kindCase, value: create(schema, val) } }) } })
  }

  /** join acceptance: roomState -> mapBootstrap -> full snapshot (state resets each join) */
  accept(conn) {
    conn.joined = true
    this.st = freshState()
    this.inputs = []
    this.send(conn, this.event('roomState', EvRoomStateSchema, { state: R_WARMUP, robotsOnline: 2, hostNick: 'feelfix' }, 0))
    this.send(conn, this.event('mapBootstrap', EvMapBootstrapSchema, { mapJson: MAP_JSON, mapHash: 'feelfix01', generatorVersion: 2 }, 0))
    this.sendFull(conn)
  }

  buildDelta(full, baseTick) {
    const st = this.st
    const ack = this.inputs.length ? this.inputs[this.inputs.length - 1].seq : 0
    const robots = st.robots.map(r => full
      ? { base: r.base, hpX10: r.hpX10, energyX10: r.energyX10, shieldOn: r.shieldOn, dashing: r.dashing, dead: r.dead, respawnInS: r.respawnInS, nick: r.nick, color: r.color, isPartner: r.isPartner }
      : { base: r.base, hpX10: r.hpX10, energyX10: r.energyX10, shieldOn: r.shieldOn, dashing: r.dashing, dead: r.dead, respawnInS: r.respawnInS })
    return create(SnapshotDeltaSchema, {
      tick: st.tick, ackSeq: ack, phase: PHASE_OUTER, timeLeftS: st.timeLeftS,
      full, baseTick,
      robots, robotGone: st.gone.robots,
      projectiles: st.projectiles, projectileGone: st.gone.projectiles,
      cores: st.cores, coreGone: st.gone.cores,
      uplinks: st.uplinks,
      self: st.self,
    })
  }

  sendFull(conn) {
    const msg = create(ServerMsgSchema, { payload: { case: 'snapshot', value: this.buildDelta(true, 0) } })
    if (conn) this.send(conn, msg); else this.bcast(msg)
  }

  pushDelta() {
    this.bcast(create(ServerMsgSchema, { payload: { case: 'snapshot', value: this.buildDelta(false, this.st.tick) } }))
  }

  /** one deterministic snapshot step: tick+=2, mutate, delta broadcast, settle */
  async step(mut) {
    const st = this.st
    const prev = st.tick
    st.tick += 2
    if (st.tick % 4 === 0 && st.timeLeftS > 0) st.timeLeftS -= 1
    st.gone = { robots: [], projectiles: [], cores: [] }
    if (mut) mut(st)
    this.pushDeltaWithBase(prev)
    await sleep(26) // >= 1 client input frame at 60 Hz
  }

  pushDeltaWithBase(baseTick) {
    this.bcast(create(ServerMsgSchema, { payload: { case: 'snapshot', value: this.buildDelta(false, baseTick) } }))
  }
}

// ---------------------------------------------------------------- http static
function startHttp() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (p === '/' || !existsSync(join(DIST, p))) p = '/index.html'
    const file = join(DIST, p)
    if (!existsSync(file) || !file.startsWith(DIST)) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)))
}

// ---------------------------------------------------------------- audio probe
// Init-script instrumentation: the real WebAudio implementation is untouched
// (every patch chains the original). We record context creation, node .start
// calls, created gain nodes and the connect() edge list so the test can find
// the MASTER gain (the GainNode connected to AudioDestinationNode) and verify
// real oscillators/buffers start and master mute drives it to exactly 0.
const AUDIO_INIT = `(() => {
  const log = (window.__ombAudio = { contexts: 0, started: [], gains: [], edges: [] })
  try {
    const AC = window.AudioContext
    function PatchedAC(...a) { const c = Reflect.construct(AC, a); log.contexts++; return c }
    Object.setPrototypeOf(PatchedAC, AC); PatchedAC.prototype = AC.prototype
    window.AudioContext = PatchedAC
  } catch {}
  try {
    const wrap = (proto, key, tag) => { if (!proto) return; const o = proto[key]; if (!o) return; proto[key] = function (...a) { try { log.started.push(tag) } catch {} return o.apply(this, a) } }
    wrap(window.OscillatorNode && window.OscillatorNode.prototype, 'start', 'osc')
    wrap(window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype, 'start', 'buf')
    const BA = window.BaseAudioContext && window.BaseAudioContext.prototype
    if (BA && BA.createGain) { const og = BA.createGain; BA.createGain = function (...a) { const g = og.apply(this, a); try { log.gains.push(g) } catch {} return g } }
    if (window.AudioNode && window.AudioNode.prototype) {
      const oc = window.AudioNode.prototype.connect
      window.AudioNode.prototype.connect = function (d, ...a) { try { log.edges.push([this, d]) } catch {} return oc.call(this, d, ...a) }
    }
  } catch {}
})()`

const audioStarted = page => page.evaluate(() => (window.__ombAudio ? window.__ombAudio.started.length : 0))
/** master = first GainNode the engine creates (ensure(): compressor -> gain -> destination) */
const masterGainValue = page => page.evaluate(() => {
  const l = window.__ombAudio
  if (!l || !l.gains.length) return null
  try { return l.gains[0].gain.value } catch { return null }
})
/** live loudness: analyser tapped off master gain, max |sample| of one buffer */
const audioPeak = page => page.evaluate(() => {
  const l = window.__ombAudio
  if (!l || !l.gains.length) return null
  if (!l.analyser) {
    try {
      const g = l.gains[0]
      const an = g.context.createAnalyser()
      an.fftSize = 2048
      g.connect(an) // parallel tap; does not alter the audio graph output
      l.analyser = an
    } catch { return null }
  }
  const buf = new Float32Array(l.analyser.fftSize)
  l.analyser.getFloatTimeDomainData(buf)
  let m = 0
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a }
  return m
})
/** max peak observed while polling for ~ms (catches short cues) */
async function audioPeakOver(page, ms) {
  let peak = 0
  const end = Date.now() + ms
  while (Date.now() < end) {
    const p = await audioPeak(page)
    if (p != null && p > peak) peak = p
    await sleep(40)
  }
  return peak
}

// ---------------------------------------------------------------- helpers
async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready) // 925 KB local font must be ready
  await page.screenshot({ path: join(SHOTS, name) })
}

/** center-crop canvas buffer for visual-diff asserts (camera centers on self) */
async function canvasCenter(page) {
  const box = await page.locator('#game-canvas').boundingBox()
  const size = Math.min(240, Math.floor(Math.min(box.width, box.height) / 2))
  return page.screenshot({ clip: { x: box.x + box.width / 2 - size / 2, y: box.y + box.height / 2 - size / 2, width: size, height: size } })
}

async function joinGame(page, fix, errors) {
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE)
  await page.evaluate(() => document.fonts.ready)
  await page.fill('#in-room', 'FEEL1')
  await page.fill('#in-nick', 'feeltest')
  await page.click('#btn-join')
  await page.locator('#view-game').waitFor({ state: 'visible', timeout: 10000 })
  // sampler drops all-zero frames (controls.ts: `if (!active) return`), so wake
  // the sticky aim axis with small real mouse moves until input frames flow
  const end = Date.now() + 10000
  while (Date.now() < end && fix.inputs.length === 0) {
    const v = page.viewportSize()
    await page.mouse.move(Math.floor(v.width / 2), Math.floor(v.height / 2))
    await page.mouse.move(Math.floor(v.width / 2) + 80, Math.floor(v.height / 2) + 40)
    await sleep(120)
  }
}

const lastSeq = fix => (fix.inputs.length ? fix.inputs[fix.inputs.length - 1].seq : 0)
const framesSince = (fix, mark) => fix.inputs.filter(i => i.seq > mark)

async function hudMsgText(page) {
  return (await page.locator('#hud-msg').textContent().catch(() => '')) || ''
}

/** pairwise no-overlap of large HUD regions at current viewport */
async function assertNoHudOverlap(page, label) {
  const boxes = await page.evaluate(() => {
    const sels = ['.hud-top', '.hud-left', '.hud-right', '.hud-hint', '#connection-notice', '#hud-msg', '#audio-settings', '.game-tools']
    const out = []
    for (const s of sels) for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect()
      if (r.width < 24 || r.height < 10) continue
      const st = getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue
      out.push({ name: s.replace(/^\./, ''), x: r.x, y: r.y, w: r.width, h: r.height })
    }
    return out
  })
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j], T = 2
    if (a.x < b.x + b.w - T && b.x < a.x + a.w - T && a.y < b.y + b.h - T && b.y < a.y + a.h - T)
      assert.fail(`[${label}] HUD overlap: ${a.name} (${Math.round(a.w)}x${Math.round(a.h)}) ∩ ${b.name} (${Math.round(b.w)}x${Math.round(b.h)})`)
  }
  return boxes.length
}

async function skillHudText(page) {
  const root = page.locator('.hud-skills')
  assert.ok(await root.count() === 1, '.hud-skills container must exist')
  assert.equal(await root.locator('.skill').count(), 5, 'expected exactly 5 skill cards')
  return (await root.locator('#skill-dash-cd').textContent()) || ''
}

// ---------------------------------------------------------------- scenario
async function fullPass(browser, fix) {
  const ctx = await browser.newContext({ viewport: { width: 2048, height: 1152 }, deviceScaleFactor: 1.25 })
  await ctx.addInitScript(AUDIO_INIT)
  const page = await ctx.newPage()
  page.setDefaultTimeout(9000)
  const errors = []
  try {
    await joinGame(page, fix, errors)
    await until(() => fix.inputs.length > 0, 'input frames after join (sampler active)')
    assert.ok(fix.joins >= 1, 'fixture accepted join')

    // audio engine lazily creates its AudioContext on first trusted pointer/key
    // event (audio.unlock()); 'z' is not bound to any input axis
    await page.keyboard.press('z')
    await until(async () => (await page.evaluate(() => window.__ombAudio.contexts)) >= 1, 'AudioContext created on trusted input', 5000)
    // master = first created gain (ensure(): compressor -> gain -> destination)
    assert.ok(await masterGainValue(page) !== null, 'master gain node exists (first createGain)')
    const masterBefore = await masterGainValue(page)
    assert.ok(masterBefore > 0, `master gain >0 before mute (got ${masterBefore})`)

    // --- baseline: default assist OFF, connection banner quiet
    const assist0 = ((await page.locator('#hud-assist').textContent()) || '').trim()
    assert.match(assist0, /OFF/i, `default assist must be OFF (got "${assist0}")`)
    assert.equal(await page.locator('#connection-notice').count(), 1)
    assert.ok(await page.locator('#connection-notice').isHidden(), 'healthy connection banner is hidden')
    await shot(page, '01-baseline-desktop-2048x1152.png')

    // --- stationary aim: mouse move changes ClientInput aim (AXIS_AIM), no move echo
    const aimMark = lastSeq(fix)
    await page.mouse.move(1024, 400)
    await sleep(200)
    await page.mouse.move(1500, 700)
    await sleep(200)
    const aimFrames = framesSince(fix, aimMark).filter(f => (f.axisMask & 0b10) !== 0)
    assert.ok(aimFrames.length >= 5, `aim takeover frames >=5, got ${aimFrames.length}`)
    const aimSpread = Math.max(...aimFrames.map(f => f.aim)) - Math.min(...aimFrames.map(f => f.aim))
    assert.ok(aimSpread > 0.2, `stationary aim must change ClientInput.aim (spread ${aimSpread.toFixed(3)} rad)`)
    assert.ok(aimFrames.every(f => f.moveX === 0 && f.moveY === 0), 'aim-only: no movement echo while stationary')
    // local visual: canvas center must repaint between two distinct aim headings
    const visA = await canvasCenter(page)
    await page.mouse.move(300, 1000)
    await sleep(250)
    const visB = await canvasCenter(page)
    assert.ok(!visA.equals(visB), 'canvas must repaint locally on aim change (no server echo needed)')

    // --- assist echo: Space toggles upstream; authoritative delta flips HUD
    await page.keyboard.press(' ')
    await until(() => fix.assistToggles >= 1, 'assistToggle upstream')
    await until(async () => /ON/i.test(((await page.locator('#hud-assist').textContent()) || '').trim()), 'HUD assist ON after authoritative delta')
    await page.keyboard.press(' ')
    await until(async () => /OFF/i.test(((await page.locator('#hud-assist').textContent()) || '').trim()), 'HUD assist OFF after second authoritative delta')

    // --- held E then F across >=10 input frames, release false
    for (const key of ['e', 'f']) {
      const mark = lastSeq(fix)
      await page.keyboard.down(key)
      await sleep(300)
      const held = framesSince(fix, mark)
      const on = held.filter(f => f.interact === true && f.fire === false)
      assert.ok(on.length >= 10, `held ${key.toUpperCase()}: >=10 interact frames (got ${on.length}/${held.length})`)
      const releaseMark = lastSeq(fix)
      await page.keyboard.up(key)
      await until(() => framesSince(fix, releaseMark).filter(f => !f.interact).length >= 8, `${key.toUpperCase()} release produces eight stopping frames`)
      const tail = fix.inputs.slice(-8)
      assert.ok(tail.every(f => f.interact === false), `${key.toUpperCase()} release stays stopped (tail: ${JSON.stringify(tail.map(f => f.interact))})`)
    }

    // --- dash edge: Shift press produces an edge, not a held level
    const dashMark = lastSeq(fix)
    await page.keyboard.down('Shift')
    await sleep(180)
    await page.keyboard.up('Shift')
    const dashFrames = framesSince(fix, dashMark).filter(f => f.dash === true)
    assert.ok(dashFrames.length >= 1 && dashFrames.length <= 2, `dash is edge-triggered (got ${dashFrames.length} dash frames)`)

    // --- shot + impact + shield visual + audio (deterministic timing)
    const a0 = await audioStarted(page)
    await fix.step(st => {
      st.projectiles.push({ base: { id: 910, pos: { x: 0.5, y: 0 }, heading: -0.358 }, ownerId: SELF_ID })
    })
    fix.bcast(fix.event('shot', EvShotSchema, { projectile: 910, owner: SELF_ID, at: create(Vec2Schema, { x: 0, y: 0 }), heading: -0.358 }))
    await sleep(60)
    await shot(page, '02-shot.png')
    const a1 = await audioStarted(page)
    assert.ok(a1 > a0, `shot must start real audio nodes (${a0} -> ${a1})`)

    await fix.step(st => {
      st.projectiles = st.projectiles.filter(p => p.base.id !== 910)
      st.gone.projectiles.push(910)
      st.robots[1].shieldOn = true
    })
    fix.bcast(fix.event('projectileImpact', EvProjectileImpactSchema, { projectile: 910, owner: SELF_ID, target: ENEMY_ID, at: create(Vec2Schema, ENEMY_POS), shield: true, invulnerable: false }))
    await sleep(60)
    await shot(page, '03-shield-impact.png')
    const a2 = await audioStarted(page)
    assert.ok(a2 > a1, `impact/shield must start real audio nodes (${a1} -> ${a2})`)
    await fix.step(() => {})
    await fix.step(st => { st.robots[1].shieldOn = false })

    // --- core spawn feedback (new core in delta => spawn cue fires)
    const a3 = await audioStarted(page)
    await fix.step(st => { st.cores.push({ base: { id: 920, pos: { x: 4, y: 2 }, heading: 0 }, value: 10 }) })
    await sleep(60)
    assert.ok((await audioStarted(page)) > a3, 'core spawn must start audio nodes (strictly)')

    // --- full resync is a quiet baseline: no replayed sounds/effects/messages
    await until(async () => await hudMsgText(page) === '', 'previous status message expires')
    const aQuiet = await audioStarted(page)
    const quietMessage = await hudMsgText(page)
    fix.sendFull()
    await sleep(700)
    assert.equal(await audioStarted(page), aQuiet, 'full resync must not replay shot/impact/spawn audio')
    assert.equal(await hudMsgText(page), quietMessage, 'full resync must not replay messages')

    // --- uplink: hold E; 25% / 75% visuals, completion, personal CD deny, interruption
    await page.keyboard.down('e')
    await fix.step(st => { st.uplinks[0] = { ...st.uplinks[0], ready: true, hackingId: SELF_ID, progressX10: 5, myCooldownS: 0 } })
    await fix.step(st => { st.uplinks[0].progressX10 = 20 }) // 2.0s / 8.0s = 25%
    assert.match(await hudMsgText(page), /黑入/, `uplink 25%: hacking banner expected (got "${await hudMsgText(page)}")`)
    assert.equal(await page.locator('#hud-uplink-track').getAttribute('aria-valuenow'), '25')
    assert.equal(await page.locator('#skill-uplink-cd').innerText(), '25%')
    await shot(page, '04-uplink25.png')
    const vis25 = await canvasCenter(page)
    await fix.step(st => { st.uplinks[0].progressX10 = 40 })
    await fix.step(st => { st.uplinks[0].progressX10 = 60 }) // 75%
    assert.equal(await page.locator('#hud-uplink-track').getAttribute('aria-valuenow'), '75')
    assert.equal(await page.locator('#skill-uplink-cd').innerText(), '75%')
    await shot(page, '05-uplink75.png')
    const vis75 = await canvasCenter(page)
    assert.ok(!vis25.equals(vis75), 'uplink progress circle must visually advance 25% -> 75%')
    // completion: authoritative EvUplinkHack + ready drop + personal 30s CD
    const aDone = await audioStarted(page)
    await fix.step(st => { st.uplinks[0].progressX10 = 80 })
    fix.bcast(fix.event('uplinkHack', EvUplinkHackSchema, { by: SELF_ID, uplinkId: UPLINK_ID, value: 10 }))
    await fix.step(st => { st.uplinks[0] = { ...st.uplinks[0], ready: false, hackingId: 0, progressX10: 0, myCooldownS: 30 } })
    await page.keyboard.up('e')
    await sleep(120)
    assert.ok((await audioStarted(page)) > aDone, 'uplink completion must fire success audio')
    assert.match(await hudMsgText(page), /黑入完成/)
    assert.equal(await page.locator('#skill-uplink-cd').innerText(), '30s')
    // personal CD: re-attempt interact while on cooldown must fire deny cue
    const aDeny = await audioStarted(page)
    await page.keyboard.down('e')
    await sleep(300)
    await page.keyboard.up('e')
    assert.ok((await audioStarted(page)) > aDeny, 'personal-cooldown re-attempt must fire deny cue')
    // interruption: fresh channel progress then authoritative break
    await fix.step(st => { st.uplinks[0] = { ...st.uplinks[0], ready: true, hackingId: SELF_ID, progressX10: 10, myCooldownS: 0 } })
    await page.keyboard.down('e')
    await sleep(120)
    await page.keyboard.up('e')
    await fix.step(st => { st.uplinks[0].hackingId = 0; st.uplinks[0].progressX10 = 0 })
    await until(async () => /中断/.test(await hudMsgText(page)), 'uplink interruption message (中断)', 3000)

    // --- dash cooldown HUD countdown from authoritative dashReadyTick (30 s)
    await fix.step(st => { st.self.dashReadyTick = st.tick + 1800 })
    const cdText0 = await skillHudText(page)
    assert.match(cdText0, /\d/, `cooldown text present after state (got "${cdText0}")`)
    await shot(page, '06-dash-cooldown.png')
    const nums = [(cdText0.match(/(\d+(?:\.\d+)?)/) || ['x'])[0]]
    for (let i = 0; i < 40; i++) {
      await fix.step(() => {})
      const t = await skillHudText(page)
      const m = t.match(/(\d+(?:\.\d+)?)/)
      if (m) nums.push(m[1])
    }
    const vals = nums.map(Number)
    assert.ok(vals.length >= 2, `multiple cooldown samples (${JSON.stringify(nums)})`)
    for (let i = 1; i < vals.length; i++) assert.ok(vals[i] <= vals[i - 1], `cooldown must not increase (${vals.join(' -> ')})`)
    assert.ok(vals[0] > vals[vals.length - 1], `cooldown must visibly decrease (${vals.join(' -> ')})`)

    // --- desktop type sizes: HP label >=16px, bar >=10px
    const hpFont = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#hud-hp-text')).fontSize))
    const barH = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.hud-bar')).height))
    assert.ok(hpFont >= 16, `HP label font >=16px on desktop (got ${hpFont}px)`)
    assert.ok(barH >= 10, `HP/EN bar height >=10px (got ${barH}px)`)

    // --- HUD clock counts down (authoritative time_left_s)
    const times = []
    for (let i = 0; i < 8; i++) { await fix.step(() => {}); times.push(await page.locator('#hud-time').textContent()) }
    assert.ok(new Set(times).size > 1, `hud-time must reflect countdown (${times.join('|')})`)

    // --- audio settings persisted controls (#audio-settings > #audio-mute/#audio-volume)
    const panel = page.locator('#audio-settings')
    assert.equal(await panel.count(), 1, '#audio-settings panel must exist')
    const mute = panel.locator('#audio-mute')
    const vol = panel.locator('#audio-volume')
    assert.equal(await mute.count(), 1, '#audio-mute must exist inside #audio-settings')
    assert.equal(await vol.count(), 1, '#audio-volume must exist inside #audio-settings')

    await panel.locator('summary').click()
    await mute.click()
    await sleep(180)
    assert.ok(Math.abs(await masterGainValue(page)) < 1e-6, 'mute must fade master gain below audibility')
    const controlReflectsMute = await page.evaluate(() => {
      const el = document.querySelector('#audio-mute')
      if (!el) return false
      return el.getAttribute('aria-pressed') === 'true' || el.checked === true || el.dataset.muted === 'true' || el.classList.contains('on') || el.classList.contains('muted')
    })
    assert.ok(controlReflectsMute, '#audio-mute control must reflect muted state')

    await vol.evaluate(el => { el.value = '40'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) })
    await sleep(150)
    const lsAfterVol = await page.evaluate(() => JSON.stringify(localStorage))
    assert.match(lsAfterVol, /audio|omb|sound|mute|volume/i, `audio settings persisted to localStorage (got ${lsAfterVol})`)

    // persisted across reload (fixture auto-accepts re-join)
    const joinsBefore = fix.joins
    await page.reload()
    await page.locator('#view-game').waitFor({ state: 'visible', timeout: 10000 })
    await until(() => fix.joins > joinsBefore, 're-join after reload')
    await page.mouse.move(1200, 600)
    await until(() => fix.inputs.length >= 5, 'sampler resumed after reload')
    const after = await page.evaluate(() => {
      const el = document.querySelector('#audio-mute'); const v = document.querySelector('#audio-volume')
      const m = el ? (el.getAttribute('aria-pressed') === 'true' || el.checked === true || el.dataset.muted === 'true' || el.classList.contains('on') || el.classList.contains('muted')) : null
      return { m, v: v ? v.value : null }
    })
    assert.equal(after.m, true, `mute persisted across reload (got ${after.m})`)
    assert.equal(String(after.v), '40', `volume persisted across reload (got ${after.v})`)
    // audio context is lazy + gesture-gated: re-wake it, then ensure() restores
    // persisted mute (master.gain = mute ? 0 : vol) on the FIRST created gain
    await page.keyboard.press('z')
    await until(async () => (await masterGainValue(page)) !== null, 'audio re-initialized after reload', 5000)
    assert.equal(await masterGainValue(page), 0, 'persisted mute must keep MASTER gain at exactly 0')

    // --- unmute restores audible master: live RMS via analyser tap on master gain
    await page.locator('#audio-settings summary').click()
    await page.locator('#audio-mute').click()
    await sleep(150)
    const masterRestored = await masterGainValue(page)
    assert.ok(masterRestored > 0, `unmute must restore master gain >0 (got ${masterRestored})`)
    await fix.step(st => { st.robots[0].base.pos = { x: 20, y: 0 } }) // leave uplink hum
    await page.locator('#audio-settings summary').click()
    await sleep(900)
    assert.ok((await audioPeakOver(page, 200)) < 0.001, 'idle baseline must be silent before shot')
    await fix.step(st => { st.projectiles.push({ base: { id: 911, pos: { x: 0.5, y: 0 }, heading: -0.358 }, ownerId: SELF_ID }) })
    fix.bcast(fix.event('shot', EvShotSchema, { projectile: 911, owner: SELF_ID, at: create(Vec2Schema, { x: 20, y: 0 }), heading: -0.358 }))
    const peak = await audioPeakOver(page, 900)
    assert.ok(peak > 0.001, `real oscillators must produce non-zero samples at master (peak ${peak})`)

    // --- overlap validation at this viewport (post-reconnect HUD state)
    await assertNoHudOverlap(page, 'desktop-2048x1152')
    assert.deepEqual(errors, [], 'no page errors during desktop pass')
  } finally {
    await ctx.close()
  }
}

/** condensed pass for extra viewports: join, E-hold, shot+shield+uplink, overlap */
async function quickPass(browser, fix, viewport, label, shotName) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  await ctx.addInitScript(AUDIO_INIT)
  const page = await ctx.newPage()
  page.setDefaultTimeout(9000)
  const errors = []
  try {
    await joinGame(page, fix, errors)
    await until(() => fix.inputs.length > 0, `input frames (${label})`)
    const mark = lastSeq(fix)
    await page.keyboard.down('e')
    await sleep(300)
    assert.ok(framesSince(fix, mark).filter(f => f.interact).length >= 10, `held E >=10 frames (${label})`)
    await page.keyboard.up('e')
    await fix.step(st => { st.projectiles.push({ base: { id: 910, pos: { x: 0.5, y: 0 }, heading: -0.358 }, ownerId: SELF_ID }) })
    fix.bcast(fix.event('shot', EvShotSchema, { projectile: 910, owner: SELF_ID, at: create(Vec2Schema, { x: 0, y: 0 }), heading: -0.358 }))
    await fix.step(st => {
      st.projectiles = st.projectiles.filter(p => p.base.id !== 910)
      st.gone.projectiles.push(910)
      st.robots[1].shieldOn = true
      st.uplinks[0] = { ...st.uplinks[0], ready: true, hackingId: SELF_ID, progressX10: 60, myCooldownS: 0 }
    })
    fix.bcast(fix.event('projectileImpact', EvProjectileImpactSchema, { projectile: 910, owner: SELF_ID, target: ENEMY_ID, at: create(Vec2Schema, ENEMY_POS), shield: true, invulnerable: false }))
    await sleep(60)
    await shot(page, shotName)
    await assertNoHudOverlap(page, label)
    assert.deepEqual(errors, [], `no page errors (${label})`)
  } finally {
    await ctx.close()
  }
}

/** prefers-reduced-motion: pipeline works and no DOM/CSS animations run on events */
async function reducedMotionPass(browser, fix) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 }, reducedMotion: 'reduce' })
  await ctx.addInitScript(AUDIO_INIT)
  const page = await ctx.newPage()
  page.setDefaultTimeout(9000)
  const errors = []
  try {
    await joinGame(page, fix, errors)
    await until(() => fix.inputs.length > 0, 'input frames (reduced-motion)')
    assert.ok(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), 'reduced-motion emulation active')
    const a0 = await audioStarted(page)
    await fix.step(st => { st.projectiles.push({ base: { id: 910, pos: { x: 0.5, y: 0 }, heading: -0.358 }, ownerId: SELF_ID }) })
    fix.bcast(fix.event('shot', EvShotSchema, { projectile: 910, owner: SELF_ID, at: create(Vec2Schema, { x: 0, y: 0 }), heading: -0.358 }))
    await fix.step(st => {
      st.projectiles = st.projectiles.filter(p => p.base.id !== 910)
      st.gone.projectiles.push(910)
      st.robots[1].shieldOn = true
    })
    fix.bcast(fix.event('projectileImpact', EvProjectileImpactSchema, { projectile: 910, owner: SELF_ID, target: ENEMY_ID, at: create(Vec2Schema, ENEMY_POS), shield: true, invulnerable: false }))
    await sleep(150)
    const anims = await page.evaluate(() => document.getAnimations({ subtree: true }).length)
    assert.equal(anims, 0, `reduced-motion must suppress DOM/CSS animations (found ${anims})`)
    assert.ok((await audioStarted(page)) > a0, 'audio cues still fire under reduced-motion')
    await shot(page, '08-reduced-motion.png')
    assert.deepEqual(errors, [], 'no page errors (reduced-motion)')
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- main
if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`dist missing: ${join(DIST, 'index.html')} — run "npm run build" in client/ first (main triggers builds)`)
  process.exit(1)
}
mkdirSync(SHOTS, { recursive: true })

const server = await startHttp()
const fix = new Fixture()
fix.attach(server)
let browser
try {
  browser = await chromium.launch()
  await fullPass(browser, fix)
  await quickPass(browser, fix, { width: 900, height: 600 }, 'mid-900x600', '09-action-900x600.png')
  await quickPass(browser, fix, { width: 480, height: 820 }, 'mobile-480x820', '10-action-480x820.png')
  await reducedMotionPass(browser, fix)

  console.log('\n=== game-feel-check PASS ===')
  console.log(`joins accepted: ${fix.joins}, input frames captured: ${fix.inputs.length}`)
  console.log(`screenshots in: ${SHOTS}`)
} finally {
  if (browser) await browser.close()
  for (const c of fix.conns) { try { c.ws.terminate() } catch {} }
  try { fix.wss.close() } catch {}
  server.close()
}
