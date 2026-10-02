// 手册专项浏览器验证（Playwright）：
// 1) 全屏手册阅读器（?view=manual）：中文目录顺序、章节首页点击、order 排序、
//    标签 chips、面包屑、相对链接、旧无扩展名 path。
// 2) 局内 workbench 手册面板：与全屏阅读器同一 ManualView，目录一致。
// 手册数据来自真实 docs/manual（协议不需要真实对局——手册路由在大厅即可进入，
// 局内面板用假 WS 走通 workbench）。
import { chromium } from 'playwright'
import { preview } from 'vite'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { ClientMsgSchema, ServerMsgSchema, ServerEventSchema, EvRoomStateSchema, RoomAction_Kind, EvMapBootstrapSchema, SnapshotDeltaSchema } from '../../packages/protocol/src/index.ts'

const shots = resolve(import.meta.dirname, '../../.artifacts/manual')
mkdirSync(shots, { recursive: true })
const docsRoot = resolve(import.meta.dirname, '../../docs/manual')
const port = Number(process.env.OMB_MANUAL_PORT || 18431)
const apiPort = port + 1

// 与 server/cmd/omb/manual_index.go 相同的排序规则（浏览器检查只断言可见顺序，
// 排序本身由 Go 测试锁定；这里仅构造预期树）。
const server = await preview({ configFile: false, root: resolve(import.meta.dirname, '..'), logLevel: 'silent', preview: { host: '127.0.0.1', port, strictPort: true } })

// 手册 API 桩：从磁盘读真实 docs/manual，按目录树（与服务器一致的排序）返回。
const api = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/api/manual') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(manualTreeJSON()))
    return
  }
  const match = url.pathname.match(/^\/api\/manual\/(.+)$/)
  if (match) {
    const rel = decodeURIComponent(match[1])
    if (!rel.endsWith('.md') || rel.includes('..')) { res.writeHead(400); res.end(); return }
    try {
      const body = readFileSync(join(docsRoot, rel))
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
      res.end(body)
    } catch { res.writeHead(404); res.end() }
    return
  }
  if (url.pathname === '/api/matches') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('[]')
    return
  }
  res.writeHead(404); res.end()
})
await new Promise(done => api.listen(apiPort, '127.0.0.1', done))

