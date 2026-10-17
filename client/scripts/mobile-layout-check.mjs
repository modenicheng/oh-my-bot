import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { preview } from 'vite'
import { WebSocketServer } from 'ws'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  ClientMsgSchema, ServerMsgSchema, ServerEventSchema, SnapshotDeltaSchema,
  EvRoomStateSchema, EvMapBootstrapSchema, EvScoreboardSchema, EvMatchEndSchema,
  EvAiQuotaSchema, EvAiStreamSchema, EvScriptResultSchema, RoomAction_Kind, Title,
} from '../../packages/protocol/src/index.ts'

// Run against the parent's existing dist; this fixture never builds or starts AI.
// pnpm --filter client exec tsx scripts/mobile-layout-check.mjs
const clientRoot = resolve(import.meta.dirname, '..')
const artifacts = resolve(clientRoot, '../.artifacts/mobile-layout')
const timeout = 5000
const allVariants = [
  { width: 667, height: 375 },
  { width: 844, height: 390 },
  { width: 915, height: 412 },
  { width: 932, height: 430 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]
const selectedViewport = process.env.MOBILE_LAYOUT_VIEWPORT
const variants = allVariants.filter(size => !selectedViewport || `${size.width}x${size.height}` === selectedViewport)
assert.ok(variants.length, `Unknown MOBILE_LAYOUT_VIEWPORT: ${selectedViewport}`)
const diagnoseScroll = process.env.MOBILE_LAYOUT_DIAGNOSE_SCROLL === '1'
const report = {
  startedAt: new Date().toISOString(),
  command: 'pnpm --filter client exec tsx scripts/mobile-layout-check.mjs',
  selectedViewport: selectedViewport ?? null,
  diagnoseScroll,
  fixture: 'Vite preview + local protobuf WebSocket, deterministic AI stream/result',
  assumptions: [
    'The parent has built client/dist from compatible protocol sources.',
    'Chromium touch emulation exercises CSS rotation, not physical device orientation locking or a native software keyboard.',
    'Read-only DOM snapshots project physical rectangles into the logical landscape viewport.',
    'AI is answered entirely by the local WebSocket fixture; external HTTP requests are blocked.',
  ],
  variants: [],
  pageErrors: [],
  fixtureErrors: [],
  externalRequests: [],
}
const rooms = new Map()
const commands = []
const protocol = new EventEmitter()
const map = {
  version: 1, generator_ver: 2, seed: 101, map_hash: 'layout-fixture',
  walls: [{ id: 1, min: { X: -66, Y: -60 }, max: { X: -58, Y: 60 } }],
  sectors: [{ id: 1, spawn_area: { Min: { X: -50, Y: -40 }, Max: { X: -35, Y: -25 } }, center: { X: -42, Y: -32 } }],
  uplinks: [{ id: 900, pos: { X: 10, Y: 10 }, main: false, interact_r: 2.5, active_phase: 1 }],
  core_pads: [{ id: 1, pos: { X: 3, Y: 3 }, group: 0, value: 10 }],
  core_zone: { radius: 30, unlock_phase: 2 },
}
const aiAnswer = [
  '## Layout fixture response',
  '',
  'This deterministic local response does not contact an AI provider.',
  '',
  ...Array.from({ length: 8 }, (_, i) => `${i + 1}. Keep movement and aiming independent; preserve the current control contract.`),
  '',
  '```js',
  'export function tick(api) {',
  '  api.move({ x: 0, y: 0 });',
  '}',
  '```',
].join('\n')

let server
let sockets
let browser

function send(room, payload) {
  const bytes = Buffer.concat([Buffer.from([3]), toBinary(ServerMsgSchema, create(ServerMsgSchema, { payload }))])
  for (const socket of sockets.clients) {
    if (socket.fixtureRoom === room && socket.readyState === 1) socket.send(bytes)
  }
}

function event(room, kind, schema, fields, tick = 600) {
  send(room, { case: 'event', value: create(ServerEventSchema, { tick, kind: { case: kind, value: create(schema, fields) } }) })
}

function scoreRows(room) {
  return Array.from({ length: 32 }, (_, index) => ({
    robot: index === 0 ? 101 : 202 + index,
    nick: index === 0 ? rooms.get(room).nick : `player-${String(index + 1).padStart(2, '0')}-long`,
    score: 900 - index * 17,
    titles: index % 3 === 0 ? [Title.WAR_MACHINE, Title.SURVIVOR] : [Title.RUNNER],
  }))
}

function beginBattle(room, warmup) {
  const state = rooms.get(room)
  state.battleStarts++
  event(room, 'roomState', EvRoomStateSchema, { state: warmup ? 1 : 2, hostNick: state.nick, robotsOnline: 32 })
  event(room, 'mapBootstrap', EvMapBootstrapSchema, {
    mapJson: JSON.stringify(map), mapHash: map.map_hash, generatorVersion: 2,
    generation: 2, discreteShotSupported: true,
  })
  send(room, { case: 'snapshot', value: create(SnapshotDeltaSchema, {
    tick: 600, full: true, phase: 1, timeLeftS: 300,
    robots: scoreRows(room).map((row, index) => ({
      base: { id: row.robot, pos: { x: index === 0 ? 0 : 8 + index % 4, y: Math.floor(index / 4) } },
      hpX10: 1000, energyX10: 1000, nick: row.nick, color: index === 0 ? '#22d3ee' : '#fbbf24',
    })),
    self: {
      robotId: 101, moveSrc: 1, turretSrc: 1, assistOn: false,
      aiRoundsLeft: 12, aiTokensLeftK: 64, inputGeneration: 2,
    },
  }) })
  event(room, 'scoreboard', EvScoreboardSchema, { tick: 600, rows: scoreRows(room) })
  event(room, 'aiQuota', EvAiQuotaSchema, { roundsLeft: 12, tokensUsedK: 0, globalTokensLeftK: 2000 })
}

function connectFixture(socket) {
  socket.on('error', error => report.fixtureErrors.push(String(error)))
  socket.on('message', data => {
    try {
      const bytes = Buffer.from(data)
      if (bytes[0] === 0) { socket.send(Buffer.from([1])); return }
      if (bytes[0] !== 2) return
      const command = fromBinary(ClientMsgSchema, bytes.subarray(1)).payload
      if (command.case === 'join') {
        socket.fixtureRoom = command.value.roomCode
        rooms.set(socket.fixtureRoom, { nick: command.value.nick, aiPrompts: [], battleStarts: 0 })
      }
      const room = socket.fixtureRoom
      commands.push({ room, case: command.case, value: command.value })
      protocol.emit('command')
      if (!room) return
      if (command.case === 'join') {
        event(room, 'roomState', EvRoomStateSchema, { state: 0, hostNick: command.value.nick, robotsOnline: 1 }, 0)
      } else if (command.case === 'roomAction' &&
          [RoomAction_Kind.START, RoomAction_Kind.WARMUP].includes(command.value.kind)) {
        beginBattle(room, command.value.kind === RoomAction_Kind.WARMUP)
      } else if (command.case === 'aiPrompt') {
        rooms.get(room).aiPrompts.push(command.value.text)
        event(room, 'aiStream', EvAiStreamSchema, { kind: 1, delta: 'Inspecting the deterministic mobile layout fixture.' })
        event(room, 'aiStream', EvAiStreamSchema, { kind: 0, delta: aiAnswer })
        event(room, 'scriptResult', EvScriptResultSchema, { clientScriptId: 0, ok: true, scriptRev: 2 })
        event(room, 'aiQuota', EvAiQuotaSchema, { roundsLeft: 11, tokensUsedK: 1, globalTokensLeftK: 1999 })
      }
    } catch (error) {
      report.fixtureErrors.push(error.stack ?? String(error))
      protocol.emit('command')
    }
  })
}

function waitCommand(room, predicate) {
  return new Promise((resolveWait, reject) => {
    const changed = () => {
      const command = commands.find(entry => entry.room === room && predicate(entry))
      if (command) { cleanup(); resolveWait(command) }
      else if (report.fixtureErrors.length) { cleanup(); reject(new Error(report.fixtureErrors.at(-1))) }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${room}: expected WebSocket command within ${timeout}ms`))
    }, timeout)
    const cleanup = () => { clearTimeout(timer); protocol.off('command', changed) }
    protocol.on('command', changed)
    changed()
  })
}

// No production hooks: read layout and hit-test results only. CSS rotations turn
// axis-aligned physical rectangles back into axis-aligned logical rectangles.
async function snapshot(page, selectors) {
  return page.evaluate(selectors => {
    const root = document.documentElement
    const rotated = root.classList.contains('mobile-rotated')
    const physicalWidth = visualViewport?.width || innerWidth
    const offsetLeft = visualViewport?.offsetLeft || 0
    const offsetTop = visualViewport?.offsetTop || 0
    const point = (x, y) => rotated
      ? { x: y - offsetTop, y: physicalWidth - x + offsetLeft } : { x, y }
    const rect = element => {
      const r = element.getBoundingClientRect()
      const a = point(r.left, r.top), b = point(r.right, r.bottom)
      const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y)
      return {
        left, top, right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y),
        width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
      }
    }
    const measure = element => {
      const style = getComputedStyle(element)
      const r = element.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        logical: rect(element),
        physical: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
        visible: element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
        centerHit: !!hit && (hit === element || element.contains(hit)),
        hit: hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}.${[...hit.classList].join('.')}` : null,
        overflowX: style.overflowX, overflowY: style.overflowY,
        scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        position: style.position, display: style.display, fontSize: parseFloat(style.fontSize),
        text: (element.textContent ?? '').trim().slice(0, 180),
      }
    }
    return {
      rotated, landscape: root.classList.contains('mobile-landscape'),
      physicalViewport: { width: innerWidth, height: innerHeight },
      logicalViewport: {
        width: parseFloat(getComputedStyle(root).getPropertyValue('--app-width')),
        height: parseFloat(getComputedStyle(root).getPropertyValue('--app-height')),
      },
      body: measure(document.body),
      elements: Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)].map(measure)])),
    }
  }, selectors)
}

