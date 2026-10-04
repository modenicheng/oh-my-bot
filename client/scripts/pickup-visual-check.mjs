// pickup-visual-check.mjs — deterministic art validation for swept pickup
// (feature 1+5): serves client/dist, mounts a protobuf WS fixture with the
// self robot next to a health pack and a core, then screenshots desktop and
// mobile viewports in available and cooldown states, and pixel-asserts the
// health pack renders with its green+white kit distinct from background.
// Real-server behavior is round2-check's job; this checks visuals only.
// Prerequisite: pnpm build in client/. Screenshots: OMB_SHOTS || ../.artifacts/pickup
import { startClient } from './startup-helpers.mjs'
import { sleep, startStaticServer, gen2MapJson, FixtureServer, frame } from './harness.mjs'
import { chromium } from 'playwright'
import { create, toBinary, fromBinary } from '@bufbuild/protobuf'
import {
  ServerMsgSchema, ClientMsgSchema, SnapshotDeltaSchema,
  EvRoomStateSchema, EvMapBootstrapSchema,
} from '../../packages/protocol/src/index.ts'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PORT = Number(process.env.OMB_PICKUP_PORT || 18449)
const BASE = `http://127.0.0.1:${PORT}`
const CLIENT_DIR = resolve(import.meta.dirname, '..')
const DIST = join(CLIENT_DIR, 'dist')
const SHOTS = resolve(process.env.OMB_SHOTS || '../.artifacts/pickup')

const CS_HUMAN = 1
// 本脚本只验收血包美术；使用核心区已开放阶段，避免 X-9 锁区雾
// 正确遮黑原点附近 fixture 后把“不可见”误判成血包渲染失败。
const PHASE_CORE_OPEN = 2
const R_PLAYING = 2
const SELF_ID = 101
const PACK_POS = { x: 2.2, y: 0 }
const CORE_POS = { x: -2.4, y: 0 }

// gen2 minimal valid map (harness.gen2MapJson): the self robot spawns at origin
// next to the health pack (+2.2, 0) and the core pad (-2.4, 0), with the uplink
// parked far away at (40, 0).
const MAP_JSON = gen2MapJson('pickup01')

function freshState() {
  return {
    tick: 600, phase: PHASE_CORE_OPEN, timeLeftS: 480,
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

class Fixture extends FixtureServer {
  constructor() { super(); this.inputs = []; this.st = freshState() }
  onFrame(conn, buf) {
    if (buf[0] === frame.ping) { conn.ws.send(Buffer.from([frame.pong])); return }
    if (buf[0] !== frame.up) return
    let msg
    try { msg = fromBinary(ClientMsgSchema, buf.subarray(1)) } catch { return }
    const c = msg.payload
    if (c.case === 'join') { conn.joined = true; this.accept(conn) }
    else if (c.case === 'input') this.inputs.push(c.value)
    else if (c.case === 'resyncRequest') this.sendFull(conn)
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

function startHttp() { return startStaticServer(PORT, DIST) }

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
