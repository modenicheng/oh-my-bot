// 手册资产截取 harness：起 vite dev server（多页入口 capture.html），
// 用真实 draw* 渲染的 sprite sheet、内联 SVG 示意图与逐枚图标截图为 PNG，
// 写入 docs/manual/reference/images/。
// UI 截图（startup/lobby/HUD/结算等）走 mock-WS fixture，复用 pickup-visual-check 模式。
// 用法：pnpm --dir client capture:manual  （或 node client/scripts/capture-manual-assets.mjs）
// 可用 OMB_CAPTURE_ONLY=sheets,diagrams,icons,ui 只跑其中几组（逗号分隔，默认全跑）。
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { create, toBinary, fromBinary } from '@bufbuild/protobuf'
import {
  ServerMsgSchema, ClientMsgSchema, ServerEventSchema, SnapshotDeltaSchema,
  EvRoomStateSchema, EvMapBootstrapSchema, EvScoreboardSchema, EvMatchEndSchema, EvScriptLogSchema,
} from '../../packages/protocol/src/index.ts'
import { gen2MapJson, frame } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolve(here, '..')
const repoRoot = resolve(clientRoot, '..')

// ---------- 配置 ----------
const PORT = Number(process.env.OMB_CAPTURE_PORT || 18458)
const DOC_IMAGES = resolve(repoRoot, 'docs/manual/reference/images')
const ARTIFACTS = resolve(repoRoot, '.artifacts/manual')

const CATEGORIES = ['arena', 'robots', 'pickups', 'projectiles', 'icons']
const ONLY = new Set((process.env.OMB_CAPTURE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean))
const want = (group) => ONLY.size === 0 || ONLY.has(group)
const relDoc = (p) => `docs/manual/reference/images/${p}`

// ---------- sprite sheet / 示意图 / 图标（vite dev + capture.html）----------
async function captureSheets(browser) {
  // vite dev server（多页应用：/capture.html）
  const viteMod = await import('vite')
  const vite = await viteMod.createServer({
    root: clientRoot,
    configFile: resolve(clientRoot, 'vite.config.ts'),
    server: { port: PORT, host: '127.0.0.1', strictPort: true },
    logLevel: 'error',
  })
  await vite.listen()
  const origin = `http://127.0.0.1:${PORT}`

  const needsPage = want('sheets') || want('icons')
  const page = needsPage
    ? await browser.newPage({ viewport: { width: 1400, height: 900 } })
    : null
  if (page) {
    page.on('pageerror', (e) => { throw e })
    await page.goto(`${origin}/capture.html`)
    await page.waitForSelector('html[data-capture-ready="1"]', { timeout: 20000 })
    await page.evaluate(() => document.fonts.ready)
  }

  if (want('sheets')) {
    for (const cat of CATEGORIES) {
      const el = page.locator(`#sheet-${cat}`)
      await el.scrollIntoViewIfNeeded()
      await el.screenshot({ path: join(DOC_IMAGES, `sheet-${cat}.png`) })
      console.log(`[capture] ${relDoc(`sheet-${cat}.png`)}`)
    }
  }

  // 示意图：内联 SVG 区块，2x 导出保证阅读器内清晰。
  if (want('diagrams')) {
    await mkdir(join(DOC_IMAGES, 'diagrams'), { recursive: true })
    const ctx2x = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
    const page2x = await ctx2x.newPage()
    page2x.on('pageerror', (e) => { throw e })
    await page2x.goto(`${origin}/capture.html`)
    await page2x.waitForSelector('html[data-capture-ready="1"]', { timeout: 20000 })
    await page2x.evaluate(() => document.fonts.ready)
    const slugs = await page2x.$$eval('[id^="diagram-"]', (els) => els.map((el) => el.id.slice('diagram-'.length)))
    for (const slug of slugs) {
      const el = page2x.locator(`#diagram-${slug}`)
      await el.scrollIntoViewIfNeeded()
      await el.screenshot({ path: join(DOC_IMAGES, 'diagrams', `${slug}.png`) })
      console.log(`[capture] ${relDoc(`diagrams/${slug}.png`)}`)
    }
    await ctx2x.close()
  }

  // 逐枚图标：capture 页把 64×64 透明底 PNG 以 dataURL 挂在 window.__ombManualIcons。
  if (want('icons')) {
    await mkdir(join(DOC_IMAGES, 'icons'), { recursive: true })
    const icons = await page.evaluate(() => window.__ombManualIcons || {})
    const names = Object.keys(icons)
    if (!names.length) throw new Error('window.__ombManualIcons 为空 — capture.ts 未导出图标')
    for (const name of names.sort()) {
      const dataUrl = icons[name]
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      await writeFile(join(DOC_IMAGES, 'icons', `${name}.png`), Buffer.from(b64, 'base64'))
      console.log(`[capture] ${relDoc(`icons/${name}.png`)}`)
    }
  }

  if (page) await page.close()
  await vite.close()
}

