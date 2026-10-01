// pickup-visual-check.mjs — deterministic art validation for swept pickup
// (feature 1+5): serves client/dist, mounts a protobuf WS fixture with the
// self robot next to a health pack and a core, then screenshots desktop and
// mobile viewports in available and cooldown states, and pixel-asserts the
// health pack renders with its green+white kit distinct from background.
// Real-server behavior is round2-check's job; this checks visuals only.
// Prerequisite: pnpm build in client/. Screenshots: OMB_SHOTS || ../.artifacts/pickup
import { startClient } from './startup-helpers.mjs'
import { chromium } from 'playwright'
import { create, toBinary, fromBinary } from '@bufbuild/protobuf'
import {
  ServerMsgSchema, ClientMsgSchema, ServerEventSchema, SnapshotDeltaSchema,
  EvRoomStateSchema, EvMapBootstrapSchema,
} from '../../packages/protocol/src/index.ts'
import http from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { WebSocketServer } from 'ws'
import assert from 'node:assert/strict'

const PORT = 18425
const BASE = `http://127.0.0.1:${PORT}`
const CLIENT_DIR = resolve(import.meta.dirname, '..')
const DIST = join(CLIENT_DIR, 'dist')
const SHOTS = resolve(process.env.OMB_SHOTS || '../.artifacts/pickup')

const CS_HUMAN = 1
const PHASE_OUTER = 1
const R_PLAYING = 2
const SELF_ID = 101
const PACK_POS = { x: 2.2, y: 0 }
const CORE_POS = { x: -2.4, y: 0 }

const MAP_JSON = JSON.stringify({
  version: 1,
  generator_ver: 2,
  seed: 20260206,
  map_hash: 'pickup01',
  walls: [
    { id: 1, min: { X: -66, Y: -60 }, max: { X: -58, Y: 60 } },
    { id: 2, min: { X: 58, Y: -60 }, max: { X: 66, Y: 60 } },
  ],
  sectors: [
    { id: 1, spawn_area: { Min: { X: -50, Y: -40 }, Max: { X: -35, Y: -25 } }, center: { X: -42, Y: -32 } },
    { id: 2, spawn_area: { Min: { X: 35, Y: 25 }, Max: { X: 50, Y: 40 } }, center: { X: 42, Y: 32 } },
  ],
  uplinks: [{ id: 900, pos: { X: 40, Y: 0 }, main: false, interact_r: 2.5, active_phase: 1 }],
  core_pads: [{ id: 1, pos: { X: -2.4, Y: 0 }, group: 0, value: 10 }],
  health_packs: [{ id: 7, pos: { X: 2.2, Y: 0 } }],
  core_zone: { radius: 30, unlock_phase: 2 },
})

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return true; await sleep(50) }
  throw new Error(`Timed out: ${label}`)
}

function freshState() {
  return {
    tick: 600, phase: PHASE_OUTER, timeLeftS: 480,
    robots: [
      { base: { id: SELF_ID, pos: { x: 0, y: 0 }, heading: 0 }, hpX10: 550, energyX10: 1000, shieldOn: false, dashing: false, dead: false, respawnInS: 0, nick: 'medic', color: '#22d3ee' },
    ],
    projectiles: [],
    cores: [{ base: { id: 1, pos: CORE_POS, heading: 0 }, value: 10, alive: true }],
    healthPacks: [{ base: { id: 7, pos: PACK_POS, heading: 0 }, available: true, respawnInS: 0 }],
    uplinks: [{ base: { id: 900, pos: { x: 40, y: 0 }, heading: 0 }, ready: true, hackingId: 0, progressX10: 0, myCooldownS: 0 }],
    self: { robotId: SELF_ID, moveSrc: CS_HUMAN, turretSrc: CS_HUMAN, aiRoundsLeft: 0, aiTokensLeftK: 0, assistOn: false, dashReadyTick: 0, fireReadyTick: 0 },
    gone: { robots: [], projectiles: [], cores: [] },
  }
}

