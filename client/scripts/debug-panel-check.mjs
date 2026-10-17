import { chromium } from 'playwright'
import { preview } from 'vite'
import { WebSocketServer } from 'ws'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { ClientMsgSchema, ServerMsgSchema, ServerEventSchema, EvRoomStateSchema, EvTickTelemetrySchema } from '../../packages/protocol/src/index.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const artifacts = resolve(import.meta.dirname, '../../.artifacts/debug-panel')
mkdirSync(artifacts, { recursive: true })
const server = await preview({ configFile: false, root: resolve(import.meta.dirname, '..'), logLevel: 'silent',
  preview: { host: '127.0.0.1', port: 18439, strictPort: true } })
const sockets = new WebSocketServer({ server: server.httpServer, path: '/ws' })
sockets.on('connection', socket => {
  socket.on('message', data => {
    const bytes = Buffer.from(data)
    if (bytes[0] === 0) {
      setTimeout(() => { if (socket.readyState === 1) socket.send(Buffer.from([1])) }, 30)
      return
    }
    if (bytes[0] !== 2) return
    const command = fromBinary(ClientMsgSchema, bytes.subarray(1)).payload
    if (command.case !== 'join') return
    const value = create(EvRoomStateSchema, { state: 0, hostNick: 'debug-test', robotsOnline: 1 })
    const event = create(ServerEventSchema, { kind: { case: 'roomState', value } })
    const message = create(ServerMsgSchema, { payload: { case: 'event', value: event } })
    socket.send(Buffer.concat([Buffer.from([3]), toBinary(ServerMsgSchema, message)]))
    const telemetry = create(EvTickTelemetrySchema, {
      tick: 60, tickAvgMs: 3.25, tickP95Ms: 8.5, windowTicks: 60,
      scriptDeferrals: 4n, tickRate: 60, frameBudgetMs: 12, warmup: false,
    })
    const telemetryEvent = create(ServerEventSchema, { tick: 60, kind: { case: 'tickTelemetry', value: telemetry } })
    const telemetryMessage = create(ServerMsgSchema, { payload: { case: 'event', value: telemetryEvent } })
    socket.send(Buffer.concat([Buffer.from([3]), toBinary(ServerMsgSchema, telemetryMessage)]))
  })
})
let browser
try {
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(() => {
    const stats = window.__debugCheck = { draws: 0, durations: [], rows: {}, layoutReads: 0, mutations: 0 }
    const isDebug = ctx => ctx.canvas.parentElement?.id === 'debug-panel'
    const fillRect = CanvasRenderingContext2D.prototype.fillRect
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
      if (isDebug(this) && x === 0 && y === 0 && h === 372) {
        stats.draws++
        stats.rows = {}
        const started = performance.now()
        queueMicrotask(() => stats.durations.push(performance.now() - started))
      }
      return fillRect.call(this, x, y, w, h)
    }
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (isDebug(this) && Number.isFinite(args[2]) && Math.abs((args[2] - 12) % 50) < 0.01) {
        const row = Math.round((args[2] - 12) / 50)
        ;(stats.rows[row] ??= []).push(args[0])
      }
      return fillText.apply(this, args)
    }
    const bounds = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLCanvasElement && this.parentElement?.id === 'debug-panel') stats.layoutReads++
      return bounds.call(this)
    }
  })
  await page.goto('http://127.0.0.1:18439')
  await page.locator('#startup[data-state="ready"]').waitFor({ timeout: 20_000 })
  await page.keyboard.press('Enter')
  await page.locator('#startup').waitFor({ state: 'hidden' })
  const panel = page.locator('#debug-panel')
  assert.equal(await panel.isVisible(), false)
  assert.equal(await panel.locator('canvas').count(), 1)
  await page.locator('#in-room').fill('DBG001')
  await page.locator('#in-nick').fill('debug-test')
  await page.keyboard.press('F3')
  await panel.waitFor({ state: 'visible' })
  assert.equal(await page.locator('#in-nick').evaluate(element => element === document.activeElement), true)
  const box = await panel.boundingBox()
  assert.ok(box.x >= 0 && box.x <= 10 && box.y >= 0 && box.y <= 10)
  assert.ok(box.width <= 340 && box.height < 450, 'compact panel in the top-left corner')
  await page.locator('#btn-join').click()
  await page.waitForFunction(() => window.__debugCheck.rows[4]?.some(text => text === '1 个'))
  await page.waitForFunction(() => window.__debugCheck.rows[5]?.some(text => /\d+(\.\d+)? ms/.test(text)), undefined, { timeout: 10_000 })
  await page.waitForFunction(() => window.__debugCheck.rows[6]?.some(text => text.includes('avg 3.3 ms')) &&
    window.__debugCheck.rows[6]?.some(text => text.includes('p95 8.5 ms')), undefined, { timeout: 10_000 })
  assert.equal(await page.locator('#view-room').isVisible(), true, 'application remains usable outside the panel')
  assert.ok(await page.evaluate(() => window.__debugCheck.rows[2].some(text => text.includes('B/s'))),
    'small heartbeat payloads use readable byte units')
  await page.screenshot({ path: resolve(artifacts, 'desktop.png') })

  // Fill the full 30-second window before measuring steady-state canvas cost.
  // This also exercises the real wrapping path instead of only a nearly empty graph.
  await page.waitForTimeout(30_500)
  await page.evaluate(() => {
    const stats = window.__debugCheck
    stats.draws = 0
    stats.layoutReads = 0
    stats.durations = []
    window.__debugObserver = new MutationObserver(records => { stats.mutations += records.length })
    window.__debugObserver.observe(document.querySelector('#debug-panel'), { subtree: true, childList: true,
      attributes: true, characterData: true })
  })
  await page.waitForTimeout(1500)
  const steady = await page.evaluate(() => {
    window.__debugObserver.disconnect()
    const { draws, durations, layoutReads, mutations } = window.__debugCheck
    const sorted = durations.toSorted((a, b) => a - b)
    return { draws, layoutReads, mutations,
      meanDrawMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
      p95DrawMs: sorted[Math.floor(sorted.length * .95)] }
  })
  assert.ok(steady.draws >= 3 && steady.draws <= 7, 'charts refresh at most four times per second')
  assert.equal(steady.mutations, 0, 'steady-state rendering does not mutate DOM or canvas attributes')
  assert.equal(steady.layoutReads, 0, 'steady-state rendering does not synchronously measure layout')
  await page.screenshot({ path: resolve(artifacts, 'full-history.png') })
  await page.keyboard.press('Shift+F3')
  assert.equal(await panel.isVisible(), true)
  await page.keyboard.press('F3')
  await panel.waitFor({ state: 'hidden' })
  const hiddenDraws = await page.evaluate(() => window.__debugCheck.draws)
  await page.waitForTimeout(600)
  assert.equal(await page.evaluate(() => window.__debugCheck.draws), hiddenDraws, 'hidden panel does no canvas drawing')
  await page.keyboard.down('F3')
  await page.keyboard.down('F3')
  await page.keyboard.up('F3')
  assert.equal(await panel.isVisible(), true, 'repeated keydowns do not retoggle the panel')

  await page.evaluate(() => Object.defineProperty(performance, 'memory', { configurable: true, value: undefined }))
  await page.waitForFunction(() => window.__debugCheck.rows[1]?.includes('不可用'))
  await page.setViewportSize({ width: 320, height: 280 })
  await page.waitForTimeout(350)
  const small = await panel.boundingBox()
  assert.ok(small.x + small.width <= 320 && small.y + small.height <= 280, 'small viewport bounds the scrollable panel')
  await page.screenshot({ path: resolve(artifacts, 'small.png') })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByRole('button', { name: '关闭调试面板' }).click()
  assert.equal(await panel.isVisible(), false)
  await page.keyboard.press('F3')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  const pausedDraws = await page.evaluate(() => window.__debugCheck.draws)
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(() => window.__debugCheck.draws), pausedDraws, 'pagehide cancels the frame loop')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')))
  await page.waitForFunction(() => window.__debugCheck.rows[4]?.includes('0 个'))
  await page.waitForFunction(() => window.__debugCheck.rows[5]?.includes('不可用'))
  assert.deepEqual(errors, [])
  console.log('Steady-state full-history canvas:', JSON.stringify(steady))
  console.log('PASS: F3/focus/repeat; one compact canvas; real WS traffic and RTT; 30s wrapping; zero steady-state DOM writes/layout reads; no hidden drawing; missing heap; small viewport; pagehide/pageshow cleanup')
} finally {
  await browser?.close()
  for (const socket of sockets.clients) socket.terminate()
  await new Promise(resolve => sockets.close(resolve))
  await new Promise(resolve => server.httpServer.close(resolve))
}
