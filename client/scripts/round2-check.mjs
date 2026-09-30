import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema } from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const work = mkdtempSync(join(tmpdir(), 'omb-round2-'))
const shots = resolve(process.env.OMB_SHOTS || '../.artifacts/round2')
mkdirSync(shots, { recursive: true })
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', '127.0.0.1:18420'], { cwd: work, stdio: 'ignore' })
let browser
const errors = []
const base = 'http://127.0.0.1:18420'
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await sleep(50) }
  throw new Error(`Timed out: ${label}`)
}
try {
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'server')
  browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  page.setDefaultTimeout(8000)
  let latest, id, map
  const robots = new Map()
  page.on('pageerror', e => errors.push(String(e)))
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
    const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
    if (msg.payload.case === 'snapshot') { latest = msg.payload.value; if (latest.full) robots.clear(); for (const r of latest.robots) robots.set(r.base.id, r); for (const id of latest.robotGone) robots.delete(id); if (latest.self) id = latest.self.robotId }
    if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'mapBootstrap') { map = JSON.parse(msg.payload.value.kind.value.mapJson); latest = undefined; robots.clear() }
  }))
  await page.goto(base)
  await page.screenshot({ path: join(shots, 'join.png') })
  await page.fill('#in-room', 'ROUND2')
  await page.fill('#in-nick', 'tester')
  await page.press('#in-nick', 'm')
  assert.equal(await page.locator('#view-manual').isHidden(), true, 'typing m must not open manual')
  await page.fill('#in-nick', 'tester')
  await page.click('#btn-join')
  await page.locator('#btn-start').waitFor({ state: 'visible' })
  await page.keyboard.press('m')
  await page.locator('#manual-content h1').first().waitFor()
  await page.keyboard.press('m')
  await page.locator('#btn-start').waitFor({ state: 'visible' })
  assert.match(page.url(), /room=ROUND2/)
  await page.screenshot({ path: join(shots, 'lobby.png') })
  await page.click('#btn-warmup')
  await page.locator('#view-game').waitFor({ state: 'visible' })
  await until(() => latest?.self && robots.size > 0, 'initial snapshot')
  const firstId = id
  const initial = robots.get(id)?.base?.pos
  assert.ok(initial)
  await page.keyboard.down('w')
  await sleep(500)
  await page.keyboard.up('w')
  await until(() => Math.abs(robots.get(id).base.pos.y - initial.y) > 0.5, 'movement')
  await page.mouse.move(900, 400)
  await page.mouse.down()
  await until(() => robots.get(id).energyX10 < 980, 'fire energy')
  await page.mouse.up()
  await page.screenshot({ path: join(shots, 'game.png') })
  const beforeRefresh = { ...robots.get(id).base.pos }
  latest = undefined
  robots.clear()
  await page.reload()
  await page.locator('#view-game').waitFor({ state: 'visible' })
  await until(() => latest?.self && robots.has(id), 'reload snapshot')
  assert.equal(id, firstId, 'refresh must retain robot identity')
  assert.ok(Math.hypot(robots.get(id).base.pos.x - beforeRefresh.x, robots.get(id).base.pos.y - beforeRefresh.y) < 1, 'refresh must retain position')
  await page.keyboard.down('s')
  await until(() => robots.get(id).base.pos.y > beforeRefresh.y + 0.5, 'input sequence recovery')
  await page.keyboard.up('s')
  for (const size of [{width: 900, height: 600}, {width: 1600, height: 900}, {width: 480, height: 820}]) {
    await page.setViewportSize(size)
    await until(() => page.locator('#game-canvas').evaluate(c => Math.abs(c.width - c.getBoundingClientRect().width * devicePixelRatio) < 2 && Math.abs(c.height - c.getBoundingClientRect().height * devicePixelRatio) < 2), 'resize backing store')
  }
  await page.screenshot({ path: join(shots, 'narrow.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'narrow viewport overflow')
  await page.setViewportSize({ width: 1280, height: 800 })
  const warmupMap = map
  await page.click('#btn-game-start')
  await until(() => map !== warmupMap && latest?.timeLeftS === 480 && latest?.tick < 60, 'new formal bootstrap and snapshot')
  await until(async () => await page.locator('#hud-time').textContent() === '8:00', 'formal countdown render')
  const clock = []
  for (let i = 0; i < 20; i++) {
    clock.push(await page.locator('#hud-time').textContent())
    await sleep(100)
  }
  const seconds = clock.map(t => t.split(':').reduce((m, s) => m * 60 + Number(s), 0))
  assert.ok(seconds.every((s, i) => Number.isFinite(s) && s > 470 && (i === 0 || s <= seconds[i - 1])), `countdown reversed or cleared: ${clock}`)
  // M releases movement, toggles back to the same game, and the visible button also works.
  await page.keyboard.down('w')
  await sleep(100)
  await page.keyboard.press('m')
  await page.keyboard.up('w')
  await page.locator('#manual-content h1').first().waitFor()
  await sleep(150)
  const stationary = { ...robots.get(id).base.pos }
  await sleep(200)
  assert.ok(Math.hypot(robots.get(id).base.pos.x - stationary.x, robots.get(id).base.pos.y - stationary.y) < 0.1, 'manual must release movement')
  await page.keyboard.press('m')
  await page.locator('#view-game').waitFor({ state: 'visible' })
  // Open through visible controls, then reload the recorded document route.
  await page.click('#btn-game-manual')
  await page.locator('#manual-content h1').first().waitFor()
  const currentManual = await page.locator('[data-path="reference"]').count() > 0
  const section = currentManual ? 'reference' : 'library'
  const tabPage = currentManual ? 'reference/actions' : 'library/tab-demo'
  await page.locator(`[data-path="${section}"]`).click()
  await until(() => page.url().includes(`doc=${section}%2Findex.md`), 'directory index navigation')
  await page.locator(`[data-path="${currentManual ? 'reference/data' : 'library/api'}"]`).click()
  await page.locator('#manual-content h1').first().waitFor()
  await page.locator(`[data-path="${tabPage}"]`).click()
  await page.getByRole('tab', { name: 'PY', exact: true }).first().click()
  assert.equal(new URL(page.url()).searchParams.get('doc'), `${tabPage}.md`)
  await page.reload()
  await page.locator('#manual-content h1').first().waitFor()
  const tabs = await page.getByRole('tab').count()
  assert.ok(tabs >= 3 && tabs % 3 === 0, 'manual language groups retain TS/PY/JAVA tabs')
  assert.equal(await page.locator('#manual-content h1').count(), 1, 'manual should not duplicate its page heading')
  await page.getByRole('tab', { name: 'PY', exact: true }).first().click()
  assert.equal(await page.getByRole('tab', { name: 'PY', exact: true }).first().getAttribute('aria-selected'), 'true')
  await page.screenshot({ path: join(shots, 'manual.png') })
  await page.click('#btn-manual-back')
  await page.locator('#view-game').waitFor({ state: 'visible' })
  // A formal room provides a fresh replay instead of relying on a historical fixture.
  const other = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  other.on('pageerror', e => errors.push(String(e)))
  await other.goto(base)
  await other.fill('#in-room', 'LOGS2')
  await other.fill('#in-nick', 'recorder')
  await other.click('#btn-join')
  await other.locator('#btn-start').waitFor({ state: 'visible' })
  await other.click('#btn-start')
  await other.locator('#view-game').waitFor({ state: 'visible' })
  await until(() => other.locator('#game-canvas').evaluate(c => c.width === Math.floor(c.clientWidth * 2)), 'DPR 2 backing store')
  await other.mouse.move(900, 400)
  await other.mouse.down()
  await other.keyboard.down('w')
  const entries = await fetch(`${base}/api/matches`).then(r => r.json())
  const replayId = entries.find(x => x.startsWith('LOGS2'))
  await until(async () => {
    const text = await fetch(`${base}/api/replay/${replayId}`).then(r => r.text())
    return text.split('\n').filter(Boolean).some(line => { try { return JSON.parse(line).tick >= 120 } catch { return false } })
  }, 'durable replay frames', 20000)
  await other.mouse.up()
  await other.keyboard.up('w')
  await page.click('#btn-game-replay')
  await page.locator('#replay-list button').filter({ hasText: replayId }).click()
  await page.locator('#view-replay-player').waitFor({ state: 'visible' }).catch(async error => {
    console.log('replay error', await page.locator('#replay-error').textContent(), errors)
    throw error
  })
  await until(async () => await page.locator('#rp-status').isHidden(), 'replay load')
  await until(async () => Number(await page.locator('#rp-timeline').inputValue()) > 10, 'replay clock progresses')
  await page.click('#rp-play')
  assert.equal(await page.locator('#rp-play').getAttribute('aria-label'), '播放', 'pause state')
  const stoppedTick = await page.locator('#rp-timeline').inputValue()
  await sleep(150)
  assert.equal(await page.locator('#rp-timeline').inputValue(), stoppedTick, 'pause freezes replay')
  await page.click('#rp-fwd')
  assert.ok(Number(await page.locator('#rp-timeline').inputValue()) >= Number(stoppedTick) + 60, 'step advances one second')
  const slider = await page.locator('#rp-timeline').boundingBox()
  await page.mouse.click(slider.x + slider.width * 0.5, slider.y + slider.height / 2)
  assert.ok(Number(await page.locator('#rp-timeline').inputValue()) > 0, 'seek from slider')
  await page.screenshot({ path: join(shots, 'replay.png') })
  assert.match(page.url(), /view=replay-player/)
  assert.ok(page.url().includes(`replay=${replayId}`))
  await page.reload()
  await page.locator('#view-replay-player').waitFor({ state: 'visible' })
  await until(() => page.locator('#rp-status').isHidden(), 'replay route restore')
  assert.equal(await page.locator('#rp-play svg.pixel-icon').count(), 1, 'play control uses SVG')
  await page.setViewportSize({ width: 480, height: 820 })
  await until(() => page.locator('#replay-canvas').evaluate(c => c.width === Math.floor(c.clientWidth * devicePixelRatio)), 'replay resize')
  await page.screenshot({ path: join(shots, 'replay-narrow.png') })
  await page.setViewportSize({ width: 1280, height: 800 })
  for (let i = 0; i < 3; i++) {
    await page.click('#rp-return')
    await page.locator('#replay-list button').filter({ hasText: replayId }).click()
    await until(async () => (await page.locator('#rp-status').isHidden()), 'replay ready')
    await page.click('#rp-speed')
    assert.equal(await page.locator('#rp-speed').textContent(), '2×', 'one click must advance once after reopening')
  }
  assert.equal(await page.locator('#rp-play').textContent(), '', 'no character playback icon')
  await page.click('#rp-return')
  assert.equal(new URL(page.url()).searchParams.has('replay'), false, 'list route must clear the previous replay')
  await page.click('#btn-replays-back')
  await page.locator('#view-game').waitFor({ state: 'visible' })
  await page.click('#btn-game-replay')
  await page.locator('#replay-list button').first().waitFor({ state: 'visible' })
  assert.equal(await page.locator('#view-replay-player').isHidden(), true, 'reopening library must stay in list')
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(JSON.stringify({ passed: true, id, generator: map?.generator_ver, screenshots: shots }))
} finally {
  await browser?.close()
  server.kill()
  await new Promise(r => server.exitCode !== null ? r() : server.once('exit', r))
  rmSync(work, { recursive: true, force: true })
}
