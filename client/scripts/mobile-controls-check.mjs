// Run from the repo: pnpm --filter client exec tsx scripts/mobile-controls-check.mjs
// Requires an already-built client/dist and server/omb.exe (or OMB_BINARY).
// OMB_PORT / OMB_E2E_PORT overrides the otherwise ephemeral loopback port;
// OMB_SHOTS overrides .artifacts/mobile-controls. This script never builds.
// OMB_MOBILE_EXPECT_COMPACT=1 requires actual compact snapshot delivery.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ClientMsgSchema, EvRoomState_State, ServerFrameDecoder, isBinarySnapshot } from '../../packages/protocol/src/index.ts'
import { startClient } from './startup-helpers.mjs'

const root = resolve(import.meta.dirname, '../..')
const binary = resolve(process.env.OMB_BINARY || join(root, 'server/omb.exe'))
const artifacts = resolve(process.env.OMB_SHOTS || join(root, '.artifacts/mobile-controls'))
const viewports = [
  { width: 667, height: 375 },
  { width: 844, height: 390 },
  { width: 932, height: 430 },
  { width: 1024, height: 768 },
]
const landscape = viewports[1]
const nonzeroSafeArea = { left: 47, right: 47, bottom: 21 }
const rightControls = ['aim', 'mode', 'dash', 'shield', 'interact']
const labels = { move: '\u79fb\u52a8\u6447\u6746', aim: '\u7784\u51c6\u6447\u6746' }
const modeNames = {
  single: /^\u5f00\u706b\u6a21\u5f0f\uff1a\u677e\u624b\u5355\u53d1/,
  hold: /^\u5f00\u706b\u6a21\u5f0f\uff1a\u6309\u4f4f\u8fde\u53d1/,
}
const actionNames = {
  mode: /\u5355\u53d1|\u8fde\u53d1|\u5f00\u706b\u6a21\u5f0f/,
  assist: /\u9a7e\u9a76\u8f85\u52a9/,
  chat: /\u53d1\u8a00|\u804a\u5929/,
  menu: /\u83dc\u5355|\u9009\u9879|\u8bbe\u7f6e/,
  scores: /\u8ba1\u5206|\u6392\u884c|\u6bd4\u5206/,
  upgrades: /\u5347\u7ea7/,
}
const errors = [], inputs = [], shots = [], results = [], checks = [], layouts = [], says = [], chatCommands = [], helpPanels = []
const robots = new Map()
const downstreamFrames = { protobuf: 0, compact: 0, batch: 0 }
let compactSnapshots = 0
let work, server, serverClosed, browser, page, touch, snapshot, self, bootstrap, roomState
let bootstrapEpoch = 0
let spawnError, interrupted, serverLog = '', stopping = false, currentCheck = 'setup'
let port, base, fullSnapshots = 0, pointerTrace = [], optionalApiTrace = [], lifecycleTrace = []
let failure

function healthy() {
  if (interrupted) throw interrupted
  if (spawnError) throw spawnError
  if (server && (server.exitCode !== null || server.signalCode !== null)) {
    throw new Error(`Server exited (${server.exitCode ?? server.signalCode}): ${serverLog.slice(-4000)}`)
  }
  assert.equal(errors.length, 0, `Browser/WS errors: ${errors.join('\n')}`)
}

async function until(predicate, label, timeout = 15000) {
  const end = Date.now() + timeout
  do {
    healthy()
    const value = await predicate()
    if (value) return value
    await delay(25)
  } while (Date.now() < end)
  throw new Error(`Timed out: ${label}; tick=${snapshot?.tick}, ack=${snapshot?.ackSeq}, ` +
    `self=${JSON.stringify(self)}, lastInput=${JSON.stringify(inputs.at(-1))}`)
}

async function freePort() {
  const requested = process.env.OMB_PORT || process.env.OMB_E2E_PORT
  if (requested) {
    const value = Number(requested)
    assert.ok(Number.isInteger(value) && value > 0 && value <= 65535, 'Invalid OMB_PORT / OMB_E2E_PORT')
    return value
  }
  const probe = createServer()
  await new Promise((accept, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', accept)
  })
  const value = probe.address().port
  await new Promise((accept, reject) => probe.close(error => error ? reject(error) : accept()))
  return value
}

// Observe the production connection, never replace WebSocket or inject inputs.
function observe(socket) {
  const decoder = new ServerFrameDecoder()
  socket.on('socketerror', error => { if (!stopping) errors.push(`WebSocket: ${error}`) })
  socket.on('close', () => { if (!stopping) errors.push(`Unexpected WebSocket close: ${socket.url()}`) })
  socket.on('framesent', ({ payload }) => {
    if (!Buffer.isBuffer(payload) || payload[0] !== 2) return
    try {
      const message = fromBinary(ClientMsgSchema, payload.subarray(1)).payload
      if (message.case === 'say') chatCommands.push(message.value)
      if (message.case !== 'input' && message.case !== 'warmupInput') return
      const input = message.value
      assert.ok(input.seq > (inputs.at(-1)?.seq ?? 0), 'Input seq must increase monotonically')
      inputs.push({ ...input, kind: message.case, observedAtTick: snapshot?.tick ?? 0,
        generationAtSend: self?.inputGeneration ?? bootstrap?.generation })
    } catch (error) { errors.push(`Decode upstream: ${error.stack ?? error}`) }
  })
  socket.on('framereceived', ({ payload }) => {
    if (!Buffer.isBuffer(payload) || ![3, 4, 5].includes(payload[0])) return
    try {
      const format = { 3: 'protobuf', 4: 'compact', 5: 'batch' }[payload[0]]
      downstreamFrames[format]++
      // Keep one decoder per real connection: compact state and batches must be
      // observed in wire order, including bootstrap resets and private generation.
      for (const decoded of decoder.decode(payload)) {
        const message = decoded.payload
        if (message.case === 'snapshot') {
          snapshot = message.value
          if (isBinarySnapshot(snapshot)) compactSnapshots++
          if (snapshot.full) { fullSnapshots++; robots.clear() }
          for (const robot of snapshot.robots) robots.set(robot.base.id, robot)
          for (const id of snapshot.robotGone) robots.delete(id)
          if (snapshot.self) self = snapshot.self
        } else if (message.case === 'event') {
          const { kind, tick } = message.value
          if (kind.case === 'mapBootstrap') { bootstrap = kind.value; bootstrapEpoch++ }
          if (kind.case === 'roomState') roomState = kind.value
          if (kind.case === 'shot') shots.push({ ...kind.value, tick, bootstrapEpoch })
          if (kind.case === 'singleShotResult') results.push({ ...kind.value, tick })
          if (kind.case === 'say') says.push({ ...kind.value, tick })
          if (kind.case === 'scriptError') errors.push(`Script error: ${JSON.stringify(kind.value)}`)
        }
      }
    } catch (error) { errors.push(`Decode downstream: ${error.stack ?? error}`) }
  })
}

const ownShots = () => shots.filter(shot => shot.owner === self?.robotId)
const tickRate = () => bootstrap?.tuning?.tickRate || 60
const neutral = input => input.moveX === 0 && input.moveY === 0 && !input.fire &&
  !input.dash && !input.shield && !input.interact && !input.singleShot
const mark = () => ({ input: inputs.length, shot: ownShots().length, result: results.length, tick: snapshot.tick })
const angleDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

async function ticks(count, label) {
  const target = snapshot.tick + count
  await until(() => snapshot.tick >= target, `${label} (server tick >= ${target})`)
}

async function chatReady() {
  const lastSay = says.findLast(event => event.robot === self?.robotId)
  if (!lastSay) return
  // Production chat shares the script say() cooldown: three simulation seconds.
  await until(() => snapshot.tick >= lastSay.tick + tickRate() * 3, 'authoritative chat cooldown elapsed')
}

async function inputSince(index, predicate, label) {
  return until(() => inputs.slice(index).find(predicate), label)
}

async function consumed(input, label) {
  await until(() => snapshot.ackSeq >= input.seq, `${label}: ack_seq >= ${input.seq}`)
  // The following snapshot also fences reliable events queued around the ack.
  await ticks(2, label)
}

