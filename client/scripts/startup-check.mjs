import { chromium } from 'playwright'
import { preview } from 'vite'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { ClientMsgSchema, ServerMsgSchema, ServerEventSchema, EvRoomStateSchema, RoomAction_Kind, EvMapBootstrapSchema, EvScoreboardSchema, EvMatchEndSchema, SnapshotDeltaSchema, Title } from '../../packages/protocol/src/index.ts'

const shots = resolve(import.meta.dirname, '../../.artifacts/startup')
mkdirSync(shots, { recursive: true })
const server = await preview({ configFile: false, root: resolve(import.meta.dirname, '..'), logLevel: 'silent', preview: { host: '127.0.0.1', port: 18425, strictPort: true } })
const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] })
const errors = []
const commands = []
const map = { version: 1, generator_ver: 2, seed: 101, map_hash: 'scorefix',
  walls: [{ id: 1, min: { X: -66, Y: -60 }, max: { X: -58, Y: 60 } }],
  sectors: [{ id: 1, spawn_area: { Min: { X: -50, Y: -40 }, Max: { X: -35, Y: -25 } }, center: { X: -42, Y: -32 } }],
  uplinks: [{ id: 900, pos: { X: 10, Y: 10 }, main: false, interact_r: 2.5, active_phase: 1 }],
  core_pads: [{ id: 1, pos: { X: 3, Y: 3 }, group: 0, value: 10 }], core_zone: { radius: 30, unlock_phase: 2 } }