// ---------- UI 截图（静态 dist + mock-WS fixture，复用 pickup-visual-check 模式）----------
async function captureUI(browser) {
  // 需要 dist；不存在则提示先构建。
  const indexPath = join(clientRoot, 'dist', 'index.html')
  try { await readFile(indexPath) } catch {
    console.error('[capture] 缺少 client/dist — 先运行 pnpm --dir client build')
    process.exit(1)
  }

  // fixture 数据（与 pickup-visual-check 相同结构）
  const SELF_ID = 101
  const PACK_POS = { x: 2.2, y: 0 }
  const CORE_POS = { x: -2.4, y: 0 }
  const PHASE_OUTER = 1, R_PLAYING = 2, CS_HUMAN = 1

  // MapDef 走 Go JSON 序列化形状（snake_case 键、大写 X/Y），与 mapdef.ts parseMapDef
  // 兼容；与 pickup-visual-check 同源（harness.gen2MapJson），仅 uplink 挪到 (0, 6)。
  const MAP_JSON = gen2MapJson('capture01', { uplink: { id: 900, pos: { X: 0, Y: 6 }, main: false, interact_r: 2.5, active_phase: 1 } })

  // 协议编解码（与 manual-check 同源：@omb/protocol 生成的 schema）
  const MAP_JSON_STR = MAP_JSON
  function frameMsg(payload) {
    return Buffer.concat([Buffer.from([frame.down]), toBinary(ServerMsgSchema, create(ServerMsgSchema, { payload }))])
  }

  const server = createServer(async (req, res) => {
    if (req.url === '/' || !req.url.includes('.')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(await readFile(indexPath, 'utf8')); return }
    try {
      const data = await readFile(join(clientRoot, 'dist', req.url.replace(/^\//, '')))
      const ct = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }[extname(req.url)] || 'application/octet-stream'
      res.writeHead(200, { 'content-type': ct }); res.end(data)
    } catch { res.writeHead(404); res.end() }
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const buf = Buffer.from(data)
      if (buf[0] === frame.ping) { ws.send(Buffer.from([frame.pong])); return } // ping → pong
      if (buf[0] !== frame.up) return // 0x02 = protobuf 消息帧
      let msg
      try { msg = fromBinary(ClientMsgSchema, buf.subarray(1)) } catch { return }
      const cmd = msg.payload
      // join 后推 roomState + mapBootstrap + snapshot
      if (cmd.case === 'join') {
        ws.send(frameMsg({ case: 'event', value: create(ServerEventSchema, { kind: { case: 'roomState',
          value: create(EvRoomStateSchema, { state: R_PLAYING, robotsOnline: 2, hostNick: '截图中' }) } }) }))
        ws.send(frameMsg({ case: 'event', value: create(ServerEventSchema, { tick: 0, kind: { case: 'mapBootstrap',
          value: create(EvMapBootstrapSchema, { mapJson: MAP_JSON_STR, mapHash: 'capture01', generatorVersion: 2 }) } }) }))
        const snap = {
          tick: 600, ackSeq: 1, phase: PHASE_OUTER, timeLeftS: 240, full: true,
          robots: [{ base: { id: SELF_ID, pos: { x: 0, y: 0 }, heading: 0 }, hpX10: 7500, energyX10: 6200, color: '#22d3ee', nick: '截图者' },
                   { base: { id: 202, pos: { x: -5, y: 3 }, heading: 2 }, hpX10: 5200, energyX10: 5000, color: '#a3e635', nick: '对手' }],
          projectiles: [{ base: { id: 301, pos: { x: 1, y: 2 }, heading: 0.5 }, ownerId: 202, color: '#a3e635' }],
          cores: [{ base: { id: 1, pos: CORE_POS }, value: 25 }],
          uplinks: [{ base: { id: 900, pos: { x: 0, y: 6 } }, ready: false, hackingId: 101, progressX10: 48 }],
          healthPacks: [{ base: { id: 7, pos: PACK_POS }, available: true }],
          self: { robotId: SELF_ID, moveSrc: CS_HUMAN, turretSrc: CS_HUMAN, assistOn: true, manualAxesMask: 3 },
        }
        ws.send(frameMsg({ case: 'snapshot', value: create(SnapshotDeltaSchema, snap) }))
        // 记分板
        ws.send(frameMsg({ case: 'event', value: create(ServerEventSchema, { tick: 600, kind: { case: 'scoreboard',
          value: create(EvScoreboardSchema, { tick: 600, rows: [{ robot: 202, score: 12 }, { robot: SELF_ID, score: 35 }] }) } }) }))
        const logEvent = (tick, text, level = 'log') => frameMsg({ case: 'event', value: create(ServerEventSchema, { tick, kind: { case: 'scriptLog',
          value: create(EvScriptLogSchema, { robotId: SELF_ID, scriptRev: 4, tick, level, text }) } }) })
        ws.send(logEvent(601, 'scan complete'))
        ws.send(logEvent(602, 'scan complete'))
        ws.send(logEvent(603, 'scan complete'))
        const structured = '\x1eomb-console:v1:' + JSON.stringify({ a: [
          { k: 's', v: 'state' },
          { k: 'o', p: [
            ['self', { k: 'o', p: [['hp', { k: 'n', v: '75' }], ['armed', { k: 'b', v: 'true' }]], m: 0 }],
            ['targets', { k: 'a', p: [['0', { k: 's', v: 'alpha' }], ['1', { k: 's', v: 'beta' }]], m: 0 }],
          ], m: 0 },
        ], m: 0 })
        ws.send(logEvent(604, structured, 'debug'))
      }
    })
  })
  await new Promise((r) => server.listen(PORT + 1, '127.0.0.1', r))
  const base = `http://127.0.0.1:${PORT + 1}`

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => { throw e })
  // 工作台截图使用真实 ManualView 数据流；静态 fixture 只提供手册首页。
  await page.route('**/api/manual**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/manual') {
      await route.fulfill({ json: [{ path: 'index.md', title: 'oh-my-bot 玩家手册', order: 0, children: [] }] })
      return
    }
    if (pathname === '/api/manual/index.md') {
      await route.fulfill({ contentType: 'text/markdown; charset=utf-8', body: await readFile(resolve(repoRoot, 'docs/manual/index.md')) })
      return
    }
    await route.fulfill({ status: 404, body: 'not found' })
  })
  await page.goto(base + '/')
  // 走真实启动门（startup overlay Enter）
  await page.waitForSelector('#startup[data-state="ready"]', { timeout: 30000 })
  await page.evaluate(() => document.getElementById('startup')?.focus())
  await page.keyboard.press('Enter')
  await page.waitForSelector('#startup', { state: 'hidden', timeout: 10000 })
  await page.screenshot({ path: join(DOC_IMAGES, 'ui-lobby.png') })
  console.log(`[capture] ${relDoc('ui-lobby.png')}`)

  // 进入对局 HUD
  await page.fill('#in-room', 'SHOT')
  await page.fill('#in-nick', '截图者')
  await page.click('#btn-join')
  await page.waitForSelector('#view-game', { state: 'visible', timeout: 10000 })
  await page.waitForTimeout(600) // 等 HUD 渲染 + 血包 sprite
  await page.screenshot({ path: join(DOC_IMAGES, 'ui-hud.png') })
  console.log(`[capture] ${relDoc('ui-hud.png')}`)

  // Esc 选项层：真实主界面 DOM、输入释放与共享音频控件。
  await page.locator('#game-canvas').focus()
  await page.keyboard.press('Escape')
  await page.waitForSelector('#game-options', { state: 'visible', timeout: 5000 })
  await page.screenshot({ path: join(DOC_IMAGES, 'ui-options.png') })
  console.log(`[capture] ${relDoc('ui-options.png')}`)
  await page.keyboard.press('Escape')
  await page.waitForSelector('#game-options', { state: 'hidden', timeout: 5000 })

  // 工作台（编辑器 + 控制台 + 手册面板）
  await page.locator('#game-canvas').focus()
  await page.keyboard.press('c')
  await page.waitForSelector('#workbench', { state: 'visible', timeout: 5000 })
  await page.click('#btn-game-manual')
  await page.waitForSelector('#workbench-doc-content h1', { timeout: 10000 })
  await page.waitForTimeout(400)

  // Console 回归：操作集中于标题栏，抽屉可关闭/恢复并支持键盘与鼠标调高。
  const heading = page.locator('.workbench-editor-heading')
  for (const selector of ['#workbench-lang-switch', '#workbench-submit', '#workbench-assist', '#workbench-console-toggle']) {
    assert.equal(await heading.locator(selector).count(), 1, `${selector} must live in editor heading`)
  }
  const headingOverflow = await heading.evaluate(el => el.scrollWidth - el.clientWidth)
  assert.ok(headingOverflow <= 1, `editor heading overflow = ${headingOverflow}`)
  assert.equal((await page.locator('#workbench-console-toggle').innerText()).replace(/\s+/g, ' ').trim(), 'Console 4')
  const consoleRoot = page.locator('#workbench-console')
  const toggle = page.locator('#workbench-console-toggle')
  const resize = page.locator('.script-console-resize')
  const logLines = consoleRoot.locator('.script-console-line')
  await page.waitForFunction(() => document.querySelectorAll('#workbench-console .script-console-line').length === 2)
  assert.equal(await logLines.count(), 2)
  const repeatedLine = logLines.filter({ hasText: 'scan complete' })
  assert.equal(await repeatedLine.locator('.script-console-repeat').textContent(), '3')
  assert.equal(await toggle.locator('[data-console-trigger-count]').textContent(), '4')
  const structuredLine = logLines.filter({ hasText: 'state' })
  const topObject = structuredLine.locator('details.script-console-object').first()
  await topObject.locator('summary').first().click()
  assert.equal(await topObject.getAttribute('open'), '')
  const selfObject = topObject.locator('.script-console-property').filter({ hasText: 'self:' }).locator('details.script-console-object').first()
  await selfObject.locator('summary').first().click()
  assert.equal(await selfObject.getAttribute('open'), '')
  assert.equal(await selfObject.locator('.script-console-property').filter({ hasText: 'hp:' }).count(), 1)
  await page.locator('.script-console-close').click()
  await consoleRoot.waitFor({ state: 'hidden' })
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  await toggle.click()
  consoleRoot.waitFor({ state: 'visible' })
  await resize.focus()
  await page.keyboard.press('Home')
  const minHeight = await consoleRoot.evaluate(el => el.getBoundingClientRect().height)
  await page.keyboard.press('ArrowUp')
  const keyboardHeight = await consoleRoot.evaluate(el => el.getBoundingClientRect().height)
  assert.ok(keyboardHeight > minHeight, `keyboard resize ${minHeight} -> ${keyboardHeight}`)
  const grip = await resize.boundingBox()
  assert.ok(grip, 'console resize grip missing')
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 38, { steps: 4 })
  await page.mouse.up()
  const pointerHeight = await consoleRoot.evaluate(el => el.getBoundingClientRect().height)
  assert.ok(pointerHeight > keyboardHeight, `pointer resize ${keyboardHeight} -> ${pointerHeight}`)
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('omb.workbench.layout') || '{}'))
  assert.equal(saved.consoleOpen, true)
  assert.ok(saved.consoleHeight >= pointerHeight - 1, `saved console height = ${saved.consoleHeight}`)
  await page.locator('.script-console-close').click()
  await toggle.click()
  const restoredHeight = await consoleRoot.evaluate(el => el.getBoundingClientRect().height)
  assert.ok(Math.abs(restoredHeight - pointerHeight) <= 1, `restored console height ${restoredHeight}, want ${pointerHeight}`)

  await page.screenshot({ path: join(DOC_IMAGES, 'ui-workbench.png') })
  console.log(`[capture] ${relDoc('ui-workbench.png')}`)

  // 窄屏：标题栏控制换行但仍全部可见，抽屉不制造横向滚动。
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(150)
  for (const selector of ['#workbench-submit', '#workbench-assist', '#workbench-console-toggle']) {
    assert.equal(await page.locator(selector).isVisible(), true, `${selector} visible on mobile`)
  }
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    workbench: document.getElementById('workbench').scrollWidth - document.getElementById('workbench').clientWidth,
  }))
  assert.ok(overflow.page <= 1 && overflow.workbench <= 1, `mobile overflow ${JSON.stringify(overflow)}`)
  await page.screenshot({ path: join(ARTIFACTS, 'console-mobile.png') })
  await page.setViewportSize({ width: 1280, height: 800 })

  // 结算 overlay
  await page.goto(base + '/')
  await page.waitForSelector('#startup[data-state="ready"]', { timeout: 15000 })
  await page.evaluate(() => document.getElementById('startup')?.focus())
  await page.keyboard.press('Enter')
  await page.waitForSelector('#startup', { state: 'hidden', timeout: 10000 })
  await page.fill('#in-room', 'SHOT2')
  await page.fill('#in-nick', '截图者')
  await page.click('#btn-join')
  await page.waitForSelector('#view-game', { state: 'visible', timeout: 10000 })
  wss.clients.forEach((ws) => ws.send(frameMsg({ case: 'event', value: create(ServerEventSchema, { kind: { case: 'matchEnd',
    value: create(EvMatchEndSchema, { scores: [{ robot: SELF_ID, score: 42, titles: [6] }, { robot: 202, score: 12 }] }) } }) })))
  await page.waitForSelector('.end-overlay', { timeout: 5000 })
  await page.screenshot({ path: join(DOC_IMAGES, 'ui-match-end.png') })
  console.log(`[capture] ${relDoc('ui-match-end.png')}`)

  await page.close()
  server.close()
  wss.close()
}

async function main() {
  await mkdir(DOC_IMAGES, { recursive: true })
  await mkdir(ARTIFACTS, { recursive: true })
  const browser = await chromium.launch()
  try {
    if (want('sheets') || want('diagrams') || want('icons')) await captureSheets(browser)
    if (want('ui')) await captureUI(browser)
    console.log(`[capture] manual assets → ${DOC_IMAGES}`)
  } finally {
    await browser.close()
  }
}

void main()