function one(data, selector, visible = true) {
  const items = data.elements[selector] ?? []
  assert.equal(items.length, 1, `${selector}: exactly one element`)
  const item = items[0]
  if (visible) assert.ok(item.visible, `${selector}: visible`)
  assert.ok(item.logical.width > 0 && item.logical.height > 0, `${selector}: has layout`)
  return item
}

function within(rect, outer, label, tolerance = 1) {
  assert.ok(rect.left >= outer.left - tolerance && rect.top >= outer.top - tolerance &&
    rect.right <= outer.right + tolerance && rect.bottom <= outer.bottom + tolerance,
  `${label}: contained; ${JSON.stringify({ rect, outer })}`)
}

function viewport(data) {
  return { left: 0, top: 0, right: data.logicalViewport.width, bottom: data.logicalViewport.height }
}

function fits(data, selector, visible = true) {
  const item = one(data, selector, visible)
  within(item.logical, viewport(data), selector)
  return item.logical
}

function separate(a, b, label) {
  const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  assert.ok(overlapX <= 1 || overlapY <= 1, `${label}: no overlap; ${JSON.stringify({ a, b })}`)
}

function reachable(data, selector) {
  const item = one(data, selector)
  within(item.logical, viewport(data), selector)
  assert.ok(item.logical.width >= 44 && item.logical.height >= 44, `${selector}: at least 44x44 logical pixels`)
  assert.ok(item.centerHit, `${selector}: center is unobscured (hit ${item.hit})`)
  return item.logical
}