async function expectNeutral(index, axes, label) {
  const input = await inputSince(index, value => neutral(value) && (value.axisMask & axes) === axes, `${label}: explicit neutral`)
  await consumed(input, label)
  return input
}

function noFireSince(start, label) {
  const frames = inputs.slice(start.input)
  assert.equal(frames.filter(input => input.fire || input.singleShot).length, 0, `${label}: leaked held/discrete fire`)
  assert.equal(ownShots().length, start.shot, `${label}: authoritative shot count changed`)
  assert.equal(results.length, start.result, `${label}: unexpected singleShotResult`)
}

async function quiet(start, label, requireNeutral = false) {
  // A full simulation second covers multiple weapon intervals, catching delayed
  // or duplicated fire without relying on rendering speed or arbitrary sleeps.
  await ticks(tickRate(), label)
  noFireSince(start, label)
  if (requireNeutral) assert.ok(inputs.slice(start.input).every(neutral), `${label}: stale held state rearmed`)
}

async function findControl(name) {
  const candidates = name === 'move' || name === 'aim'
    ? [page.locator(`[data-mobile-role="${name}"]`), page.getByLabel(new RegExp(labels[name]))]
    : ['dash', 'shield', 'interact'].includes(name)
      ? [page.locator(`[data-mobile-ability="${name}"]`)]
      : [page.locator(`[data-mobile-action="${name}"]`), page.getByRole('button', { name: actionNames[name] })]
  return until(async () => {
    for (const candidate of candidates) {
      for (const element of await candidate.all()) if (await element.isVisible()) return element
    }
    return false
  }, `visible mobile ${name}; build client/dist and check data-mobile-* selectors`)
}

async function boxOf(locator) {
  const box = await locator.boundingBox()
  assert.ok(box && box.width > 0 && box.height > 0, 'Control has no hit region')
  return box
}

const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })

async function geometry() {
  const move = await boxOf(await findControl('move'))
  const aim = await boxOf(await findControl('aim'))
  const moveOrigin = center(move), aimOrigin = center(aim)
  const radius = Math.min(aim.width, aim.height) / 2
  const rotated = await page.locator('html').evaluate(element => element.classList.contains('mobile-rotated'))
  // DOM boxes/CDP touch coordinates are physical. The whole body rotates 90deg
  // clockwise in portrait: logical (dx,dy) projects to physical (-dy,dx).
  const offset = (origin, dx, dy) => rotated
    ? { x: origin.x - dy, y: origin.y + dx }
    : { x: origin.x + dx, y: origin.y + dy }
  const aimX = radius * 0.72, aimY = radius * 0.25
  return {
    rotated,
    moveOrigin,
    moveOutside: offset(moveOrigin, -Math.min(70, (rotated ? move.height : move.width) * 0.3), 0),
    aimOrigin,
    aimOutside: offset(aimOrigin, aimX, aimY),
    aimAngle: Math.atan2(aimY, aimX),
  }
}

class Contacts {
  constructor(cdp) { this.cdp = cdp; this.points = new Map() }
  point(id, position) { return { id, x: position.x, y: position.y, radiusX: 4, radiusY: 4, force: 1 } }
  async down(id, position) {
    assert.ok(!this.points.has(id), `Contact ${id} already down`)
    this.points.set(id, this.point(id, position))
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [...this.points.values()] })
  }
  async move(id, position) {
    assert.ok(this.points.has(id), `Contact ${id} is not down`)
    this.points.set(id, this.point(id, position))
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [...this.points.values()] })
  }
  async up(id) {
    assert.ok(this.points.has(id), `Contact ${id} is not down`)
    // Chromium ends the named contacts, not the remaining contacts. Passing []
    // ends all. Including the left point here would lift the WRONG thumb.
    await this.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd', touchPoints: this.points.size === 1 ? [] : [this.points.get(id)],
    })
    this.points.delete(id)
  }
  async cancel() {
    if (!this.points.size) return
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    this.points.clear()
  }
  async tap(locator) {
    await this.down(33, center(await boxOf(locator)))
    await this.up(33)
  }
}

async function movingLeft(g) {
  const index = inputs.length
  await touch.down(11, g.moveOrigin)
  await touch.move(11, g.moveOutside)
  return inputSince(index, value => value.moveX < -100 && (value.axisMask & 1) === 1, 'left touch owns movement')
}

async function aiming(g, held = false, moving = false) {
  const index = inputs.length
  await touch.down(22, g.aimOrigin)
  await touch.move(22, g.aimOutside)
  const angle = g.aimAngle
  await inputSince(index, value => (value.axisMask & 6) === 6 && value.fire === held &&
    angleDistance(value.aim, angle) < 0.06 && (!moving || value.moveX < -100), 'independent right touch owns aim/fire')
  return angle
}

async function setMode(mode) {
  const control = await findControl('mode')
  assert.ok(modeNames[mode], `Unknown firing mode: ${mode}`)
  if (await control.getAttribute('data-mode') !== mode) await touch.tap(control)
  await modeSelected(mode)
}

async function modeSelected(mode) {
  const control = await findControl('mode')
  await until(async () => (await control.getAttribute('data-mode')) === mode &&
    (await control.getAttribute('aria-pressed')) === String(mode === 'hold') &&
    modeNames[mode].test(await control.getAttribute('aria-label') ?? ''), `icon firing mode and accessible selection: ${mode}`)
  assert.equal(await control.locator('.pixel-icon').count(), 1, 'Selected mode has a visible icon')
}

async function releaseShot(angle) {
  const start = mark()
  await touch.up(22)
  const frame = await inputSince(start.input, value => !!value.singleShot, 'normal release sends singleShot')
  assert.equal(frame.fire, false, 'Discrete release must not also hold fire')
  assert.equal(frame.axisMask & 6, 6, 'Discrete release owns aim and fire atomically')
  // Resync/life boundaries can refresh SelfState.inputGeneration without a new
  // map bootstrap. Compare with the generation observed when this frame left.
  assert.ok(frame.generationAtSend > 0, 'Release requires an advertised current generation')
  assert.equal(frame.singleShot.generation, frame.generationAtSend, 'Release uses current owner generation')
  assert.ok(frame.singleShot.observedTick > 0 && frame.singleShot.observedTick <= snapshot.tick, 'Release carries an observed simulation tick')
  assert.ok(angleDistance(frame.singleShot.aim, angle) < 0.06, 'Captured release direction is stick-relative')
  assert.ok(angleDistance(frame.aim, angle) < 0.06, 'Held snapshot agrees with captured release direction')
  const result = await until(() => results.slice(start.result).find(value => value.robot === self.robotId && value.seq === frame.seq), 'request-correlated terminal outcome')
  assert.equal(result.outcome, 'fired', `Authoritative shot rejected: ${JSON.stringify(result)}`)
  await until(() => ownShots().length > start.shot, 'authoritative self shot event')
  await consumed(frame, 'single-shot release')
  await ticks(tickRate(), 'no duplicate or delayed release shot')
  assert.equal(inputs.slice(start.input).filter(value => value.singleShot).length, 1, 'One release sends exactly one discrete intent')
  assert.ok(inputs.slice(start.input).every(value => !value.fire), 'No boolean-pulse fallback')
  assert.equal(results.length - start.result, 1, 'One terminal outcome per release')
  assert.equal(ownShots().length - start.shot, 1, 'One release creates exactly one authoritative projectile')
  assert.ok(angleDistance(ownShots().at(-1).heading, angle) < 0.06, 'Authoritative projectile keeps the release heading')
  const expectedMove = touch.points.has(11)
  assert.ok(inputs.at(-1) && (expectedMove ? inputs.at(-1).moveX < -100 : inputs.at(-1).moveX === 0), 'Right release preserves independent left state')
}

async function readyWeapon() {
  await until(() => {
    const robot = robots.get(self?.robotId)
    return robot && !robot.dead && !robot.shieldOn && snapshot.tick >= (self.fireReadyTick ?? 0) &&
      robot.energyX10 >= (bootstrap.tuning?.fireCost ?? 5) * 10
  }, 'authoritative weapon ready')
}

