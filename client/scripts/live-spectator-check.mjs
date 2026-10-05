import { startClient } from './startup-helpers.mjs'
// Real-server acceptance for a distinct, read-only live room connection.
import { chromium } from 'playwright'
import { fromBinary, create, toBinary } from '@bufbuild/protobuf'
import { ClientMsgSchema, ServerMsgSchema, ServerEventSchema, SnapshotDeltaSchema, Phase,
  RoomActionSchema, RoomAction_Kind, EvRoomState_State, encodeClient } from '../../packages/protocol/src/index.ts'
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
  let humanOnline = 0, selfId = 0, hostTick = 0, hostRoomState
  host.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
    const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
    if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'roomState') {
      hostRoomState = msg.payload.value.kind.value.state
      humanOnline = msg.payload.value.kind.value.robotsOnline
    }
    if (msg.payload.case === 'snapshot') {
      hostTick = msg.payload.value.tick
      if (msg.payload.value.self) selfId = msg.payload.value.self.robotId
    }
  }))
  await host.goto(base)
  await startClient(host)
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
  let rawSpoof = false
  let room, source = '', snapshotTick = 0
  const robots = new Map()
  watch.on('websocket', socket => {
    const connection = { upstream: [], full: false }
    connections.push(connection)
    socket.on('framesent', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 2) return
      const message = fromBinary(ClientMsgSchema, payload.subarray(1))
      connection.upstream.push(message.payload.case)
      assert.ok(rawSpoof && message.payload.case === 'roomAction' ||
        ['spectate', 'resyncRequest', 'leave'].includes(message.payload.case), `spectator sent ${message.payload.case}`)
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
  await startClient(watch)
  await watch.locator('#view-live').waitFor({ state: 'visible' })
  await until(() => room?.robotsOnline === 1, 'idle spectator room state')
  assert.equal(connections.length, 1)
  assert.deepEqual(connections[0].upstream, ['spectate'])
  assert.equal(await watch.locator('#live-follow').isDisabled(), true)
  assert.equal(await watch.locator('#view-room').isVisible(), false)
  assert.equal(humanOnline, 1, 'spectator does not take a player slot')
  await watch.screenshot({ path: join(shots, 'idle.png') })

  await host.click('#btn-solo-bots')
  await until(() => room?.soloBots === 63, 'spectator bot configuration')
  await host.click('#btn-warmup')
  await until(() => snapshotTick > 90 && robots.size === 64, 'full-world live warmup', 30_000)
  await until(() => watch.locator('#live-follow option').count().then(n => n === 65), 'live robot selection', 30_000)
  assert.ok(await pixels(watch) > 20, 'live canvas is nonblank')
  assert.equal(room.robotsOnline, 1)
  assert.equal(await watch.locator('#live-match').textContent(), '热身中')
  const human = robots.get(selfId)
  assert.ok(human, 'spectator sees real robot')
  assert.ok([...robots.values()].some(robot => Math.hypot(robot.base.pos.x - human.base.pos.x, robot.base.pos.y - human.base.pos.y) > 20), 'feed extends beyond player vision')
  assert.ok([...robots.values()].every(robot => robot.nick), 'global feed carries identity labels')
  const beforeTick = Number(await watch.locator('#view-live').getAttribute('data-tick'))
  await until(() => watch.locator('#view-live').getAttribute('data-tick').then(tick => Number(tick) > beforeTick + 30), 'client applies live simulation frames')
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
  await until(() => source !== warmSource && snapshotTick > 30 && robots.size === 64, 'new-match spectator bootstrap', 30_000)
  assert.equal(await watch.locator('#live-follow').inputValue(), '', 'new map resets follow')
  await until(() => watch.locator('#live-zoom').textContent().then(text => text === '1.0\u00d7'), 'new map fits camera')
  assert.equal(room.robotsOnline, 1)
  assert.equal(await watch.locator('#live-match').textContent(), '对局中')
  const beforeReload = connections.length
  await watch.reload()
  await startClient(watch)
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
      const contents = ['.live-heading', '.live-camera', '.live-footer'].flatMap(selector => {
        const parent = document.querySelector(selector)
        const bounds = parent.getBoundingClientRect()
        return [...parent.children].filter(child => getComputedStyle(child).display !== 'none').map(child => {
          const box = child.getBoundingClientRect()
          return { name: child.id || child.tagName, left: box.left, right: box.right,
            top: box.top, bottom: box.bottom, parentLeft: bounds.left, parentRight: bounds.right,
            parentTop: bounds.top, parentBottom: bounds.bottom, clipped: child.scrollWidth > child.clientWidth + 1 }
        })
      })
      return { rects, contents, height: innerHeight, scroll: document.documentElement.scrollWidth }
    })
    assert.ok(metrics.scroll <= width, `no horizontal overflow at ${width}px`)
    for (const element of metrics.contents) {
      assert.ok(element.left >= element.parentLeft - 1 && element.right <= element.parentRight + 1 &&
        element.top >= element.parentTop - 1 && element.bottom <= element.parentBottom + 1 && !element.clipped,
      `${element.name} fits its toolbar at ${width}px`)
    }
    for (const [i, rect] of metrics.rects.entries()) {
      assert.ok(rect.left >= -1 && rect.right <= width + 1 && rect.top >= 0 && rect.bottom <= metrics.height + 1, `panel ${i} in viewport at ${width}px`)
      if (i) assert.ok(rect.top >= metrics.rects[i - 1].bottom - 1, `panel ${i} does not overlap at ${width}px`)
    }
    assert.ok(await pixels(watch) > 20, `nonblank narrow canvas ${width}px`)
    await watch.locator('#audio-settings summary').click()
    const audioBounds = await watch.locator('.audio-row').boundingBox()
    assert.ok(audioBounds.x >= 0 && audioBounds.x + audioBounds.width <= width, `audio popup fits at ${width}px`)
    await watch.locator('#audio-mute').click()
    await watch.screenshot({ path: join(shots, `narrow-${width}.png`) })
    await watch.locator('#audio-settings summary').click()
  }
  await watch.locator('#live-canvas').focus()
  await watch.keyboard.press('Escape')
  await watch.locator('#view-join').waitFor({ state: 'visible' })
  assert.equal(new URL(watch.url()).searchParams.get('view'), 'join')
  assert.equal(humanOnline, 1)
  const beforeReopen = connections.length
  await watch.click('#btn-live')
  await until(() => watch.locator('#view-live').isVisible().then(visible => visible && connections.length > beforeReopen && connections.at(-1).full), 'reopen live spectator from form')

  assert.equal(hostRoomState, EvRoomState_State.R_RUNNING)
  const beforeSpoof = hostTick
  const abort = encodeClient(create(ClientMsgSchema, {
    payload: { case: 'roomAction', value: create(RoomActionSchema, { kind: RoomAction_Kind.ABORT }) },
  }))
  rawSpoof = true
  await watch.evaluate(bytes => window.__liveSockets.at(-1).send(new Uint8Array(bytes)), [...abort])
  await until(() => hostRoomState !== EvRoomState_State.R_RUNNING || hostTick > beforeSpoof + 20, 'unauthorized spectator ABORT')
  rawSpoof = false
  assert.equal(hostRoomState, EvRoomState_State.R_RUNNING, 'spectator cannot abort the match over raw WebSocket')
  assert.equal(humanOnline, 1, 'spoofed command cannot add a player')
  // Controlled UI-only final-frame checks; the preceding assertions use the real server.
  const finalPage = await context.newPage()
  finalPage.on('pageerror', error => errors.push(String(error)))
  const fixtureUp = []
  const fixtureRobots = [...robots.values()]
  let fixtureSocket, fixtureMode = 'running'
  const sendFixture = payload => fixtureSocket.send(Buffer.concat([
    Buffer.from([3]), toBinary(ServerMsgSchema, create(ServerMsgSchema, { payload })),
  ]))
  const fixtureEvent = (tick, kind) => sendFixture({ case: 'event', value: create(ServerEventSchema, { tick, kind }) })
  const fixtureSnapshot = (tick, extra = {}) => sendFixture({ case: 'snapshot', value: create(SnapshotDeltaSchema, {
    tick, phase: Phase.CORE_OPEN, timeLeftS: 0, full: true, robots: fixtureRobots, ...extra,
  }) })
  await finalPage.routeWebSocket('**/ws', socket => {
    fixtureSocket = socket
    socket.onMessage(message => {
      const data = Buffer.from(message)
      if (data[0] === 0) { socket.send(Buffer.concat([Buffer.from([1]), data.subarray(1)])); return }
      if (data[0] !== 2) return
      const kind = fromBinary(ClientMsgSchema, data.subarray(1)).payload.case
      fixtureUp.push(kind)
      if (kind === 'spectate') {
        if (fixtureMode === 'idle') {
          fixtureEvent(0, { case: 'roomState', value: { state: EvRoomState_State.R_IDLE, robotsOnline: 0 } })
          return
        }
        fixtureEvent(200, { case: 'roomState', value: { state: EvRoomState_State.R_RUNNING, robotsOnline: 1 } })
        fixtureEvent(200, { case: 'mapBootstrap', value: { mapJson: fixtureMode === 'bad' ? '{broken' : source, generatorVersion: 4 } })
        fixtureSnapshot(200, { phase: Phase.OUTER_RING, timeLeftS: 476 })
      }
    })
  })
  await finalPage.goto(`${base}/?view=live&room=LIVEBOT`)
  await startClient(finalPage)
  await until(() => finalPage.locator('#view-live').getAttribute('data-tick').then(tick => tick === '200'), 'controlled live frame')
  const target = fixtureRobots[0].base.id
  await finalPage.selectOption('#live-follow', String(target))
  fixtureSnapshot(201, { robots: fixtureRobots.map(r => r.base.id === target ? { ...r, dead: true, hpX10: 0 } : r) })
  await until(() => finalPage.locator('#view-live').getAttribute('data-tick').then(tick => tick === '201'), 'follow dead target')
  assert.equal(await finalPage.locator('#live-follow').inputValue(), String(target))
  fixtureSnapshot(202, { robots: fixtureRobots.filter(r => r.base.id !== target) })
  await until(() => finalPage.locator('#live-follow option').count().then(count => count === fixtureRobots.length), 'follow removed target')
  assert.ok(await pixels(finalPage) > 20, 'target removal does not blank camera')
  fixtureSnapshot(203)
  await until(() => finalPage.locator('#live-follow').inputValue().then(value => value === String(target)), 'target returns to camera follow')
  fixtureSnapshot(28800)
  fixtureEvent(28800, { case: 'matchEnd', value: { scores: fixtureRobots.map((r, i) => ({ robot: r.base.id, score: 40 - i, titles: [] })) } })
  fixtureEvent(28800, { case: 'roomState', value: { state: EvRoomState_State.R_ENDED, robotsOnline: 1 } })
  await until(() => finalPage.locator('#live-scores li').count().then(count => count === fixtureRobots.length), 'final scores')
  assert.equal(await finalPage.locator('#live-match').textContent(), '已结束')
  assert.equal(await finalPage.locator('#live-time').textContent(), '0:00')
  assert.equal(await finalPage.locator('#live-scores li').first().locator('.score-name').textContent(), fixtureRobots[0].nick)
  assert.ok(await pixels(finalPage) > 20, 'final arena stays visible')
  assert.deepEqual(fixtureUp, ['spectate'], 'final view never sends gameplay commands')
  await finalPage.setViewportSize({ width: 360, height: 780 })
  await finalPage.screenshot({ path: join(shots, 'final-360.png') })
  await finalPage.click('#live-back')
  fixtureMode = 'idle'
  await finalPage.fill('#in-room', 'IDLE123')
  await finalPage.click('#btn-live')
  await until(() => finalPage.locator('#live-status').textContent().then(text => text === '已连接'), 'idle room after final scores')
  assert.equal(await finalPage.locator('#live-scores').isVisible(), false, 'previous scores cleared')
  assert.equal(await finalPage.locator('#live-follow').isDisabled(), true, 'previous follow targets cleared')
  assert.equal(await finalPage.locator('#live-follow option').count(), 1)
  assert.equal(await finalPage.locator('#view-live').getAttribute('data-tick'), '0')
  assert.equal(await finalPage.locator('#live-count').textContent(), '机器人 0')
  await finalPage.click('#live-back')
  fixtureMode = 'bad'
  await finalPage.click('#btn-live')
  await until(() => finalPage.locator('#live-status').textContent().then(text => text.includes('地图数据异常')), 'bad map remains actionable')
  assert.equal(await finalPage.locator('#live-retry').isVisible(), true)
  assert.equal(await finalPage.locator('#view-live').getAttribute('data-tick'), '0', 'bad map cannot be masked by snapshot')
  fixtureMode = 'running'
  await finalPage.click('#live-retry')
  await until(() => finalPage.locator('#view-live').getAttribute('data-tick').then(tick => tick === '200'), 'map retry replaces stopped session')
  await finalPage.close()
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