function shell(data, size) {
  assert.equal(data.landscape, true, 'global mobile landscape shell enabled')
  assert.equal(data.rotated, size.height > size.width, 'portrait uses clockwise CSS rotation')
  assert.equal(data.logicalViewport.width, Math.max(size.width, size.height), 'logical width')
  assert.equal(data.logicalViewport.height, Math.min(size.width, size.height), 'logical height')
  within(data.body.logical, viewport(data), 'body')
  assert.ok(Math.abs(data.body.logical.width - data.logicalViewport.width) <= 1, 'body fills logical width')
  assert.ok(Math.abs(data.body.logical.height - data.logicalViewport.height) <= 1, 'body fills logical height')
}

async function tap(page, selector) {
  const target = page.locator(selector)
  await target.waitFor({ state: 'visible', timeout })
  const point = await target.evaluate(element => {
    const r = element.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x, y, visible: element.checkVisibility({ checkVisibilityCSS: true }),
      enabled: !element.matches(':disabled, [inert]') && !element.closest('[inert]'),
      hit: !!hit && (hit === element || element.contains(hit)),
      hitDescription: hit?.outerHTML.slice(0, 220) }
  })
  const size = page.viewportSize()
  assert.ok(point.visible && point.enabled && point.hit && point.x > 0 && point.x < size.width &&
    point.y > 0 && point.y < size.height, `${selector}: trusted tap reachable; ${JSON.stringify(point)}`)
  await page.touchscreen.tap(point.x, point.y)
}

async function type(page, selector, text) {
  await tap(page, selector)
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(text)
}

async function checkpoint(result, page, label, selectors, verify) {
  const check = { name: label, ok: false }
  result.checks.push(check)
  try {
    check.snapshot = await snapshot(page, selectors)
    await verify(check.snapshot)
    check.ok = true
  } catch (error) {
    check.error = error.stack ?? String(error)
    console.error(`FAIL ${result.name} ${label}: ${error.message}`)
  } finally {
    check.screenshot = `${result.name}-${label}.png`
    await page.screenshot({ path: resolve(artifacts, check.screenshot) }).catch(error => {
      check.ok = false
      check.error = `${check.error ?? ''}\nScreenshot: ${error}`
    })
  }
  if (check.ok) console.log(`PASS ${result.name} ${label}`)
}

