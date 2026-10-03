import { startClient } from './startup-helpers.mjs'
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
const port = Number(process.env.OMB_E2E_PORT || 18420)
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', `127.0.0.1:${port}`], { cwd: work, stdio: 'ignore' })
let browser
const errors = []
const base = `http://127.0.0.1:${port}`
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
  const says = []
  const messages = []
  const inputs = []
  const robots = new Map()
  const projectileSnapshots = []
  const projectileImpacts = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 2) return
      const msg = fromBinary(ClientMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'scriptSubmit') submissions.push(msg.payload.value)
      if (msg.payload.case === 'say') says.push(msg.payload.value.text)
      if (msg.payload.case === 'input') inputs.push(msg.payload.value)
    })
    socket.on('framereceived', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
      const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'snapshot') {
        latest = msg.payload.value
        projectileSnapshots.push(...latest.projectiles)
        if (latest.full) robots.clear()
        for (const r of latest.robots) {
          const previous = robots.get(r.base.id)
          robots.set(r.base.id, { ...r, nick: r.nick || previous?.nick || '', color: r.color || previous?.color || '' })
        }
        for (const gone of latest.robotGone) robots.delete(gone)
        if (latest.self) id = latest.self.robotId
      }
      if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'mapBootstrap') { map = JSON.parse(msg.payload.value.kind.value.mapJson); latest = undefined; robots.clear() }
      if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'scriptResult') receipts.push(msg.payload.value.kind.value)
      if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'say') messages.push(msg.payload.value.kind.value)
      if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'projectileImpact') projectileImpacts.push(msg.payload.value.kind.value)
    })
  })
  await page.goto(base)
  await startClient(page)
  await page.screenshot({ path: join(shots, 'join.png') })
  await page.fill('#in-room', 'ROUND2')
  await page.fill('#in-nick', 'tester')
  await page.press('#in-nick', 'm')
  assert.equal(await page.locator('#view-manual').isHidden(), true, 'typing m must not open manual')
  await page.fill('#in-nick', 'tester')
  await page.locator('.swatch[title="#a78bfa"]').click()
  await page.click('#btn-join')
  await page.locator('#btn-start').waitFor({ state: 'visible' })
  await page.keyboard.press('m')
  await page.locator('#manual-content h1').first().waitFor()
  for (const width of [1280, 480]) {
    await page.setViewportSize({ width, height: 800 })
    const back = await page.locator('#btn-manual-back').boundingBox()
    const sound = await page.locator('#audio-settings').boundingBox()
    assert.ok(back.x + back.width <= sound.x || sound.y >= back.y + back.height, 'sound entry never covers manual back button')
    await page.locator('#audio-settings summary').click()
    assert.equal(await page.locator('#audio-volume').isVisible(), true)
    await page.locator('#audio-settings summary').click()
    await page.screenshot({ path: join(shots, `manual-toolbar-${width}.png`) })
  }
  await page.setViewportSize({ width: 1280, height: 800 })
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
  await until(() => projectileSnapshots.some(projectile => projectile.ownerId === id), 'authoritative projectile snapshot')
  await page.mouse.up()
  assert.equal(robots.get(id).color, '#a78bfa', 'selected shooter color survives join')
  assert.ok(projectileSnapshots.filter(projectile => projectile.ownerId === id).every(projectile => projectile.color === '#a78bfa'), 'projectile snapshots carry owner color without requiring visible robot metadata')
  await page.screenshot({ path: join(shots, 'game.png') })
  const beforeRefresh = { ...robots.get(id).base.pos }
  latest = undefined
  robots.clear()
  await page.reload()
  await startClient(page)
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
  // Enter opens IME-safe chat, shares the server Say path and restores canvas focus.
  await page.locator('#game-canvas').focus()
  await page.keyboard.press('Enter')
  await page.locator('#game-chat-input').waitFor({ state: 'visible' })
  const chatPosition = { ...robots.get(id).base.pos }
  await page.fill('#game-chat-input', 'wasd中文发言')
  await page.locator('#game-chat-input').dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  assert.equal(says.length, 0, 'composition confirmation never sends chat')
  assert.equal(await page.locator('#game-chat').isVisible(), true)
  await sleep(100)
  assert.ok(Math.hypot(robots.get(id).base.pos.x - chatPosition.x, robots.get(id).base.pos.y - chatPosition.y) < 0.1, 'chat input never drives robot')
  await page.keyboard.press('Enter')
  await until(() => messages.some(m => m.robot === id && m.text === 'wasd中文发言'), 'manual say broadcast')
  assert.equal(says.length, 1)
  assert.equal(await page.evaluate(() => document.activeElement.id), 'game-canvas', 'send restores battlefield focus')
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#game-chat').isHidden(), true, 'shared say cooldown blocks repeated chat')
  const cooldownTick = latest.tick + 181
  await until(() => latest.tick >= cooldownTick, 'say cooldown expires on server tick')
  await page.keyboard.press('Enter')
  await page.locator('#game-chat-input').waitFor({ state: 'visible' })
  await page.fill('#game-chat-input', '取消不发送')
  await page.keyboard.press('Escape')
  assert.equal(says.length, 1, 'Escape cancels without sending')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'game-canvas')
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
  await startClient(page)
  await page.locator('#workbench-doc-content h1').first().waitFor()
  const tabs = await page.getByRole('tab').count()
  assert.ok(tabs >= 3 && tabs % 3 === 0, 'manual language groups retain TS/PY/JAVA tabs')
  assert.equal(await page.locator('#workbench-doc-content h1').count(), 1, 'manual should not duplicate its page heading')
  await page.getByRole('tab', { name: 'PY', exact: true }).first().click()
  assert.equal(await page.getByRole('tab', { name: 'PY', exact: true }).first().getAttribute('aria-selected'), 'true')
  await page.screenshot({ path: join(shots, 'manual.png') })
  // Two panes stack vertically, either can fill the column on its own.
  const docsOnly = await page.locator('#workbench-docs').boundingBox()
  await page.locator('#workbench-doc-content').focus()
  await page.keyboard.press('c')
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
  // Focus the battlefield while both panes remain visible: keys and fire must work.
  await page.locator('#game-canvas').click({ position: { x: 250, y: 330 } })
  const focusedAt = inputs.length
  await page.keyboard.down('d')
  await until(() => inputs.slice(focusedAt).some(i => i.moveX > 0), 'movement with both panels open')
  await page.mouse.down()
  await page.keyboard.down('e')
  await until(() => inputs.slice(focusedAt).some(i => i.fire && i.interact), 'fire and interact with both panels open')
  await editorInput.focus()
  await until(() => inputs.slice(focusedAt).some(i => !i.fire && !i.interact && i.moveX === 0 && (i.axisMask & 13) === 13), 'focus change sends complete stop frame')
  await page.mouse.up()
  await page.keyboard.up('d')
  await page.keyboard.up('e')
  const stoppedAt = inputs.length
  await page.keyboard.type('wasd c m ')
  await sleep(100)
  assert.equal(inputs.length, stoppedAt, 'typing never leaks control frames or shortcuts')
  assert.equal(await page.locator('#workbench-docs').isVisible(), true)
  assert.equal(await page.locator('#workbench-editor').isVisible(), true)
  const widthHandle = page.locator('#workbench-resize')
  const oldWidth = (await page.locator('#workbench').boundingBox()).width
  const grip = await widthHandle.boundingBox()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x - 90, grip.y + grip.height / 2, { steps: 8 })
  await page.mouse.up()
  const resizedWidth = (await page.locator('#workbench').boundingBox()).width
  assert.ok(resizedWidth >= oldWidth + 80, 'sidebar width resizes by pointer')
  await widthHandle.focus()
  await page.keyboard.press('ArrowRight')
  assert.ok((await page.locator('#workbench').boundingBox()).width < resizedWidth, 'separator arrow resizes sidebar')
  const splitHandle = page.locator('#workbench-split')
  await splitHandle.focus()
  await page.keyboard.press('ArrowDown')
  assert.ok((await page.locator('#workbench-docs').boundingBox()).height > docsHalf.height, 'split keyboard resizes pane ratio')
  const split = await splitHandle.boundingBox()
  await page.mouse.move(split.x + split.width / 2, split.y + split.height / 2)
  await page.mouse.down()
  await page.mouse.move(split.x + split.width / 2, split.y - 55, { steps: 8 })
  await page.mouse.up()
  assert.ok((await page.locator('#workbench-docs').boundingBox()).height < docsHalf.height, 'split pointer adjusts pane heights')
  const savedWidth = (await page.locator('#workbench').boundingBox()).width
  const savedDocsHeight = (await page.locator('#workbench-docs').boundingBox()).height
  await page.screenshot({ path: join(shots, 'workbench-both.png') })
  await page.locator('.workbench-tools [data-panel="docs"]').click()
  const editorOnly = await page.locator('#workbench-editor').boundingBox()
  assert.ok(editorOnly.height > editorHalf.height * 1.8, 'editor alone fills column')
  const draftKey = `omb.bot.draft:${JSON.stringify(['ROUND2', 'tester'])}`
  const tsDraftKey = `omb.bot.draft:${JSON.stringify(['ROUND2', 'tester', 'ts'])}`
  async function replaceSource(source, key = draftKey) {
    await editorInput.focus()
    await page.keyboard.press('ControlOrMeta+a')
    await page.evaluate(source => navigator.clipboard.writeText(source), source)
    await page.keyboard.press('ControlOrMeta+v')
    await until(() => page.evaluate(k => localStorage.getItem(k), key).then(s => s === source), 'draft saved')
  }
  const prelude = "/** @param {import('@omb/bot-api').BotContext} bot */\n"
  // Completion is supplied by the real TypeScript worker using canonical Bot API declarations.
  await replaceSource(`${prelude}function tick(bot) { bot. }`)
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Control+Space')
  await page.locator('.suggest-widget.visible').waitFor()
  await until(() => page.locator('.suggest-widget.visible').textContent().then(t => t.includes('moveTo')), 'Bot API completion')
  await page.keyboard.press('Escape')
  const validSource = `let layoutLog = 0\nconsole.info('JS load console')\n${prelude}function tick(bot) { if (layoutLog < 3600) console.debug('layout-log', layoutLog++); bot.shield(true); bot.say('脚本 say 正常') }\n`
  await replaceSource(validSource)
  await until(() => page.locator('#workbench-diagnostics').textContent().then(t => t.includes('检查通过')), 'valid JS diagnostics', 20000)
  const energyBefore = robots.get(id).energyX10
  assert.equal(await editorInput.evaluate(el => el === document.activeElement), true, 'Monaco focused before submit')
  await page.keyboard.press('ControlOrMeta+Enter')
  await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('服务器已加载脚本 r1')), 'script success')
  await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('JS load console')), 'real server console log')
  assert.equal(await editorInput.evaluate(el => el === document.activeElement), true, 'console follow never steals Monaco focus')
  await page.click('#workbench-console-toggle')
  assert.equal(await page.locator('#workbench-console-toggle').getAttribute('aria-expanded'), 'false', 'console collapses')
  assert.equal(await page.locator('.script-console-body').isHidden(), true, 'collapsed console does not cover editor')
  await page.click('#workbench-console-toggle')
  assert.equal(await page.locator('#workbench-console-toggle').getAttribute('aria-expanded'), 'true', 'console expands')
  const cleared = await page.evaluate(() => {
    document.querySelector('.script-console-clear').click()
    return { text: document.querySelector('.script-console-list').textContent, count: document.querySelector('.script-console-tab [data-console-count]').textContent }
  })
  assert.equal(cleared.text, '等待脚本输出 · 使用 console.log(...) 调试', 'console clear restores empty-state hint')
  assert.equal(cleared.count, '0', 'console count resets after clear')
  assert.equal(submissions.at(-1).source, validSource)
  assert.equal(receipts.at(-1).clientScriptId, submissions.at(-1).clientScriptId)
  await page.click('#workbench-assist')
  await until(() => page.locator('#workbench-assist').getAttribute('aria-pressed').then(v => v === 'true'), 'authoritative assist on')
  await until(() => robots.get(id).energyX10 < energyBefore - 20, 'submitted script runs on server')
  await until(() => messages.some(m => m.robot === id && m.text === '脚本 say 正常'), 'script say shares public broadcast path')
  await until(() => page.locator('.script-console-tab [data-console-count]').textContent().then(t => Number(t) === 300), 'console fills bounded browser buffer', 25000)
  await page.locator('.workbench-tools [data-panel="docs"]').click()
  assert.equal(await page.locator('#workbench-docs').isVisible(), true, 'docs and editor remain visible with full console')
  for (const width of [400, 320]) {
    await page.setViewportSize({ width, height: 700 })
    await page.locator('.script-console-list').evaluate(list => { list.scrollTop = list.scrollHeight })
    const layout = await page.evaluate(() => {
      const body = document.querySelector('.script-console-body').getBoundingClientRect()
      const list = document.querySelector('.script-console-list')
      const listRect = list.getBoundingClientRect()
      const last = list.lastElementChild.getBoundingClientRect()
      return { bodyBottom: body.bottom, listBottom: listRect.bottom, lastBottom: last.bottom, scrollBottom: list.scrollHeight - list.scrollTop - list.clientHeight, overflow: document.documentElement.scrollWidth > innerWidth }
    })
    assert.ok(Math.abs(layout.bodyBottom - layout.listBottom) < 1.5, `${width}px console list fits body`)
    assert.ok(layout.lastBottom <= layout.listBottom + 1, `${width}px final log line is visible`)
    assert.ok(layout.scrollBottom <= 1, `${width}px console reaches true bottom`)
    assert.equal(layout.overflow, false, `${width}px workbench has no horizontal overflow`)
    await editorInput.focus()
    const beforeScroll = await page.locator('.script-console-list').evaluate(list => { list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - 240); return { top: list.scrollTop } })
    const beforeLast = await page.locator('.script-console-line').last().getAttribute('data-tick')
    await until(() => page.locator('.script-console-line').last().getAttribute('data-tick').then(t => t !== beforeLast), `${width}px receives log while scrolled up`, 10000)
    const afterScroll = await page.locator('.script-console-list').evaluate(list => ({ top: list.scrollTop, distance: list.scrollHeight - list.scrollTop - list.clientHeight }))
    assert.ok(afterScroll.distance > 100, `${width}px appended log does not jump to bottom`)
    assert.ok(Math.abs(afterScroll.top - beforeScroll.top) < 80, `${width}px scroll stays near user position`)
    assert.equal(await editorInput.evaluate(el => el === document.activeElement), true, `${width}px append keeps Monaco focus`)
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('.workbench-tools [data-panel="docs"]').click()
  const oldScriptTick = await page.locator('.script-console-line').last().getAttribute('data-tick')
  await replaceSource('function tick( {')
  await page.click('#workbench-submit')
  await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('加载失败')), 'load failure')
  assert.equal(receipts.at(-1).ok, false)
  assert.equal(receipts.at(-1).scriptRev, 1, 'failed load retains previous revision')
  await until(() => page.locator('.script-console-line').last().getAttribute('data-tick').then(t => t !== oldScriptTick), 'old script remains active after failure')
  await page.click('#workbench-assist')
  await until(() => page.locator('#workbench-assist').getAttribute('aria-pressed').then(v => v === 'false'), 'assist off')
  const beforeOversize = submissions.length
  await replaceSource(`// ${'超'.repeat(11000)}\nfunction tick() {}`)
  await page.click('#workbench-submit')
  await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('32 KiB')), 'UTF-8 message size guard')
  assert.equal(submissions.length, beforeOversize, 'oversized source never reaches websocket')
  assert.equal(await page.locator('#workbench-submit').isEnabled(), true, 'oversize rejection keeps connection usable')
  await replaceSource(validSource)
  const legacySource = `console.info('legacy ctx.api load')\nfunction tick(ctx) { ctx.api.shield(true); ctx.api.say('旧 ctx.api 正常') }\n`
  await replaceSource(legacySource)
  await page.keyboard.press('ControlOrMeta+Enter')
  await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('服务器已加载脚本 r2')), 'legacy ctx.api loads on real server')
  await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('legacy ctx.api load') && t.includes('script r2')), 'legacy load console reaches owner')
  await page.click('#workbench-assist')
  await until(() => page.locator('#workbench-assist').getAttribute('aria-pressed').then(v => v === 'true'), 'assist on for legacy script')
  await until(() => messages.some(m => m.robot === id && m.text === '旧 ctx.api 正常'), 'legacy ctx.api executes on real server', 15000)
  await page.click('#workbench-assist')
  await until(() => page.locator('#workbench-assist').getAttribute('aria-pressed').then(v => v === 'false'), 'assist off after legacy script')
  // TypeScript 模式：开关、注解补全、编译提交、编译失败保留旧脚本。
  const tsSource = ["import type { BotContext } from '@omb/bot-api'", "", "console.info('TS load console')", "export function tick(bot: BotContext) {", "  const walls = bot.scan().walls", "  if (!Array.isArray(walls) || !walls.length) throw new Error('missing static walls')", "  if (!walls.every(w => Number.isFinite(w.min.x) && Number.isFinite(w.min.y) && Number.isFinite(w.max.x) && Number.isFinite(w.max.y) && w.min.x <= w.max.x && w.min.y <= w.max.y)) throw new Error('invalid wall geometry')", "  const heading: number = bot.self.position.x + bot.self.position.y", "  bot.shield(heading > 0)", "  bot.say('TS 脚本运行正常')", "}", ""].join(String.fromCharCode(10))
  await page.click('#workbench-lang-switch [data-lang="ts"]')
  assert.equal(await page.locator('#workbench-lang-switch [data-lang="ts"]').getAttribute('aria-pressed'), 'true', 'TS switch toggles pressed state')
  assert.equal(await page.locator('#workbench-lang-switch [data-lang="js"]').getAttribute('aria-pressed'), 'false', 'JS switch released')
  await until(() => page.locator('#workbench-diagnostics').textContent().then(t => t.includes('检查通过')), 'TS diagnostics', 20000)
  await replaceSource(tsSource, tsDraftKey)
  await until(() => page.locator('#workbench-diagnostics').textContent().then(t => t.includes('检查通过')), 'TS annotations diagnostics', 20000)
  await page.screenshot({ path: join(shots, 'workbench-ts.png') })
  const jsBeforeTs = submissions.length
  await page.keyboard.press('ControlOrMeta+Enter')
  await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('服务器已加载脚本 r3')), 'TS compiles and submits JS', 20000)
  assert.equal(submissions.length, jsBeforeTs + 1, 'TS submit sends exactly one message')
  const tsPayload = submissions.at(-1).source
  assert.ok(!tsPayload.includes(': BotContext'), 'submitted source is compiled, not TS')
  assert.ok(tsPayload.includes('function tick'), 'compiled JS keeps tick entrypoint')
  await page.click('#workbench-assist')
  await until(() => page.locator('#workbench-assist').getAttribute('aria-pressed').then(v => v === 'true'), 'assist on for TS script')
  await until(() => messages.some(m => m.robot === id && m.text === 'TS 脚本运行正常'), 'compiled TS script runs on server')
  await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('TS load console') && t.includes('script r3')), 'TS console revision appears')
  assert.equal(await page.evaluate(key => localStorage.getItem(key), tsDraftKey), tsSource, 'TS draft saved under language-scoped key')
  // 编译失败：不发送任何帧，旧脚本继续运行。
  await replaceSource('function tick(bot: { moveTo(p: { x: number, y: number }): void }) { bot.moveTo() }\n', tsDraftKey)
  await page.keyboard.press('ControlOrMeta+Enter')
  await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('TypeScript 编译失败')), 'compile failure surfaces TS errors', 20000)
  assert.ok(await page.locator('.script-console-list').textContent().then(t => t.includes('第 1 行')), 'compile errors carry original TS line numbers')
  assert.equal(submissions.length, jsBeforeTs + 1, 'compile failure sends nothing')
  await until(() => messages.some(m => m.robot === id && m.text === 'TS 脚本运行正常'), 'old compiled script keeps running', 100)
  assert.equal(receipts.at(-1).scriptRev, 3, 'compile failure leaves server revision untouched')
  assert.ok(await page.locator('#workbench-submit').isEnabled(), 'compile failure keeps submit usable')
  await page.screenshot({ path: join(shots, 'workbench-ts-error.png') })
  await page.click('#workbench-assist')
  await until(() => page.locator('#workbench-assist').getAttribute('aria-pressed').then(v => v === 'false'), 'assist off after TS checks')
  await replaceSource(tsSource, tsDraftKey)
  await page.click('#workbench-lang-switch [data-lang="js"]')
  assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), legacySource, 'switching back restores the latest JS draft')
  await until(() => page.locator('#workbench-diagnostics').textContent().then(t => t.includes('检查通过')), 'JS diagnostics after switching back', 20000)

  // Snippet tool pane: bootstrap publishes all six official sources; custom
  // switches/range controls apply over the real websocket and never stay pending.
  await page.locator('.workbench-tools [data-panel="snippets"]').click()
  await page.locator('#workbench-snippets').waitFor({ state: 'visible' })
  await until(() => page.locator('.snippet-source-count').textContent().then(t => t?.includes('6 / 6')), 'official snippet sources', 20000)
  assert.equal(await page.locator('.snippet-row').count(), 6, 'six official snippet cards render')
  assert.equal(await page.locator('.snippet-switch').count(), 6, 'all cards use custom switches')
  assert.ok(await page.locator('.snippet-range-shell').count() >= 3, 'numeric modules use custom sliders')
  await page.locator('.snippet-row[data-kind="autoAim"] .snippet-toggle').click()
  await page.locator('.snippet-row[data-kind="avoid"] .snippet-toggle').click()
  await page.locator('.snippet-row[data-kind="avoid"] .snippet-range-input').fill('12')
  await page.locator('.snippet-apply').click()
  await until(() => page.locator('.snippet-status').textContent().then(t => /已生效|配置已保存/.test(t || '')), 'snippet config ack', 12000)
  assert.notEqual(await page.locator('.snippet-status').getAttribute('data-phase'), 'pending', 'snippet apply leaves pending state')
  await page.locator('.snippet-row[data-kind="autoAim"] .snippet-source-toggle').click()
  assert.match(await page.locator('.snippet-row[data-kind="autoAim"] .snippet-source pre').textContent(), /function snippetTick/, 'official source is visible')
  await page.screenshot({ path: join(shots, 'workbench-snippets.png') })
  // Tool panes are exclusive; explicitly restore the prior docs+editor layout
  // before the reload/persistence assertions below.
  await page.locator('.workbench-tools [data-panel="editor"]').click()
  await page.locator('.workbench-tools [data-panel="docs"]').click()
  const submittedCount = submissions.length
  latest = undefined
  await page.reload()
  await startClient(page)
  await page.locator('#workbench-doc-content h1').first().waitFor()
  await editorInput.waitFor({ timeout: 20000 })
  await until(() => latest?.self && !latest.self.assistOn, 'reload full state')
  assert.equal(id, firstId, 'editor refresh retains robot identity')
  assert.equal(submissions.length, submittedCount, 'reload never auto-submits')
  assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), legacySource, 'latest JS draft survives refresh')
  assert.equal(new URL(page.url()).searchParams.get('panels'), 'docs,editor')
  assert.ok(Math.abs((await page.locator('#workbench').boundingBox()).width - savedWidth) < 2, 'sidebar width survives reload')
  assert.ok(Math.abs((await page.locator('#workbench-docs').boundingBox()).height - savedDocsHeight) < 3, 'split ratio survives reload')
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
  await startClient(other)
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
  await startClient(page)
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
