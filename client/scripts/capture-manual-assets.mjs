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
import protobuf from 'protobufjs'
import { loadSync } from '@bufbuild/protobuf/wkt'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolve(here, '..')
const repoRoot = resolve(clientRoot, '..')

// ---------- 配置 ----------
const PORT = Number(process.env.OMB_CAPTURE_PORT || 18458)
const SHOTS = resolve(repoRoot, process.env.OMB_SHOTS || 'docs/manual/reference/images')
const DOC_IMAGES = resolve(repoRoot, 'docs/manual/reference/images')

const CATEGORIES = ['arena', 'robots', 'pickups', 'projectiles', 'icons']
const SHEET_LABELS = { arena: '场地', robots: '机器人', pickups: '拾取物', projectiles: '子弹', icons: '图标' }

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
    await el.screenshot({ path: join(SHOTS, `sheet-${cat}.png`) })
    console.log(`[capture] sheet-${cat}.png`)
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

  const mapDef = {
    version: 1, generatorVer: 1, seed: 20260206, mapHash: 'capture01', extent: 80,
    walls: [{ id: 1, rect: { min: { x: -2.5, y: -1 }, max: { x: -1.5, y: 1 } } }],
    sectors: [{ id: 1, name: 'A', spawnArea: { min: { x: -6, y: -6 }, max: { x: -2, y: -2 } } }],
    uplinks: [{ id: 1, pos: { x: 0, y: 6 }, activePhase: 1 }],
    corePads: [{ id: 1, pos: CORE_POS, value: 25, mega: true }],
    healthPacks: [{ id: 1, pos: PACK_POS }],
    coreZone: { radius: 30, unlockPhase: 2 },
  }

  // 协议编解码
  const protoPath = resolve(repoRoot, 'protocol/proto/omb.proto')
  const pbroot = protobuf.loadSync(protoPath)
  const ServerMsg = pbroot.lookupType('omb.ServerMsg')
  const ClientMsg = pbroot.lookupType('omb.ClientMsg')
  const SnapshotDelta = pbroot.lookupType('omb.SnapshotDelta')

  function encode(msg) { return ServerMsg.encode(ServerMsg.create(msg)).finish() }
  function frame(buf) {
    const out = Buffer.alloc(1 + buf.length); out[0] = 3; buf.copy(out, 1); return out
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
      let msg
      try { msg = ClientMsg.decode(Buffer.from(data)) } catch { return }
      // join 后推 roomState + mapBootstrap + snapshot
      if (msg.join) {
        ws.send(frame(encode({ ev: { roomState: { state: R_PLAYING, robotsOnline: 2, hostNick: '截图中' } } })))
        ws.send(frame(encode({ ev: { mapBootstrap: { map: mapDef } } })))
        const snap = {
          tick: 600, ackSeq: 1, phase: PHASE_OUTER, timeLeftS: 240, full: true,
          robots: [{ base: { id: SELF_ID, pos: { x: 0, y: 0 }, heading: 0 }, hpX10: 7500, energyX10: 6200, color: '#22d3ee', nick: '截图者' },
                   { base: { id: 202, pos: { x: -5, y: 3 }, heading: 2 }, hpX10: 5200, energyX10: 5000, color: '#a3e635', nick: '队友' }],
          projectiles: [{ base: { id: 301, pos: { x: 1, y: 2 }, heading: 0.5 }, ownerId: 202, color: '#a3e635' }],
          cores: [{ base: { id: 1, pos: CORE_POS }, value: 25 }],
          uplinks: [{ base: { id: 1, pos: { x: 0, y: 6 } }, ready: false, hackingId: 101, progressX10: 48 }],
          healthPacks: [{ base: { id: 1, pos: PACK_POS }, available: true }],
          self: { robotId: SELF_ID, moveSrc: CS_HUMAN, turretSrc: CS_HUMAN, assistOn: true, manualAxesMask: 3 },
        }
        ws.send(frame(encode({ snap })))
        // 记分板
        ws.send(frame(encode({ ev: { scoreboard: { tick: 600, rows: [{ robot: 202, score: 12 }, { robot: SELF_ID, score: 35 }] } } })))
      }
    })
  })
  await new Promise((r) => server.listen(PORT + 1, '127.0.0.1', r))
  const base = `http://127.0.0.1:${PORT + 1}`

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => { throw e })
  await page.goto(base + '/')
  // 走真实启动门（startup overlay Enter）
  await page.waitForSelector('#startup[data-state="ready"]', { timeout: 30000 })
  await page.evaluate(() => document.getElementById('startup')?.focus())
  await page.keyboard.press('Enter')
  await page.waitForSelector('#startup', { state: 'hidden', timeout: 10000 })
  await page.screenshot({ path: join(SHOTS, 'ui-lobby.png') })
  console.log('[capture] ui-lobby.png')

  // 进入对局 HUD
  await page.fill('#in-room', 'SHOT')
  await page.fill('#in-nick', '截图者')
  await page.click('#btn-join')
  await page.waitForSelector('#view-game', { state: 'visible', timeout: 10000 })
  await page.waitForTimeout(600) // 等 HUD 渲染 + 血包 sprite
  await page.screenshot({ path: join(SHOTS, 'ui-hud.png') })
  console.log('[capture] ui-hud.png')

  // 工作台（编辑器 + 控制台 + 手册面板）
  await page.keyboard.press('c')
  await page.waitForSelector('#workbench', { state: 'visible', timeout: 5000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, 'ui-workbench.png') })
  console.log('[capture] ui-workbench.png')

  // 全屏手册：图鉴页（sidebar + tags + 图片渲染）
  await page.goto(base + '/?view=manual&doc=reference/visual')
  await page.waitForSelector('#manual-content .manual-body', { timeout: 10000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(SHOTS, 'ui-manual-visual.png') })
  console.log('[capture] ui-manual-visual.png')

  // 结算 overlay
  await page.goto(base + '/')
  await page.waitForSelector('#startup[data-state="ready"]', { timeout: 15000 })
  await page.keyboard.press('Enter')
  await page.waitForSelector('#startup', { state: 'hidden', timeout: 10000 })
  await page.fill('#in-room', 'SHOT2')
  await page.fill('#in-nick', '截图者')
  await page.click('#btn/join') // placeholder，下面修正
  await page.click('#btn-join')
  await page.waitForSelector('#view-game', { state: 'visible', timeout: 10000 })
  wss.clients.forEach((ws) => ws.send(frame(encode({ ev: { matchEnd: { scores: [{ robot: SELF_ID, score: 42, titles: [6] }, { robot: 202, score: 12 }] } } }))))
  await page.waitForSelector('.end-overlay', { timeout: 5000 })
  await page.screenshot({ path: join(SHOTS, 'ui-match-end.png') })
  console.log('[capture] ui-match-end.png')

  await page.close()
  server.close()
  wss.close()
}

async function main() {
  await mkdir(SHOTS, { recursive: true })
  await mkdir(DOC_IMAGES, { recursive: true })
  const browser = await chromium.launch()
  try {
    await captureSheets(browser)
    await captureUI(browser)
    console.log(`[capture] done → ${SHOTS}`)
  } finally {
    await browser.close()
  }
}

void main()
