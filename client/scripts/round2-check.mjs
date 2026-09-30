import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema, ClientMsgSchema } from '../../packages/protocol/src/index.ts'
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  page.setDefaultTimeout(8000)
  let latest, id, map
  const submissions = []
  const receipts = []
  const robots = new Map()
  page.on('pageerror', e => errors.push(String(e)))
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 2) return
      const msg = fromBinary(ClientMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'scriptSubmit') submissions.push(msg.payload.value)
    })
    socket.on('framereceived', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
      const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'snapshot') { latest = msg.payload.value; if (latest.full) robots.clear(); for (const r of latest.robots) robots.set(r.base.id, r); for (const id of latest.robotGone) robots.delete(id); if (latest.self) id = latest.self.robotId }
      if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'mapBootstrap') { map = JSON.parse(msg.payload.value.kind.value.mapJson); latest = undefined; robots.clear() }
      if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'scriptResult') receipts.push(msg.payload.value.kind.value)
    })
  })
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
  await page.locator('#workbench-doc-content h1').first().waitFor()
  assert.equal(await page.locator('#view-game').isVisible(), true, 'sidebar leaves battlefield visible')
  const tickAtOpen = latest.tick
  await sleep(150)
  const stationary = { ...robots.get(id).base.pos }
  await sleep(200)
  assert.ok(Math.hypot(robots.get(id).base.pos.x - stationary.x, robots.get(id).base.pos.y - stationary.y) < 0.1, 'manual must release movement')
  assert.ok(latest.tick > tickAtOpen, 'simulation continues while reading')
  await page.keyboard.press('m')
  assert.equal(await page.locator('#workbench').isHidden(), true)
  // Open through visible controls, then reload the recorded document route.
  await page.click('#btn-game-manual')
  await page.locator('#workbench-doc-content h1').first().waitFor()
  const tabPage = 'reference/actions'
  await page.click('#workbench-toc-toggle')
  await page.locator('#workbench-toc [data-path="reference"]').click()
  await until(() => page.url().includes('doc=reference%2Findex.md'), 'directory index navigation')
  await page.click('#workbench-toc-toggle')
  await page.locator('#workbench-toc [data-path="reference/data"]').click()
  await page.locator('#workbench-doc-content h1').first().waitFor()
  await page.click('#workbench-toc-toggle')
  await page.locator(`#workbench-toc [data-path="${tabPage}"]`).click()
  await page.getByRole('tab', { name: 'PY', exact: true }).first().click()
  assert.equal(new URL(page.url()).searchParams.get('doc'), `${tabPage}.md`)
  await page.reload()
  await page.locator('#workbench-doc-content h1').first().waitFor()
  const tabs = await page.getByRole('tab').count()
  assert.ok(tabs >= 3 && tabs % 3 === 0, 'manual language groups retain TS/PY/JAVA tabs')
  assert.equal(await page.locator('#workbench-doc-content h1').count(), 1, 'manual should not duplicate its page heading')
  await page.getByRole('tab', { name: 'PY', exact: true }).first().click()
  assert.equal(await page.getByRole('tab', { name: 'PY', exact: true }).first().getAttribute('aria-selected'), 'true')
  await page.screenshot({ path: join(shots, 'manual.png') })
  // Two panes stack vertically, either can fill the column on its own.
  const docsOnly = await page.locator('#workbench-docs').boundingBox()
  await page.click('#btn-game-editor')
  const editorInput = page.getByRole('textbox', { name: '机器人脚本编辑器', exact: true })
  await editorInput.waitFor({ timeout: 20000 })
  const docsHalf = await page.locator('#workbench-docs').boundingBox()
  const editorHalf = await page.locator('#workbench-editor').boundingBox()
  assert.ok(Math.abs(docsHalf.height - editorHalf.height) < 4 && docsHalf.y + docsHalf.height <= editorHalf.y + 2, 'docs above editor, evenly sharing height')
  assert.ok(docsOnly.height > docsHalf.height * 1.8, 'docs alone fills column')
  const stage = await page.locator('#game-stage').boundingBox()
  for (const box of await page.locator('#game-stage .skill').evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect(); return { right: r.right, left: r.left }
  }))) assert.ok(box.left >= stage.x && box.right <= stage.x + stage.width, 'skill cards stay within resized battlefield')
  await page.screenshot({ path: join(shots, 'workbench-both.png') })
  await page.locator('.workbench-tools [data-panel="docs"]').click()
  const editorOnly = await page.locator('#workbench-editor').boundingBox()
  assert.ok(editorOnly.height > editorHalf.height * 1.8, 'editor alone fills column')
  const draftKey = `omb.bot.draft:${JSON.stringify(['ROUND2', 'tester'])}`
  async function replaceSource(source) {
    await editorInput.focus()
    await page.keyboard.press('ControlOrMeta+a')
    await page.evaluate(source => navigator.clipboard.writeText(source), source)
    await page.keyboard.press('ControlOrMeta+v')
    await until(() => page.evaluate(key => localStorage.getItem(key), draftKey).then(s => s === source), 'draft saved')
  }
  const prelude = "/** @param {import('@omb/bot-api').TickContext} ctx */\n"
  // Completion is supplied by the real TypeScript worker using canonical Bot API declarations.
  await replaceSource(`${prelude}function tick(ctx) { ctx.api. }`)
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Control+Space')
  await page.locator('.suggest-widget.visible').waitFor()
  await until(() => page.locator('.suggest-widget.visible').textContent().then(t => t.includes('moveTo')), 'Bot API completion')
  await page.keyboard.press('Escape')
  const validSource = `${prelude}function tick(ctx) { ctx.api.shield(true) }\n`
  await replaceSource(validSource)
  await until(() => page.locator('#workbench-diagnostics').textContent().then(t => t.includes('检查通过')), 'valid JS diagnostics', 20000)
  const energyBefore = robots.get(id).energyX10
  await page.keyboard.press('ControlOrMeta+Enter')
  await until(() => page.locator('#workbench-result').textContent().then(t => t.includes('服务器已加载 r1')), 'script success')
  assert.equal(submissions.at(-1).source, validSource)
  assert.equal(receipts.at(-1).clientScriptId, submissions.at(-1).clientScriptId)
  await page.click('#workbench-assist')
  await until(() => page.locator('#workbench-assist').getAttribute('aria-pressed').then(v => v === 'true'), 'authoritative assist on')
  await until(() => robots.get(id).energyX10 < energyBefore - 20, 'submitted script runs on server')
  await replaceSource('function tick( {')
  await page.click('#workbench-submit')
  await until(() => page.locator('#workbench-result').textContent().then(t => t.includes('加载失败')), 'load failure')
  assert.equal(receipts.at(-1).ok, false)
  assert.equal(receipts.at(-1).scriptRev, 1, 'failed load retains previous revision')
  const energyAfterFailure = robots.get(id).energyX10
  await until(() => robots.get(id).energyX10 < energyAfterFailure - 10, 'old script remains active after failure')
  await page.click('#workbench-assist')
  await until(() => page.locator('#workbench-assist').getAttribute('aria-pressed').then(v => v === 'false'), 'assist off')
  const beforeOversize = submissions.length
  await replaceSource(`// ${'超'.repeat(11000)}\nfunction tick() {}`)
  await page.click('#workbench-submit')
  await until(() => page.locator('#workbench-result').textContent().then(t => t.includes('32 KiB')), 'UTF-8 message size guard')
  assert.equal(submissions.length, beforeOversize, 'oversized source never reaches websocket')
  assert.equal(await page.locator('#workbench-submit').isEnabled(), true, 'oversize rejection keeps connection usable')
  await replaceSource(validSource)
  await page.locator('.workbench-tools [data-panel="docs"]').click()
  const submittedCount = submissions.length
  latest = undefined
  await page.reload()
  await page.locator('#workbench-doc-content h1').first().waitFor()
  await editorInput.waitFor({ timeout: 20000 })
  await until(() => latest?.self && !latest.self.assistOn, 'reload full state')
  assert.equal(id, firstId, 'editor refresh retains robot identity')
  assert.equal(submissions.length, submittedCount, 'reload never auto-submits')
  assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), validSource, 'draft survives refresh')
  assert.equal(new URL(page.url()).searchParams.get('panels'), 'docs,editor')
  await page.screenshot({ path: join(shots, 'workbench-restored.png') })
  await ctx.setOffline(true)
  await until(() => page.locator('#workbench-submit').isDisabled(), 'offline submission disabled')
  await ctx.setOffline(false)
  await until(() => page.locator('#workbench-submit').isEnabled(), 'submission resumes after full synchronization', 20000)
  assert.equal(submissions.length, submittedCount, 'reconnect never replays submissions')
  // Typing gameplay letters cannot leak into the game, including M and Space.
  await replaceSource(validSource)
  const editPosition = { ...robots.get(id).base.pos }
  await page.keyboard.press('End')
  await page.keyboard.type('// wasd m ')
  await sleep(300)
  assert.ok(Math.hypot(robots.get(id).base.pos.x - editPosition.x, robots.get(id).base.pos.y - editPosition.y) < 0.1, 'editing does not drive robot')
  assert.equal(await page.locator('#workbench-docs').isVisible(), true, 'typing m preserves docs')
  await page.setViewportSize({ width: 480, height: 820 })
  await page.locator('.workbench-tools [data-panel="docs"]').click()
  assert.equal(await page.locator('#workbench-docs').isHidden(), true, 'narrow document button remains clickable beside audio settings')
  await page.locator('.workbench-tools [data-panel="docs"]').click()
  await page.locator('#workbench-doc-content h1').waitFor()
  await page.screenshot({ path: join(shots, 'workbench-narrow.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'sidebar narrow viewport overflow')
  await page.click('#workbench-close')
  assert.equal(await page.locator('#workbench').isHidden(), true)
  await page.setViewportSize({ width: 1280, height: 800 })
  await until(() => page.locator('#game-canvas').evaluate(c => Math.abs(c.clientWidth - innerWidth) < 2), 'closing restores full battlefield width')
  const closedPosition = { ...robots.get(id).base.pos }
  await page.keyboard.down('s')
  await until(() => Math.hypot(robots.get(id).base.pos.x - closedPosition.x, robots.get(id).base.pos.y - closedPosition.y) > 0.3, 'manual control resumes after closing sidebar')
  await page.keyboard.up('s')
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
} catch (error) {
  console.error('Browser errors:', errors)
  const failedPage = browser?.contexts()[0]?.pages()[0]
  await failedPage?.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await browser?.close()
  server.kill()
  await new Promise(r => server.exitCode !== null ? r() : server.once('exit', r))
  rmSync(work, { recursive: true, force: true })
}
