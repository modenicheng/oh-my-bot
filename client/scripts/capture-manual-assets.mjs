// 手册资产截取 harness：起 vite dev server（多页入口 capture.html），
// 用真实 draw* 渲染的 sprite sheet 截图为 PNG，写入 docs/manual/reference/images/。
// UI 截图（startup/lobby/HUD/结算等）走 mock-WS fixture，复用 pickup-visual-check 模式。
// 用法：pnpm --dir client capture:manual  （或 node client/scripts/capture-manual-assets.mjs）
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { create, toBinary, fromBinary } from '@bufbuild/protobuf'
import {
  ServerMsgSchema, ClientMsgSchema, ServerEventSchema, SnapshotDeltaSchema,
  EvRoomStateSchema, EvMapBootstrapSchema, EvScoreboardSchema, EvMatchEndSchema,
} from '../../packages/protocol/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolve(here, '..')
const repoRoot = resolve(clientRoot, '..')

// ---------- 配置 ----------
const PORT = Number(process.env.OMB_CAPTURE_PORT || 18458)
const DOC_IMAGES = resolve(repoRoot, 'docs/manual/reference/images')

const CATEGORIES = ['arena', 'robots', 'pickups', 'projectiles', 'icons']

// ---------- sprite sheet 截图（vite dev + capture.html）----------
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

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (e) => { throw e })
  await page.goto(`${origin}/capture.html`)
  await page.waitForSelector('html[data-capture-ready="1"]', { timeout: 20000 })
  await page.evaluate(() => document.fonts.ready)

  for (const cat of CATEGORIES) {
    const el = page.locator(`#sheet-${cat}`)
    await el.scrollIntoViewIfNeeded()
    await el.screenshot({ path: join(DOC_IMAGES, `sheet-${cat}.png`) })
    console.log(`[capture] docs/manual/reference/images/sheet-${cat}.png`)
  }
  await page.close()
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

  // MapDef 走 Go JSON 序列化形状（snake_case 键、大写 X/Y），与 mapdef.ts parseMapDef 兼容。
  const MAP_JSON = JSON.stringify({
    version: 1,
    generator_ver: 2,
    seed: 20260206,
    map_hash: 'capture01',
    walls: [
      { id: 1, min: { X: -66, Y: -60 }, max: { X: -58, Y: 60 } },
      { id: 2, min: { X: 58, Y: -60 }, max: { X: 66, Y: 60 } },
    ],
    sectors: [
      { id: 1, spawn_area: { Min: { X: -50, Y: -40 }, Max: { X: -35, Y: -25 } }, center: { X: -42, Y: -32 } },
      { id: 2, spawn_area: { Min: { X: 35, Y: 25 }, Max: { X: 50, Y: 40 } }, center: { X: 42, Y: 32 } },
    ],
    uplinks: [{ id: 900, pos: { X: 0, Y: 6 }, main: false, interact_r: 2.5, active_phase: 1 }],
    core_pads: [{ id: 1, pos: { X: -2.4, Y: 0 }, group: 0, value: 10 }],
    health_packs: [{ id: 7, pos: { X: 2.2, Y: 0 } }],
    core_zone: { radius: 30, unlock_phase: 2 },
  })

  // 协议编解码（与 manual-check 同源：@omb/protocol 生成的 schema）
  const MAP_JSON_STR = MAP_JSON
  function frame(payload) {
    return Buffer.concat([Buffer.from([3]), toBinary(ServerMsgSchema, create(ServerMsgSchema, { payload }))])
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
      if (buf[0] === 0x00) { ws.send(Buffer.from([0x01])); return } // ping → pong
      if (buf[0] !== 0x02) return // 0x02 = protobuf 消息帧
      let msg
      try { msg = fromBinary(ClientMsgSchema, buf.subarray(1)) } catch { return }
      const cmd = msg.payload
      // join 后推 roomState + mapBootstrap + snapshot
      if (cmd.case === 'join') {
        ws.send(frame({ case: 'event', value: create(ServerEventSchema, { kind: { case: 'roomState',
          value: create(EvRoomStateSchema, { state: R_PLAYING, robotsOnline: 2, hostNick: '截图中' }) } }) }))
        ws.send(frame({ case: 'event', value: create(ServerEventSchema, { tick: 0, kind: { case: 'mapBootstrap',
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
        ws.send(frame({ case: 'snapshot', value: create(SnapshotDeltaSchema, snap) }))
        // 记分板
        ws.send(frame({ case: 'event', value: create(ServerEventSchema, { tick: 600, kind: { case: 'scoreboard',
          value: create(EvScoreboardSchema, { tick: 600, rows: [{ robot: 202, score: 12 }, { robot: SELF_ID, score: 35 }] }) } }) }))
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
  console.log('[capture] docs/manual/reference/images/ui-lobby.png')

  // 进入对局 HUD
  await page.fill('#in-room', 'SHOT')
  await page.fill('#in-nick', '截图者')
  await page.click('#btn-join')
  await page.waitForSelector('#view-game', { state: 'visible', timeout: 10000 })
  await page.waitForTimeout(600) // 等 HUD 渲染 + 血包 sprite
  await page.screenshot({ path: join(DOC_IMAGES, 'ui-hud.png') })
  console.log('[capture] docs/manual/reference/images/ui-hud.png')

  // Esc 选项层：真实主界面 DOM、输入释放与共享音频控件。
  await page.locator('#game-canvas').focus()
  await page.keyboard.press('Escape')
  await page.waitForSelector('#game-options', { state: 'visible', timeout: 5000 })
  await page.screenshot({ path: join(DOC_IMAGES, 'ui-options.png') })
  console.log('[capture] docs/manual/reference/images/ui-options.png')
  await page.keyboard.press('Escape')
  await page.waitForSelector('#game-options', { state: 'hidden', timeout: 5000 })

  // 工作台（编辑器 + 控制台 + 手册面板）
  await page.locator('#game-canvas').focus()
  await page.keyboard.press('c')
  await page.waitForSelector('#workbench', { state: 'visible', timeout: 5000 })
  await page.click('#btn-game-manual')
  await page.waitForSelector('#workbench-doc-content h1', { timeout: 10000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(DOC_IMAGES, 'ui-workbench.png') })
  console.log('[capture] docs/manual/reference/images/ui-workbench.png')

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
  wss.clients.forEach((ws) => ws.send(frame({ case: 'event', value: create(ServerEventSchema, { kind: { case: 'matchEnd',
    value: create(EvMatchEndSchema, { scores: [{ robot: SELF_ID, score: 42, titles: [6] }, { robot: 202, score: 12 }] }) } }) })))
  await page.waitForSelector('.end-overlay', { timeout: 5000 })
  await page.screenshot({ path: join(DOC_IMAGES, 'ui-match-end.png') })
  console.log('[capture] docs/manual/reference/images/ui-match-end.png')

  await page.close()
  server.close()
  wss.close()
}

async function main() {
  await mkdir(DOC_IMAGES, { recursive: true })
  const browser = await chromium.launch()
  try {
    await captureSheets(browser)
    await captureUI(browser)
    console.log(`[capture] manual assets → ${DOC_IMAGES}`)
  } finally {
    await browser.close()
  }
}

void main()