async function startupLayout(result, page, size, state) {
  const selectors = [
    '.startup-content', '.startup-brand', '#startup-ascii', '.startup-center', '#startup-start',
    '.startup-loader', '.startup-load-list', '.startup-progress', '#startup-track',
    '#startup-percent', '.startup-load-note', '.startup-footer', '.startup-load-row',
  ]
  await checkpoint(result, page, `startup-${state}`, selectors, data => {
    shell(data, size)
    const content = fits(data, '.startup-content')
    const brand = fits(data, '.startup-brand')
    const loader = fits(data, '.startup-loader')
    const footer = fits(data, '.startup-footer')
    const center = fits(data, '.startup-center')
    fits(data, '#startup-ascii')
    for (const selector of ['.startup-brand', '#startup-start', '.startup-loader', '.startup-load-list',
      '.startup-progress', '#startup-track', '#startup-percent', '.startup-load-note']) {
      const rect = fits(data, selector, selector !== '#startup-start' || state === 'ready')
      const delta = Math.abs((rect.left + rect.right) / 2 - data.logicalViewport.width / 2)
      assert.ok(delta <= 1, `${selector}: logical center within 1px (delta ${delta})`)
    }
    assert.equal(one(data, '#startup-start', false).visible, state === 'ready', 'start prompt follows readiness')
    assert.ok(brand.bottom <= center.top + 1, 'brand does not overlap start prompt/loading group')
    assert.ok(center.bottom <= footer.top + 1, 'loading group does not overlap footer')
    assert.ok(loader.bottom <= footer.top + 1, 'loader does not overlap footer')
    const groupCenter = (brand.top + loader.bottom) / 2
    assert.ok(Math.abs(groupCenter - (content.top + content.bottom) / 2) <= 1,
      `brand + loading group vertically centered in startup-content (${groupCenter})`)
    assert.equal(data.elements['.startup-load-row'].length, 5, 'five actual resource rows')
    for (const row of data.elements['.startup-load-row']) {
      within(row.logical, one(data, '.startup-load-list').logical, 'resource row')
      assert.ok(row.scrollWidth <= row.clientWidth + 1, 'resource row has no implicit min-content overflow')
    }
    assert.ok(one(data, '.startup-load-list').scrollWidth <= one(data, '.startup-load-list').clientWidth + 1,
      'two-column resource list does not spill horizontally')
  })
}

async function swipeList(page, axis = 'logical') {
  const before = await page.locator('.end-list').evaluate(el => el.scrollTop)
  const points = await page.locator('.end-list').evaluate((element, axis) => {
    const r = element.getBoundingClientRect()
    const rotated = document.documentElement.classList.contains('mobile-rotated')
    // Leave title badges on the right alone; begin in the row's rank/name area.
    if (axis === 'physical-y') return {
      start: { x: r.left + r.width * .5, y: r.top + r.height * .75 },
      end: { x: r.left + r.width * .5, y: r.top + r.height * .25 },
    }
    if (axis === 'physical-y-reverse') return {
      start: { x: r.left + r.width * .5, y: r.top + r.height * .25 },
      end: { x: r.left + r.width * .5, y: r.top + r.height * .75 },
    }
    if (axis === 'physical-x-reverse') return {
      start: { x: r.left + r.width * .8, y: r.top + r.height * .22 },
      end: { x: r.left + r.width * .2, y: r.top + r.height * .22 },
    }
    return rotated
      ? { start: { x: r.left + r.width * .2, y: r.top + r.height * .22 },
        end: { x: r.left + r.width * .8, y: r.top + r.height * .22 } }
      : { start: { x: r.left + r.width * .22, y: r.top + r.height * .8 },
        end: { x: r.left + r.width * .22, y: r.top + r.height * .2 } }
  }, axis)
  const session = await page.context().newCDPSession(page)
  let ended = false
  try {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ ...points.start, id: 11 }],
    })
    for (let i = 1; i <= 10; i++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{
          x: points.start.x + (points.end.x - points.start.x) * i / 10,
          y: points.start.y + (points.end.y - points.start.y) * i / 10, id: 11,
        }],
      })
      // A rendering frame gives Chromium time to recognize a real scroll gesture.
      await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => resolveFrame())))
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    ended = true
    await page.waitForFunction(before => document.querySelector('.end-list').scrollTop > before + 8, before, { timeout })
  } finally {
    if (!ended) await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {})
    await session.detach()
  }
}

async function settleList(page) {
  // A tap during compositor inertia stops the fling instead of clicking a button.
  // Observe rest, rather than retrying clicks or sleeping for an arbitrary period.
  await page.locator('.end-list').evaluate(element => new Promise((resolveRest, reject) => {
    const deadline = performance.now() + 2500
    let previous = element.scrollTop, stableFrames = 0
    const frame = () => {
      const value = element.scrollTop
      stableFrames = Math.abs(value - previous) < .1 ? stableFrames + 1 : 0
      previous = value
      if (stableFrames >= 6) resolveRest()
      else if (performance.now() > deadline) reject(new Error('Settlement list did not stop scrolling within 2500ms'))
      else requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }))
}

async function tracePointers(page) {
  return page.evaluateHandle(() => {
    const events = [], controller = new AbortController()
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'click']) {
      window.addEventListener(type, event => {
        if (events.length >= 240) return
        const contact = event.changedTouches?.[0] ?? event
        const hit = document.elementFromPoint(contact.clientX ?? 0, contact.clientY ?? 0)
        events.push({ type, trusted: event.isTrusted, pointerId: event.pointerId,
          x: contact.clientX, y: contact.clientY, cancelable: event.cancelable,
          target: `${event.target?.tagName}.${event.target?.className}`,
          hit: hit ? `${hit.tagName}.${hit.className}` : null,
          scrollTop: document.querySelector('.end-list')?.scrollTop })
      }, { capture: true, passive: true, signal: controller.signal })
    }
    return { events, stop: () => controller.abort() }
  })
}

