import { startClient } from './startup-helpers.mjs'
// Real-server acceptance for the aim guard: with assist on and a script
// (aimAt) or the auto-aim snippet owning the turret axis, mouse moves must
// NOT seize the aim axis; only R does. Verifies the actual server-reported
// turret_src (CS_SCRIPT/CS_SNIPPET) drives the client guard.
import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema, ClientMsgSchema } from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const work = mkdtempSync(join(tmpdir(), 'omb-aimguard-'))
const shots = resolve(process.env.OMB_SHOTS || '../.artifacts/aimguard')
mkdirSync(shots, { recursive: true })
const port = Number(process.env.OMB_E2E_PORT || 18429)
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', `127.0.0.1:${port}`], { cwd: work, stdio: 'ignore', env: { ...process.env, OMB_WEB_DIR: resolve('../client/dist') } })
const base = `http://127.0.0.1:${port}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await sleep(50) }
  throw new Error(`Timed out: ${label}`)
}

// A script that aims at the nearest enemy every tick (like any aimAt script).
const source = `function tick(bot) {
  const enemy = bot.nearestEnemy()
  if (enemy) bot.aimAt(enemy)
}
`

let browser
try {
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'server')
  browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  page.setDefaultTimeout(8000)
  const inputs = []
  let latest, selfId
  const robots = new Map()
  page.on('pageerror', e => { throw e })
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 2) return
      const msg = fromBinary(ClientMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'input') inputs.push(msg.payload.value)
    })
    socket.on('framereceived', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
      const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'snapshot') {
        latest = msg.payload.value
        if (latest.full) robots.clear()
        for (const r of latest.robots) robots.set(r.base.id, r)
        for (const g of latest.robotGone) robots.delete(g)
        if (latest.self) {
          if (self && self.assistOn !== latest.self.assistOn) {
            console.log(`[assistOn] ${self.assistOn} -> ${latest.self.assistOn} @tick ${latest.tick}`)
          }
          selfId = latest.self.robotId; self = latest.self
        }
      }
      if (msg.payload.case === 'event') {
        const ev = msg.payload.value.kind
        if (ev.case === 'say') console.log(`[say] ${ev.value.text}`)
      }
    })
  })
  var self
  // Second player joins FIRST (matches launch with the full roster).
  const e2 = await ctx.newPage()
  const e2inputs = []
  let e2self
  const e2robots = new Map()
  let e2latest
  e2.on('websocket', socket => {
    socket.on('framereceived', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
      const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'snapshot') {
        e2latest = msg.payload.value
        if (e2latest.full) e2robots.clear()
        for (const r of e2latest.robots) e2robots.set(r.base.id, r)
        for (const g of e2latest.robotGone) e2robots.delete(g)
        if (e2latest.self) e2self = e2latest.self
      }
    })
  })
  await e2.goto(base)
  await startClient(e2)
  await e2.fill('#in-room', 'AIMGRD')
  await e2.fill('#in-nick', 'enemy')
  await e2.click('#btn-join')
  await e2.locator('#view-room').waitFor({ state: 'visible', timeout: 15000 })

  await page.goto(base)
  await startClient(page)
  await page.fill('#in-room', 'AIMGRD')
  await page.fill('#in-nick', 'guard-test')
  await page.click('#btn-join')
  await page.locator('#btn-warmup').waitFor({ state: 'visible', timeout: 15000 }).catch(async () => {
    // First joiner (enemy) holds host rights — it starts the warmup.
    await e2.locator('#btn-warmup').waitFor({ state: 'visible', timeout: 5000 })
    await e2.click('#btn-warmup')
    return
  })
  await page.click('#btn-warmup').catch(() => {})
  await page.locator('#view-game').waitFor({ state: 'visible' })
  await e2.locator('#view-game').waitFor({ state: 'visible', timeout: 15000 })
  await until(() => latest?.self && e2self, 'both snapshots')

  // Submit the aimAt script (or the auto-aim snippet) through the real UI.
  const useSnippet = process.env.OMB_GUARD_VARIANT === 'snippet'
  if (!useSnippet) {
    await page.click('#btn-game-manual')
    await page.locator('.workbench-tools [data-panel="editor"]').click()
    const editor = page.getByRole('textbox', { name: '机器人脚本编辑器', exact: true })
    await editor.waitFor({ timeout: 20000 })
    await editor.focus()
    await page.keyboard.press('ControlOrMeta+a')
    await page.evaluate(src => navigator.clipboard.writeText(src), source)
    await page.keyboard.press('ControlOrMeta+v')
    await sleep(400)
    await page.keyboard.press('ControlOrMeta+Enter')
    await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('服务器已加载脚本')), 'script loaded', 20000)
    await page.keyboard.press('m') // close workbench
  } else {
    await page.click('#btn-game-manual')
    await page.locator('.workbench-tools [data-panel="snippets"]').click()
    await page.locator('#workbench-snippets').waitFor({ state: 'visible' })
    const aimRow = page.locator('.snippet-row', { hasText: '自动瞄准' }).first()
    await aimRow.locator('.snippet-toggle').click()
    await sleep(200)
    await page.locator('.snippet-apply').click()
    await sleep(800)
    await page.keyboard.press('m')
  }

  // Focus the battlefield first — battle keys (Space/R) require activeElement === canvas.
  await page.locator('#game-canvas').click({ position: { x: 640, y: 400 } })

  // Turn assist ON (retry: Space in warmup should stick via authoritative echo).
  await page.keyboard.press(' ')
  await until(() => self?.assistOn === true, 'assist on (authoritative)', 5000).catch(async () => {
    console.log(`assist echo not seen yet (assistOn=${self?.assistOn}); pressing Space again`)
    await page.keyboard.press(' ')
    await until(() => self?.assistOn === true, 'assist on retry', 5000)
  })

  // PRE-GUARD: move the mouse BEFORE any enemy exists — with the aim-capable
  // script loaded and assist on, these moves must NOT seize the aim axis at all
  // (the old turret_src-based guard only engaged after the script aimed).
  {
    const probe = await page.evaluate(() => ({
      aimCapable: (globalThis).__ombAimCapable,
      hudMsg: document.querySelector('#hud-msg')?.textContent ?? '',
    }))
    console.log(`pre-guard probe: ${JSON.stringify(probe)}`)
    console.log(`pre-guard debug: assistOn=${self?.assistOn} turretSrc=${self?.turretSrc}`)
    const mark0 = inputs.length
    await page.mouse.move(1100, 250)
    await page.mouse.move(250, 650, { steps: 6 })
    await sleep(500)
    const leaked = inputs.slice(mark0).filter(i => (i.axisMask & 0b10) !== 0)
    console.log(`pre-guard (no enemy yet): leaked aim frames = ${leaked.length}`)
    assert.equal(leaked.length, 0, 'aim-capable script + assist must guard the turret axis even before the script aims')
  }

  // Wake the mouse axis with small real moves (canvas focus), then check
  // turret_src: the script aims only when an enemy is visible; alone in the
  // room there is none, so also enable the auto-aim snippet via the panel.
  await page.locator('#game-canvas').click({ position: { x: 640, y: 400 } })
  await until(() => self?.turretSrc !== undefined, 'turret src reported')

  // Both in warmup; enemy walks toward us until mutually visible.
  // myPos works from my own snapshot (self always visible); the enemy is out of
  // my 20m vision until it approaches — track its own position from its snapshot.
  const myPos = () => robots.get(selfId)?.base?.pos
  const ePos = () => e2robots.get(e2self?.robotId)?.base?.pos
  await until(() => myPos() && ePos(), 'both positions', 10000).catch(() => {
    console.log(`debug: my=${!!myPos()} enemy=${!!ePos()} dist=${dist().toFixed(1)}`)
    throw new Error('positions missing')
  })
  const dist = () => { const a = myPos(), b = ePos(); return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity }
  const t0 = Date.now()
  let lastDist = Infinity, stuck = 0
  while (Date.now() - t0 < 30000 && dist() > 15) {
    const a = myPos(), b = ePos()
    if (!a || !b) { await sleep(200); continue }
    const dx = a.x - b.x, dy = a.y - b.y
    const key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'd' : 'a') : (dy > 0 ? 's' : 'w')
    await e2.locator('#game-canvas').click({ position: { x: 640, y: 400 } }).catch(() => {})
    await e2.keyboard.down(key)
    if (stuck > 3) { await e2.keyboard.down('Shift'); await sleep(400); await e2.keyboard.up('Shift'); stuck = 0 }
    await sleep(200)
    await e2.keyboard.up(key)
    const d = dist()
    if (d > lastDist - 0.3) stuck++; else stuck = 0
    lastDist = d
  }
  console.log(`distance: ${dist().toFixed(1)}m turretSrc=${self.turretSrc}`)

  // Now the script/snippet sees an enemy and aims → turret_src becomes CS_SCRIPT/CS_SNIPPET.
  await until(() => self.turretSrc === 2 || self.turretSrc === 3, `turret under script (got ${self.turretSrc})`, 8000)
  console.log(`turret_src=${self.turretSrc} (${self.turretSrc === 3 ? 'CS_SNIPPET' : 'CS_SCRIPT'}) — guard active`)

  // PHASE 1: big mouse moves must NOT produce aim-mask frames.
  const mark1 = inputs.length
  await page.mouse.move(200, 200)
  await page.mouse.move(1100, 600, { steps: 8 })
  await page.mouse.move(300, 700, { steps: 8 })
  await sleep(600)
  const aimFrames1 = inputs.slice(mark1).filter(i => (i.axisMask & 0b10) !== 0)
  console.log(`phase 1 (guard on): aim-mask frames after mouse moves = ${aimFrames1.length}`)
  assert.equal(aimFrames1.length, 0, `guard failed: mouse moves seized the aim axis (${aimFrames1.length} aim frames)`)
  // Turret stays script-owned authoritatively.
  await until(() => self.turretSrc === 2 || self.turretSrc === 3, 'turret still script after guarded moves')

  // PHASE 2: R seizes the axis.
  await page.keyboard.press('r')
  const mark2 = inputs.length
  await page.mouse.move(900, 300, { steps: 4 })
  await sleep(400)
  const aimFrames2 = inputs.slice(mark2).filter(i => (i.axisMask & 0b10) !== 0)
  console.log(`phase 2 (after R): aim-mask frames = ${aimFrames2.length}`)
  assert.ok(aimFrames2.length > 0, 'R did not restore manual aim frames')
  await until(() => self.turretSrc === 1, `turret becomes human after R (got ${self.turretSrc})`, 5000)
  console.log('turret_src = CS_HUMAN after R')

  // PHASE 3: Space returns the axis to the script; guard re-engages.
  await page.keyboard.press(' ')
  await until(() => self.turretSrc === 2 || self.turretSrc === 3, `turret back to script after Space (got ${self.turretSrc})`, 8000)
  const mark3 = inputs.length
  await page.mouse.move(400, 400, { steps: 4 })
  await sleep(400)
  const aimFrames3 = inputs.slice(mark3).filter(i => (i.axisMask & 0b10) !== 0)
  console.log(`phase 3 (guard re-engaged): aim-mask frames = ${aimFrames3.length}`)
  assert.equal(aimFrames3.length, 0, 'guard did not re-engage after Space')

  await page.screenshot({ path: join(shots, 'aim-guard.png') })
  console.log('AIM GUARD E2E OK')
} catch (err) {
  console.error(String(err))
  process.exitCode = 1
} finally {
  server.kill()
  await browser?.close()
}