async function freshContactFires() {
  await readyWeapon()
  const g = await geometry()
  const angle = await aiming(g)
  await releaseShot(angle)
}

async function screenshot(name) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(accept => requestAnimationFrame(() => requestAnimationFrame(accept)))
  })
  await page.screenshot({ path: join(artifacts, `${name}.png`) })
}

async function skillFeedback() {
  await until(async () => {
    for (const [ability, id] of [['dash', 'dash'], ['shield', 'shield'], ['interact', 'uplink']]) {
      const source = page.locator(`#skill-${id}`), target = await findControl(ability)
      const reason = (await source.locator('.skill-cd').textContent()) ?? ''
      const state = await source.getAttribute('data-state')
      if (state !== (await target.getAttribute('data-state'))) return false
      if ((await source.getAttribute('data-takeover')) !== (await target.getAttribute('data-takeover'))) return false
      if (!(await target.getAttribute('aria-label') ?? '').includes(reason)) return false
      const visual = target.locator('.mobile-ability-status')
      const numeric = ['cooling', 'active'].includes(state) && /\d/.test(reason)
      if ((await visual.textContent()) !== (numeric ? reason : '')) return false
      assert.equal(await visual.getAttribute('aria-hidden'), 'true', `${ability}: compact feedback must not replace the full accessible reason`)
      assert.equal(await target.locator('.pixel-icon').count(), 1, `${ability}: icon remains visible`)
      assert.equal(await target.getAttribute('aria-disabled'), String(state === 'off' || state === 'cooling'),
        `${ability}: accessible availability mirrors authoritative state`)
      if (state === 'off' || state === 'active') {
        assert.ok(await target.evaluate(element => {
          const glyph = getComputedStyle(element, '::after')
          return glyph.content !== 'none' && parseFloat(glyph.width) > 0 && parseFloat(glyph.height) > 0
        }), `${ability}: nonnumeric state has a painted glyph`)
      }
      assert.equal(await target.getAttribute('disabled'), null, `${ability}: unavailable styling must not disable pointer release`)
    }
    return true
  }, 'mobile skill state/full aria reason and compact visual feedback mirror authoritative HUD')
}

async function reachable(locator, label) {
  const box = await boxOf(locator), viewport = page.viewportSize()
  assert.ok(box.width >= 44 && box.height >= 44,
    `${label}: target ${box.width}x${box.height} is smaller than 44 CSS px`)
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height, `${label}: target outside viewport`)
  assert.ok(await locator.evaluate(element => {
    const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return element === hit || element.contains(hit)
  }), `${label}: target obscured`)
}

async function check(name, run) {
  currentCheck = name
  const started = Date.now(), start = mark()
  await run()
  healthy()
  if (process.env.OMB_MOBILE_EXPECT_COMPACT === '1') {
    assert.ok(compactSnapshots > 0, 'Expected decoded compact snapshots, not legacy-only evidence')
  }
  checks.push({ name, elapsedMs: Date.now() - started, fromTick: start.tick, toTick: snapshot.tick,
    inputs: inputs.length - start.input, shots: ownShots().length - start.shot, outcomes: results.length - start.result })
  console.log(`PASS: ${name}`)
}

async function sampledHits(control, circular = false) {
  return control.evaluate((element, circle) => {
    const box = element.getBoundingClientRect(), samples = []
    for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98]) {
      for (const fy of [0.02, 0.25, 0.5, 0.75, 0.98]) {
        // Test the circular stick's painted hit area, not its transparent corners.
        if (circle && Math.hypot((fx - 0.5) * 2, (fy - 0.5) * 2) > 0.95) continue
        const x = box.x + box.width * fx, y = box.y + box.height * fy
        const hit = document.elementFromPoint(x, y)
        const target = hit?.closest('[data-mobile-role], [data-mobile-action], [data-mobile-ability]')
        samples.push({ x, y, owned: hit === element || element.contains(hit),
          hit: target?.getAttribute('data-mobile-role') ?? target?.getAttribute('data-mobile-action') ??
            target?.getAttribute('data-mobile-ability') ?? hit?.id ?? hit?.tagName ?? null })
      }
    }
    return samples
  }, circular)
}

async function mobileHelp(viewport, safeArea = { left: 0, right: 0, bottom: 0 }, suffix = '') {
  assert.equal(touch.points.size, 0, 'Help reachability requires a fresh primary touch')
  const menu = await findControl('menu'), options = page.locator('#game-options')
  const dialog = options.locator('.game-options-panel'), disclosure = options.locator('details.mobile-help')
  const summary = disclosure.locator('summary'), panel = disclosure.locator('p')
  await reachable(menu, 'mobile menu for Help')
  await touch.tap(menu)
  await options.waitFor({ state: 'visible', timeout: 5000 })
  assert.equal(await options.getAttribute('aria-modal'), 'true', 'Help lives in the real options dialog')
  const record = { viewport, safeArea }
  helpPanels.push(record)
  try {
    await summary.scrollIntoViewIfNeeded()
    await reachable(summary, 'touch Help disclosure')
    assert.match(await summary.textContent() ?? '', /\u89e6\u63a7.*\u5e2e\u52a9/, 'Localized touch Help summary')
    assert.equal(await disclosure.evaluate(element => element.open), false, 'Help starts collapsed')
    await touch.tap(summary)
    await until(() => disclosure.evaluate(element => element.open), 'native touch Help disclosure opens')
    await panel.waitFor({ state: 'visible', timeout: 5000 })
    await panel.scrollIntoViewIfNeeded()
    const box = await boxOf(panel), stage = await boxOf(page.locator('#game-stage'))
    record.bounds = box
    record.stage = stage
    record.dialog = await boxOf(dialog)
    assert.ok(box.width > 200, `Mobile Help has readable content width; actual=${box.width}`)
    const left = Math.max(stage.x, 0) + safeArea.left + 8
    const right = Math.min(stage.x + stage.width, viewport.width) - safeArea.right - 8
    const bottom = Math.min(stage.y + stage.height, viewport.height) - safeArea.bottom - 8
    assert.ok(box.x >= left - 0.5 && box.y >= Math.max(stage.y, 0) + 8 - 0.5 &&
      box.x + box.width <= right + 0.5 && box.y + box.height <= bottom + 0.5,
    `Mobile Help must fit stage/safe-area; bounds=${JSON.stringify(box)}, safeArea=${JSON.stringify(safeArea)}`)
    const text = await panel.innerText()
    record.text = text
    assert.match(text, /\u5de6\u6447\u6746.*\u53f3\u6447\u6746/s, 'Mobile Help explains both thumbsticks')
    assert.match(text, /\u677e\u624b\u5355\u53d1/, 'Mobile Help explains release-to-fire')
    assert.match(text, /\u4e2d\u5fc3.*\u53d6\u6d88/, 'Mobile Help explains center cancellation')
    assert.ok(!/\b(?:WASD|LMB|RMB|SHIFT|SPACE|ENTER|ESC)\b|\u9f20\u6807|E\/F|1-5/i.test(text),
      'Mobile Help must not use desktop keyboard/mouse shortcuts as touch instructions')
    record.metrics = await panel.evaluate(element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect()
      const clipLeft = box.left + element.clientLeft, clipRight = clipLeft + element.clientWidth
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), lines = []
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(walker.currentNode)
        for (const rect of range.getClientRects()) {
          lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
        }
      }
      return { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight),
        overflowY: style.overflowY, touchAction: style.touchAction,
        horizontallyClippedLines: lines.filter(line => line.left < clipLeft - 1 || line.right > clipRight + 1),
        lines: lines.length }
    })
    const metrics = record.metrics
    assert.ok(metrics.fontSize >= 11 && metrics.lineHeight >= metrics.fontSize * 1.4, 'Mobile Help text has readable font size and line spacing')
    assert.ok(metrics.clientHeight >= metrics.lineHeight * 2, 'Mobile Help displays multiple readable lines')
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1 && metrics.horizontallyClippedLines.length === 0,
      'Mobile Help text wraps without horizontal clipping')
    assert.ok(['auto', 'scroll'].includes(metrics.overflowY), 'Help overflow must remain scrollable, not hidden/clipped')
    assert.notEqual(metrics.touchAction, 'none', 'Help text must retain native touch scrolling')
    assert.ok(await panel.evaluate(element => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).touchAction === 'none') return false
      }
      return true
    }), 'Help ancestors must preserve native touch scrolling')
    record.hitTests = await sampledHits(panel)
    assert.ok(record.hitTests.every(sample => sample.owned), 'Help body must be hit-testable, not covered by HUD or ancestor clipping')
    if (metrics.scrollHeight > metrics.clientHeight + 1) {
      const finger = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.8 }
      await touch.down(44, finger)
      for (const fraction of [0.65, 0.5, 0.35, 0.2]) {
        await touch.move(44, { x: finger.x, y: box.y + box.height * fraction })
      }
      await touch.up(44)
      record.scrollTop = await until(() => panel.evaluate(element => element.scrollTop || false), 'Help body scrolls after a real touch swipe', 5000)
    } else record.scrollTop = 0 // All production text fits; do not manufacture test overflow.
    // The options dialog may overflow even when the help copy itself fits.
    // Verify its real scroll container rather than injecting extra fixture text.
    const dialogMetrics = await dialog.evaluate(element => ({ scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY, touchAction: getComputedStyle(element).touchAction }))
    record.dialogMetrics = dialogMetrics
    assert.ok(['auto', 'scroll'].includes(dialogMetrics.overflowY), 'Options containing Help remain natively scrollable')
    assert.notEqual(dialogMetrics.touchAction, 'none', 'Options retain native touch scrolling')
    if (dialogMetrics.scrollTop > 5) {
      const rect = await boxOf(dialog)
      const finger = { x: rect.x + 8, y: rect.y + rect.height * 0.2 }
      await touch.down(44, finger)
      for (const fraction of [0.35, 0.5, 0.65, 0.8]) {
        await touch.move(44, { x: finger.x, y: rect.y + rect.height * fraction })
      }
      await touch.up(44)
      record.dialogScrollTop = await until(async () => {
        const top = await dialog.evaluate(element => element.scrollTop)
        return top < dialogMetrics.scrollTop - 2 ? { top } : false
      }, 'options containing Help scroll after a real touch swipe', 5000)
    }
    await panel.scrollIntoViewIfNeeded()
    await screenshot(`help-${viewport.width}x${viewport.height}${suffix}`)
    await summary.scrollIntoViewIfNeeded()
    await reachable(summary, 'touch Help collapse')
    await touch.tap(summary)
    await panel.waitFor({ state: 'hidden', timeout: 5000 })
    assert.equal(await disclosure.evaluate(element => element.open), false, 'Native Help disclosure collapses')
    const close = page.locator('#options-continue')
    await close.scrollIntoViewIfNeeded()
    await reachable(close, 'options Continue after Help')
    await touch.tap(close)
    await options.waitFor({ state: 'hidden', timeout: 5000 })
  } finally {
    await touch.cancel()
    if (await options.isVisible()) await page.keyboard.press('Escape')
  }
}