// 目录树构造（与 manual_index.go 相同的 frontmatter 语义，足够构造期望顺序）。
function frontmatter(raw) {
  if (!raw.startsWith('---')) return {}
  const nl = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.slice(3).split(nl)
  const fm = {}
  let closed = false
  for (const line of lines) {
    if (line.trim() === '---') { closed = true; break }
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[2].trim().replace(/^['"](.*)['"]$/, '$1')
    if (m[1] === 'title') fm.title = value
    if (m[1] === 'order' && Number.isFinite(Number(value))) fm.order = Number(value)
  }
  return closed ? fm : {}
}
function listDir(rel) {
  let entries
  try { entries = readdirSync(join(docsRoot, rel), { withFileTypes: true }) } catch { return [] }
  return entries.filter(e => !e.name.startsWith('.') && (e.isDirectory() || e.name.endsWith('.md')))
}
function buildNode(rel, name, isDir) {
  const indexRel = rel ? `${rel}/index.md` : 'index.md'
  let fm = {}
  try { fm = frontmatter(readFileSync(join(docsRoot, indexRel), 'utf-8')) } catch { /* no index */ }
  const path = rel ? `${rel}` : name
  const children = []
  for (const entry of listDir(rel)) {
    if (entry.isDirectory()) {
      const sub = buildNode(`${rel}/${entry.name}`, entry.name, true)
      if (sub.children.length > 0) children.push(sub)
    } else if (entry.name === 'index.md') {
      const childFm = frontmatter(readFileSync(join(docsRoot, `${rel}/index.md`), 'utf-8'))
      children.push({ path: indexRel, title: childFm.title ?? 'index', order: childFm.order, children: [] })
    } else {
      const childFm = frontmatter(readFileSync(join(docsRoot, `${rel}/${entry.name}`), 'utf-8'))
      children.push({ path: `${rel}/${entry.name}`, title: childFm.title ?? entry.name.replace(/\.md$/, ''), order: childFm.order, children: [] })
    }
  }
  const byOrder = (a, b) => {
    const ao = typeof a.order === 'number', bo = typeof b.order === 'number'
    if (ao && bo && a.order !== b.order) return a.order - b.order
    if (ao !== bo) return ao ? -1 : 1
    return a.path < b.path ? -1 : 1
  }
  children.sort(byOrder)
  return { path, title: isDir ? (fm.title ?? name) : (fm.title ?? name.replace(/\.md$/, '')), order: isDir ? fm.order : undefined, children }
}
function manualTreeJSON() {
  const children = []
  for (const entry of listDir('')) {
    if (entry.isDirectory()) {
      const sub = buildNode(entry.name, entry.name, true)
      if (sub.children.length > 0) children.push(sub)
    } else if (entry.name === 'index.md') {
      const fm = frontmatter(readFileSync(join(docsRoot, 'index.md'), 'utf-8'))
      children.push({ path: 'index.md', title: fm.title ?? 'index.md', order: fm.order, children: [] })
    } else {
      const fm = frontmatter(readFileSync(join(docsRoot, entry.name), 'utf-8'))
      children.push({ path: entry.name, title: fm.title ?? entry.name.replace(/\.md$/, ''), order: fm.order, children: [] })
    }
  }
  children.sort((a, b) => {
    const ao = typeof a.order === 'number', bo = typeof b.order === 'number'
    if (ao && bo && a.order !== b.order) return a.order - b.order
    if (ao !== bo) return ao ? -1 : 1
    return a.path < b.path ? -1 : 1
  })
  return children
}

// 假 WS：进房 → 开始对局，进入 workbench（局内手册面板）。
const sockets = new WebSocketServer({ server: server.httpServer, path: '/ws' })
const commands = []
sockets.on('connection', socket => {
  socket.on('message', data => {
    const bytes = Buffer.from(data)
    if (bytes[0] === 0) { socket.send(Buffer.from([1])); return }
    if (bytes[0] !== 2) return
    const command = fromBinary(ClientMsgSchema, bytes.subarray(1)).payload
    commands.push(command)
    if (command.case !== 'join') return
    socket.testRoom = command.value.roomCode
    // 加入即接受：roomState → mapBootstrap → 全量快照（与 game-feel-check 的
    // accept() 相同序列），客户端进入对局视图后可用 c 键开 workbench。
    socket.send(frame({ case: 'event', value: create(ServerEventSchema, { kind: { case: 'roomState',
      value: create(EvRoomStateSchema, { state: 0, hostNick: 'manual-test', robotsOnline: 1 }) } }) }))
    socket.send(frame({ case: 'event', value: create(ServerEventSchema, { tick: 0, kind: { case: 'mapBootstrap',
      value: create(EvMapBootstrapSchema, { mapJson: JSON.stringify(map), mapHash: 'manualcheck', generatorVersion: 2 }) } }) }))
    socket.send(frame({ case: 'snapshot', value: create(SnapshotDeltaSchema, { tick: 60, full: true, phase: 1, timeLeftS: 300,
      robots: [{ base: { id: 101, pos: { x: 0, y: 0 } }, hpX10: 1000, energyX10: 1000, nick: 'manual-test', color: '#22d3ee' }],
      self: { robotId: 101, moveSrc: 1, turretSrc: 1 } }) }))
  })
})
const map = { version: 1, generator_ver: 2, seed: 101, map_hash: 'manualcheck',
  walls: [{ id: 1, min: { X: -66, Y: -60 }, max: { X: -58, Y: 60 } }],
  sectors: [{ id: 1, spawn_area: { Min: { X: -50, Y: -40 }, Max: { X: -35, Y: -25 } }, center: { X: -42, Y: -32 } }],
  uplinks: [{ id: 900, pos: { X: 10, Y: 10 }, main: false, interact_r: 2.5, active_phase: 1 }],
  core_pads: [{ id: 1, pos: { X: 3, Y: 3 }, group: 0, value: 10 }], core_zone: { radius: 30, unlock_phase: 2 } }
function frame(payload) {
  return Buffer.concat([Buffer.from([3]), toBinary(ServerMsgSchema, create(ServerMsgSchema, { payload }))])
}
function broadcast(room, payload) {
  const data = frame(payload)
  for (const socket of sockets.clients) if (socket.testRoom === room && socket.readyState === 1) socket.send(data)
}
function event(room, kind, schema, value, tick = 0) {
  broadcast(room, { case: 'event', value: create(ServerEventSchema, { tick, kind: { case: kind, value: create(schema, value) } }) })
}
function snapshot(room, tick = 60, phase = 1, self = true) {
  broadcast(room, { case: 'snapshot', value: create(SnapshotDeltaSchema, { tick, full: true, phase, timeLeftS: 300,
    robots: [101].map(id => ({ base: { id, pos: { x: 0, y: 0 } }, hpX10: 1000, energyX10: 1000, nick: 'manual-test', color: '#22d3ee' })),
    ...(self ? { self: { robotId: 101, moveSrc: 1, turretSrc: 1 } } : {}) }) })
}

const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] })
const errors = []
async function open(url, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...options })
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(() => {
    window.__startupContexts = []
    window.AudioContext = new Proxy(window.AudioContext, { construct(target, args) {
      const context = Reflect.construct(target, args)
      window.__startupContexts.push({ active: navigator.userActivation.isActive, context })
      return context
    } })
  })
  await page.route('**/api/manual**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/manual') {
      await route.fulfill({ json: manualTreeJSON() })
    } else {
      const rel = decodeURIComponent(path.slice('/api/manual/'.length))
      if (rel.endsWith('.png') || rel.endsWith('.webp')) {
        // 图片与 markdown 同前缀：从磁盘读白名单图片（与服务端 serveManualImage 同语义）。
        if (rel.includes('..')) { await route.fulfill({ status: 400 }); return }
        try {
          await route.fulfill({ contentType: rel.endsWith('.webp') ? 'image/webp' : 'image/png', body: readFileSync(join(docsRoot, rel)) })
        } catch { await route.fulfill({ status: 404, body: 'not found' }) }
        return
      }
      if (!rel.endsWith('.md') || rel.includes('..')) { await route.fulfill({ status: 400 }); return }
      try {
        await route.fulfill({ contentType: 'text/markdown; charset=utf-8', body: readFileSync(join(docsRoot, rel), 'utf-8') })
      } catch { await route.fulfill({ status: 404, body: 'not found' }) }
    }
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('#startup[data-state="ready"]').waitFor({ timeout: 20000 })
  await page.keyboard.press('Enter')
  await page.locator('#startup').waitFor({ state: 'hidden' })
  return page
}

