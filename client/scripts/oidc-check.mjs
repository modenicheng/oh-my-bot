import { startClient } from './startup-helpers.mjs'
import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema, ClientMsgSchema } from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const issuer = process.env.OMB_TEST_OIDC_ISSUER || 'http://127.0.0.1:18080/realms/omb-test'
const username = process.env.OMB_TEST_OIDC_USERNAME || 'modenicheng'
const password = process.env.OMB_TEST_OIDC_PASSWORD || 'local-oidc-test-password'
const authEnabled = process.env.OMB_TEST_AUTH_ENABLED !== 'false'
const shotPrefix = authEnabled ? 'oidc' : 'no-auth'
const work = mkdtempSync(join(tmpdir(), 'omb-oidc-'))
const shots = resolve(import.meta.dirname, '../../.artifacts/oidc')
mkdirSync(shots, { recursive: true })
const base = 'http://127.0.0.1:18430'
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', '127.0.0.1:18430'], {
  cwd: work, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, OMB_CONFIG_DIR: work, OMB_WEB_DIR: resolve(import.meta.dirname, '../dist'),
    AUTH_ENABLED: String(authEnabled), AUTH_ISSUER: issuer, AUTH_CLIENT_ID: 'omb',
    AUTH_REDIRECT_URL: `${base}/auth/callback`, AUTH_BYPASS_PROXY: 'true',
    OIDC_CLIENT_SECRET: process.env.OMB_TEST_OIDC_CLIENT_SECRET || 'local-oidc-test-secret',
    OMB_AUTH_SECRET: 'local-oidc-test-hmac-secret-32-bytes',
  },
})
const errors = [], events = [], commands = []
let serverLog = ''
server.stdout.on('data', data => { serverLog += data })
server.stderr.on('data', data => { serverLog += data })
let browser, page, room, self, snapshots = 0, bootstraps = 0, sockets = 0, closures = 0
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label}; ${JSON.stringify({ room, self, snapshots, bootstraps, sockets, closures, events, errors })}`)
}
try {
  if (authEnabled) await until(() => fetch(`${issuer}/.well-known/openid-configuration`).then(r => r.ok).catch(() => false), 'Keycloak discovery', 60000)
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'server')
  if (authEnabled) assert.equal((await (await fetch(`${base}/auth/status`)).json()).enabled, true)
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => {
    const Native = window.WebSocket
    window.__oidcSockets = []
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); window.__oidcSockets.push(this) }
    }
  })
  page.on('pageerror', error => errors.push(String(error)))
  page.on('websocket', socket => {
    sockets++
    socket.on('close', () => { closures++ })
    socket.on('framesent', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 2) return
      const message = fromBinary(ClientMsgSchema, payload.subarray(1)).payload
      if (message.case !== 'input') commands.push(message.case)
    })
    socket.on('framereceived', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
      const message = fromBinary(ServerMsgSchema, payload.subarray(1))
      if (message.payload.case === 'snapshot') {
        snapshots++
        if (message.payload.value.self) self = message.payload.value.self
      }
      if (message.payload.case !== 'event') return
      const event = message.payload.value.kind
      if (events.length < 40) events.push(event.case === 'say' ? { say: event.value.text } : event.case)
      if (event.case === 'roomState') room = event.value
      if (event.case === 'mapBootstrap') bootstraps++
    })
  })
  await page.goto(base)
  await startClient(page)
  await page.fill('#in-room', 'OIDCTEST')
  if (authEnabled) {
    await page.click('#auth-login')
    await page.fill('#username', username)
    await page.fill('#password', password)
    await page.click('#kc-login')
    await page.waitForURL(url => url.origin === base)
    await startClient(page)
    assert.equal(new URL(page.url()).searchParams.has('token'), false, 'callback token is removed from URL')
    assert.equal(await page.locator('#in-nick').inputValue(), username)
    assert.equal(await page.locator('#in-nick').isDisabled(), true)
  } else {
    await page.fill('#in-nick', username)
  }
  await page.click('#btn-join')
  await page.locator('#btn-warmup').waitFor({ state: 'visible' })
  assert.equal(room.hostNick, username)
  if (process.env.OMB_TEST_SOLO_BOTS !== 'false') await page.click('#btn-solo-bots')
  if (process.env.OMB_TEST_LAUNCH_FAILURE !== 'false') {
    mkdirSync(join(work, 'data'), { recursive: true })
    writeFileSync(join(work, 'data/matches'), 'blocked')
    await page.click('#btn-start')
    await until(() => events.some(event => typeof event === 'object' && event.say.startsWith('match launch failed:')), 'assembly error')
    await until(() => room?.state === 3, 'failed launch releases the room for retry')
    assert.equal(await page.locator('#room-error').isVisible(), true, 'failure is visible outside game view')
    assert.match(await page.locator('#room-error').innerText(), /event log/)
    assert.equal(bootstraps, 0)
    assert.equal(snapshots, 0)
    assert.equal(closures, 0, 'assembly failure keeps the authenticated connection')
    await page.screenshot({ path: join(shots, `${shotPrefix}-retry.png`) })
    unlinkSync(join(work, 'data/matches'))
  }
  await page.click('#btn-start')
  await until(() => room?.state === 2, 'running room')
  await until(() => bootstraps > 0 && snapshots > 0 && self, 'map and player snapshot')
  await until(() => page.locator('#view-game').isVisible(), 'game view becomes visible')
  assert.equal(await page.locator('#room-error').evaluate(element => element.hidden), true, 'successful retry clears launch error')
  const robot = self.robotId
  let previousMaps = bootstraps, previousSnapshots = snapshots
  await page.reload()
  await startClient(page)
  await until(() => bootstraps > previousMaps && snapshots > previousSnapshots && self?.robotId === robot, 'authenticated reload restores the same robot')
  await until(() => page.locator('#view-game').isVisible(), 'game returns after reload')
  previousMaps = bootstraps
  previousSnapshots = snapshots
  const previousSockets = sockets
  await page.evaluate(() => window.__oidcSockets.at(-1).close(4001, 'OIDC reconnect test'))
  await until(() => sockets > previousSockets && bootstraps > previousMaps && snapshots > previousSnapshots && self?.robotId === robot, 'authenticated reconnect restores the same robot')
  await page.locator('#connection-notice').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('#view-game').isVisible(), true)
  assert.deepEqual(errors, [], 'no client exceptions while entering game')
  await page.screenshot({ path: join(shots, `${shotPrefix}-game.png`) })
  console.log(JSON.stringify({ result: 'game entered, reload and reconnect passed', authEnabled, bootstraps, snapshots, sockets, closures, commands }))
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(shots, `${shotPrefix}-failure.png`) }).catch(() => {})
    console.error(JSON.stringify({
      roomVisible: await page.locator('#view-room').isVisible().catch(() => false),
      gameVisible: await page.locator('#view-game').isVisible().catch(() => false),
      commands, errors,
    }))
  }
  writeFileSync(join(shots, 'server.log'), serverLog)
  throw error
} finally {
  await browser?.close()
  if (server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve))
    server.kill()
    await exited
  }
  rmSync(work, { recursive: true, force: true })
}
