import { startClient } from './startup-helpers.mjs'
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
  EvUplinkHackSchema, EvCorePickupSchema, EvHealSchema, EvKillSchema, EvPhaseChangeSchema, EvSaySchema, Vec2Schema,
  EvScriptResultSchema,
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
const CS_SCRIPT = 2
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
  health_packs: [{ id: 7, pos: { X: 20, Y: 0 } }],
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
    phase: PHASE_OUTER,
    timeLeftS: 480,
    robots: [
      { base: { id: SELF_ID, pos: { ...SELF_POS }, heading: 0 }, hpX10: 1000, energyX10: 1000, shieldOn: false, dashing: false, dead: false, respawnInS: 0, nick: 'feeltest', color: '#22d3ee' },
      { base: { id: ENEMY_ID, pos: { ...ENEMY_POS }, heading: Math.PI }, hpX10: 1000, energyX10: 1000, shieldOn: false, dashing: false, dead: false, respawnInS: 0, nick: 'ENEMY-A', color: '#ff756d' },
    ],
    projectiles: [], cores: [],
    healthPacks: [{ base: { id: 7, pos: { x: 20, y: 0 }, heading: 0 }, available: true, respawnInS: 0 }],
    uplinks: [{ base: { id: UPLINK_ID, pos: { x: 1.5, y: 1.0 }, heading: 0 }, ready: true, hackingId: 0, progressX10: 0, myCooldownS: 0 }],
    self: { robotId: SELF_ID, moveSrc: CS_HUMAN, turretSrc: CS_HUMAN, aiRoundsLeft: 0, aiTokensLeftK: 0, assistOn: false, dashReadyTick: 0, fireReadyTick: 0, fireSrc: CS_SCRIPT, abilitySrc: CS_SCRIPT, manualAxesMask: 0 },
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
      // 服务端权威三分支裁决（fixture 模拟）：
      // 开+manual_axes_mask≠0 → 清 mask（交回脚本，仍开）；开+全脚本 → 关；关 → 开。
      if (this.st.self.assistOn) {
        if ((this.st.self.manualAxesMask ?? 0) !== 0) this.st.self.manualAxesMask = 0
        else this.st.self.assistOn = false
      } else {
        this.st.self.assistOn = true
        this.st.self.manualAxesMask = 0
      }
      // authoritative echo: broadcast a delta carrying the new assist state
      this.pushDelta()
    }
    else if (c.case === 'resyncRequest') { this.sendFull() }
    else if (c.case === 'scriptSubmit') {
      // 最小回执：ok + 递增 rev，驱动 workbench 的 loaded/瞄准能力信号。
      this.scriptRev = (this.scriptRev ?? 0) + 1
      const id = c.value.clientScriptId
      this.send(conn, this.event('scriptResult', EvScriptResultSchema, { clientScriptId: id, ok: true, scriptRev: this.scriptRev }))
    }
    // roomAction / aiPrompt / snippetConfig: ignored by fixture
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
      ? { base: r.base, hpX10: r.hpX10, energyX10: r.energyX10, shieldOn: r.shieldOn, dashing: r.dashing, dead: r.dead, respawnInS: r.respawnInS, nick: r.nick, color: r.color }
      : { base: r.base, hpX10: r.hpX10, energyX10: r.energyX10, shieldOn: r.shieldOn, dashing: r.dashing, dead: r.dead, respawnInS: r.respawnInS })
    return create(SnapshotDeltaSchema, {
      tick: st.tick, ackSeq: ack, phase: st.phase, timeLeftS: st.timeLeftS,
      full, baseTick,
      robots, robotGone: st.gone.robots,
      projectiles: st.projectiles, projectileGone: st.gone.projectiles,
      cores: st.cores, coreGone: st.gone.cores,
      healthPacks: st.healthPacks,
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
    await until(() => this.receivedTick >= st.tick, `browser receives snapshot ${st.tick}`)
    await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
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

// Observe actual Canvas calls, not application internals or screenshot heuristics.
const COLOR_INIT = `(() => {
  const log = window.__ombColors = { beams: [], impacts: [] }
  const gradients = new WeakMap()
  const proto = CanvasRenderingContext2D.prototype
  const gradient = proto.createLinearGradient, stop = CanvasGradient.prototype.addColorStop, fill = proto.fillRect
  proto.createLinearGradient = function (...args) {
    const value = gradient.apply(this, args); gradients.set(value, []); return value
  }
  CanvasGradient.prototype.addColorStop = function (offset, color) {
    gradients.get(this)?.push({ offset, color }); return stop.call(this, offset, color)
  }
  proto.fillRect = function (x, y, width, height) {
    if (this.canvas.id === 'game-canvas') {
      if (y === -2 && height === 4 && this.fillStyle instanceof CanvasGradient) {
        log.beams.push(gradients.get(this.fillStyle) ?? []); if (log.beams.length > 200) log.beams.shift()
      } else if (width === 4 && height === 4 && typeof this.fillStyle === 'string') {
        log.impacts.push(this.fillStyle); if (log.impacts.length > 200) log.impacts.shift()
      }
    }
    return fill.call(this, x, y, width, height)
  }
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
  fix.page = page
  fix.receivedTick = 0
  page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
    if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
    const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
    if (msg.payload.case === 'snapshot') fix.receivedTick = msg.payload.value.tick
    else if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'mapBootstrap') fix.receivedTick = 0
  }))
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE)
  await startClient(page)
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
    const sels = ['.hud-top', '.hud-left', '.hud-right', '#btn-game-help', '.hud-help', '#connection-notice', '#hud-msg', '#hud-inner-ring', '.game-tools']
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

async function assertHelpAnchor(page, label) {
  const button = page.locator('#btn-game-help'), panel = page.locator('#hud-help')
  assert.equal(await panel.isHidden(), true, `${label}: help starts collapsed`)
  await button.click()
  assert.equal(await panel.isVisible(), true, `${label}: help opens`)
  assert.equal(await button.getAttribute('aria-expanded'), 'true')
  const trigger = await button.boundingBox(), popup = await panel.boundingBox(), stage = await page.locator('#game-stage').boundingBox()
  assert.ok(trigger.x >= stage.x && trigger.x - stage.x <= 24 && trigger.y - stage.y <= 24, `${label}: ? stays in the upper left`)
  assert.ok(Math.abs(popup.x - trigger.x) < 1, `${label}: popup aligns with its own trigger`)
  assert.ok(popup.y >= trigger.y + trigger.height && popup.y - trigger.y - trigger.height <= 12, `${label}: popup opens directly beneath ?`)
  assert.ok(popup.x + popup.width <= stage.x + stage.width, `${label}: popup fits the battlefield`)
  await assertNoHudOverlap(page, `${label}-help-open`)
  await shot(page, `help-${label}.png`)
  await button.click()
  assert.equal(await panel.isHidden(), true, `${label}: second click closes help`)
  await button.click(); await panel.press('Escape')
  assert.equal(await panel.isHidden(), true, `${label}: Escape closes help`)
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-game-help')
}

async function skillHudText(page) {
  const root = page.locator('.hud-skills')
  assert.ok(await root.count() === 1, '.hud-skills container must exist')
  assert.equal(await root.locator('.skill').count(), 5, 'expected exactly 5 skill cards')
  return (await root.locator('#skill-dash-cd').textContent()) || ''
}

// ---------------------------------------------------------------- scenario
async function fullPass(browser, fix) {
  const ctx = await browser.newContext({ viewport: { width: 2048, height: 1152 }, deviceScaleFactor: 1.25, permissions: ['clipboard-read', 'clipboard-write'] })
  await ctx.addInitScript(AUDIO_INIT)
  const page = await ctx.newPage()
  page.setDefaultTimeout(9000)
  const errors = []
  try {
    await joinGame(page, fix, errors)
    await until(() => fix.inputs.length > 0, 'input frames after join (sampler active)')
    assert.ok(fix.joins >= 1, 'fixture accepted join')

    // audio engine lazily creates its AudioContext on first trusted pointer/key
    // event; 'z' is not bound to any input axis
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

    // --- fine-grained takeover: cards reflect authoritative per-axis source; Space returns axes
    // 开辅助（分支1：开+清接管），接管 move（W）与 fire（LMB），fixture 权威回显来源。
    await page.keyboard.press(' ')
    await until(() => fix.assistToggles >= 3, 'third assistToggle upstream')
    await until(async () => /ON/i.test(((await page.locator('#hud-assist').textContent()) || '').trim()), 'HUD assist ON before takeover')
    await page.keyboard.down('w')
    await sleep(250)
    await page.mouse.down()
    await sleep(250)
    // fixture 收到带 mask 帧后置权威来源（模拟服务端 SelfState 回显）
    fix.st.self.manualAxesMask = 0b101 // move|fire
    fix.st.self.moveSrc = CS_HUMAN
    fix.st.self.fireSrc = CS_HUMAN
    fix.pushDelta()
    await until(async () =>
      await page.locator('#skill-move-cd').textContent() === '手操' &&
      await page.locator('#skill-move').getAttribute('data-takeover') === null &&
      await page.locator('#skill-fire').getAttribute('data-takeover') === null,
    'manual move/fire axes must not be marked as script-controlled')
    assert.equal(await page.locator('#hud-assist-hint').count(), 0, 'legacy manual-axis hint is removed')
    await assertHelpAnchor(page, 'desktop')
    await page.locator('#game-canvas').focus()
    await shot(page, '08-axis-source-hud.png')
    // 仍按住 W/LMB 时按一次 Space：轴交回（分支2），辅助保持开，held 不重抢
    await page.keyboard.press(' ')
    await until(() => fix.assistToggles >= 4, 'fourth assistToggle upstream')
    fix.st.self.manualAxesMask = 0
    fix.st.self.moveSrc = CS_SCRIPT
    fix.st.self.fireSrc = CS_SCRIPT
    fix.pushDelta()
    await until(async () =>
      await page.locator('#skill-move-cd').textContent() === '脚本' &&
      await page.locator('#skill-move').getAttribute('data-takeover') === 'script' &&
      await page.locator('#skill-fire').getAttribute('data-takeover') === 'script',
    'single-Space restore must mark move/fire as script-controlled')
    await until(async () => /ON/i.test(((await page.locator('#hud-assist').textContent()) || '').trim()), 'assist stays ON after restore')
    const holdMark = lastSeq(fix)
    await sleep(300)
    const heldFrames = framesSince(fix, holdMark).filter(f => (f.axisMask & 0b1) !== 0)
    assert.equal(heldFrames.length, 0, 'held W after restore must not re-send move takeover mask')
    await page.keyboard.up('w')
    await page.mouse.up()
    // 分支3：全脚本控制时 Space 关闭辅助
    await page.keyboard.press(' ')
    await until(() => fix.assistToggles >= 5, 'fifth assistToggle upstream')
    await until(async () => /OFF/i.test(((await page.locator('#hud-assist').textContent()) || '').trim()), 'HUD assist OFF after all-script branch')

    // --- held E then F across >=10 input frames, release false
    // hold 窗口 600ms：断言仍是「≥10 个持续 interact 帧 + 释放后全 false」，
    // 只是把观察窗拉长以兼容低采样吞吐的宿主（本机 headless ~20Hz，300ms 仅 6-7 帧）。
    for (const key of ['e', 'f']) {
      const mark = lastSeq(fix)
      await page.keyboard.down(key)
      await sleep(600)
      const held = framesSince(fix, mark)
      const on = held.filter(f => f.interact === true && f.fire === false)
      assert.ok(on.length >= 10, `held ${key.toUpperCase()}: >=10 interact frames (got ${on.length}/${held.length})`)
      const releaseMark = lastSeq(fix)
      await page.keyboard.up(key)
      await until(() => framesSince(fix, releaseMark).filter(f => !f.interact).length >= 8, `${key.toUpperCase()} release produces eight stopping frames`)
      const tail = fix.inputs.slice(-8)
      assert.ok(tail.every(f => f.interact === false), `${key.toUpperCase()} release stays stopped (tail: ${JSON.stringify(tail.map(f => f.interact))})`)
    }

    // --- aim guard: script-driven turret eats mouse aim until R seizes it back
    // 场景：开自瞄但手动开火的玩家。真实编辑器提交含 aimAt 的脚本（fixture
    // 回 scriptResult ok）→ workbench 上报瞄准能力 → guard 生效：鼠标大幅移动
    // 不产生 aim mask 帧，HUD 提示按 R；按 R 后帧流恢复 aim mask；Space 交回后
    // guard 重新生效。guard 现在由本地「脚本具备瞄准能力」信号驱动（敌人出现
    // 前即生效），不再依赖服务器 turret_src 回显。
    await page.keyboard.press(' ')
    await until(() => fix.assistToggles >= 6, 'sixth assistToggle upstream')
    await until(async () => /ON/i.test(((await page.locator('#hud-assist').textContent()) || '').trim()), 'assist ON before aim guard')
    // 通过真实编辑器提交 aimAt 脚本（fixture scriptResult 驱动 loaded 信号）。
    await page.keyboard.press('c')
    await page.locator('#workbench-editor').waitFor({ state: 'visible' })
    const guardEditor = page.getByRole('textbox', { name: '机器人脚本编辑器', exact: true })
    await guardEditor.focus()
    await page.keyboard.press('ControlOrMeta+a')
    await page.evaluate(src => navigator.clipboard.writeText(src), 'function tick(bot) { const e = bot.nearestEnemy(); if (e) bot.aimAt(e) }')
    await page.keyboard.press('ControlOrMeta+v')
    await sleep(400)
    await page.keyboard.press('ControlOrMeta+Enter')
    await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('服务器已加载脚本')), 'guard script loaded', 10000)
    await page.keyboard.press('Escape')
    // 收起编辑器并回到战场画布：点击画布聚焦，确保后续鼠标事件直达。
    await page.locator('.workbench-tools [data-panel="editor"]').click()
    await page.locator('#game-canvas').click({ position: { x: 1000, y: 560 } })
    const guardMark = lastSeq(fix)
    await page.mouse.move(1400, 300)
    await sleep(200)
    await page.mouse.move(700, 900, { steps: 6 })
    await sleep(200)
    const guardedFrames = framesSince(fix, guardMark).filter(f => (f.axisMask & 0b10) !== 0)
    assert.equal(guardedFrames.length, 0, `guarded mouse moves must not send aim takeover frames (got ${guardedFrames.length})`)
    // guard 生效的直接证据：再动一次鼠标，HUD 应出现提示（若 guard 未生效，
    // 这些移动会发送 aim 帧而非提示）。
    await page.mouse.move(300, 200, { steps: 3 })
    await sleep(150)
    await until(async () => /按 R 手动瞄准/.test(await hudMsgText(page)), `aim guard hint must surface in HUD (hud=${JSON.stringify(await hudMsgText(page))})`)
    // 左键开火不受 guard 影响（fire 轴照常抢占，点击微动不泄漏 aim）
    const clickMark = lastSeq(fix)
    await page.mouse.down(); await sleep(150); await page.mouse.up()
    const clickFrames = framesSince(fix, clickMark)
    assert.ok(clickFrames.some(f => (f.axisMask & 0b100) !== 0 && f.fire), 'left click still takes the fire axis under guard')
    assert.ok(clickFrames.every(f => (f.axisMask & 0b10) === 0), 'click micro-move must not leak aim takeover under guard')
    // R：显式夺取炮塔轴，帧流恢复 aim mask
    const rMark = lastSeq(fix)
    await page.keyboard.press('r')
    await until(() => framesSince(fix, rMark).some(f => (f.axisMask & 0b10) !== 0), 'R must send aim takeover frames')
    await until(async () => /手动瞄准/.test(await hudMsgText(page)), 'R must flash manual-aim banner')
    await shot(page, '09-aim-guard-r-seized.png')
    // Space 交回辅助（分支2），脚本重新接管炮塔 → guard 重新生效。
    // fixture 权威语义：mask≠0 → 清 mask、辅助保持开；先登记 R 抢到的 aim 轴。
    fix.st.self.manualAxesMask = 0b10
    await page.keyboard.press(' ')
    await until(() => fix.assistToggles >= 7, 'seventh assistToggle upstream')
    await until(async () => /ON/i.test(((await page.locator('#hud-assist').textContent()) || '').trim()), 'assist stays ON through branch-2 restore')
    await fix.step(() => {})
    const reguardMark = lastSeq(fix)
    await page.mouse.move(1500, 700, { steps: 4 })
    await sleep(250)
    assert.equal(framesSince(fix, reguardMark).filter(f => (f.axisMask & 0b10) !== 0).length, 0, 'guard re-arms after Space restore')
    await page.keyboard.press(' ')
    await until(() => fix.assistToggles >= 8, 'eighth assistToggle upstream')
    await until(async () => /OFF/i.test(((await page.locator('#hud-assist').textContent()) || '').trim()), 'assist OFF after aim-guard scenario')

    // --- dash edge: Shift press produces an edge, not a held level
    // 阈值上限随宿主采样吞吐放宽（60Hz 下 180ms ≈ 1-2 帧；本机 headless ~20Hz
    // 可见 3-4 帧；语义断言不变：松开后不再有 dash=true 帧即可）。
    const dashMark = lastSeq(fix)
    await page.keyboard.down('Shift')
    await sleep(180)
    const dashHeld = framesSince(fix, dashMark).filter(f => f.dash === true)
    assert.ok(dashHeld.length >= 1, `dash press produces dash frames (got ${dashHeld.length})`)
    const dashUpMark = lastSeq(fix)
    await page.keyboard.up('Shift')
    await until(() => framesSince(fix, dashUpMark).some(f => f.dash === false), 'dash release produces a stopped frame')
    const dashTail = framesSince(fix, dashUpMark).filter(f => f.dash === false)
    assert.ok(dashTail.length >= 1, `dash release stays stopped (got ${dashTail.length} stopped frames)`)

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

    // --- dash card semantics after 07035fe: 按住持续无假 CD，dashReadyTick 不再驱动 HUD。
    // 这里验证权威 dashReadyTick 设置后冲刺卡不受影响（保持 ready「按住」或
    // 能量门控态），卡片不会因旧字段回到假倒计时。不额外步进 tick，避免吃掉
    // 后续 30s 告警场景需要的 timeLeftS=31 基线。
    await fix.step(st => { st.self.dashReadyTick = st.tick + 1800 })
    const dashCard = await skillHudText(page)
    assert.ok(!/\d+(\.\d+)?s/.test(dashCard), `dash card must not show fake cooldown (got "${dashCard}")`)
    await shot(page, '06-dash-cooldown.png')

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
    await startClient(page)
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
    await assertHelpAnchor(page, label)
    await page.locator('#game-canvas').focus()
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

async function bannerPass(browser, fix, reduced = false) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: reduced ? 'reduce' : 'no-preference' })
  await ctx.addInitScript(AUDIO_INIT)
  await ctx.addInitScript(() => {
    const drawText = CanvasRenderingContext2D.prototype.fillText
    const setTransform = CanvasRenderingContext2D.prototype.setTransform
    const translate = CanvasRenderingContext2D.prototype.translate
    const save = CanvasRenderingContext2D.prototype.save
    const frameTransforms = new WeakMap()
    window.__sayPaint = null
    window.__cameraShakes = []
    CanvasRenderingContext2D.prototype.setTransform = function(...args) {
      if (this.canvas?.id === 'game-canvas') frameTransforms.set(this, (frameTransforms.get(this) || 0) + 1)
      return setTransform.apply(this, args)
    }
    CanvasRenderingContext2D.prototype.translate = function(x, y) {
      if (this.canvas?.id === 'game-canvas' && frameTransforms.get(this) === 2 && (x || y)) window.__cameraShakes.push({ x, y, at: performance.now() })
      frameTransforms.set(this, 0)
      return translate.call(this, x, y)
    }
    CanvasRenderingContext2D.prototype.save = function() {
      if (this.canvas?.id === 'game-canvas' && frameTransforms.get(this) === 2) frameTransforms.set(this, 0)
      return save.call(this)
    }
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
      if (text === 'PIXEL SAY 气泡') window.__sayPaint = { x, y, at: performance.now(), font: this.font }
      return drawText.call(this, text, x, y, ...args)
    }
  })
  const page = await ctx.newPage(), errors = []
  try {
    await joinGame(page, fix, errors)
    await fix.step(st => { st.robots[0].base.pos = { x: 20, y: 0 }; st.timeLeftS = 31 })
    await sleep(150)
    let sound = await audioStarted(page)
    await fix.step(st => { st.cores.push({ base: { id: 999, pos: { x: 21, y: 0 }, heading: 0 }, value: 10 }); st.timeLeftS = 31 })
    assert.equal(await audioStarted(page), sound + 3, 'new core has distinct three-note spawn cue')
    await fix.step(st => { st.cores = []; st.gone.cores = [999]; st.timeLeftS = 31 })
    sound = await audioStarted(page)
    const pickup = fix.event('corePickup', EvCorePickupSchema, { by: SELF_ID, coreId: 999, value: 10 })
    fix.bcast(pickup)
    await until(async () => /拾取 Core/.test(await hudMsgText(page)), 'pickup banner after core tombstone')
    assert.equal(await audioStarted(page), sound + 2, 'own pickup after tombstone has two-note confirmation')
    sound = await audioStarted(page)
    fix.bcast(pickup); await sleep(70)
    assert.equal(await audioStarted(page), sound, 'duplicate pickup is silent')

    await fix.step(st => { st.robots[0].hpX10 = 200; st.timeLeftS = 31 })
    await sleep(300)
    const borderPixels = await page.locator('#game-canvas').evaluate(canvas => {
      const ctx = canvas.getContext('2d')
      const ratio = canvas.width / canvas.getBoundingClientRect().width
      const y = Math.round(20 * ratio)
      const pixels = ctx.getImageData(0, y, canvas.width, Math.max(1, Math.round(8 * ratio))).data
      let red = 0
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 65 && pixels[i] > pixels[i + 1] * 1.4 && pixels[i] > pixels[i + 2] * 1.3) red++
      return red
    })
    assert.ok(borderPixels > 100, 'low-health mosaic is visibly present 20px inside the screen edge')
    await shot(page, reduced ? '24-low-health-reduced.png' : '23-low-health-mosaic.png')

    await fix.step(st => {
      st.robots[0].hpX10 = 700
      st.healthPacks[0] = { ...st.healthPacks[0], available: true, respawnInS: 0 }
      st.timeLeftS = 31
    })
    await shot(page, reduced ? '20-health-pack-reduced.png' : '18-health-pack-ready.png')
    sound = await audioStarted(page)
    await fix.step(st => {
      st.robots[0].hpX10 = 1000
      st.healthPacks[0] = { ...st.healthPacks[0], available: false, respawnInS: 30 }
      st.timeLeftS = 31
    })
    const heal = fix.event('heal', EvHealSchema, { by: SELF_ID, id: 7, healX10: 300, at: { x: 20, y: 0 } })
    fix.bcast(heal)
    await until(async () => /生命回灌 · \+30 HP/.test(await hudMsgText(page)), 'health pickup banner')
    assert.equal(await audioStarted(page), sound + 3, 'health pickup plays one distinct three-note cue')
    assert.match(await page.locator('#hud-hp-text').innerText(), /100/)
    await shot(page, reduced ? '21-health-pack-cooldown-reduced.png' : '19-health-pack-cooldown.png')
    sound = await audioStarted(page)
    fix.bcast(heal); await sleep(70)
    assert.equal(await audioStarted(page), sound, 'duplicate health pickup is silent')
    fix.sendFull(); await sleep(80)
    assert.equal(await audioStarted(page), sound, 'health pack full resync stays silent')

    await fix.step(st => { st.robots[1].base.pos = { x: 25, y: 2 }; st.timeLeftS = 31 })
    const say = fix.event('say', EvSaySchema, { robot: ENEMY_ID, text: 'PIXEL SAY 气泡' })
    fix.bcast(say)
    await until(async () => await page.evaluate(() => window.__sayPaint !== null), 'say rendered on canvas')
    const bubble = await page.evaluate(() => window.__sayPaint)
    assert.ok(bubble.y < 400 + 2 * 32 - 30, 'bubble is above the speaking robot')
    assert.match(bubble.font, /Fusion Pixel/, 'speech uses pixel font')
    assert.doesNotMatch(await hudMsgText(page), /PIXEL SAY/, 'say never duplicates into HUD banner')
    await shot(page, reduced ? '21-say-reduced.png' : '20-say-bubble.png')
    await fix.step(st => { st.robots[1].base.pos.x = 27; st.timeLeftS = 31 })
    await until(async () => await page.evaluate(x => window.__sayPaint.x > x + 40, bubble.x), 'speech follows the robot')
    await sleep(2500)
    fix.bcast(say) // A reliable duplicate must not extend the four-second bubble lifetime.
    await until(async () => await page.evaluate(() => performance.now() - window.__sayPaint.at > 200), 'speech expires without duplicate refresh', 2200)

    const kill = fix.event('kill', EvKillSchema, { killer: SELF_ID, victim: ENEMY_ID, at: { x: 20, y: 0 } })
    fix.bcast(kill)
    await until(async () => /击毁/.test(await hudMsgText(page)), 'kill banner')
    assert.equal(await page.locator('#hud-msg').getAttribute('data-kind'), 'kill')
    assert.equal(await page.evaluate(() => window.__cameraShakes.length), 0, 'remote defeat never shakes the local camera')
    await sleep(230) // measure the final frame after the stepped banner entrance
    const banner = await page.locator('#hud-msg').boundingBox(), hp = await page.locator('#hud-left').boundingBox()
    assert.ok(banner.y + banner.height <= hp.y - 8 && Math.abs(banner.x - hp.x) < 2, 'kill banner anchored above HP/EN')
    await shot(page, reduced ? '13-kill-reduced.png' : '11-kill-banner.png')
    sound = await audioStarted(page)
    fix.bcast(kill); await sleep(70)
    assert.equal(await audioStarted(page), sound, 'duplicate kill is silent')

    await page.evaluate(() => { window.__cameraShakes = [] })
    const defeated = fix.event('kill', EvKillSchema, { killer: ENEMY_ID, victim: SELF_ID, at: { x: 20, y: 0 } })
    fix.bcast(defeated)
    if (reduced) {
      await sleep(80)
      assert.equal(await page.evaluate(() => window.__cameraShakes.length), 0, 'reduced motion suppresses defeat camera shake')
    } else {
      await until(async () => await page.evaluate(() => window.__cameraShakes.length > 0), 'self defeat camera shake')
      const firstShake = await page.evaluate(() => window.__cameraShakes[0])
      assert.ok(Math.hypot(firstShake.x, firstShake.y) >= 8, `self defeat starts with a strong camera shake (${firstShake.x}, ${firstShake.y})`)
      // 钉住 timeLeftS：这 7 步只观察镜头抖动衰减；放任内置递减会把秒数拉过
      // 30 边界提前消耗掉 30s 告警，后面 0:30 场景就永远静音。
      for (let i = 0; i < 7; i++) await fix.step(st => { st.timeLeftS = 31 })
      await until(async () => await page.evaluate(() => window.__cameraShakes.length > 4), 'camera shake decay samples')
      const shakes = await page.evaluate(() => window.__cameraShakes)
      const lastShake = shakes[shakes.length - 1]
      assert.ok(Math.hypot(lastShake.x, lastShake.y) < Math.hypot(firstShake.x, firstShake.y), 'camera shake decays across authoritative ticks')
      await fix.step(st => { st.timeLeftS = 31 })
      await sleep(80)
      const count = await page.evaluate(() => window.__cameraShakes.length)
      fix.bcast(defeated); await sleep(80)
      assert.equal(await page.evaluate(() => window.__cameraShakes.length), count, 'duplicate self defeat does not restart camera shake')
    }
    const hack = fix.event('uplinkHack', EvUplinkHackSchema, { by: SELF_ID, uplinkId: UPLINK_ID, value: 15 })
    fix.bcast(hack)
    await until(async () => /黑入完成/.test(await hudMsgText(page)), 'uplink banner')
    assert.equal(await page.locator('#hud-msg').getAttribute('data-kind'), 'uplink')
    await shot(page, reduced ? '14-uplink-reduced.png' : '12-uplink-banner.png')

    await page.locator('#game-canvas').focus()
    await page.keyboard.press('c')
    await page.locator('#workbench-editor').waitFor({ state: 'visible' })
    await sleep(150)
    sound = await audioStarted(page)
    const opening = fix.event('phaseChange', EvPhaseChangeSchema, { from: 1, to: 2 }, fix.st.tick + 1)
    fix.bcast(opening)
    await fix.step(st => { st.phase = 2; st.timeLeftS = 31 })
    await page.locator('#hud-inner-ring.show').waitFor()
    await sleep(220)
    assert.equal(await audioStarted(page), sound + 7, 'inner opening plays one staged seven-note cue')
    fix.bcast(opening); await sleep(80)
    assert.equal(await audioStarted(page), sound + 7, 'phase event plus snapshot never double plays')
    const gate = await page.locator('#hud-inner-ring').boundingBox(), stage = await page.locator('#game-stage').boundingBox()
    assert.ok(Math.abs(gate.x + gate.width / 2 - stage.x - stage.width / 2) < 2, 'inner banner centered on battlefield with sidebar open')
    assert.ok(gate.y < stage.y + 180, 'inner banner remains in top region')
    await assertNoHudOverlap(page, `inner-${reduced ? 'reduced' : 'motion'}`)
    await shot(page, reduced ? '16-inner-reduced.png' : '15-inner-open.png')

    await page.evaluate(() => {
      window.__timerPulses = 0
      document.getElementById('hud-time').addEventListener('animationstart', () => window.__timerPulses++)
    })
    sound = await audioStarted(page)
    await fix.step(st => { st.timeLeftS = 30 })
    assert.equal(await audioStarted(page), sound + 2, '30-second warning is double tone')
    assert.equal(await page.locator('#hud-time').innerText(), '0:30')
    assert.ok(await page.locator('#hud-time').evaluate(el => el.classList.contains('urgent')), '30-second timer is urgent')
    const color = await page.locator('#hud-time').evaluate(el => getComputedStyle(el).color)
    assert.equal(color, 'rgb(255, 92, 92)', 'urgent timer uses the existing red palette')
    if (!reduced) await until(async () => await page.evaluate(() => window.__timerPulses) === 1, '30-second pulse')
    await shot(page, reduced ? '18-countdown-reduced.png' : '17-countdown-30.png')
    sound = await audioStarted(page)
    await fix.step(st => { st.timeLeftS = 30 })
    assert.equal(await audioStarted(page), sound, 'same authoritative second never repeats cue')
    for (let remaining = 10; remaining >= 1; remaining--) {
      await sleep(60)
      sound = await audioStarted(page)
      await fix.step(st => { st.timeLeftS = remaining })
      assert.equal(await audioStarted(page), sound + 1, `last ${remaining} seconds plays one tick`)
      await fix.step(st => { st.timeLeftS = remaining })
      assert.equal(await audioStarted(page), sound + 1, `same ${remaining} second does not repeat`)
    }
    if (reduced) {
      assert.equal(await page.evaluate(() => window.__timerPulses), 0, 'reduced motion suppresses countdown jumps')
      assert.equal(await page.evaluate(() => document.getAnimations({ subtree: true }).length), 0, 'reduced motion suppresses all banner animations')
    } else {
      await until(async () => await page.evaluate(() => window.__timerPulses) === 11, '30 plus ten final countdown pulses')
    }
    sound = await audioStarted(page)
    fix.sendFull(); await sleep(100)
    assert.equal(await audioStarted(page), sound, 'full resync in final seconds stays silent')
    await page.setViewportSize({ width: 480, height: 820 })
    await page.locator('#workbench-close').click()
    await fix.step(st => { st.timeLeftS = 1 })
    fix.bcast(fix.event('kill', EvKillSchema, { killer: SELF_ID, victim: ENEMY_ID, at: { x: 20, y: 0 } }))
    await until(async () => /击毁/.test(await hudMsgText(page)), 'narrow kill banner')
    await assertNoHudOverlap(page, 'narrow-event-banner')
    if (!reduced) await shot(page, '19-kill-narrow.png')
    assert.deepEqual(errors, [], 'event and countdown pass has no page errors')
  } finally { await ctx.close() }
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

async function projectileColorPass(browser, fix) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript(COLOR_INIT)
  const page = await ctx.newPage(), errors = []
  const clearColors = () => page.evaluate(() => { window.__ombColors.beams = []; window.__ombColors.impacts = [] })
  const hasBeam = color => page.evaluate(c => window.__ombColors.beams.some(stops => stops.some(s => s.offset === 1 && s.color === c)), color)
  const hasImpact = color => page.evaluate(c => window.__ombColors.impacts.includes(c), color)
  const failures = []
  const checkColor = async (check, label) => {
    try { await until(check, label, 1500) } catch (error) { failures.push(error.message) }
  }
  try {
    await joinGame(page, fix, errors)
    for (const [i, color] of ['#a78bfa', '#fbbf24'].entries()) {
      // Owner starts visible, but the impact arrives after its projectile tombstone.
      fix.st.robots[1].color = color
      fix.sendFull()
      await fix.step(st => { st.projectiles = [{ base: { id: 940 + i, pos: { x: 5, y: 2 }, heading: 0.2 }, ownerId: ENEMY_ID, color }] })
      await clearColors()
      await checkColor(() => hasBeam(color), `visible owner's ${color} projectile beam`)
      await fix.step(st => { st.projectiles = []; st.gone.projectiles = [940 + i] })
      await clearColors()
      fix.bcast(fix.event('projectileImpact', EvProjectileImpactSchema, { projectile: 940 + i, owner: ENEMY_ID, target: 0, at: { x: 5, y: 2 }, color }))
      await checkColor(() => hasImpact(color), `${color} wall impact preserves projectile color`)
      await sleep(370)
    }
    // Shooter leaves AOI while its yellow projectile remains in sight.
    const yellow = '#fbbf24'
    await fix.step(st => { st.projectiles = [{ base: { id: 950, pos: { x: 5, y: 2 }, heading: 0.3 }, ownerId: ENEMY_ID, color: yellow }] })
    await fix.step(st => { st.robots = st.robots.filter(r => r.base.id !== ENEMY_ID); st.gone.robots = [ENEMY_ID] })
    await clearColors()
    await checkColor(() => hasBeam(yellow), 'projectile retains yellow after robotGone')
    await fix.step(st => { st.projectiles = []; st.gone.projectiles = [950] })
    await clearColors()
    fix.bcast(fix.event('projectileImpact', EvProjectileImpactSchema, { projectile: 950, owner: ENEMY_ID, target: 0, at: { x: 5, y: 2 }, color: yellow }))
    await checkColor(() => hasImpact(yellow), 'wall impact remains yellow after both owner and projectile disappear')
    await sleep(370)
    // No prior owner metadata exists: the projectile and event must be self-contained.
    const purple = '#a78bfa'
    await fix.step(st => { st.projectiles = [{ base: { id: 960, pos: { x: 4, y: -2 }, heading: 0.1 }, ownerId: 303, color: purple }] })
    await clearColors()
    await checkColor(() => hasBeam(purple), 'never-observed owner projectile stays purple')
    await fix.step(st => { st.projectiles = []; st.gone.projectiles = [960] })
    await clearColors()
    fix.bcast(fix.event('projectileImpact', EvProjectileImpactSchema, { projectile: 960, owner: 303, target: 0, at: { x: 4, y: -2 }, color: purple }))
    await checkColor(() => hasImpact(purple), 'never-observed owner impact stays purple')
    await shot(page, 'projectile-color-regression.png')
    assert.deepEqual(errors, [], 'no page errors during projectile color regression')
    assert.deepEqual(failures, [], 'projectile colors remain independent of owner visibility and tombstone ordering')
  } finally { await ctx.close() }
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
  await projectileColorPass(browser, fix)
  await fullPass(browser, fix)
  await quickPass(browser, fix, { width: 900, height: 600 }, 'mid-900x600', '09-action-900x600.png')
  await quickPass(browser, fix, { width: 480, height: 820 }, 'mobile-480x820', '10-action-480x820.png')
  await reducedMotionPass(browser, fix)
  await bannerPass(browser, fix)
  await bannerPass(browser, fix, true)

  console.log('\n=== game-feel-check PASS ===')
  console.log(`joins accepted: ${fix.joins}, input frames captured: ${fix.inputs.length}`)
  console.log(`screenshots in: ${SHOTS}`)
} finally {
  if (browser) await browser.close()
  for (const c of fix.conns) { try { c.ws.terminate() } catch {} }
  try { fix.wss.close() } catch {}
  server.close()
}
