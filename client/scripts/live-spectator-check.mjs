// Real-server acceptance for a distinct, read-only live room connection.
import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ClientMsgSchema, ServerMsgSchema } from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const work = mkdtempSync(join(tmpdir(), 'omb-live-'))
const shots = resolve(process.env.OMB_SHOTS || '../.artifacts/live-spectator')
mkdirSync(shots, { recursive: true })
const addr = `127.0.0.1:${process.env.OMB_PORT || 18425}`
const base = `http://${addr}`
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', addr], { cwd: work, stdio: 'ignore' })
let spawnError
server.on('error', error => { spawnError = error })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (spawnError) throw spawnError
    if (server.exitCode !== null) throw new Error(`Server exited with ${server.exitCode}`)
    if (await fn()) return
    await sleep(50)
  }
  throw new Error(`Timed out: ${label}`)
}
async function pixels(page) {
  return page.locator('#live-canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    const colors = new Set()
    for (let i = 0; i < data.length; i += 44) colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
    return colors.size
  })
}
let browser, watch
const errors = []
try {
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'server')
  browser = await chromium.launch()
  const host = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  host.on('pageerror', error => errors.push(String(error)))
  let humanOnline = 0, selfId = 0
  host.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
    const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
    if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'roomState') humanOnline = msg.payload.value.kind.value.robotsOnline
    if (msg.payload.case === 'snapshot' && msg.payload.value.self) selfId = msg.payload.value.self.robotId
  }))
  await host.goto(base)
  await host.fill('#in-room', 'LIVEBOT')
  await host.fill('#in-nick', 'live-host')
  await host.click('#btn-join')
  await host.locator('#btn-warmup').waitFor({ state: 'visible' })
  assert.equal(humanOnline, 1)
  assert.equal(new URL(await host.locator('#room-live').getAttribute('href'), base).searchParams.get('view'), 'live')

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addInitScript(() => {
    // A stale player profile must not turn a direct spectator URL into a player.
    sessionStorage.setItem('omb.join', JSON.stringify({ roomCode: 'LIVEBOT', nick: 'not-a-player', color: '#00e5ff' }))
    const NativeWebSocket = window.WebSocket
    window.__liveSockets = []
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) { super(...args); window.__liveSockets.push(this) }
    }
  })
  watch = await context.newPage()
  watch.on('pageerror', error => errors.push(String(error)))
  const connections = []
  let room, source = '', snapshotTick = 0
  const robots = new Map()
  watch.on('websocket', socket => {
    const connection = { upstream: [], full: false }
    connections.push(connection)
    socket.on('framesent', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 2) return
      const message = fromBinary(ClientMsgSchema, payload.subarray(1))
      connection.upstream.push(message.payload.case)
      assert.ok(['spectate', 'resyncRequest', 'leave'].includes(message.payload.case), `spectator sent ${message.payload.case}`)
    })
    socket.on('framereceived', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
      const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'event') {
        const ev = msg.payload.value.kind
        if (ev.case === 'roomState') room = ev.value
        if (ev.case === 'mapBootstrap') { source = ev.value.mapJson; snapshotTick = 0; robots.clear(); connection.full = false }
      } else if (msg.payload.case === 'snapshot') {
        const snap = msg.payload.value
        assert.equal(snap.self, undefined, 'spectator has no personal state')
        if (!connection.full) assert.equal(snap.full, true, 'connection starts from reliable full snapshot')
        connection.full = true
        if (snap.full) robots.clear()
        for (const robot of snap.robots) {
          const previous = robots.get(robot.base.id)
          robots.set(robot.base.id, { ...robot, nick: robot.nick || previous?.nick, color: robot.color || previous?.color })
        }
        for (const id of snap.robotGone) robots.delete(id)
        snapshotTick = snap.tick
      }
    })
  })
  await watch.goto(`${base}/?view=live&room=LIVEBOT`)
  await watch.locator('#view-live').waitFor({ state: 'visible' })
  await until(() => room?.robotsOnline === 1, 'idle spectator room state')
  assert.equal(connections.length, 1)
  assert.deepEqual(connections[0].upstream, ['spectate'])
  assert.equal(await watch.locator('#live-follow').isDisabled(), true)
  assert.equal(await watch.locator('#view-room').isVisible(), false)
  assert.equal(humanOnline, 1, 'spectator does not take a player slot')
  await watch.screenshot({ path: join(shots, 'idle.png') })

  await host.click('#btn-solo-bots')
  await until(() => room?.soloBots === 3, 'spectator bot configuration')
  await host.click('#btn-warmup')
  await until(() => snapshotTick > 90 && robots.size === 4, 'full-world live warmup')
  await until(() => watch.locator('#live-follow option').count().then(n => n === 5), 'live robot selection')
  assert.ok(await pixels(watch) > 20, 'live canvas is nonblank')
  assert.equal(room.robotsOnline, 1)
  assert.equal(await watch.locator('#live-match').textContent(), '热身中')
  const human = robots.get(selfId)
  assert.ok(human, 'spectator sees real robot')
  assert.ok([...robots.values()].some(robot => Math.hypot(robot.base.pos.x - human.base.pos.x, robot.base.pos.y - human.base.pos.y) > 20), 'feed extends beyond player vision')
  assert.ok([...robots.values()].every(robot => robot.nick), 'global feed carries identity labels')
  const beforeTick = snapshotTick
  await until(() => snapshotTick > beforeTick + 30, 'live simulation advances')
  await watch.screenshot({ path: join(shots, 'desktop.png') })

  await watch.selectOption('#live-follow', String(selfId))
  await watch.click('#live-in')
  await until(() => watch.locator('#live-zoom').textContent().then(text => text === '5.0\u00d7'), 'zoom')
  const box = await watch.locator('#live-canvas').boundingBox()
  await watch.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await watch.mouse.down()
  await watch.mouse.move(box.x + box.width / 2 + 96, box.y + box.height / 2 + 36, { steps: 8 })
  await watch.mouse.up()
  await until(() => watch.locator('#live-follow').inputValue().then(value => value === ''), 'drag exits follow')
  await watch.locator('#live-canvas').focus()
  await watch.keyboard.press('Home')
  await until(() => watch.locator('#live-zoom').textContent().then(text => text === '1.0\u00d7'), 'camera fit')
  await watch.keyboard.press('ArrowLeft')
  await watch.keyboard.press('w')
  await watch.keyboard.press('Enter')
  await watch.keyboard.press('Space')
  await watch.keyboard.press('c')
  await watch.keyboard.press('m')
  assert.equal(await watch.locator('#view-live').isVisible(), true)
  assert.equal(await watch.locator('#game-chat').isVisible(), false)
  assert.equal(connections[0].upstream.some(kind => !['spectate', 'resyncRequest', 'leave'].includes(kind)), false)

  await watch.selectOption('#live-follow', String(selfId))
  await watch.click('#live-in')
  const connectionCount = connections.length
  await watch.evaluate(() => window.__liveSockets.at(-1).close())
  await until(() => connections.length > connectionCount && connections.at(-1).full, 'spectator reconnect')
  assert.equal(connections.at(-1).upstream[0], 'spectate')
  await until(() => watch.locator('#live-follow').inputValue().then(value => value === String(selfId)), 'reconnect preserves camera follow')
  assert.equal(await watch.locator('#live-zoom').textContent(), '5.0\u00d7')
  assert.equal(humanOnline, 1)

  const warmSource = source
  await host.click('#btn-game-start')
  await until(() => source !== warmSource && snapshotTick > 30 && robots.size === 4, 'new-match spectator bootstrap')
  assert.equal(await watch.locator('#live-follow').inputValue(), '', 'new map resets follow')
  await until(() => watch.locator('#live-zoom').textContent().then(text => text === '1.0\u00d7'), 'new map fits camera')
  assert.equal(room.robotsOnline, 1)
  assert.equal(await watch.locator('#live-match').textContent(), '对局中')
  const beforeReload = connections.length
  await watch.reload()
  await until(() => connections.length > beforeReload && connections.at(-1).full && snapshotTick > 30, 'mid-match direct spectator join')
  assert.equal(new URL(watch.url()).searchParams.get('view'), 'live')
  assert.equal(humanOnline, 1)

  for (const width of [480, 360]) {
    await watch.setViewportSize({ width, height: 780 })
    await watch.waitForFunction(() => {
      const canvas = document.querySelector('#live-canvas')
      return canvas.width === Math.round(canvas.getBoundingClientRect().width * devicePixelRatio)
    })
    const metrics = await watch.evaluate(() => {
      const rects = ['.live-heading', '.live-camera', '#live-canvas', '.live-footer'].map(selector => {
        const { left, right, top, bottom } = document.querySelector(selector).getBoundingClientRect()
        return { left, right, top, bottom }
      })
      return { rects, height: innerHeight, scroll: document.documentElement.scrollWidth }
    })
    assert.ok(metrics.scroll <= width, `no horizontal overflow at ${width}px`)
    for (const [i, rect] of metrics.rects.entries()) {
      assert.ok(rect.left >= -1 && rect.right <= width + 1 && rect.top >= 0 && rect.bottom <= metrics.height + 1, `panel ${i} in viewport at ${width}px`)
      if (i) assert.ok(rect.top >= metrics.rects[i - 1].bottom - 1, `panel ${i} does not overlap at ${width}px`)
    }
    assert.ok(await pixels(watch) > 20, `nonblank narrow canvas ${width}px`)
    await watch.screenshot({ path: join(shots, `narrow-${width}.png`) })
  }
  await watch.locator('#live-canvas').focus()
  await watch.keyboard.press('Escape')
  await watch.locator('#view-join').waitFor({ state: 'visible' })
  assert.equal(new URL(watch.url()).searchParams.get('view'), 'join')
  assert.equal(humanOnline, 1)
  const beforeReopen = connections.length
  await watch.click('#btn-live')
  await until(() => watch.locator('#view-live').isVisible().then(visible => visible && connections.length > beforeReopen && connections.at(-1).full), 'reopen live spectator from form')
  assert.deepEqual(errors, [])
  console.log(`LIVE_SPECTATOR_OK connections=${connections.length} screenshots=${shots}`)
} catch (error) {
  await watch?.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await browser?.close()
  if (server.exitCode === null && !spawnError) {
    const exited = once(server, 'exit')
    server.kill()
    await exited
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
