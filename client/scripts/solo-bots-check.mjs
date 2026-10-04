import { startClient } from './startup-helpers.mjs'
// Real-server acceptance for the optional built-in test opponents.
import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema } from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const work = mkdtempSync(join(tmpdir(), 'omb-bots-'))
const shots = resolve(process.env.OMB_SHOTS || '../.artifacts/bots')
mkdirSync(shots, { recursive: true })
const base = 'http://127.0.0.1:18423'
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', '127.0.0.1:18423'], { cwd: work, stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await sleep(50) }
  throw new Error(`Timed out: ${label}`)
}
function records() {
  try {
    // The live writer can have one partial final line; inspect complete lines.
    const dir = join(work, 'data/matches')
    const name = readdirSync(dir).find(name => /^SOLOBOT-\d+\.jsonl$/.test(name))
    if (!name) return []
    return readFileSync(join(dir, name), 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse)
  } catch { return [] }
}
let browser, page
const errors = []
try {
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'server')
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', e => errors.push(String(e)))
  let room, map, self, tick = 0
  const seenBots = new Map()
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
    const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
    if (msg.payload.case === 'event') {
      const ev = msg.payload.value.kind
      if (ev.case === 'roomState') room = ev.value
      if (ev.case === 'mapBootstrap') { map = JSON.parse(ev.value.mapJson); tick = 0; seenBots.clear() }
    }
    if (msg.payload.case === 'snapshot') {
      tick = msg.payload.value.tick
      if (msg.payload.value.self) self = msg.payload.value.self
    }
  }))
  await page.goto(base)
  await startClient(page)
  await page.fill('#in-room', 'SOLOBOT')
  await page.fill('#in-nick', 'solo-host')
  await page.click('#btn-join')
  await page.locator('#btn-solo-bots').waitFor({ state: 'visible' })
  assert.equal(room.robotsOnline, 1)
  await page.click('#btn-solo-bots')
  await until(() => room?.soloBots === 3, 'bot configuration')
  assert.equal(await page.locator('#btn-solo-bots').getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('#btn-solo-bots svg').count(), 1, 'toggle preserves pixel icon')
  await page.reload()
  await startClient(page)
  await page.locator('#btn-solo-bots').waitFor({ state: 'visible' })
  await until(async () => await page.locator('#btn-solo-bots').getAttribute('aria-pressed') === 'true', 'restored bot configuration')
  assert.equal(room.robotsOnline, 1, 'bots do not take membership slots')
  await page.screenshot({ path: join(shots, 'lobby.png') })
  await page.click('#btn-warmup')
  await page.locator('#view-game').waitFor({ state: 'visible' })
  await until(() => tick > 90 && self, 'warmup simulation')
  assert.equal(map.generator_ver, 6)
  assert.equal(map.core_rules.period_ticks, 1200)
  assert.equal(map.health_packs.length, 4, 'generated map contains four public health-pack locations')
  assert.ok(map.health_packs.every(pack => Number.isFinite(pack.pos.X) && Number.isFinite(pack.pos.Y)), 'health-pack coordinates are finite')
  assert.ok(map.walls.some(w => Math.hypot((w.min.X+w.max.X)/2, (w.min.Y+w.max.Y)/2) < 28), 'map includes inner cover')
  assert.equal(self.assistOn, false, 'human assist remains opt-in')
  // FFA players have no shared vision. Observe movement through the real,
  // read-only spectator connection instead of requiring enemies in player AOI.
  const watch = await browser.newPage({ viewport: { width: 960, height: 700 } })
  watch.on('pageerror', e => errors.push(String(e)))
  watch.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
    const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
    if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'mapBootstrap') seenBots.clear()
    if (msg.payload.case !== 'snapshot') return
    const snapshot = msg.payload.value
    assert.equal(snapshot.self, undefined, 'movement observer is read-only')
    for (const r of snapshot.robots) if (r.nick.startsWith('TEST-BOT-') || seenBots.has(r.base.id)) {
      const old = seenBots.get(r.base.id), pos = r.base.pos
      seenBots.set(r.base.id, { first: old?.first || pos, last: pos,
        moved: old?.moved || !!old && Math.hypot(pos.x-old.first.x, pos.y-old.first.y) > 0.5 })
    }
  }))
  await watch.goto(`${base}?view=live&room=SOLOBOT`)
  await startClient(watch)
  await until(() => seenBots.size === 3 && [...seenBots.values()].some(r => r.moved), 'spectator-observed bot movement')
  await watch.close()
  assert.equal(room.robotsOnline, 1, 'read-only movement observer does not take a membership slot')
  await page.screenshot({ path: join(shots, 'warmup.png') })
  const warmMap = map
  await page.click('#btn-game-start')
  await until(() => map !== warmMap && tick > 90, 'formal bot match')
  await until(() => records().some(r => r.type === 'control' && r.control?.script), 'persisted bot commands')
  const log = records()
  const initial = log.find(r => r.type === 'match_start').state
  assert.equal(initial.robots.length, 4, 'one real robot and three synthetic bots')
  const bots = initial.robots.filter(r => r.nick.startsWith('TEST-BOT-'))
  assert.equal(bots.length, 3)
  for (const bot of bots) {
    assert.ok(log.some(r => r.robot_id === bot.id && r.control?.toggles === 1), 'bot explicitly enables assist')
    assert.ok(log.some(r => r.robot_id === bot.id && r.control?.script), 'bot commands are replayable')
  }
  const identity = self.robotId
  self = undefined
  await page.reload()
  await startClient(page)
  await until(() => self?.robotId === identity && tick > 90, 'formal reconnect identity')
  assert.equal(room.soloBots, 3)
  assert.equal(room.robotsOnline, 1)
  assert.equal(await page.locator('#btn-solo-bots').isVisible(), false, 'no running-match reconfiguration')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, robots: initial.robots.length, screenshots: shots }))
} catch (error) {
  await page?.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
  console.error('Browser errors:', errors)
  throw error
} finally {
  await browser?.close()
  server.kill()
  await new Promise(r => server.exitCode !== null ? r() : server.once('exit', r))
  rmSync(work, { recursive: true, force: true })
}