function broadcast(room, payload) {
  const frame = Buffer.concat([Buffer.from([3]), toBinary(ServerMsgSchema, create(ServerMsgSchema, { payload }))])
  for (const socket of sockets.clients) if (socket.testRoom === room && socket.readyState === 1) socket.send(frame)
}
function event(room, kind, schema, value, tick = 0) {
  broadcast(room, { case: 'event', value: create(ServerEventSchema, { tick, kind: { case: kind, value: create(schema, value) } }) })
}
function snapshot(room, tick, phase, self = true) {
  broadcast(room, { case: 'snapshot', value: create(SnapshotDeltaSchema, { tick, full: true, phase, timeLeftS: 300,
    robots: [101, 202].map(id => ({ base: { id, pos: { x: id === 101 ? 0 : 8, y: 0 } }, hpX10: 1000, energyX10: 1000,
      nick: id === 101 ? 'score-test' : '<b>NO HTML</b>', color: '#22d3ee' })),
    ...(self ? { self: { robotId: 101, moveSrc: 1, turretSrc: 1 } } : {}),
  }) })
}
const sockets = new WebSocketServer({ server: server.httpServer, path: '/ws' })
sockets.on('connection', socket => {
  socket.on('message', data => {
    const bytes = Buffer.from(data)
    if (bytes[0] === 0) { socket.send(Buffer.from([1])); return }
    if (bytes[0] !== 2) return
    const command = fromBinary(ClientMsgSchema, bytes.subarray(1)).payload
    commands.push(command)
    if (command.case !== 'join' && command.case !== 'spectate') return
    socket.testRoom = command.value.roomCode
    const value = create(EvRoomStateSchema, { state: 0, hostNick: 'module-test', robotsOnline: 1 })
    const event = create(ServerEventSchema, { kind: { case: 'roomState', value } })
    const message = create(ServerMsgSchema, { payload: { case: 'event', value: event } })
    socket.send(Buffer.concat([Buffer.from([3]), toBinary(ServerMsgSchema, message)]))
  })
})
async function open(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...options })
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(() => {
    window.__startupContexts = []
    window.__musicSources = []
    window.AudioContext = new Proxy(window.AudioContext, { construct(target, args) {
      // Chromium consumes transient activation while constructing a running context.
      const active = navigator.userActivation.isActive
      const context = Reflect.construct(target, args)
      window.__startupContexts.push({ active, state: context.state, context })
      const makeSource = context.createBufferSource.bind(context)
      context.createBufferSource = () => {
        const source = makeSource()
        const entry = { source, gain: null, started: false, stopped: false }
        const connect = source.connect.bind(source), start = source.start.bind(source), stop = source.stop.bind(source)
        source.connect = (...args) => { if (args[0] instanceof GainNode) entry.gain = args[0].gain; return connect(...args) }
        source.start = (...args) => { entry.started = true; return start(...args) }
        source.stop = (...args) => { entry.stopped = true; return stop(...args) }
        window.__musicSources.push(entry)
        return source
      }
      return context
    } })
  })
  return page
}
const ready = page => page.locator('#startup[data-state="ready"]').waitFor({ timeout: 20000 })
const geometry = []
async function centered(page, label) {
  const measurements = await page.evaluate(() => {
    const bounds = selector => {
      const rect = document.querySelector(selector).getBoundingClientRect()
      return { center: rect.x + rect.width / 2, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    }
    const prompt = bounds('#startup-start')
    const selectors = ['.startup-loader', '.startup-load-list', '.startup-progress', '#startup-track', '#startup-percent', '.startup-load-note']
    return { viewport: innerWidth, prompt, overflow: document.documentElement.scrollWidth > innerWidth,
      parts: selectors.map(selector => ({ selector, ...bounds(selector) })) }
  })
  assert.equal(measurements.overflow, false, `${label}: no horizontal document overflow`)
  for (const part of measurements.parts) {
    assert.ok(Math.abs(part.center - measurements.viewport / 2) <= 2, `${label} ${part.selector}: viewport axis`)
    assert.ok(Math.abs(part.center - measurements.prompt.center) <= 2, `${label} ${part.selector}: prompt axis`)
    assert.ok(part.left >= 0 && part.right <= measurements.viewport, `${label} ${part.selector}: no clipping`)
    assert.ok(part.top >= measurements.prompt.bottom, `${label} ${part.selector}: below PRESS TO START`)
  }
  geometry.push({ label, viewport: measurements.viewport,
    viewportDelta: Math.max(...measurements.parts.map(part => Math.abs(part.center - measurements.viewport / 2))),
    promptDelta: Math.max(...measurements.parts.map(part => Math.abs(part.center - measurements.prompt.center))) })
}
const sampleProgress = page => page.locator('#startup-progress').evaluate(element => ({
  visual: Number(element.dataset.visual), real: Number(element.dataset.real), cap: Number(element.dataset.cap),
  aria: Number(element.getAttribute('aria-valuenow')), track: document.getElementById('startup-track').textContent,
}))
async function assertEventually(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(check(), 'expected protocol command')
}
async function entered(page) {
  await page.locator('#startup').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('#app').evaluate(el => el.inert), false)
  assert.equal(await page.evaluate(() => window.__startupContexts.length), 1)
  assert.equal(await page.evaluate(() => window.__startupContexts[0].active), true)
  assert.equal(await page.evaluate(() => window.__startupContexts[0].state), 'running')
  assert.equal(await page.evaluate(() => window.__startupContexts[0].context.state), 'running')
}
try {
  const page = await open()
  let release
  const held = new Promise(resolve => { release = resolve })
  await page.route('**/assets/main-*.js', async route => { await held; await route.continue() })
  await page.goto('http://127.0.0.1:18425', { waitUntil: 'domcontentloaded' })
  assert.equal(await page.locator('#startup').getAttribute('data-state'), 'loading')
  await page.mouse.click(30, 30)
  assert.equal(await page.evaluate(() => window.__startupContexts.length), 0)
  await page.screenshot({ path: resolve(shots, 'loading.png') })
  release()
  await ready(page)
  assert.equal(await page.locator('#startup button').count(), 0)
  const frame = await page.locator('#startup-ascii').textContent()
  await page.waitForFunction(before => document.getElementById('startup-ascii').textContent !== before, frame)
  await page.evaluate(() => document.getElementById('startup').click())
  assert.equal(await page.evaluate(() => window.__startupContexts.length), 0)
  await page.waitForTimeout(1300)
  await page.screenshot({ path: resolve(shots, 'desktop.png') })
  const originalTitle = await page.locator('#startup-ascii').textContent()
  await page.mouse.click(30, 30)
  assert.equal(await page.locator('#startup').getAttribute('data-state'), 'eroding')
  await page.waitForTimeout(180)
  assert.notEqual(await page.locator('#startup-ascii').textContent(), originalTitle, 'the actual title characters erode, not just a decorative ring')
  assert.equal(await page.locator('#startup').evaluate(el => getComputedStyle(el).opacity), '1', 'root never fades over the character animation')
  await page.screenshot({ path: resolve(shots, 'erosion-early.png') })
  await page.waitForTimeout(250)
  assert.equal(await page.locator('#startup').isVisible(), true, 'whole-screen erosion is not cut off after 300ms')
  const remaining = await page.locator('#startup-ascii').textContent()
  assert.ok(remaining.replace(/\s/g, '').length < originalTitle.replace(/\s/g, '').length, 'title loses real character cells')
  await page.screenshot({ path: resolve(shots, 'erosion-late.png') })
  await entered(page)
  await page.close()

  // Editor chunk preload: Monaco starts with the splash resource bundle, not
  // inside the trusted gesture that enters the app. The splash ready gate waits
  // for the preload (subject to startup.ts's outer timeout); entering the room
  // and opening the editor must not create a second module request.
  const editorRequests = []
  let releasePreload
  const preloadHeld = new Promise(resolve => { releasePreload = resolve })
  const preload = await open()
  await preload.route('**/assets/editor-*.js', async route => {
    editorRequests.push(route.request().url())
    await preloadHeld
    await route.continue()
  })
  await preload.goto('http://127.0.0.1:18425', { waitUntil: 'domcontentloaded' })
  await assertEventually(() => editorRequests.length === 1)
  assert.equal(await preload.locator('#startup').getAttribute('data-state'), 'loading', 'held Monaco preload keeps splash in resource-loading state')
  const loadRows = preload.locator('.startup-load-row')
  assert.equal(await loadRows.count(), 5, 'client/fonts/audio/sprites/editor each get a loading row')
  assert.deepEqual(await loadRows.evaluateAll(rows => rows.map(row => row.dataset.resource)), ['client', 'fonts', 'audio', 'sprites', 'editor'])
  const loadingEditor = preload.locator('.startup-load-row[data-resource="editor"]')
  assert.match((await loadingEditor.innerText()).replace(/\s+/g, ''), /^Loadingeditor\.{1,3}\[>>\]$/)
  await preload.waitForFunction(() => document.querySelectorAll('.startup-load-row[data-state="done"]').length === 4)
  const dotsBefore = await loadingEditor.locator('.startup-load-dots').textContent()
  await preload.waitForFunction(previous => document.querySelector('.startup-load-row[data-resource="editor"] .startup-load-dots')?.textContent !== previous, dotsBefore)
  const liveBefore = await preload.locator('#startup-status').textContent()
  assert.equal(await loadingEditor.locator('.startup-load-dots').getAttribute('aria-hidden'), 'true')
  assert.equal(await preload.locator('#startup-resources').getAttribute('aria-live'), null)
  const samples = [await sampleProgress(preload)]
  for (let i = 0; i < 4; i++) {
    await preload.waitForTimeout(300)
    samples.push(await sampleProgress(preload))
  }
  assert.ok(samples.at(-1).visual > samples[0].visual, 'perceived progress moves between fixed real milestones')
  for (const [index, sample] of samples.entries()) {
    assert.equal(sample.real, 80, 'holding editor leaves authoritative milestones unchanged')
    assert.equal(sample.cap, 95)
    assert.ok(sample.visual < sample.cap && sample.aria < 100, 'pending resource never reaches its cap or completion')
    if (index) assert.ok(sample.visual >= samples[index - 1].visual, 'visual progress never regresses')
    assert.match(sample.track, /^\[[#=+>.]{28}\]$/)
  }
  assert.ok(new Set(samples.map(sample => sample.track)).size > 1, 'character track itself animates')
  assert.equal(await preload.locator('#startup-status').textContent(), liveBefore, 'animation does not mutate the live region')
  await centered(preload, 'desktop-loading')
  await preload.screenshot({ path: resolve(shots, 'resource-loading.png') })
  await preload.setViewportSize({ width: 390, height: 844 })
  await centered(preload, 'mobile-loading')
  await preload.screenshot({ path: resolve(shots, 'resource-loading-mobile.png') })
  await preload.setViewportSize({ width: 320, height: 740 })
  await centered(preload, 'narrow-mobile-loading')
  await preload.setViewportSize({ width: 1440, height: 900 })
  await preload.mouse.click(30, 30)
  assert.equal(await preload.evaluate(() => window.__startupContexts.length), 0, 'loading splash does not consume a gesture')
  releasePreload()
  await ready(preload)
  assert.equal(editorRequests.length, 1, 'splash resources issue exactly one editor chunk request')
  assert.equal((await preload.locator('.startup-load-row[data-resource="editor"]').innerText()).replace(/\s+/g, ''), 'Loadededitor[OK]')
  assert.equal(await preload.locator('#startup-track').textContent(), `[${'#'.repeat(28)}]`)
  assert.equal(await preload.locator('#startup-percent').textContent(), '100%')
  assert.equal(await preload.locator('#startup-progress').getAttribute('aria-valuenow'), '100')
  assert.equal(await preload.locator('#startup-load-note').textContent(), 'ALL SYSTEMS READY')
  await preload.waitForTimeout(1250)
  await centered(preload, 'desktop-ready')
  await preload.screenshot({ path: resolve(shots, 'resource-ready.png') })
  await preload.setViewportSize({ width: 390, height: 844 })
  await centered(preload, 'mobile-ready')
  await preload.screenshot({ path: resolve(shots, 'resource-ready-mobile.png') })
  await preload.setViewportSize({ width: 1440, height: 900 })
  console.log('Held-editor progress:', JSON.stringify(samples))
  await preload.keyboard.press('Enter')
  await entered(preload)
  assert.equal(editorRequests.length, 1, 'trusted start gesture does not trigger Monaco loading')

  // Reach the game view like players do, then open the already-preloaded editor.
  await preload.locator('#in-room').fill('PREL')
  await preload.locator('#in-nick').fill('preload-test')
  await preload.locator('#btn-join').click()
  await preload.locator('#view-room').waitFor({ state: 'visible', timeout: 10000 })
  // Mock 服务器 join 只回 roomState；游戏视图由 mapBootstrap 触发（真实服
  // 务器同样如此），下发后 enterGame 进战斗视图。
  event('PREL', 'mapBootstrap', EvMapBootstrapSchema, { mapJson: JSON.stringify(map), mapHash: 'scorefix', generatorVersion: 2 })
  await preload.locator('#view-game').waitFor({ state: 'visible', timeout: 10000 })
  assert.equal(editorRequests.length, 1, 'game entry does not add editor fetches')
  await preload.locator('#btn-game-editor').click()
  await preload.locator('#workbench-code .monaco-editor').waitFor({ state: 'visible', timeout: 20000 })
  assert.equal(editorRequests.length, 1, 'opening the editor reuses the splash preload')
  assert.equal(await preload.evaluate(() => document.getElementById('workbench-editor-loading').hidden), true)
  assert.deepEqual(errors, [])
  await preload.close()

  // The existing 8s escape hatch permits entry, but never invents readiness.
  const timeoutPage = await open({ reducedMotion: 'reduce' })
  let releaseTimeout
  const timeoutHeld = new Promise(resolve => { releaseTimeout = resolve })
  let timeoutEditorRequests = 0
  await timeoutPage.route('**/assets/editor-*.js', async route => {
    timeoutEditorRequests++
    await timeoutHeld
    await route.continue()
  })
  await timeoutPage.goto('http://127.0.0.1:18425', { waitUntil: 'domcontentloaded' })
  await timeoutPage.waitForFunction(() => document.querySelectorAll('.startup-load-row[data-state="done"]').length === 4)
  const reducedBefore = await sampleProgress(timeoutPage)
  const reducedDots = await timeoutPage.locator('[data-resource="editor"] .startup-load-dots').textContent()
  await timeoutPage.waitForTimeout(500)
  assert.deepEqual(await sampleProgress(timeoutPage), reducedBefore, 'reduced motion snaps to milestones with a stationary track')
  assert.equal(reducedBefore.visual, 80)
  assert.equal(await timeoutPage.locator('[data-resource="editor"] .startup-load-dots').textContent(), reducedDots)
  await timeoutPage.keyboard.press('Enter')
  assert.equal(await timeoutPage.evaluate(() => window.__startupContexts.length), 0, 'pending resources still block early input')
  await ready(timeoutPage)
  assert.equal(await timeoutPage.locator('#startup').getAttribute('data-assets'), 'background')
  assert.equal((await sampleProgress(timeoutPage)).visual, 80)
  assert.equal(await timeoutPage.locator('[data-resource="editor"]').getAttribute('data-state'), 'loading')
  assert.match(await timeoutPage.locator('#startup-load-note').textContent(), /RESOURCES STILL LOADING/)
  assert.doesNotMatch(await timeoutPage.locator('#startup-load-note').textContent(), /ALL SYSTEMS READY/)
  await timeoutPage.screenshot({ path: resolve(shots, 'resource-background.png') })
  await timeoutPage.keyboard.press('Enter')
  await entered(timeoutPage)
  assert.equal(timeoutEditorRequests, 1, 'timeout entry also reuses the pending Monaco request')
  releaseTimeout()
  await timeoutPage.waitForLoadState('networkidle')
  await timeoutPage.close()

  const degraded = await open({ reducedMotion: 'reduce' })
  await degraded.route('**/assets/editor-*.js', route => route.abort())
  await degraded.goto('http://127.0.0.1:18425', { waitUntil: 'domcontentloaded' })
  await ready(degraded)
  assert.equal(await degraded.locator('#startup').getAttribute('data-assets'), 'degraded')
  assert.equal(await degraded.locator('[data-resource="editor"]').getAttribute('data-state'), 'error')
  assert.match(await degraded.locator('[data-resource="editor"]').innerText(), /Unavailable editor/)
  assert.ok((await sampleProgress(degraded)).visual < 100)
  assert.match(await degraded.locator('#startup-load-note').textContent(), /SOME RESOURCES UNAVAILABLE/)
  await degraded.screenshot({ path: resolve(shots, 'resource-degraded.png') })
  await degraded.keyboard.press('Enter')
  await entered(degraded)
  await degraded.close()

  for (const key of ['Enter', 'Space', 'a']) {
    const p = await open()
    await p.goto('http://127.0.0.1:18425')
    await ready(p)
    await p.keyboard.press('Shift')
    assert.equal(await p.evaluate(() => window.__startupContexts.length), 0)
    await p.keyboard.press(key)
    await entered(p)
    assert.equal(await p.locator('#in-room').inputValue(), '')
    await p.close()
  }
  const rejected = await open()
  await rejected.goto('http://127.0.0.1:18425')
  await ready(rejected)
  for (const shortcut of ['Control+a', 'Alt+a', 'Meta+a']) {
    await rejected.keyboard.press(shortcut)
    assert.equal(await rejected.evaluate(() => window.__startupContexts.length), 0)
  }
  const cdp = await rejected.context().newCDPSession(rejected)
  await rejected.evaluate(() => {
    window.__startupCompositionKeys = []
    document.addEventListener('keydown', event => {
      window.__startupCompositionKeys.push({ trusted: event.isTrusted, composing: event.isComposing })
    }, true)
    const probe = document.createElement('div')
    probe.id = 'startup-ime-probe'
    probe.contentEditable = 'true'
    document.getElementById('startup').append(probe)
    probe.focus()
  })
  await cdp.send('Input.imeSetComposition', { text: '候', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  assert.deepEqual(await rejected.evaluate(() => window.__startupCompositionKeys.at(-1)), { trusted: true, composing: true })
  assert.equal(await rejected.evaluate(() => window.__startupContexts.length), 0)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await rejected.locator('#startup-ime-probe').evaluate(element => element.remove())
  await rejected.keyboard.press('Enter')
  await entered(rejected)
  await rejected.close()
  const background = await open()
  await background.goto('http://127.0.0.1:18425')
  await ready(background)
  await background.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }))
  await background.keyboard.press('Enter')
  assert.equal(await background.evaluate(() => window.__startupContexts.length), 0)
  await background.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: false }))
  await background.keyboard.press('Enter')
  await entered(background)
  await background.close()
  const mobile = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  await mobile.goto('http://127.0.0.1:18425')
  await ready(mobile)
  const still = await mobile.locator('#startup-ascii').textContent()
  await mobile.waitForTimeout(350)
  assert.equal(await mobile.locator('#startup-ascii').textContent(), still)
  assert.equal(await mobile.locator('#startup-start').evaluate(el => getComputedStyle(el).animationName), 'none')
  const box = await mobile.locator('#startup-ascii').boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'mobile wordmark fits')
  await mobile.screenshot({ path: resolve(shots, 'mobile.png') })
  await mobile.touchscreen.tap(30, 30)
  await entered(mobile)
  await mobile.close()
  // App-module regression: real DOM and protobuf handshake, no gameplay simulation.
  const navigation = await open()
  await navigation.route('**/api/matches', route => route.fulfill({ json: [] }))
  await navigation.route(/\/api\/manual(?:\/.*)?$/, route => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill(path.endsWith('/api/manual')
      ? { json: [{ path: 'index.md', title: '模块回归', children: [] }] }
      : { contentType: 'text/markdown', body: ['# 模块回归', '', '验证手册导航与返回大厅。'].join(String.fromCharCode(10)) })
  })
  await navigation.goto('http://127.0.0.1:18425?room=nav1')
  await ready(navigation)
  await navigation.keyboard.press('Enter')
  await entered(navigation)
  assert.equal(await navigation.locator('#in-room').inputValue(), 'NAV1')
  await navigation.locator('#btn-join').click()
  assert.match(await navigation.locator('#form-error').textContent(), /昵称/)
  await navigation.locator('#in-room').fill('ab-12')
  assert.equal(await navigation.locator('#in-room').inputValue(), 'AB12')
  await navigation.locator('#in-nick').fill('module-test')
  await navigation.locator('.swatch').nth(1).click()
  const commandStart = commands.length
  await navigation.locator('#in-nick').press('Enter')
  await navigation.locator('#btn-start').waitFor({ state: 'visible' })
  assert.match(await navigation.locator('#room-state').textContent(), /房主 module-test/)
  const join = commands.slice(commandStart).find(command => command.case === 'join')
  assert.ok(join, 'join command reaches the existing session owner')
  assert.equal(join.value.roomCode, 'AB12')
  assert.equal(join.value.nick, 'module-test')
  assert.equal(join.value.color, '#a3e635')
  const actionCount = commands.filter(command => command.case === 'roomAction').length
  await navigation.locator('#btn-solo-bots').click()
  await navigation.locator('#btn-warmup').click()
  await navigation.locator('#btn-start').click()
  await assertEventually(() => commands.filter(command => command.case === 'roomAction').length === actionCount + 3)
  assert.deepEqual(commands.filter(command => command.case === 'roomAction').slice(-3).map(command => command.value.kind),
    [RoomAction_Kind.SOLO_BOTS, RoomAction_Kind.WARMUP, RoomAction_Kind.START])
  for (let round = 0; round < 2; round++) {
    await navigation.locator('#btn-manual').click()
    await navigation.locator('#manual-content .manual-body').waitFor()
    await navigation.locator('#btn-manual-back').click()
    assert.equal(await navigation.locator('#view-room').isVisible(), true)
    await navigation.locator('#btn-replay').click()
    assert.equal(await navigation.locator('#view-replays').isVisible(), true)
    await navigation.locator('#btn-replays-back').click()
    await navigation.locator('#btn-room-spectator').click()
    assert.equal(await navigation.locator('#spectator-library-note').isVisible(), true)
    await navigation.keyboard.press('Escape')
    assert.equal(await navigation.locator('#view-room').isVisible(), true)
    assert.equal(await navigation.locator('#btn-room-spectator').evaluate(el => el === document.activeElement), true)
  }
  const leaveCount = commands.filter(command => command.case === 'leave').length
  await navigation.locator('#btn-leave').click()
  await navigation.locator('#view-join').waitFor({ state: 'visible' })
  await assertEventually(() => commands.filter(command => command.case === 'leave').length === leaveCount + 1)
  await navigation.close()

  const directLive = await open()
  await directLive.addInitScript(() => sessionStorage.setItem('omb.join', JSON.stringify({ roomCode: 'NAV1', nick: 'must-not-join', color: '#22d3ee' })))
  const joinsBeforeLive = commands.filter(command => command.case === 'join').length
  const spectatorsBeforeLive = commands.filter(command => command.case === 'spectate').length
  await directLive.goto('http://127.0.0.1:18425?view=live&room=NAV1')
  await ready(directLive)
  await directLive.keyboard.press('Enter')
  await entered(directLive)
  await assertEventually(() => commands.filter(command => command.case === 'spectate').length > spectatorsBeforeLive)
  assert.equal(commands.filter(command => command.case === 'join').length, joinsBeforeLive)
  assert.equal(await directLive.locator('#view-live').isVisible(), true)
  event('NAV1', 'mapBootstrap', EvMapBootstrapSchema, { mapJson: JSON.stringify(map), mapHash: 'scorefix', generatorVersion: 2 })
  snapshot('NAV1', 60, 1, false)
  event('NAV1', 'scoreboard', EvScoreboardSchema, { tick: 60, rows: [{ robot: 101, score: 15 }, { robot: 202, score: 35 }] }, 60)
  await directLive.waitForFunction(() => document.querySelector('#live-scores .score-value')?.textContent === '35')
  event('NAV1', 'matchEnd', EvMatchEndSchema, { scores: [{ robot: 202, score: 42, titles: [Title.SURVIVOR] }, { robot: 101, score: 15 }] }, 61)
  await directLive.waitForFunction(() => document.querySelector('#live-scores .score-title')?.textContent === '苟王')
  assert.equal(await directLive.locator('#live-scores .score-self').count(), 0)
  assert.equal(await directLive.locator('#live-scores .score-value').first().textContent(), '42')
  await directLive.locator('#live-back').click()
  assert.equal(await directLive.locator('#view-join').isVisible(), true)
  await directLive.close()

  const scoring = await open()
  await scoring.goto('http://127.0.0.1:18425')
  await ready(scoring)
  await scoring.keyboard.press('Enter')
  await entered(scoring)
  await scoring.waitForFunction(() => window.__musicSources.filter(entry => entry.source.loop && entry.started && !entry.stopped).length > 0)
  const weights = () => scoring.evaluate(() => window.__musicSources.filter(entry => entry.source.loop && !entry.stopped).map(entry => entry.gain.value.toFixed(3)).join(','))
  /** Wait (bounded) until stage gains settle to new values — quantized switches
   *  land on the next beat (≤1.5 beats ≈ 0.81s @ 112bpm), then fade for 90ms.
   *  Three identical 100ms samples prove the value is no longer mid-fade. */
  const waitForWeights = async (before, label) => {
    let current = before
    let stableReads = 0
    for (let i = 0; i < 40; i++) {
      const next = await weights()
      stableReads = next !== before && next === current ? stableReads + 1 : next !== before ? 1 : 0
      current = next
      if (stableReads >= 3) return current
      await scoring.waitForTimeout(100)
    }
    assert.fail(`${label}: stage gains did not settle to values different from ${before}; last observed ${current}`)
  }
  const titleWeights = await weights()
  const loopsBefore = await scoring.evaluate(() => window.__musicSources.filter(entry => entry.source.loop).length)
  assert.ok(await scoring.evaluate(() => window.__musicSources.some(entry => entry.source.loop && entry.source.buffer.getChannelData(0).some(sample => Math.abs(sample) > 0.001))), 'music contains rendered audio')
  await scoring.locator('#in-room').fill('SCOR')
  await scoring.locator('#in-nick').fill('score-test')
  await scoring.locator('#btn-join').click()
  await scoring.locator('#view-room').waitFor({ state: 'visible' })
  await assertEventually(() => [...sockets.clients].some(socket => socket.testRoom === 'SCOR'))
  event('SCOR', 'mapBootstrap', EvMapBootstrapSchema, { mapJson: JSON.stringify(map), mapHash: 'scorefix', generatorVersion: 2 })
  snapshot('SCOR', 60, 1)
  event('SCOR', 'scoreboard', EvScoreboardSchema, { tick: 60, rows: [{ robot: 101, score: 0 }, { robot: 202, score: 25 }, { robot: 303, score: 10 }] }, 60)
  await scoring.waitForFunction(() => document.querySelector('#hud-self-score strong')?.textContent === '0')
  assert.equal(await scoring.locator('#hud-score-rows .score-row').count(), 3)
  assert.equal(await scoring.locator('#hud-score-rows .score-name').first().textContent(), '<b>NO HTML</b>')
  assert.equal(await scoring.locator('#hud-score-rows b').count(), 0)
  const outerWeights = await waitForWeights(titleWeights, 'outer ring selects arena stage')
  snapshot('SCOR', 120, 2)
  event('SCOR', 'scoreboard', EvScoreboardSchema, { tick: 120, rows: [{ robot: 101, score: 80 }, { robot: 202, score: 25 }, { robot: 303, score: 10 }] }, 120)
  await scoring.waitForFunction(() => document.querySelector('#hud-self-score strong')?.textContent === '80')
  await waitForWeights(outerWeights, 'inner ring selects final stage')
  assert.equal(await scoring.evaluate(() => window.__musicSources.filter(entry => entry.source.loop).length), loopsBefore, 'stage changes do not restart looping sources')
  await scoring.screenshot({ path: resolve(shots, 'score-hud.png') })
  const final = { scores: [{ robot: 101, score: 99, titles: [Title.KILL_STEAL, Title.HEALER] }, { robot: 202, score: 25 }] }
  event('SCOR', 'matchEnd', EvMatchEndSchema, final, 121)
  event('SCOR', 'matchEnd', EvMatchEndSchema, final, 121)
  event('SCOR', 'scoreboard', EvScoreboardSchema, { tick: 122, rows: [{ robot: 101, score: 0 }] }, 122)
  await scoring.locator('.end-overlay').waitFor({ state: 'visible' })
  assert.equal(await scoring.locator('.end-overlay').count(), 1)
  assert.equal(await scoring.locator('.end-list .score-self .score-value').textContent(), '99')
  assert.deepEqual(await scoring.locator('.end-list .score-self .score-title').allTextContents(), ['抢人头', '耐活王'])
  assert.equal(await scoring.locator('.end-list .score-no-title').textContent(), '暂无称号')
  await scoring.screenshot({ path: resolve(shots, 'settlement.png') })
  await scoring.locator('.end-back').click()
  await scoring.locator('#view-room').waitFor({ state: 'visible' })
  for (let i = 0; i < 40; i++) {
    if (await weights() === titleWeights) break
    await scoring.waitForTimeout(100)
  }
  assert.equal(await weights(), titleWeights, 'returning to lobby restores title stage')
  await scoring.locator('#audio-settings summary').click()
  await scoring.locator('#audio-mute').click()
  await scoring.waitForFunction(() => window.__musicSources.every(entry => !entry.source.loop || entry.stopped))
  await scoring.locator('#audio-mute').click()
  await scoring.waitForFunction(() => window.__musicSources.some(entry => entry.source.loop && !entry.stopped))
  assert.equal(await scoring.evaluate(() => window.__startupContexts.length), 1, 'music and effects keep one context')
  event('SCOR', 'mapBootstrap', EvMapBootstrapSchema, { mapJson: JSON.stringify(map), mapHash: 'scorefix', generatorVersion: 2 })
  snapshot('SCOR', 1, 1)
  event('SCOR', 'scoreboard', EvScoreboardSchema, { tick: 1, rows: [{ robot: 101, score: 0 }] }, 1)
  await scoring.waitForFunction(() => document.querySelector('#hud-self-score strong')?.textContent === '0')
  assert.equal(await scoring.locator('.end-overlay').count(), 0, 'new bootstrap removes old settlement')
  await scoring.close()

  const replay = await open()
  const replayText = [
    { type: 'match_start', tick: 0, state: { tick: 0, phase: 1, map, robots: [
      { id: 101, nick: 'score-test', position: { X: 0, Y: 0 }, hp: 1000, state: 'alive' },
      { id: 202, nick: '<b>NO HTML</b>', position: { X: 8, Y: 0 }, hp: 1000, state: 'alive' },
    ] } },
    { type: 'event', tick: 60, event: { hit: { from: 101, to: 202 } } },
    { type: 'event', tick: 120, event: { phase_change: { from: 1, to: 2 } } },
    { type: 'event', tick: 125, event: { match_end: { scores: [
      { robot: 101, score: 77, titles: ['KILL_STEAL', 'HEALER'] }, { robot: 202, score: 0 },
    ] } } },
  ].map(record => JSON.stringify(record)).join(String.fromCharCode(10))
  await replay.route('**/api/matches', route => route.fulfill({ json: ['SCOR-1'] }))
  await replay.route(/\/api\/replay\/SCOR-1(?:\?visual=1)?$/, route => route.fulfill({ contentType: 'application/x-ndjson', body: replayText }))
  await replay.goto('http://127.0.0.1:18425?view=replay-player&replay=SCOR-1')
  await ready(replay)
  await replay.keyboard.press('Enter')
  await entered(replay)
  await replay.locator('#rp-score .score-row').first().waitFor()
  await replay.locator('#rp-timeline').evaluate(el => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    el.value = '125'; el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await replay.waitForFunction(() => document.querySelector('#rp-score .score-value')?.textContent === '77')
  assert.deepEqual(await replay.locator('#rp-score .score-title').allTextContents(), ['抢人头', '耐活王'])
  assert.equal(await replay.locator('#rp-score b').count(), 0)
  await replay.locator('#rp-timeline').evaluate(el => {
    el.value = '60'; el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await replay.waitForFunction(() => document.querySelector('#rp-score .score-value')?.textContent === '1')
  assert.equal(await replay.locator('#rp-score .score-title').count(), 0)
  await replay.close()

  const broken = await open()
  await broken.route('**/assets/main-*.js', route => route.abort())
  await broken.goto('http://127.0.0.1:18425', { waitUntil: 'domcontentloaded' })
  await broken.locator('#startup[data-state="error"]').waitFor()
  assert.equal(await broken.locator('#startup-retry').isVisible(), true)
  assert.equal(await broken.evaluate(() => window.__startupContexts.length), 0)
  await broken.close()
  assert.deepEqual(errors, [])
  console.log('Loader centering:', JSON.stringify(geometry))
  console.log('PASS: startup/audio/ASCII/mobile; lobby/navigation; direct live isolation; authoritative scoreboard/settlement/reset; title/arena/final looping music + mute; live scores + replay settlement/seek')
} finally {
  await browser.close()
  for (const socket of sockets.clients) socket.terminate()
  await new Promise(resolve => sockets.close(resolve))
  await new Promise(resolve => server.httpServer.close(resolve))
}
