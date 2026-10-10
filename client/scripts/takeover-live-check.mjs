// Real editor/runtime/authority/HUD coverage for all four takeover axes.
import { startClient } from './startup-helpers.mjs'
import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema } from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const work = mkdtempSync(join(tmpdir(), 'omb-takeover-'))
const shots = resolve(process.env.OMB_SHOTS || '../.artifacts/takeover-live')
mkdirSync(shots, { recursive: true })
const addr = `127.0.0.1:${process.env.OMB_PORT || '18431'}`
const base = `http://${addr}`
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', addr], { cwd: work, stdio: 'ignore' })
let spawnError, browser, self, own
server.on('error', error => { spawnError = error })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (spawnError) throw spawnError
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}`)
    if (await check()) return
    await sleep(50)
  }
  throw new Error(`timed out: ${label}; self=${JSON.stringify(self)}`)
}
try {
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'server')
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  const errors = [], fired = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
    const message = fromBinary(ServerMsgSchema, payload.subarray(1)).payload
    if (message.case === 'snapshot') {
      self = message.value.self ?? self
      own = message.value.robots.find(robot => robot.base.id === self?.robotId) ?? own
    } else if (message.case === 'event' && message.value.kind.case === 'shot') fired.push(message.value.kind.value)
    else if (message.case === 'event' && message.value.kind.case === 'scriptError') errors.push(JSON.stringify(message.value.kind.value))
  }))
  await page.goto(base); await startClient(page)
  await page.fill('#in-room', 'TAKEVR'); await page.fill('#in-nick', 'taker')
  await page.click('#btn-join')
  await page.locator('#view-room').waitFor({ state: 'visible' })
  await until(() => page.locator('#room-state').textContent().then(text => text.includes('房主 taker')), 'authoritative room joined')
  await page.click('#btn-warmup')
  await until(() => !!self && !!own, 'self snapshot')
  const takeover = id => page.locator(`#skill-${id}`).getAttribute('data-takeover')
  const allScript = () => self?.assistOn && self.moveSrc === 2 && self.turretSrc === 2 && self.fireSrc === 2 && self.abilitySrc === 2 && self.manualAxesMask === 0
  assert.equal(self.assistOn, false)
  assert.equal(await takeover('move'), null)
  await page.click('#btn-game-editor')
  const editor = page.getByRole('textbox', { name: '机器人脚本编辑器', exact: true })
  await editor.waitFor({ timeout: 20000 }); await editor.focus()
  await page.keyboard.press('ControlOrMeta+a')
  await page.evaluate(source => navigator.clipboard.writeText(source), 'function tick(bot) { bot.move(0, 1); bot.aimAt(0); bot.fire(); bot.shield(false); }')
  await page.keyboard.press('ControlOrMeta+v'); await sleep(250)
  await page.keyboard.press('ControlOrMeta+Enter')
  await until(() => page.locator('.script-console-list').textContent().then(text => text.includes('服务器已加载脚本')), 'script loaded through editor')
  await page.locator('.workbench-tools [data-panel="editor"]').click()
  await page.locator('#game-canvas').focus()
  const initial = { ...own.base.pos }
  await page.keyboard.press('Space')
  await until(allScript, 'branch 1: all four script axes active')
  await until(() => Math.hypot(own.base.pos.x - initial.x, own.base.pos.y - initial.y) > 0.3, 'script moves actual robot')
  await until(() => fired.some(shot => shot.owner === self.robotId), 'script fires actual projectile')
  for (const axis of ['move', 'aim', 'fire', 'dash', 'shield', 'uplink']) {
    await until(() => takeover(axis).then(value => value === 'script'), `${axis} HUD amber`)
  }
  await page.screenshot({ path: join(shots, 'script-four-axes.png') })

  await page.keyboard.down('w'); await page.keyboard.press('r')
  await page.mouse.move(300, 300); await page.mouse.down(); await page.keyboard.down('q')
  await until(() => self.manualAxesMask === 15 && self.moveSrc === 1 && self.turretSrc === 1 && self.fireSrc === 1 && self.abilitySrc === 1, 'all four human takeovers reach server')
  await until(() => own.shieldOn, 'manual ability changes actual shield')
  for (const axis of ['move', 'aim', 'fire', 'dash', 'shield', 'uplink']) assert.equal(await takeover(axis), null, `${axis} human marker neutral`)
  await page.screenshot({ path: join(shots, 'human-four-axes.png') })

  await page.keyboard.press('Space')
  await until(allScript, 'branch 2: single Space returns all axes without turning assist off')
  await sleep(600)
  assert.ok(allScript(), 'still-held keys and mouse do not reclaim returned axes')
  assert.equal(own.shieldOn, false, 'returned script ability closes shield')
  for (const axis of ['move', 'aim', 'fire', 'dash']) assert.equal(await takeover(axis), 'script')
  await page.keyboard.up('w'); await page.keyboard.up('q'); await page.mouse.up()
  await page.keyboard.press('Space')
  await until(() => self.assistOn === false, 'branch 3: Space turns assist off')
  for (const axis of ['move', 'aim', 'fire', 'dash']) await until(() => takeover(axis).then(value => value === null), `${axis} marker removed when off`)
  assert.deepEqual(errors, [])
  console.log('PASS: editor movement/projectiles, four-axis HUD, manual shield, held-input handoff, Space three branches')
} finally {
  await browser?.close()
  server.kill()
  try { rmSync(work, { recursive: true, force: true }) } catch {}
}
