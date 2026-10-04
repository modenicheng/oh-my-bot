import { startClient } from './startup-helpers.mjs'
// Real-server acceptance for the aim guard: with assist on and a script
// (aimAt) or the auto-aim snippet owning the turret axis, mouse moves must
// NOT seize the aim axis; only R does. Verifies the actual server-reported
// turret_src (CS_SCRIPT/CS_SNIPPET) drives the client guard.
import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema, ClientMsgSchema } from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const work = mkdtempSync(join(tmpdir(), 'omb-aimguard-'))
const shots = resolve(process.env.OMB_SHOTS || '../.artifacts/aimguard')
mkdirSync(shots, { recursive: true })
const port = Number(process.env.OMB_E2E_PORT || 18429)
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', `127.0.0.1:${port}`], { cwd: work, stdio: 'ignore', env: { ...process.env } })
const base = `http://127.0.0.1:${port}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await sleep(50) }
  throw new Error(`Timed out: ${label}`)
}

// A script that aims at the nearest enemy every tick (like any aimAt script).
const source = `let fireTicks = 0
function tick(bot) {
  const enemy = bot.nearestEnemy()
  if (enemy) {
    bot.aimAt(enemy)
    if (++fireTicks % 180 < 12) bot.fire()
  }
}
`

let browser
try {
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'server')
  browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  page.setDefaultTimeout(8000)
  const inputs = [], shotsFired = []
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
        if (ev.case === 'shot') shotsFired.push(ev.value)
        if (ev.case === 'scriptError') throw new Error(`script runtime error: ${JSON.stringify(ev.value)}`)
      }
    })
  })
  var self
  // Second player joins FIRST (matches launch with the full roster).
  const e2 = await ctx.newPage()
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
  await e2.locator('#btn-warmup').waitFor({ state: 'visible', timeout: 5000 })
  await e2.click('#btn-warmup')
  await page.locator('#view-game').waitFor({ state: 'visible' })
  await e2.locator('#view-game').waitFor({ state: 'visible', timeout: 15000 })
  await until(() => latest?.self && e2self, 'both snapshots')

  // Applying a module must work even after prior manual aim/fire with assist ON.
  const useSnippet = process.env.OMB_GUARD_VARIANT === 'snippet'
  if (useSnippet) {
    await page.locator('#game-canvas').focus()
    await page.keyboard.press('Space')
    await until(() => self?.assistOn === true, 'assist initially on')
    await page.mouse.move(400, 300)
    await page.mouse.down(); await sleep(120); await page.mouse.up()
    await until(() => (self?.manualAxesMask & 6) === 6, 'manual aim/fire established before Snippet apply')
  }

  // Submit the aimAt script (or the auto-aim snippet) through the real UI.
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
    await page.locator('.workbench-tools [data-panel="editor"]').click()
  } else {
    await page.click('#btn-game-manual')
    await page.locator('.workbench-tools [data-panel="snippets"]').click()
    await page.locator('#workbench-snippets').waitFor({ state: 'visible' })
    const aimRow = page.locator('.snippet-row', { hasText: '自动瞄准' }).first()
    await aimRow.locator('.snippet-toggle').click()
    await sleep(200)
    await page.locator('.snippet-apply').click()
    await until(() => page.locator('.snippet-status').getAttribute('data-phase').then(s => s === 'ok'), 'snippet applied')
    await until(() => self?.assistOn === true && self.manualAxesMask === 0, 'Snippet apply releases prior manual axes while keeping assist ON', 5000)
  }

  // Focus the battlefield first — battle keys (Space/R) require activeElement === canvas.
  await page.locator('#game-canvas').focus()
  if (!useSnippet) {
    await page.keyboard.press('Space')
    await until(() => self?.assistOn === true, 'assist on (authoritative)', 5000)
  }

  await until(() => page.locator('#skill-aim-cd').textContent().then(text => text === '辅助待机'), 'enabled auto aim without target shows standby, never manual')
  assert.equal(await page.locator('#skill-aim').getAttribute('data-takeover'), null, 'standby does not pretend a target is being tracked')

  // PRE-GUARD: move the mouse BEFORE any enemy exists — with the aim-capable
  // script loaded and assist on, these moves must NOT seize the aim axis at all
  // (the old turret_src-based guard only engaged after the script aimed).
  {
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
  await page.locator('#game-canvas').focus()
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
  // Navigate through real cover instead of walking a cardinal key into a wall.
  const destination = myPos(), retreat = { ...ePos() }
  await e2.click('#btn-game-editor')
  const enemyEditor = e2.getByRole('textbox', { name: '机器人脚本编辑器', exact: true })
  await enemyEditor.waitFor({ timeout: 20000 })
  await enemyEditor.focus(); await e2.keyboard.press('ControlOrMeta+a')
  await e2.evaluate(src => navigator.clipboard.writeText(src), `function tick(bot) { bot.navigateTo({x:${destination.x},y:${destination.y}}); }`)
  await e2.keyboard.press('ControlOrMeta+v'); await sleep(200)
  await e2.keyboard.press('ControlOrMeta+Enter')
  await until(() => e2.locator('.script-console-list').textContent().then(t => t.includes('服务器已加载脚本')), 'target navigation script loaded')
  await e2.click('#workbench-assist')
  await until(() => dist() < 10 && robots.has(e2self.robotId), 'target reaches unobstructed sight', 45000)
  await e2.click('#workbench-assist')
  await until(() => e2self.assistOn === false, 'target stops moving')
  await page.locator('#game-canvas').focus()
  console.log(`distance: ${dist().toFixed(1)}m turretSrc=${self.turretSrc}`)

  // Now the script/snippet sees an enemy and aims → turret_src becomes CS_SCRIPT/CS_SNIPPET.
  await until(() => self.turretSrc === 2 || self.turretSrc === 3, `turret under script (got ${self.turretSrc})`, 8000)
  const expectedSource = useSnippet ? 3 : 2
  assert.equal(self.turretSrc, expectedSource)
  await until(() => page.locator('#skill-aim').getAttribute('data-takeover').then(v => v === 'script'), 'aim HUD reflects actual script source')
  assert.equal(await page.locator('#skill-aim-cd').textContent(), '辅助瞄准', 'actual aim output uses the same assist terminology')
  const a = myPos(), b = ePos()
  const expectedAim = Math.atan2(b.y - a.y, b.x - a.x)
  await until(() => Math.abs(Math.atan2(Math.sin(robots.get(selfId).base.heading - expectedAim), Math.cos(robots.get(selfId).base.heading - expectedAim))) < 0.08, 'actual turret points at visible enemy')
  const fireMark = useSnippet ? shotsFired.length : 0
  if (useSnippet) {
    await page.mouse.move(300, 300); await page.mouse.down()
    await until(() => self.fireSrc === 1 && self.turretSrc === 3, 'manual fire coexists with Snippet aim')
  }
  await until(() => shotsFired.slice(fireMark).some(shot => shot.owner === selfId), 'real self projectile is fired')
  if (useSnippet) {
    await page.mouse.up()
    assert.equal(await page.locator('#skill-fire').getAttribute('data-takeover'), null, 'manual fire is not marked as script')
  } else {
    await until(() => self.fireSrc === 2, 'editor code controls real firing')
    await until(() => page.locator('#skill-fire').getAttribute('data-takeover').then(v => v === 'script'), 'editor fire HUD turns amber')
    await page.mouse.move(300, 300); await page.mouse.down(); await page.mouse.up()
    await until(() => self.fireSrc === 1 && self.turretSrc === 2, 'LMB seizes only fire from editor script')
    await page.keyboard.press('Space')
    await until(() => self.fireSrc === 2 && self.assistOn, 'Space returns fire without turning assist off')
  }
  console.log(`real aim/fire verified: source=${expectedSource}`)

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
  await until(() => page.locator('#skill-aim-cd').textContent().then(text => text === '手动瞄准'), 'R changes HUD to manual aim')
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

  // Losing a real target is standby, not a silent switch to human aim.
  await enemyEditor.focus(); await e2.keyboard.press('ControlOrMeta+a')
  await e2.evaluate(src => navigator.clipboard.writeText(src), `function tick(bot) { bot.navigateTo({x:${retreat.x},y:${retreat.y}}); }`)
  await e2.keyboard.press('ControlOrMeta+v'); await sleep(200)
  await e2.keyboard.press('ControlOrMeta+Enter')
  await until(() => e2.locator('.script-console-list').textContent().then(t => t.includes('服务器已加载脚本 r2')), 'target retreat script loaded')
  await e2.click('#workbench-assist')
  await until(() => dist() > 22 && !robots.has(e2self.robotId) && self.turretSrc === 0, 'target leaves actual sight', 45000)
  await until(() => page.locator('#skill-aim-cd').textContent().then(text => text === '辅助待机'), 'target loss returns aim HUD to standby')
  assert.equal(self.assistOn, true, 'target loss does not disable assistance')
  await page.locator('#game-canvas').focus()
  await page.mouse.move(300, 300, { steps: 3 })
  await until(() => page.locator('#hud-msg').textContent().then(text => text.includes('辅助待机')), 'guard hint uses the same standby wording')
  await page.screenshot({ path: join(shots, useSnippet ? 'snippet-aim-standby.png' : 'editor-aim-standby.png') })
  await page.keyboard.press('Space')
  await until(() => self.assistOn === false, 'disable assistance after handoff')
  await until(() => page.locator('#skill-aim-cd').textContent().then(text => text === '手动瞄准'), 'disabled assistance returns HUD to manual aim')
  console.log('AIM GUARD E2E OK: standby / assisting / manual / target loss / assist off')
} catch (err) {
  console.error(String(err))
  process.exitCode = 1
} finally {
  server.kill()
  await browser?.close()
  try { rmSync(work, { recursive: true, force: true }) } catch {}
}