class Fixture {
  constructor() { this.conns = new Set(); this.inputs = []; this.st = freshState() }
  attach(server) {
    const wss = new WebSocketServer({ noServer: true })
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
    if (buf[0] === 0x00) { conn.ws.send(Buffer.from([0x01])); return }
    if (buf[0] !== 0x02) return
    let msg
    try { msg = fromBinary(ClientMsgSchema, buf.subarray(1)) } catch { return }
    const c = msg.payload
    if (c.case === 'join') { conn.joined = true; this.accept(conn) }
    else if (c.case === 'input') this.inputs.push(c.value)
    else if (c.case === 'resyncRequest') this.sendFull(conn)
  }
  send(conn, msg) { if (conn.ws.readyState === 1) conn.ws.send(Buffer.concat([Buffer.from([0x03]), toBinary(ServerMsgSchema, msg)])) }
  event(kindCase, schema, val, tick = this.st.tick) {
    return create(ServerMsgSchema, { payload: { case: 'event', value: create(ServerEventSchema, { tick, kind: { case: kindCase, value: create(schema, val) } }) } })
  }
  accept(conn) {
    this.st = freshState()
    this.inputs = []
    this.send(conn, this.event('roomState', EvRoomStateSchema, { state: R_PLAYING, robotsOnline: 1, hostNick: 'pickup' }, 0))
    this.send(conn, this.event('mapBootstrap', EvMapBootstrapSchema, { mapJson: MAP_JSON, mapHash: 'pickup01', generatorVersion: 2 }, 0))
    this.sendFull(conn)
  }
  buildDelta(full, baseTick) {
    const st = this.st
    const robots = st.robots.map(r => full
      ? { base: r.base, hpX10: r.hpX10, energyX10: r.energyX10, shieldOn: r.shieldOn, dashing: r.dashing, dead: r.dead, respawnInS: r.respawnInS, nick: r.nick, color: r.color }
      : { base: r.base, hpX10: r.hpX10, energyX10: r.energyX10 })
    return create(SnapshotDeltaSchema, {
      tick: st.tick, ackSeq: 0, phase: st.phase, timeLeftS: st.timeLeftS,
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
    if (conn) this.send(conn, msg); else for (const c of this.conns) this.send(c, msg)
  }
  /** deterministic step: tick+=2, optional mutation, full snapshot (delta base 0 keeps cooldown edits simple) */
  async step(mut, page) {
    const st = this.st
    st.tick += 2
    st.gone = { robots: [], projectiles: [], cores: [] }
    if (mut) mut(st)
    this.sendFull()
    await sleep(80)
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  }
}

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

async function joinGame(page) {
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE)
  await startClient(page)
  await page.evaluate(() => document.fonts.ready)
  await page.fill('#in-room', 'PICKUP')
  await page.fill('#in-nick', 'medic')
  await page.click('#btn-join')
  await page.locator('#view-game').waitFor({ state: 'visible', timeout: 10000 })
  return errors
}

// Pixel assert on the game canvas: health pack must paint clearly-green kit
// pixels right of center (its world x is +2.2m), and in cooldown mode those
// green pixels must disappear while the pack ring stays faint.
async function packStats(page) {
  return page.evaluate(() => {
    const cv = document.querySelector('#game-canvas')
    const ctx = cv.getContext('2d')
    const w = cv.width, h = cv.height
    const img = ctx.getImageData(0, 0, w, h).data
    let green = 0, minX = w, maxX = 0, minY = h, maxY = 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const r = img[i], g = img[i + 1], b = img[i + 2]
      if (g > 110 && g > r * 1.5 && g > b * 1.2) {
        green++
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
      }
    }
    return { green, w, h, bbox: green ? { minX, maxX, minY, maxY } : null }
  })
}

const http2 = await startHttp()
const fix = new Fixture()
fix.attach(http2)
const browser = await chromium.launch()
try {
  assert.ok(existsSync(join(DIST, 'index.html')), 'build client first: pnpm build')
  mkdirSync(SHOTS, { recursive: true })

  // Desktop 1280x800
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  const errors = await joinGame(page)
  await sleep(300)
  await page.screenshot({ path: join(SHOTS, 'desktop-available.png') })
  const avail = await packStats(page)
  assert.ok(avail.green > 40, `health pack not visible on desktop: ${JSON.stringify(avail)}`)
  // pack sits +2.2m east of self (screen right of center); bbox must sit in
  // the right half and be a compact blob, not scattered noise.
  if (avail.bbox) {
    assert.ok(avail.bbox.minX > avail.w / 2, `pack bbox not right of center: ${JSON.stringify(avail.bbox)}`)
    assert.ok(avail.bbox.maxX - avail.bbox.minX < avail.w / 4, `pack bbox too wide: ${JSON.stringify(avail.bbox)}`)
  }

  await fix.step(st => { st.healthPacks[0].available = false; st.healthPacks[0].respawnInS = 17 }, page)
  await page.screenshot({ path: join(SHOTS, 'desktop-cooldown.png') })
  const cd = await packStats(page)
  assert.ok(cd.green < avail.green / 2, `cooldown pack still painted bright: ${JSON.stringify({ avail, cd })}`)

  // Mobile viewport of the same live session
  await page.setViewportSize({ width: 480, height: 800 })
  await fix.step(st => { st.healthPacks[0].available = true; st.healthPacks[0].respawnInS = 0 }, page)
  await sleep(300)
  await page.screenshot({ path: join(SHOTS, 'mobile-available.png') })
  const mob = await packStats(page)
  assert.ok(mob.green > 20, `health pack not visible on mobile: ${JSON.stringify(mob)}`)

  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`)
  console.log('PICKUP_VISUAL_OK', JSON.stringify({ avail, cd, mob }))
} catch (e) {
  console.error('PICKUP_VISUAL_FAIL', e.message)
  process.exitCode = 1
} finally {
  await browser?.close()
  http2.close()
}