async function runVariant(size, index, baseURL) {
  const result = { name: `${size.width}x${size.height}`, viewport: size, checks: [], screenshots: [], errors: [] }
  report.variants.push(result)
  const context = await browser.newContext({
    viewport: size, screen: size, hasTouch: true, isMobile: true,
    deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(timeout)
  page.on('pageerror', error => {
    const message = error.stack ?? String(error)
    result.errors.push(message)
    report.pageErrors.push({ viewport: result.name, error: message })
  })
  let releaseMain
  const holdMain = new Promise(resolveHold => { releaseMain = resolveHold })
  let heldRequests = 0
  let stage = 'startup-loading'
  const room = `LAY${String(index).padStart(3, '0')}`
  const nick = 'layout-test'
  try {
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== baseURL) {
        report.externalRequests.push({ viewport: result.name, url: url.href })
        await route.abort('blockedbyclient')
      } else if (url.pathname === '/auth/status') {
        await route.fulfill({ json: { enabled: false } })
      } else if (url.pathname === '/api/version') {
        await route.fulfill({ json: { version: 'layout-fixture' } })
      } else if (url.pathname === '/api/manual') {
        await route.fulfill({ json: [{ path: 'index.md', title: 'Fixture manual', children: [] }] })
      } else if (url.pathname.startsWith('/api/manual/')) {
        await route.fulfill({ contentType: 'text/markdown', body: '# Fixture manual\n\nLocal deterministic layout fixture.' })
      } else {
        await route.continue()
      }
    })
    await page.route('**/assets/main-*.js', async route => {
      heldRequests++
      await holdMain
      if (!page.isClosed()) await route.continue().catch(() => {})
    })
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.locator('html.mobile-landscape').waitFor({ state: 'attached' })
    await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout })
    assert.ok(heldRequests > 0, 'main chunk held for deterministic loading screenshot')
    assert.equal(await page.locator('#startup').getAttribute('data-state'), 'loading')
    await startupLayout(result, page, size, 'loading')
    releaseMain()
    await page.locator('#startup[data-state="ready"]').waitFor({ timeout: 20000 })
    stage = 'startup-ready'
    await startupLayout(result, page, size, 'ready')
    await tap(page, '#startup-start')
    await page.locator('#startup').waitFor({ state: 'hidden' })

    stage = 'join'
    await checkpoint(result, page, stage,
      ['#view-join', '.join-brand', '.join-form', '.join-identity', '#in-room', '#in-nick', '#btn-join'], data => {
        shell(data, size)
        const brand = fits(data, '.join-brand'), form = fits(data, '.join-form')
        assert.ok(brand.right <= form.left + 1, 'join brand and form use separate columns')
        const code = reachable(data, '#in-room'), name = reachable(data, '#in-nick')
        assert.ok(code.right <= name.left + 1, 'room code and nickname use separate columns')
        reachable(data, '#btn-join')
      })
    await type(page, '#in-room', room)
    await type(page, '#in-nick', nick)
    await tap(page, '#btn-join')
    await waitCommand(room, entry => entry.case === 'join')
    await page.locator('#view-room').waitFor({ state: 'visible' })
    await page.locator('#btn-start').waitFor({ state: 'visible' })

    stage = 'lobby'
    await checkpoint(result, page, stage,
      ['#view-room', '.room-heading', '.room-members', '#room-actions', '.room-footer', '#btn-start', '#btn-warmup'], data => {
        shell(data, size)
        const heading = fits(data, '.room-heading'), footer = fits(data, '.room-footer')
        const members = fits(data, '.room-members'), actions = fits(data, '#room-actions')
        assert.ok(members.right <= actions.left + 1, 'members and room actions occupy separate columns')
        assert.ok(heading.bottom <= Math.min(members.top, actions.top) + 1, 'room heading above both columns')
        assert.ok(Math.max(members.bottom, actions.bottom) <= footer.top + 1, 'room footer below both columns')
        reachable(data, '#btn-start')
        reachable(data, '#btn-warmup')
      })
    await tap(page, '#btn-start')
    await waitCommand(room, entry => entry.case === 'roomAction' && entry.value.kind === RoomAction_Kind.START)
    await page.locator('#game-stage.touch-battle').waitFor({ state: 'visible' })
    await page.waitForFunction(() => document.querySelector('#hud-time').textContent.trim() === '5:00', undefined, { timeout })

    stage = 'battle'
    const forbidden = '#btn-game-replay, #btn-game-help, .game-help, #audio-settings, [data-fullscreen], #btn-fullscreen, #btn-game-fullscreen'
    await checkpoint(result, page, stage,
      ['#game-stage', '.hud-top', '#hud-phase', '#hud-time', '.game-header', '#btn-game-editor',
        '.mobile-toolbar [data-mobile-action="menu"]', '[data-mobile-role="move"]', '[data-mobile-role="aim"]', forbidden], data => {
        shell(data, size)
        const bounds = fits(data, '#game-stage'), top = fits(data, '.hud-top')
        const phase = fits(data, '#hud-phase'), clock = fits(data, '#hud-time')
        assert.ok(top.top >= bounds.top - 1 && top.top <= bounds.top + 24, 'core/time header pinned near stage top')
        assert.ok(Math.abs((top.left + top.right) / 2 - (bounds.left + bounds.right) / 2) <= 1, 'core/time centered')
        assert.ok(phase.bottom <= clock.top + 1, 'core/time labels do not overlap')
        separate(clock, reachable(data, '#btn-game-editor'), 'battle header and editor')
        for (const item of data.elements[forbidden]) assert.equal(item.visible, false, 'legacy replay/help/audio/fullscreen toolbar hidden')
        reachable(data, '.mobile-toolbar [data-mobile-action="menu"]')
        reachable(data, '[data-mobile-role="move"]')
        reachable(data, '[data-mobile-role="aim"]')
      })

    stage = 'ai-workbench'
    await tap(page, '#btn-game-editor')
    await page.locator('#workbench').waitFor({ state: 'visible' })
    await tap(page, '.workbench-tools [data-panel="ai"]')
    await page.locator('#workbench-ai').waitFor({ state: 'visible' })
    await type(page, '#ai-prompt-input', `Verify mobile layout ${result.name}.`)
    await tap(page, '.ai-composer button[type="submit"]')
    await waitCommand(room, entry => entry.case === 'aiPrompt')
    await page.locator('.ai-turn-notice.kind-success').waitFor({ state: 'visible' })
    await page.waitForFunction(() => document.querySelector('.ai-runtime-status')?.dataset.state === 'idle', undefined, { timeout })
    await checkpoint(result, page, stage,
      ['#workbench', '.workbench-tools', '#workbench-close', '#workbench-ai', '.ai-heading', '.ai-feed',
        '.ai-composer', '#ai-prompt-input', '.ai-composer button[type="submit"]', '.game-header'], data => {
        shell(data, size)
        const workbench = fits(data, '#workbench'), pane = fits(data, '#workbench-ai')
        const tools = fits(data, '.workbench-tools'), heading = fits(data, '.ai-heading')
        const feed = fits(data, '.ai-feed'), composer = fits(data, '.ai-composer')
        within(pane, workbench, 'AI pane')
        within(feed, pane, 'AI feed')
        within(composer, pane, 'AI composer')
        assert.ok(feed.right <= composer.left + 1, 'AI feed and composer side by side')
        assert.ok(Math.min(feed.bottom, composer.bottom) - Math.max(feed.top, composer.top) >= 48,
          'AI columns have visible shared vertical space')
        assert.ok(tools.bottom <= heading.top + 1, 'AI header starts below workbench toolbar')
        assert.ok(heading.bottom <= Math.min(feed.top, composer.top) + 1, 'AI heading does not overlap columns')
        const back = reachable(data, '#workbench-close')
        within(back, tools, 'return control')
        reachable(data, '#ai-prompt-input')
        reachable(data, '.ai-composer button[type="submit"]')
        assert.match(one(data, '.ai-feed').text, /Layout fixture response|Verify mobile layout/, 'fixture AI text rendered')
        assert.equal(rooms.get(room).aiPrompts.length, 1, 'exactly one local AI request')
        assert.ok(one(data, '#workbench-close').centerHit, 'battle header cannot intercept return')
      })
    await tap(page, '#workbench-close')
    await page.locator('#workbench').waitFor({ state: 'hidden' })

    stage = 'options'
    await tap(page, '.mobile-toolbar [data-mobile-action="menu"]')
    await page.locator('#game-options').waitFor({ state: 'visible' })
    await checkpoint(result, page, 'options-inside',
      ['#game-options', '.game-options-panel', '#options-title', '#options-continue'], data => {
        fits(data, '#game-options')
        within(fits(data, '.game-options-panel'), viewport(data), 'options panel')
        reachable(data, '#options-continue')
      })
    await tap(page, '#options-title')
    assert.equal(await page.locator('#game-options').isVisible(), true, 'tap inside options keeps modal open')
    const backdrop = await page.locator('#game-options').evaluate(element => {
      const r = element.getBoundingClientRect()
      for (const x of [r.left + 3, r.right - 3, r.left + r.width / 2]) {
        for (const y of [r.top + 3, r.bottom - 3, r.top + r.height / 2]) {
          if (document.elementFromPoint(x, y) === element) return { x, y }
        }
      }
      return null
    })
    assert.ok(backdrop, 'options backdrop has a physically reachable sample')
    await page.touchscreen.tap(backdrop.x, backdrop.y)
    await page.locator('#game-options').waitFor({ state: 'hidden' })
    await checkpoint(result, page, 'options-backdrop',
      ['#game-options', '#game-stage', '.mobile-toolbar [data-mobile-action="menu"]'], data => {
        assert.equal(data.elements['#game-options'][0].visible, false, 'real backdrop tap closes options')
        reachable(data, '.mobile-toolbar [data-mobile-action="menu"]')
        assert.equal(commands.filter(entry => entry.room === room && entry.case === 'roomAction').length, 1,
          'inside/backdrop taps do not pause, finish or restart the match')
      })

    stage = 'settlement'
    event(room, 'matchEnd', EvMatchEndSchema, { scores: scoreRows(room) }, 660)
    event(room, 'roomState', EvRoomStateSchema, { state: 3, hostNick: nick, robotsOnline: 32 }, 660)
    await page.locator('.end-overlay').waitFor({ state: 'visible' })
    const settlementSelectors = ['.end-overlay', '.end-panel', '.end-header', '.end-summary', '.end-help',
      '.end-list', '.end-list > .score-row', '.end-footer', '.end-back', '.game-header']
    let pinned
    await checkpoint(result, page, stage, settlementSelectors, data => {
      shell(data, size)
      const panel = fits(data, '.end-panel'), header = fits(data, '.end-header')
      const summary = fits(data, '.end-summary'), help = fits(data, '.end-help')
      const list = fits(data, '.end-list'), footer = fits(data, '.end-footer')
      for (const [name, rect] of Object.entries({ header, summary, help, list, footer })) within(rect, panel, `settlement ${name}`)
      for (const [a, b] of [[header, summary], [summary, help], [help, list], [list, footer]]) {
        assert.ok(a.bottom <= b.top + 1, 'settlement sections do not overlap')
      }
      reachable(data, '.end-back')
      const listItem = one(data, '.end-list')
      assert.ok(listItem.scrollHeight > listItem.clientHeight + 100, 'fixture requires scrolling')
      const rows = data.elements['.end-list > .score-row']
      assert.equal(rows.length, 32, 'all authoritative score rows rendered')
      const fullyVisible = rows.filter(row => row.logical.top >= list.top - 1 && row.logical.bottom <= list.bottom + 1).length
      data.fullyVisibleRows = fullyVisible
      assert.ok(fullyVisible >= 3, `compact settlement shows at least three complete rows (${fullyVisible})`)
      assert.ok(list.height >= panel.height * .45, 'score list receives at least 45% of panel height')
      for (const row of rows.filter(row => row.logical.bottom > list.top && row.logical.top < list.bottom)) {
        assert.ok(row.logical.top >= header.bottom - 1, 'visible score row does not hit settlement header')
      }
      assert.equal(data.elements['.game-header'][0].visible, false, 'battle header hidden for settlement')
      pinned = { header, footer }
    })
    const scrollAreas = await page.locator('.end-overlay').evaluate(root =>
      [root, ...root.querySelectorAll('*')].filter(element => {
        const style = getComputedStyle(element)
        return element.checkVisibility({ checkVisibilityCSS: true }) &&
          /^(auto|scroll)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
      }).map(element => ({ tag: element.tagName, className: element.className })))
    if (diagnoseScroll) {
      result.scrollAncestors = await page.locator('.end-list').evaluate(element => {
        const ancestors = []
        for (let node = element; node; node = node.parentElement) {
          const style = getComputedStyle(node)
          ancestors.push({ tag: node.tagName, id: node.id, className: node.className,
            touchAction: style.touchAction, overflowX: style.overflowX, overflowY: style.overflowY,
            transform: style.transform, pointerEvents: style.pointerEvents,
            scrollHeight: node.scrollHeight, clientHeight: node.clientHeight })
        }
        return ancestors
      })
      result.scrollDiagnostics = []
      for (const axis of ['logical', 'physical-x-reverse', 'physical-y', 'physical-y-reverse']) {
        const trace = await tracePointers(page)
        const before = await page.locator('.end-list').evaluate(element => element.scrollTop)
        let error
        try { await swipeList(page, axis) } catch (failure) { error = String(failure) }
        await settleList(page)
        const after = await page.locator('.end-list').evaluate(element => element.scrollTop)
        const events = await trace.evaluate(value => { value.stop(); return value.events })
        await trace.dispose()
        result.scrollDiagnostics.push({ axis, before, after, error, events })
        console.log(`SCROLL ${result.name} ${axis}: ${before} -> ${after}${error ? ` (${error})` : ''}`)
        await writeReport()
      }
    }
    await swipeList(page)
    await settleList(page)
    await checkpoint(result, page, 'settlement-scroll', settlementSelectors, data => {
      assert.deepEqual(scrollAreas.map(area => area.className), ['end-list'], 'score list is the sole vertical scroll area')
      assert.ok(one(data, '.end-list').scrollTop > 8, 'trusted touch swipe scrolls the score list')
      assert.ok(pinned, 'initial settlement geometry available')
      for (const [name, selector] of [['header', '.end-header'], ['footer', '.end-footer']]) {
        const rect = fits(data, selector)
        for (const axis of ['left', 'top', 'right', 'bottom']) {
          assert.ok(Math.abs(rect[axis] - pinned[name][axis]) <= 1, `${name} stays pinned while list scrolls`)
        }
      }
      reachable(data, '.end-back')
    })
    stage = 'settlement-return'
    const returnTrace = await tracePointers(page)
    try {
      await tap(page, '.end-back')
      await page.locator('#view-room').waitFor({ state: 'visible' })
    } finally {
      result.returnTrace = await returnTrace.evaluate(value => { value.stop(); return value.events })
      await returnTrace.dispose()
      console.log(`RETURN ${result.name}: ${result.returnTrace.map(entry => entry.type).join(', ')}`)
    }
    result.returnedToLobby = true
    await checkpoint(result, page, stage, ['#view-room', '#btn-start'], data => {
      fits(data, '#view-room')
      reachable(data, '#btn-start')
      assert.match(one(data, '#btn-start').text, /开始下一局/, 'authoritative ended room state retained')
    })
    result.protocol = {
      joined: commands.filter(entry => entry.room === room && entry.case === 'join').length,
      battleStarts: rooms.get(room).battleStarts,
      aiPrompts: rooms.get(room).aiPrompts,
      commandCounts: Object.fromEntries([...new Set(commands.filter(entry => entry.room === room).map(entry => entry.case))]
        .map(kind => [kind, commands.filter(entry => entry.room === room && entry.case === kind).length])),
    }
  } catch (error) {
    const failure = { name: `${stage}-interaction`, ok: false, error: error.stack ?? String(error),
      screenshot: `${result.name}-failure.png` }
    result.checks.push(failure)
    console.error(`FAIL ${result.name} ${stage}: ${error.message}`)
    await page.screenshot({ path: resolve(artifacts, failure.screenshot) }).catch(() => {})
  } finally {
    releaseMain()
    result.screenshots = result.checks.map(check => check.screenshot).filter(Boolean)
    await context.close()
    result.ok = result.checks.every(check => check.ok) && result.errors.length === 0 && result.returnedToLobby === true
    await writeFile(resolve(artifacts, `${result.name}-report.json`), `${JSON.stringify(result, null, 2)}\n`)
    await writeReport()
  }
}