const base = `http://127.0.0.1:${port}`
try {
  // ---- 1) 全屏手册：中文目录顺序与章节点击 ----
  const page = await open(`${base}/?view=manual`)
  await page.locator('#manual-content .manual-body').waitFor()
  const chapters = await page.locator('#manual-sidebar .toc-section > a').allTextContents()
  assert.deepEqual(chapters.map(c => c.trim()), ['oh-my-bot 玩家手册', '快速上手', '游戏规则', '写自己的 Bot', 'API 总览'],
    `sidebar chapter order = ${JSON.stringify(chapters)}`)
  await page.screenshot({ path: resolve(shots, 'fullscreen-toc.png') })

  // start 章节子页顺序：index 落地页在前，之后按 order（非字典序）。
  const startItems = await page.locator('#manual-sidebar .toc-section', { hasText: '快速上手' }).locator('.toc-children a').allTextContents()
  assert.deepEqual(startItems.map(s => s.trim()), ['快速上手', '进房前准备', '你的第一局', 'Snippet 驾驶辅助（规划）', 'AI Agent（接入状态与规划）'],
    `start children order = ${JSON.stringify(startItems)}`)

  // 点击章节首页（目录导航，非字典序验证：点击“游戏规则”章节落地页）。
  await page.locator('#manual-sidebar .toc-section', { hasText: '游戏规则' }).locator('> a').first().click()
  await page.locator('#manual-content .manual-body').first().waitFor()
  assert.match(await page.locator('#manual-content h1').first().textContent(), /游戏规则/)
  await page.screenshot({ path: resolve(shots, 'fullscreen-rules-chapter.png') })

  // 面包屑：从 rules 落地页进入 game-rules 再看面包屑。
  await page.locator('#manual-sidebar .toc-children a', { hasText: '游戏规则' }).nth(1).click()
  await page.waitForTimeout(300)
  const crumbs = await page.locator('#manual-breadcrumb').textContent()
  assert.match(crumbs, /游戏规则/, `breadcrumb = ${crumbs}`)

  // 标签 chips 出现在页标题旁。
  await page.locator('#manual-sidebar .toc-children a', { hasText: '操作与控制仲裁' }).click()
  await page.waitForTimeout(300)
  const chips = await page.locator('#manual-content .manual-tag').allTextContents()
  assert.ok(chips.includes('规则') && chips.includes('手操'), `tag chips = ${JSON.stringify(chips)}`)
  assert.match(await page.locator('#manual-content .manual-audience').first().textContent(), /手操玩家|全部|Bot 玩家/)
  await page.screenshot({ path: resolve(shots, 'fullscreen-tags.png') })

  // 相对链接：正文内 start/index.md 的 prepare.md 链接可导航。
  await page.locator('#manual-sidebar .toc-section', { hasText: '快速上手' }).locator('> a').first().click()
  await page.waitForTimeout(300)
  await page.locator('#manual-content a', { hasText: '进房前准备' }).first().click()
  await page.waitForTimeout(300)
  assert.match(await page.locator('#manual-content h1').first().textContent(), /进房前准备/)
  const doc = new URL(page.url()).searchParams.get('doc')
  assert.equal(doc, 'start/prepare.md', `route doc = ${doc}`)

  // 图鉴页：双 reader 图片断言（全屏侧）——目录含图鉴章节，正文图片改写为 /api/manual/ 前缀且真实加载成功。
  const visual = await open(`${base}/?view=manual&doc=reference/visual.md`)
  await visual.locator('#manual-content .manual-body').waitFor({ timeout: 10000 })
  const visualH1 = await visual.locator('#manual-content h1').first().textContent()
  assert.match(visualH1, /图鉴/, `visual page h1 = ${visualH1}`)
  const imgs = visual.locator('#manual-content .manual-body img')
  const imgCount = await imgs.count()
  assert.equal(imgCount, 10, `visual page image count = ${imgCount}, want 10`)
  for (let i = 0; i < imgCount; i++) {
    const src = await imgs.nth(i).getAttribute('src')
    assert.match(src, /^\/api\/manual\/reference\/images\/(?:sheet|ui)-[a-z-]+\.png$/, `img src = ${src}`)
  }
  await visual.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('#manual-content .manual-body img')]
    return nodes.length === 10 && nodes.every(img => img.complete && img.naturalWidth > 0)
  }, undefined, { timeout: 10000 })
  const natural = await imgs.evaluateAll(nodes => nodes.map(n => ({ w: n.naturalWidth, h: n.naturalHeight, ok: n.complete && n.naturalWidth > 0 })))
  assert.ok(natural.every(n => n.ok), `visual images not loaded: ${JSON.stringify(natural)}`)
  await visual.screenshot({ path: resolve(shots, 'fullscreen-visual.png') })
  await visual.close()

  // 旧无扩展名 path（曾用格式）仍可导航（重新加载页面走启动门）。
  const oldPath = await open(`${base}/?view=manual&doc=reference/actions`)
  await oldPath.locator('#manual-content h1').first().waitFor({ timeout: 10000 })
  assert.match(await oldPath.locator('#manual-content h1').first().textContent(), /动作参考/)
  await oldPath.close()

  // 首页默认打开正确。
  const home = await open(`${base}/?view=manual`)
  await home.locator('#manual-content h1').first().waitFor({ timeout: 10000 })
  assert.match(await home.locator('#manual-content h1').first().textContent(), /玩家手册/)
  await home.close()
  await page.close()

  // ---- 2) 局内 workbench 手册面板与全屏一致 ----
  const game = await open(`${base}/`)
  await game.locator('#in-room').fill('mn01')
  await game.locator('#in-nick').fill('manual-test')
  await game.locator('#btn-join').click()
  await game.locator('#view-game').waitFor({ state: 'visible', timeout: 10000 })
  // c 键打开局内 workbench（docs 面板内嵌同一 ManualView）。
  await game.locator('#game-canvas').focus()
  await game.keyboard.press('c')
  await game.locator('#workbench').waitFor({ state: 'visible', timeout: 10000 })
  // M 键切到文档面板（内嵌 ManualView），再点“目录”开关显示侧栏。
  await game.keyboard.press('m')
  await game.locator('#workbench-toc-toggle').waitFor({ state: 'visible' })
  await game.locator('#workbench-toc-toggle').click()
  await game.locator('#workbench-toc').waitFor({ state: 'visible' })
  const wbChapters = await game.locator('#workbench-toc .toc-section > a').allTextContents()
  assert.deepEqual(wbChapters.map(c => c.trim()), ['oh-my-bot 玩家手册', '快速上手', '游戏规则', '写自己的 Bot', 'API 总览'],
    `workbench chapter order = ${JSON.stringify(wbChapters)}`)
  // 局内点击“写自己的 Bot”章节（order 3 非字典序），再进“写第一个 Bot”子页验证 chips。
  await game.locator('#workbench-toc .toc-section', { hasText: '写自己的 Bot' }).locator('> a').first().click()
  await game.locator('#workbench-doc-content h1').first().waitFor({ timeout: 10000 })
  assert.match(await game.locator('#workbench-doc-content h1').first().textContent(), /写自己的 Bot/)
  // 导航后目录自动收起（onNavigate 契约），重新展开再进子页。
  await game.locator('#workbench-toc-toggle').click()
  await game.locator('#workbench-toc .toc-children a', { hasText: '写第一个 Bot' }).click()
  await game.locator('#workbench-doc-content .manual-tag').first().waitFor({ timeout: 10000 })
  // 同一 ManualView：局内页标题同样带 audience/tag chips。
  const wbChips = await game.locator('#workbench-doc-content .manual-tag').allTextContents()
  assert.ok(wbChips.includes('脚本'), `workbench tag chips = ${JSON.stringify(wbChips)}`)
  await game.screenshot({ path: resolve(shots, 'workbench-manual.png') })

  // 双 reader 图片断言（局内 workbench 侧）：同一图鉴页在局内阅读器同样加载真实图片。
  await game.locator('#workbench-toc-toggle').click()
  await game.locator('#workbench-toc .toc-section', { hasText: 'API 总览' }).locator('> a').first().click()
  await game.locator('#workbench-toc-toggle').click()
  await game.locator('#workbench-toc .toc-children a', { hasText: '图鉴' }).first().click()
  await game.locator('#workbench-doc-content h1').first().waitFor({ timeout: 10000 })
  const wbImgs = game.locator('#workbench-doc-content .manual-body img')
  const wbImgCount = await wbImgs.count()
  assert.equal(wbImgCount, 10, `workbench visual image count = ${wbImgCount}, want 10`)
  await game.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('#workbench-doc-content .manual-body img')]
    return nodes.length === 10 && nodes.every(img => img.complete && img.naturalWidth > 0)
  }, undefined, { timeout: 10000 })
  const wbNatural = await wbImgs.evaluateAll(nodes => nodes.map(n => ({ ok: n.complete && n.naturalWidth > 0 })))
  assert.ok(wbNatural.every(n => n.ok), `workbench visual images not loaded: ${JSON.stringify(wbNatural)}`)
  await game.screenshot({ path: resolve(shots, 'workbench-visual.png') })
  await game.close()

  assert.deepEqual(errors, [], `page errors: ${errors}`)
  console.log('manual-check passed: fullscreen + workbench readers, Chinese TOC, order, tags, breadcrumbs, relative links')
} finally {
  await browser.close().catch(() => {})
  sockets.close()
  api.close()
  await new Promise(r => server.httpServer.close(r))
}