async function layout(viewport, { safeArea = { left: 0, right: 0, bottom: 0 }, suffix = '' } = {}) {
  await page.setViewportSize(viewport)
  await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, viewport)
  await ticks(4, 'layout/geometry update')
  const boxes = []
  const record = { viewport, safeArea, boxes }
  layouts.push(record)
  for (const name of ['move', 'aim', 'dash', 'shield', 'interact', ...Object.keys(actionNames)]) {
    const control = await findControl(name), box = await boxOf(control)
    const hitTests = await sampledHits(control, name === 'aim')
    boxes.push({ name, ...box, hitTests })
    assert.ok(box.width >= 44 && box.height >= 44, `${name}: touch target smaller than 44 CSS px`)
    const insets = name === 'move' || rightControls.includes(name) ? safeArea : { left: 0, right: 0, bottom: 0 }
    assert.ok(box.x >= insets.left + 8 && box.y >= 8 &&
      box.x + box.width <= viewport.width - insets.right - 8 &&
      box.y + box.height <= viewport.height - insets.bottom - 8,
    `${name}: target touches viewport/safe-area edge; bounds=${JSON.stringify(box)}, insets=${JSON.stringify(insets)}`)
    const missed = hitTests.filter(sample => !sample.owned)
    assert.equal(missed.length, 0, `${name}: sampled hit regions are obscured: ${JSON.stringify(missed)}`)
  }
  for (let i = 0; i < boxes.length; i++) {
    for (const b of boxes.slice(i + 1)) {
      const a = boxes[i]
      const gapX = Math.max(a.x - b.x - b.width, b.x - a.x - a.width)
      const gapY = Math.max(a.y - b.y - b.height, b.y - a.y - a.height)
      assert.ok(Math.hypot(Math.max(0, gapX), Math.max(0, gapY)) >= 8 - 0.5,
        `${viewport.width}x${viewport.height}${suffix}: ${a.name}/${b.name} overlap or have <8px separation; ` +
        `bounds=${JSON.stringify({ a: { x: a.x, y: a.y, width: a.width, height: a.height },
          b: { x: b.x, y: b.y, width: b.width, height: b.height } })}`)
    }
  }
  const move = boxes.find(box => box.name === 'move'), aim = boxes.find(box => box.name === 'aim')
  assert.ok(move.width >= aim.width && move.height >= aim.height, 'Move activation bounds must contain the whole floating stick')
  for (const name of ['move', 'aim']) {
    assert.match(await (await findControl(name)).getAttribute('aria-label') ?? '', new RegExp(labels[name]), `${name}: localized accessible name`)
    assert.equal(await (await findControl(name)).evaluate(element => getComputedStyle(element).touchAction), 'none', `${name}: touch-action must suppress battle scrolling`)
  }
  const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content')
  assert.ok(!/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(?:\D|$)/i.test(viewportMeta ?? ''), 'Do not disable document zoom globally')
  for (const selector of ['#btn-game-help', '#btn-game-replay', '#game-stage #audio-settings', '[data-mobile-action="fullscreen"]']) {
    for (const control of await page.locator(selector).all()) {
      assert.equal(await control.isVisible(), false, `${selector}: removed mobile toolbar action must not occupy the battlefield`)
    }
  }
  await screenshot(`layout-${viewport.width}x${viewport.height}${suffix}`)
  writeFileSync(join(artifacts, `layout-${viewport.width}x${viewport.height}${suffix}.json`), JSON.stringify(record, null, 2))
}