async function writeReport() {
  report.summary = {
    variants: report.variants.length,
    passedVariants: report.variants.filter(result => result.ok).length,
    checks: report.variants.reduce((sum, result) => sum + result.checks.length, 0),
    passedChecks: report.variants.reduce((sum, result) => sum + result.checks.filter(check => check.ok).length, 0),
    pageErrors: report.pageErrors.length,
    fixtureErrors: report.fixtureErrors.length,
    externalRequests: report.externalRequests.length,
  }
  await writeFile(resolve(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
}

await mkdir(artifacts, { recursive: true })
try {
  const html = await readFile(resolve(clientRoot, 'dist/index.html'), 'utf8')
  report.buildAssets = [...new Set(html.match(/\/assets\/[^"'\s<>]+/g) ?? [])]
  server = await preview({ configFile: false, root: clientRoot, logLevel: 'silent',
    preview: { host: '127.0.0.1', port: 0, strictPort: true } })
  const address = server.httpServer.address()
  assert.ok(address && typeof address !== 'string', 'Vite preview listening')
  sockets = new WebSocketServer({ server: server.httpServer, path: '/ws' })
  sockets.on('connection', connectFixture)
  sockets.on('error', error => report.fixtureErrors.push(String(error)))
  browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] })
  const baseURL = `http://127.0.0.1:${address.port}`
  for (const [index, size] of variants.entries()) await runVariant(size, index, baseURL)
} catch (error) {
  report.fatalError = error.stack ?? String(error)
  console.error(report.fatalError)
} finally {
  await browser?.close().catch(error => report.fixtureErrors.push(`Browser teardown: ${error}`))
  if (sockets) {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise(resolveClose => sockets.close(() => resolveClose()))
  }
  if (server?.httpServer.listening) {
    server.httpServer.closeAllConnections()
    await new Promise(resolveClose => server.httpServer.close(() => resolveClose()))
  }
  report.finishedAt = new Date().toISOString()
  await writeReport()
}
const ok = !report.fatalError && report.variants.length === variants.length &&
  report.variants.every(result => result.ok) && !report.pageErrors.length &&
  !report.fixtureErrors.length && !report.externalRequests.length
console.log(`${ok ? 'PASS' : 'FAIL'} mobile layout: ${JSON.stringify(report.summary)}`)
console.log(`Report: ${resolve(artifacts, 'report.json')}`)
if (!ok) process.exitCode = 1
