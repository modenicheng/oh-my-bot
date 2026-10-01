import { startClient } from './startup-helpers.mjs'
import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema, ClientMsgSchema } from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const work = mkdtempSync(join(tmpdir(), 'omb-reconnect-'))
const binary = resolve(process.env.OMB_BINARY || '../server/omb.exe')
const base = 'http://127.0.0.1:18422'
let server, browser
const delay = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await delay(40) }
  throw new Error(`Timed out: ${label}`)
}
async function startServer() {
  server = spawn(binary, ['-addr', '127.0.0.1:18422'], { cwd: work, stdio: 'ignore' })
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'server start')
}
async function stopServer() {
  if (!server || server.exitCode !== null) return
  const exited = new Promise(r => server.once('exit', r))
  server.kill()
  await exited
}
try {
  await startServer()
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  // Keep the native transport; retain its handle only to force a real socket close.
  await context.addInitScript(() => {
    const Native = window.WebSocket
    window.__sockets = []
    window.__socketClosures = []
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args)
        window.__sockets.push(this)
        this.addEventListener('close', event => window.__socketClosures.push({ code: event.code, reason: event.reason }))
      }
    }
  })
  const page = await context.newPage()
  const errors = [], robots = new Map(), inputs = []
  let latest, activeTransport, fullCount = 0, connections = 0, bootstraps = 0
  page.on('pageerror', e => errors.push(String(e)))
  page.on('websocket', ws => {
    connections++
    const transport = { closed: false, lastSelf: null }
    activeTransport = transport
    ws.on('close', () => { transport.closed = true })
    ws.on('framereceived', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
      const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'snapshot') {
        latest = msg.payload.value
        if (latest.full) { robots.clear(); fullCount++ }
        for (const r of latest.robots) robots.set(r.base.id, r)
        for (const id of latest.robotGone) robots.delete(id)
        const robot = robots.get(latest.self?.robotId)
        if (robot?.base?.pos) transport.lastSelf = { tick: latest.tick, pos: { ...robot.base.pos } }
      } else if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'mapBootstrap') {
        bootstraps++; robots.clear()
      }
    })
    ws.on('framesent', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 2) return
      const msg = fromBinary(ClientMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'input') inputs.push(msg.payload.value)
    })
  })
  await page.goto(base)
  await startClient(page)
  await page.fill('#in-room', 'RECON')
  await page.fill('#in-nick', 'driver')
  await page.click('#btn-join')
  await page.locator('#btn-warmup').waitFor({ state: 'visible' })
  await page.click('#btn-warmup')
  await until(() => latest?.self && robots.has(latest.self.robotId), 'first full state')
  const id = latest.self.robotId
  assert.equal(latest.self.assistOn, false, 'assist must start disabled')
  const self = () => robots.get(id)
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  await page.locator('#game-canvas').click({ position: { x: 600, y: 300 } })
  await page.keyboard.press('Space')
  await until(() => latest.self.assistOn === true, 'confirmed assist toggle')
  const beforeMove = { ...self().base.pos }
  await page.keyboard.down('s')
  await until(() => distance(self().base.pos, beforeMove) > 0.3, 'movement before disconnection')
  const interruptedTransport = activeTransport
  const oldTick = latest.tick, oldFull = fullCount
  const oldConnections = connections, oldBootstrap = bootstraps, oldInputSeq = inputs.at(-1)?.seq
  // Finish the native closing handshake before blocking network traffic.
  // Offline Chromium can leave a graceful close in CLOSING until its timeout.
  await page.evaluate(() => window.__sockets.at(-1).close(4001, 'network test'))
  await until(() => interruptedTransport.closed, 'old transport closed').catch(async error => {
    const native = await page.evaluate(() => ({ states: window.__sockets.map(socket => socket.readyState), closures: window.__socketClosures, online: navigator.onLine }))
    throw new Error(`${error.message}: ${JSON.stringify({ native, oldTick, lastTick: interruptedTransport.lastSelf?.tick, connections })}`)
  })
  await context.setOffline(true)
  await page.keyboard.up('s')
  await page.locator('#connection-notice').waitFor({ state: 'visible' })
  assert.ok(interruptedTransport.lastSelf, 'old transport supplied a self snapshot')
  // setOffline/close are asynchronous. Anchor to the last old-transport frame,
  // not a sample taken before those browser operations while movement was valid.
  const beforeDrop = interruptedTransport.lastSelf.pos
  await delay(850)
  assert.equal(connections, oldConnections, 'offline must suspend retries')
  assert.equal(await page.locator('#view-game').isVisible(), true, 'keep frozen game during retry')
  assert.match(await page.locator('#connection-text').innerText(), /离线/)
  await context.setOffline(false)
  await until(() => fullCount > oldFull && bootstraps > oldBootstrap, 'reconnected bootstrap + full snapshot')
  await page.locator('#connection-notice').waitFor({ state: 'hidden' })
  assert.equal(latest.self.robotId, id, 'automatic rejoin preserves identity')
  assert.equal(latest.self.assistOn, true, 'rejoin preserves confirmed assist state')
  assert.ok(latest.tick > oldTick, 'simulation clock continues')
  assert.ok(distance(self().base.pos, beforeDrop) < 1, `server must release held movement on disconnect: ${JSON.stringify({ beforeDrop, afterReconnect: self().base.pos, displacement: distance(self().base.pos, beforeDrop), oldTick, dropTick: interruptedTransport.lastSelf.tick, tick: latest.tick, recentInputs: inputs.slice(-4) })}`)
  const afterRestore = { ...self().base.pos }
  await delay(250)
  assert.ok(distance(self().base.pos, afterRestore) < 0.1, 'do not replay held inputs after recovery')
  await page.keyboard.down('w')
  await until(() => distance(self().base.pos, afterRestore) > 0.3, 'new input after recovery')
  await page.keyboard.up('w')
  assert.ok(inputs.at(-1).seq > oldInputSeq, 'new input sequence exceeds server acknowledgement')
  // A server restart has no in-memory match. Recover honestly to the same room's lobby.
  await stopServer()
  await page.locator('#connection-notice').waitFor({ state: 'visible' })
  await startServer()
  await page.locator('#view-room').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('#btn-warmup').waitFor({ state: 'visible' })
  await page.locator('#connection-notice').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('#view-game').isHidden(), true, 'restart must discard stale game')
  // Cancel must invalidate both online listeners and scheduled retries.
  const cancelledTransport = activeTransport
  await page.evaluate(() => window.__sockets.at(-1).close(4001, 'cancel test'))
  await until(() => cancelledTransport.closed, 'cancel transport closed')
  await context.setOffline(true)
  await page.locator('#connection-notice').waitFor({ state: 'visible' })
  await page.click('#connection-cancel')
  const cancelledConnections = connections
  await context.setOffline(false)
  await delay(900)
  assert.equal(connections, cancelledConnections, 'cancel must prevent online-triggered reconnect')
  assert.equal(await page.locator('#view-join').isVisible(), true)
  assert.equal(await page.locator('#connection-notice').isHidden(), true)
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(JSON.stringify({ passed: true, id, connections, fullCount, bootstraps, checks: ['offline pause', 'input release', 'identity + assist restore', 'sequence recovery', 'server restart', 'cancel'] }))
} finally {
  await browser?.close()
  await stopServer()
  rmSync(work, { recursive: true, force: true })
}