async function safeAreaLayout() {
  assert.equal(touch.points.size, 0, 'Safe-area geometry changes require no active contacts')
  const viewport = viewports[0], suffix = '-safe-l47-r47-b21'
  await page.setViewportSize(viewport)
  await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, viewport)
  const baseline = { move: await boxOf(await findControl('move')), aim: await boxOf(await findControl('aim')) }
  // Override only the production safe-area seams. Do not replace env() with a
  // test-only stylesheet: an unconsumed seam must fail, not silently fake a pass.
  const previous = await page.evaluate(insets => {
    const roots = [
      { selector: 'html', prefix: '--app-safe-' },
      { selector: '#game-stage', prefix: '--mobile-safe-' },
      { selector: '.mobile-controls', prefix: '--mobile-safe-' },
    ]
    return roots.map(({ selector, prefix }) => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) throw new Error('Missing mobile safe-area root')
      const properties = Object.entries(insets).map(([edge, value]) => {
        const property = `${prefix}${edge}`
        const old = { property, value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) }
        element.style.setProperty(property, `${value}px`)
        return old
      })
      return { selector, properties }
    })
  }, nonzeroSafeArea)
  try {
    // Safe-area overrides describe the next viewport, not a runtime settings
    // change. Use a real resize so cached pointer geometry refreshes as on-device.
    await page.setViewportSize(landscape)
    await layout(viewport, { safeArea: nonzeroSafeArea, suffix })
    const move = await boxOf(await findControl('move')), aim = await boxOf(await findControl('aim'))
    assert.ok(Math.abs(move.x - baseline.move.x - nonzeroSafeArea.left) <= 1,
      'Production layout must consume --mobile-safe-left (47 CSS px)')
    assert.ok(Math.abs(aim.x - baseline.aim.x + nonzeroSafeArea.right) <= 1,
      'Production layout must consume --mobile-safe-right (47 CSS px)')
    assert.ok(Math.abs(aim.y - baseline.aim.y + nonzeroSafeArea.bottom) <= 1,
      'Production layout must consume --mobile-safe-bottom (21 CSS px)')
    await mobileHelp(viewport, nonzeroSafeArea, suffix)
    const start = mark(), g = await geometry()
    await movingLeft(g)
    await aiming(g, false, true)
    await screenshot(`two-thumb${suffix}`)
    const index = inputs.length
    await touch.cancel()
    await expectNeutral(index, 7, 'nonzero safe-area gesture cancellation')
    await quiet(start, 'nonzero safe-area two-thumb aim never fires before release')
  } catch (error) {
    await page.screenshot({ path: join(artifacts, `layout-667x375${suffix}-failure.png`), timeout: 5000 }).catch(() => {})
    throw error
  } finally {
    await touch.cancel()
    await page.evaluate(roots => {
      for (const { selector, properties } of roots) {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) continue
        for (const { property, value, priority } of properties) {
          if (value) element.style.setProperty(property, value, priority)
          else element.style.removeProperty(property)
        }
      }
    }, previous)
  }
}

async function staleContactsStayNeutral(g, label, { freshShot = true } = {}) {
  const start = mark()
  const downs = await page.evaluate(() => window.__mobileCheckPointers.filter(event => event.type === 'pointerdown').length)
  await touch.move(11, g.moveOutside)
  await touch.move(22, g.aimOutside)
  await ticks(12, `${label}: old contacts after recovery`)
  assert.equal(await page.evaluate(() => window.__mobileCheckPointers.filter(event => event.type === 'pointerdown').length), downs,
    `${label}: CDP must move existing contacts, not manufacture new pointerdowns`)
  await quiet(start, label, true)
  await touch.up(22)
  await touch.up(11)
  await quiet(start, `${label}: stale release`, true)
  if (freshShot) await freshContactFires()
}

const onInterrupt = signal => { interrupted = new Error(`Interrupted: ${signal}`) }
const onSigint = () => onInterrupt('SIGINT'), onSigterm = () => onInterrupt('SIGTERM')
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)

try {
  mkdirSync(artifacts, { recursive: true })
  assert.ok(existsSync(binary), `Build server first; missing OMB_BINARY: ${binary}`)
  assert.ok(existsSync(join(root, 'client/dist/index.html')), 'Build client/dist first; this check does not build production artifacts')
  port = await freePort()
  base = `http://127.0.0.1:${port}`
  work = mkdtempSync(join(tmpdir(), 'omb-mobile-controls-'))
  server = spawn(binary, ['-addr', `127.0.0.1:${port}`], {
    cwd: work, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OMB_CONFIG_DIR: root, OMB_MANUAL_DIR: join(root, 'docs/manual'),
      OMB_WEB_DIR: join(root, 'client/dist'), AUTH_ENABLED: 'false', AI_ENABLED: 'false' },
  })
  serverClosed = new Promise(accept => server.once('close', accept))
  server.on('error', error => { spawnError = error })
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { serverLog = (serverLog + data).slice(-64000) })
  await until(() => fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false), 'real server /healthz')
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: landscape, deviceScaleFactor: 2, hasTouch: true, isMobile: true })
  page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.stack ?? String(error)))
  page.on('websocket', observe)
  await page.addInitScript(() => {
    window.__mobileCheckPointers = []
    window.__mobileCheckOptionalApis = []
    window.__mobileCheckLifecycle = []
    for (const type of ['blur', 'focus', 'visibilitychange']) {
      const target = type === 'visibilitychange' ? document : window
      target.addEventListener(type, event => window.__mobileCheckLifecycle.push({ type,
        trusted: event.isTrusted, focused: document.hasFocus(), visibility: document.visibilityState }))
    }
    // Exercise the supported denied/unsupported enhancement path. Letting a
    // headless fullscreen request resize the stage mid-gesture tests Chromium's
    // window manager instead of the two-thumb interaction being verified here.
    for (const [target, method] of [[Element.prototype, 'requestFullscreen'],
      [window.ScreenOrientation?.prototype, 'lock']]) {
      if (!target || typeof target[method] !== 'function') continue
      Object.defineProperty(target, method, { configurable: true, value: async () => {
        window.__mobileCheckOptionalApis.push(method)
        throw new DOMException('Denied for mobile fallback verification', 'NotAllowedError')
      } })
    }
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click', 'mousedown']) {
      document.addEventListener(type, event => {
        const target = event.target instanceof Element ? event.target : null
        const record = { type, id: event.pointerId, pointerType: event.pointerType,
          primary: event.isPrimary, trusted: event.isTrusted, x: event.clientX, y: event.clientY,
          target: target?.tagName, targetId: target?.id,
          action: target?.closest('[data-mobile-action]')?.getAttribute('data-mobile-action'),
          chatButton: target?.closest('#game-chat button')?.getAttribute('type'), detail: event.detail,
          prevented: event.defaultPrevented }
        window.__mobileCheckPointers.push(record)
        queueMicrotask(() => { record.prevented = event.defaultPrevented })
      }, true)
    }
  })
  touch = new Contacts(await context.newCDPSession(page))
  await page.goto(base)
  await startClient(page)
  await page.fill('#in-room', 'MOBILE')
  await page.fill('#in-nick', 'mobile-check')
  await page.click('#btn-join')
  await page.locator('#view-room').waitFor({ state: 'visible' })
  await until(() => page.locator('#room-state').textContent().then(text => text.includes('mobile-check')), 'room joined as host')
  await page.click('#btn-warmup')
  await page.locator('#view-game').waitFor({ state: 'visible' })
  await until(() => fullSnapshots > 0 && self?.robotId && bootstrap, 'bootstrap and full warmup self snapshot')
  assert.equal(bootstrap.discreteShotSupported, true, 'Real server lacks discrete-shot capability; rebuild server/omb.exe (no boolean fallback)')
  assert.ok(bootstrap.generation > 0, 'Real server must advertise a current input generation')
  assert.notEqual(self.assistOn, true, 'Fresh isolated room must not have script-driven fire')
  await page.locator('#game-canvas').focus()
  await findControl('aim')
  await modeSelected('single')

  for (const viewport of viewports) await check(`layout ${viewport.width}x${viewport.height}`, () => layout(viewport))
  await check('menu options Help disclosure is readable, scrollable and touch-closeable at all landscape sizes', async () => {
    const start = mark()
    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      await ticks(4, 'Help viewport geometry')
      await mobileHelp(viewport)
    }
    await quiet(start, 'Help interaction must not fire')
  })
  await check('nonzero safe-area 667x375: left/right 47px, bottom 21px', safeAreaLayout)
  await page.setViewportSize(landscape)
  await ticks(4, 'restore main geometry')

  await check('two real contacts: move + single-shot aim; release fires once', async () => {
    await readyWeapon()
    const start = mark(), g = await geometry()
    const traceStart = await page.evaluate(() => window.__mobileCheckPointers.length)
    await movingLeft(g)
    const angle = await aiming(g, false, true)
    const downs = await page.evaluate(index => window.__mobileCheckPointers.slice(index).filter(event => event.type === 'pointerdown'), traceStart)
    assert.equal(downs.length, 2, 'Exactly two contact downs')
    assert.equal(new Set(downs.map(event => event.id)).size, 2, 'Separate pointer owner IDs')
    assert.ok(downs.every(event => event.trusted && event.pointerType === 'touch'), 'Use real Chromium touch, not synthetic DOM PointerEvents')
    assert.equal(downs[0].primary, true)
    assert.equal(downs[1].primary, false, 'The non-primary second thumb must control aim')
    await until(() => (self.manualAxesMask & 7) === 7 && self.moveSrc === 1 && self.turretSrc === 1 && self.fireSrc === 1, 'server confirms human move/aim/fire ownership')
    await quiet(start, 'single-shot drag')
    await screenshot('two-thumb-aim')
    await releaseShot(angle)
    const index = inputs.length
    await touch.up(11)
    await expectNeutral(index, 7, 'left release')
  })

  await check('center tap / return-to-center / pointercancel never fire', async () => {
    const g = await geometry()
    let start = mark()
    await touch.down(22, g.aimOrigin)
    await touch.up(22)
    await quiet(start, 'center tap')
    start = mark()
    await aiming(g)
    await touch.move(22, g.aimOrigin)
    await touch.up(22)
    await quiet(start, 'center release')
    start = mark()
    await movingLeft(g)
    await aiming(g, false, true)
    const index = inputs.length
    await touch.cancel()
    await expectNeutral(index, 7, 'CDP touchCancel')
    await quiet(start, 'pointer cancellation')
  })

  await check('continuous fire: hold only; center/release stop without a one-shot', async () => {
    let start = mark()
    await setMode('hold')
    await quiet(start, 'mode toggle alone')
    await readyWeapon()
    const g = await geometry()
    start = mark()
    await movingLeft(g)
    await aiming(g, true, true)
    await until(() => ownShots().length >= start.shot + 2, 'held fire creates multiple authoritative shots')
    let index = inputs.length
    await touch.move(22, g.aimOrigin)
    let stopped = await inputSince(index, value => !value.fire && !value.singleShot && value.moveX < -100, 'continuous center stops held fire but not movement')
    await consumed(stopped, 'continuous center stop')
    await quiet(mark(), 'continuous dead zone')
    index = inputs.length
    const count = ownShots().length
    await touch.move(22, g.aimOutside)
    await inputSince(index, value => value.fire && value.moveX < -100, 'same continuous gesture resumes outside center')
    await until(() => ownShots().length > count, 'continuous fire resumes authoritatively')
    index = inputs.length
    await touch.up(22)
    stopped = await inputSince(index, value => !value.fire && !value.singleShot && value.moveX < -100, 'continuous release stops held fire')
    await consumed(stopped, 'continuous release stop')
    await quiet(mark(), 'no extra shot after acknowledged continuous release')
    assert.equal(inputs.slice(start.input).filter(value => value.singleShot).length, 0, 'Continuous gestures never submit discrete shots')
    index = inputs.length
    await touch.up(11)
    await expectNeutral(index, 7, 'continuous left release')
    await setMode('single')
  })

  await check('aiming crossing skill buttons keeps firing ownership', async () => {
    const g = await geometry()
    await readyWeapon()
    await movingLeft(g)
    await aiming(g, false, true)
    const dash = await findControl('dash'), shield = await findControl('shield')
    let index = inputs.length
    await touch.move(22, center(await boxOf(dash)))
    await inputSince(index, value => !value.dash && !value.fire && !value.singleShot && value.moveX < -100 &&
      (value.axisMask & 6) === 6, 'crossing dash keeps captured aim/fire axes')
    await skillFeedback()
    await dash.focus()
    index = inputs.length
    await touch.move(22, g.aimOutside)
    await inputSince(index, value => !value.dash && !value.fire && value.moveX < -100 && (value.axisMask & 6) === 6,
      'battle-button focus and crossing back retain aim ownership')
    index = inputs.length
    await touch.move(22, center(await boxOf(shield)))
    await inputSince(index, value => !value.dash && !value.shield && !value.fire && value.moveX < -100 && (value.axisMask & 6) === 6,
      'crossing shield does not switch ability')
    await screenshot('aim-crosses-skills')
    const shieldCenter = center(await boxOf(shield))
    await releaseShot(Math.atan2(shieldCenter.y - g.aimOrigin.y, shieldCenter.x - g.aimOrigin.x))
    await quiet(mark(), 'aim crossing/release')
    index = inputs.length
    await touch.up(11)
    await expectNeutral(index, 7, 'aim crossing movement neutral')
  })

  await check('direct dash acquires the right role and releases without firing', async () => {
    const start = mark(), g = await geometry()
    await movingLeft(g)
    let index = inputs.length
    await touch.down(22, center(await boxOf(await findControl('dash'))))
    await inputSince(index, value => value.dash && value.moveX < -100 && !value.fire &&
      !value.singleShot && (value.axisMask & 8) !== 0, 'direct ability down preserves left movement')
    index = inputs.length
    await touch.up(22)
    await inputSince(index, value => !value.dash && value.moveX < -100 && !value.fire, 'direct ability up clears hold')
    index = inputs.length
    await touch.up(11)
    await expectNeutral(index, 9, 'direct ability stop')
    await quiet(start, 'direct ability cannot fire')
  })

  await check('mode switch cancels current right owner, not the left thumb', async () => {
    const start = mark(), g = await geometry()
    await movingLeft(g)
    await aiming(g, false, true)
    await touch.tap(await findControl('mode'))
    await modeSelected('hold')
    const index = inputs.length
    await touch.move(22, g.aimOrigin)
    await touch.move(22, g.aimOutside)
    await inputSince(index, value => value.moveX < -100 && !value.fire && !value.singleShot, 'old right contact cannot rearm continuous fire')
    await touch.up(22)
    await quiet(start, 'mode-switch cancellation')
    const releaseIndex = inputs.length
    await touch.up(11)
    await expectNeutral(releaseIndex, 7, 'mode-switch left release')
    await setMode('single')
  })

  await check('portrait rotation cancels both gestures; old contacts stay neutral with controls visible', async () => {
    const start = mark(), g = await geometry()
    await movingLeft(g)
    await aiming(g, false, true)
    const index = inputs.length
    await page.setViewportSize({ width: 375, height: 667 })
    await page.waitForFunction(() => innerWidth === 375 && innerHeight === 667 &&
      document.documentElement.classList.contains('mobile-rotated'), null, { timeout: 5000 })
    assert.ok(await page.locator('body').evaluate(element => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
      return Math.abs(matrix.a) < 0.001 && Math.abs(matrix.b - 1) < 0.001 &&
        Math.abs(matrix.c + 1) < 0.001 && Math.abs(matrix.d) < 0.001
    }), 'Portrait fallback rotates the actual body 90deg clockwise')
    await expectNeutral(index, 7, 'portrait entry')
    for (const name of ['move', 'aim', 'mode', 'dash', 'shield', 'interact']) {
      const control = await findControl(name)
      await reachable(control, `rotated portrait ${name}`)
      const hitTests = await sampledHits(control, name === 'aim')
      assert.ok(hitTests.every(sample => sample.owned), `rotated portrait ${name}: touch region obscured`)
    }
    for (const gate of await page.locator('[data-mobile-gate], .mobile-portrait, .mobile-rotate').all()) {
      assert.equal(await gate.isVisible(), false, 'Portrait remains playable without a rotate-device gate')
    }
    await quiet(start, 'portrait transition cancels without release-to-fire')
    await screenshot('portrait-rotated-375x667')
    await staleContactsStayNeutral(await geometry(), 'rotated portrait old-contact recovery', { freshShot: false })
  })

  await check('fresh portrait two-thumb drag maps logical left/aim and creates one authoritative shot', async () => {
    await readyWeapon()
    const start = mark(), g = await geometry()
    assert.equal(g.rotated, true, 'Fresh portrait contacts exercise the rotated surface')
    assert.ok(Math.abs(g.moveOutside.x - g.moveOrigin.x) < 0.001 && g.moveOutside.y < g.moveOrigin.y,
      'Logical left must project to physical UP in clockwise portrait rotation')
    const physicalAngle = Math.atan2(g.aimOutside.y - g.aimOrigin.y, g.aimOutside.x - g.aimOrigin.x)
    assert.ok(Math.abs(angleDistance(physicalAngle, g.aimAngle) - Math.PI / 2) < 0.001,
      'Portrait fixture distinguishes physical aim from logical world heading')
    const traceStart = await page.evaluate(() => window.__mobileCheckPointers.length)
    const movement = await movingLeft(g)
    assert.ok(Math.abs(movement.moveY) <= 5, 'Physical UP produces logical -X movement without a -Y leak')
    const angle = await aiming(g, false, true)
    const downs = await page.evaluate(index => window.__mobileCheckPointers.slice(index).filter(event => event.type === 'pointerdown'), traceStart)
    assert.equal(downs.length, 2, 'Portrait shot uses exactly two fresh thumb contacts')
    assert.equal(new Set(downs.map(event => event.id)).size, 2, 'Portrait thumb roles have independent IDs')
    assert.ok(downs.every(event => event.trusted && event.pointerType === 'touch'), 'Portrait uses trusted Chromium touch')
    assert.equal(downs[0].primary, true)
    assert.equal(downs[1].primary, false, 'Portrait aim accepts the non-primary second thumb')
    await quiet(start, 'fresh portrait aiming does not fire before release')
    await screenshot('portrait-two-thumb-aim')
    await releaseShot(angle)
    const index = inputs.length
    await touch.up(11)
    await expectNeutral(index, 7, 'portrait left release after authoritative shot')
  })

  await check('returning to landscape cancels portrait contacts and requires fresh gestures', async () => {
    const start = mark(), g = await geometry()
    await movingLeft(g)
    await aiming(g, false, true)
    const index = inputs.length
    await page.setViewportSize(landscape)
    await page.waitForFunction(() => innerWidth > innerHeight &&
      !document.documentElement.classList.contains('mobile-rotated'), null, { timeout: 5000 })
    await findControl('aim')
    await expectNeutral(index, 7, 'return to landscape')
    await quiet(start, 'landscape transition cannot fire old portrait contacts')
    await screenshot('portrait-return-landscape')
    await staleContactsStayNeutral(await geometry(), 'portrait-to-landscape recovery')
  })

  await check('real browser blur cancels without release-to-fire', async () => {
    // Headless tabs can all remain visible/focused after bringToFront. Minimize
    // the actual Chromium window instead, with focus emulation disabled: this
    // emits a trusted blur and changes document.hasFocus(), without DOM mocks.
    await touch.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    const { windowId } = await touch.cdp.send('Browser.getWindowForTarget')
    try {
      await page.bringToFront()
      await page.waitForFunction(() => document.hasFocus() && !document.hidden, null, { timeout: 5000 })
      const start = mark(), g = await geometry()
      const lifecycleStart = await page.evaluate(() => window.__mobileCheckLifecycle.length)
      await movingLeft(g)
      await aiming(g, false, true)
      const index = inputs.length
      await touch.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
      await page.waitForFunction(() => !document.hasFocus(), null, { polling: 50, timeout: 5000 })
      assert.ok(await page.evaluate(index => window.__mobileCheckLifecycle.slice(index)
        .some(event => event.type === 'blur' && event.trusted && !event.focused), lifecycleStart), 'Window minimization must emit a trusted blur')
      await expectNeutral(index, 7, 'real window blur')
      await quiet(start, 'blur cancellation')
      await touch.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await page.bringToFront()
      await page.waitForFunction(() => document.hasFocus() && !document.hidden, null, { timeout: 5000 })
      await staleContactsStayNeutral(await geometry(), 'focus recovery')
    } finally {
      await touch.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await touch.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    }
  })

  await check('real menu modal cancels both thumbs and stale releases', async () => {
    const start = mark(), g = await geometry()
    await movingLeft(g)
    await aiming(g, false, true)
    const index = inputs.length
    const menu = await findControl('menu')
    await reachable(menu, 'touch menu')
    await touch.tap(menu)
    await page.locator('#game-options[aria-modal="true"]').waitFor({ state: 'visible', timeout: 5000 })
    await expectNeutral(index, 7, 'modal entry')
    await quiet(start, 'modal cancellation')
    await screenshot('menu-modal')
    await page.keyboard.press('Escape')
    await page.locator('#game-options').waitFor({ state: 'hidden' })
    await staleContactsStayNeutral(await geometry(), 'modal recovery')
  })

  await check('chat entry cancels held touches; typing never becomes battle input', async () => {
    const start = mark(), g = await geometry()
    await movingLeft(g)
    await aiming(g, false, true)
    const index = inputs.length
    await touch.tap(await findControl('chat'))
    await page.locator('#game-chat').waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForFunction(() => document.activeElement?.id === 'game-chat-input')
    await expectNeutral(index, 7, 'text-entry focus')
    await page.keyboard.type('wasd mobile check')
    await quiet(start, 'chat typing cancellation')
    await screenshot('chat-panel')
    await page.keyboard.press('Escape')
    await page.locator('#game-chat').waitFor({ state: 'hidden' })
    await staleContactsStayNeutral(await geometry(), 'chat recovery')
  })

  await check('keyboard Tab to chat Cancel then Enter never sends a message', async () => {
    const start = mark(), commandCount = chatCommands.length, sayCount = says.length
    await touch.tap(await findControl('chat'))
    await page.locator('#game-chat').waitFor({ state: 'visible', timeout: 5000 })
    await page.fill('#game-chat-input', 'must not send on Cancel Enter')
    await page.keyboard.press('Tab')
    await page.waitForFunction(() => document.activeElement?.matches('#game-chat button[type="submit"]'), null, { timeout: 5000 })
    await page.keyboard.press('Tab')
    await page.waitForFunction(() => document.activeElement?.id === 'game-chat-cancel', null, { timeout: 5000 })
    await screenshot('chat-keyboard-cancel-focused')
    const traceStart = await page.evaluate(() => window.__mobileCheckPointers.length)
    await page.keyboard.press('Enter')
    await page.locator('#game-chat').waitFor({ state: 'hidden', timeout: 5000 })
    assert.ok(await page.evaluate(index => window.__mobileCheckPointers.slice(index).some(event =>
      event.type === 'click' && event.trusted && event.detail === 0 && event.targetId === 'game-chat-cancel'), traceStart),
    'Enter on Cancel must produce native trusted keyboard activation')
    await quiet(start, 'keyboard chat Cancel must not fire', true)
    assert.equal(chatCommands.length, commandCount, 'Enter on focused Cancel must not submit a say command')
    assert.equal(says.length, sayCount, 'Server must not echo chat from keyboard Cancel')
    assert.equal(await page.locator('#game-chat').isVisible(), false, 'Cancel Enter must not reopen chat through the global shortcut')
  })

  await check('keyboard Tab to chat Send then Enter sends exactly one real message', async () => {
    await chatReady()
    const start = mark(), commandCount = chatCommands.length, sayCount = says.length
    const message = 'mobile native Enter send check'
    await touch.tap(await findControl('chat'))
    await page.locator('#game-chat').waitFor({ state: 'visible', timeout: 5000 })
    await page.fill('#game-chat-input', message)
    await page.keyboard.press('Tab')
    await page.waitForFunction(() => document.activeElement?.matches('#game-chat button[type="submit"]'), null, { timeout: 5000 })
    await screenshot('chat-keyboard-send-focused')
    const traceStart = await page.evaluate(() => window.__mobileCheckPointers.length)
    await page.keyboard.press('Enter')
    await page.locator('#game-chat').waitFor({ state: 'hidden', timeout: 5000 })
    assert.ok(await page.evaluate(index => window.__mobileCheckPointers.slice(index).some(event =>
      event.type === 'click' && event.trusted && event.detail === 0 && event.chatButton === 'submit'), traceStart),
    'Enter on Send must produce native trusted keyboard activation, not the text-input shortcut')
    await until(() => says.slice(sayCount).some(event => event.robot === self.robotId && event.text === message),
      'server confirms native Enter Send')
    await quiet(start, 'native Enter Send must not fire', true)
    assert.equal(chatCommands.length - commandCount, 1, 'Native Enter Send emits exactly one say command')
    assert.equal(chatCommands.at(-1).text, message, 'Native Enter Send preserves the draft')
    assert.equal(says.slice(sayCount).filter(event => event.robot === self.robotId && event.text === message).length, 1,
      'Server confirms exactly one chat event from native Enter Send')
    assert.equal(await page.locator('#game-chat').isVisible(), false, 'Send Enter must not reopen chat through the global shortcut')
  })

  await check('touch chat Cancel/Send buttons are reachable at every landscape size', async () => {
    await chatReady()
    const start = mark(), commandCount = chatCommands.length, sayCount = says.length
    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      await ticks(4, 'chat viewport geometry')
      await touch.tap(await findControl('chat'))
      await page.locator('#game-chat').waitFor({ state: 'visible', timeout: 5000 })
      const send = page.locator('#game-chat button[type="submit"]'), cancel = page.locator('#game-chat-cancel')
      await reachable(send, 'chat Send')
      await reachable(cancel, 'chat Cancel')
      await page.fill('#game-chat-input', 'wasd cancelled')
      await screenshot(`chat-${viewport.width}x${viewport.height}`)
      await touch.tap(cancel)
      await page.locator('#game-chat').waitFor({ state: 'hidden' })
      assert.equal(chatCommands.length, commandCount, 'Touch Cancel must not send chat')
    }
    await touch.tap(await findControl('chat'))
    await page.locator('#game-chat').waitFor({ state: 'visible' })
    const message = 'mobile touch send check'
    await page.fill('#game-chat-input', message)
    await touch.tap(page.locator('#game-chat button[type="submit"]'))
    await until(() => chatCommands.length > commandCount, 'touch Send emits real say command')
    await until(() => says.slice(sayCount).some(value => value.robot === self.robotId && value.text === message), 'server confirms touch chat')
    await page.locator('#game-chat').waitFor({ state: 'hidden' })
    assert.equal(chatCommands.length - commandCount, 1, 'Touch Send emits exactly one chat command')
    await quiet(start, 'touch chat buttons do not fire')
    await skillFeedback()
  })

  await check('touch host start replaces warmup; old fingers cannot fire in Running', async () => {
    const start = mark(), g = await geometry()
    const previous = { bootstrap, fullSnapshots, robotId: self.robotId, generation: self.inputGeneration }
    await movingLeft(g)
    await aiming(g, false, true)
    const button = page.locator('#btn-game-start')
    await reachable(button, 'touch host Start')
    await touch.tap(button)
    await until(() => roomState?.state === EvRoomState_State.R_RUNNING &&
      bootstrap !== previous.bootstrap && fullSnapshots > previous.fullSnapshots &&
      self.inputGeneration !== previous.generation && snapshot.timeLeftS < 600,
    'formal bootstrap, fresh owner generation and full snapshot')
    assert.equal(self.robotId, previous.robotId, 'Host identity survives Warmup to Running')
    assert.equal(bootstrap.discreteShotSupported, true, 'Running advertises discrete-shot support')
    assert.equal(await button.isVisible(), false, 'Running hides the warmup Start action')
    await screenshot('running-landscape')
    await quiet(start, 'match replacement cancels old move/aim contacts')
    await staleContactsStayNeutral(await geometry(), 'Running bootstrap recovery')
    assert.equal(inputs.findLast(input => input.singleShot)?.kind, 'input',
      'Running release uses the formal input path')
  })

  await check('touch host pause/resume stays reachable and requires fresh contacts', async () => {
    const start = mark(), g = await geometry()
    await movingLeft(g)
    await aiming(g, false, true)
    const index = inputs.length
    await touch.tap(await findControl('menu'))
    await page.locator('#game-options').waitFor({ state: 'visible' })
    await expectNeutral(index, 7, 'pause menu entry')
    const pause = page.locator('#options-pause')
    await reachable(pause, 'touch host Pause')
    await touch.tap(pause)
    await until(() => roomState?.paused, 'authoritative host pause')
    await page.locator('#game-paused').waitFor({ state: 'visible' })
    assert.match(await page.locator('#game-paused-note').innerText(), /\u83dc\u5355/,
      'Touch pause instructions explain the reachable menu')
    await touch.tap(page.locator('#options-continue'))
    await page.locator('#game-options').waitFor({ state: 'hidden' })
    await screenshot('running-paused')
    const menu = await findControl('menu')
    await reachable(menu, 'touch menu while paused')
    await touch.tap(menu)
    await page.locator('#game-options').waitFor({ state: 'visible' })
    await reachable(pause, 'touch host Resume')
    await touch.tap(pause)
    await until(() => roomState?.paused === false, 'authoritative host resume')
    await page.locator('#game-paused').waitFor({ state: 'hidden' })
    await touch.tap(page.locator('#options-continue'))
    await page.locator('#game-options').waitFor({ state: 'hidden' })
    await quiet(start, 'pause/resume does not release-to-fire')
    await staleContactsStayNeutral(await geometry(), 'pause/resume recovery')
  })

  healthy()
  // Projectile IDs may restart when the authoritative match is replaced.
  assert.equal(new Set(ownShots().map(shot => `${shot.bootstrapEpoch}:${shot.projectile}`)).size,
    ownShots().length, 'Authoritative shot events must not be counted twice within a match')
  console.log(`MOBILE CONTROLS OK: ${checks.length} checks; ${ownShots().length} authoritative shots; artifacts: ${artifacts}`)
} catch (error) {
  process.exitCode = 1
  failure = String(error.stack ?? error)
  console.error(`FAIL: ${currentCheck}\n${failure}`)
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(artifacts, 'failure.png'), timeout: 5000 }).catch(() => {})
  }
} finally {
  stopping = true
  if (page && !page.isClosed()) {
    pointerTrace = await page.evaluate(() => window.__mobileCheckPointers ?? []).catch(() => [])
    optionalApiTrace = await page.evaluate(() => window.__mobileCheckOptionalApis ?? []).catch(() => [])
    lifecycleTrace = await page.evaluate(() => window.__mobileCheckLifecycle ?? []).catch(() => [])
  }
  await touch?.cancel().catch(() => {})
  await browser?.close().catch(error => { process.exitCode = 1; console.error(`Browser cleanup: ${error}`) })
  if (server) {
    const killDeadline = setTimeout(() => server.kill('SIGKILL'), 5000)
    try {
      if (server.exitCode === null && server.signalCode === null) server.kill()
      await serverClosed
    } finally { clearTimeout(killDeadline) }
  }
  if (work) {
    // Only delete the exact mkdtemp child of the OS temp directory, after the
    // server has exited (Windows otherwise retains open data/log files).
    assert.ok(resolve(work).startsWith(resolve(tmpdir()) + '\\') || resolve(work).startsWith(resolve(tmpdir()) + '/'))
    try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    catch (error) { process.exitCode = 1; console.error(`Temp cleanup ${work}: ${error}`) }
  }
  if (existsSync(artifacts)) {
    writeFileSync(join(artifacts, 'server.log'), serverLog)
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify({
      ok: process.exitCode !== 1, currentCheck, failure, binary, base, viewports, layouts, helpPanels, checks, errors, bootstrap: bootstrap && {
        generation: bootstrap.generation, discreteShotSupported: bootstrap.discreteShotSupported,
      }, snapshot: snapshot && { tick: snapshot.tick, ackSeq: snapshot.ackSeq }, self,
      ownShots: ownShots(), results, downstreamFrames, compactSnapshots, discreteInputs: inputs.filter(input => input.singleShot),
      recentInputs: inputs.slice(-120), pointers: pointerTrace,
      rejectedOptionalApis: optionalApiTrace, lifecycle: lifecycleTrace, chatCommands, says,
      limitations: [
        'Chromium emulation only; no Android Chrome/iPhone Safari hardware certification.',
        'Trusted window blur is verified, not OS app backgrounding or hidden-document lifecycle.',
        'Native safe-area insets are zero; the nonzero case overrides production --mobile-safe-* variables, not physical notch geometry.',
        'Menu/chat entry during held sticks uses an extra trusted contact; modal recovery uses Escape while old contacts remain down.',
        'Fullscreen/orientation-lock rejection is intentional; portrait verifies the whole-body CSS rotation fallback with trusted two-thumb input.',
      ],
    }, null, 2))
  }
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
}
