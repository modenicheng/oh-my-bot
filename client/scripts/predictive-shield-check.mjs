import { startClient } from './startup-helpers.mjs'
// Real-server acceptance for scan().projectiles heading/owner passthrough and
// the predictive-shield example: shield must be up when a projectile is about
// to hit and down otherwise (energy stays high while idle).
import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema, ClientMsgSchema } from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const work = mkdtempSync(join(tmpdir(), 'omb-pshield-'))
const shots = resolve(process.env.OMB_SHOTS || '../.artifacts/pshield')
mkdirSync(shots, { recursive: true })
const port = Number(process.env.OMB_E2E_PORT || 18427)
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', `127.0.0.1:${port}`], { cwd: work, stdio: 'ignore' })
const base = `http://127.0.0.1:${port}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await sleep(50) }
  throw new Error(`Timed out: ${label}`)
}

// The predictive-shield example, submitted as JS (server-side TS stripping of
// import type + type annotation, matching the client emit pipeline).
// E2E variant: same shield logic, but hold position instead of fighting back —
// the human gunner needs a stable target to land aimed shots.
const source = readFileSync(resolve('../docs/manual/examples/predictive-shield.ts'), 'utf8')
  .split('\n').filter(l => !/^\s*import type/.test(l)).join('\n')
  .replace('function tick(bot: BotContext) {', 'function tick(bot) {')
  .replace(/  const enemy = bot\.nearestEnemy\(\)[\s\S]*$/, '  bot.move(0, 0)\n}')
writeFileSync(join(work, 'predictive-shield.js'), source)

function client() {
  return {
    latest: undefined, id: undefined,
    robots: new Map(), projectiles: new Map(), impacts: [], msgs: [], everSawProjectile: false, firstProj: null,
    sawProjFields: false, shieldHits: 0, unshieldedHits: 0,
  }
}
const state = { gunner: client(), shielder: client() }

async function joinRoom(page, room, nick, st, host = false) {
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 2) return
      const msg = fromBinary(ClientMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'input' && !st.inputs) st.inputs = []
      if (msg.payload.case === 'input' && st.inputs.length < 400) {
        st.inputs.push({ aim: msg.payload.value.aim, fire: msg.payload.value.fire })
      }
    })
    socket.on('framereceived', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
      const msg = fromBinary(ServerMsgSchema, payload.subarray(1))
      if (msg.payload.case === 'snapshot') {
        st.latest = msg.payload.value
        if (st.latest.full) st.robots.clear()
        for (const r of st.latest.robots) st.robots.set(r.base.id, { ...r, ...(st.robots.get(r.base.id) || {}), ...r })
        for (const g of st.latest.robotGone) st.robots.delete(g)
        for (const p of st.latest.projectiles) {
          st.projectiles.set(p.base.id, p)
          st.everSawProjectile = true
          if (!st.firstProj) st.firstProj = { id: p.base.id, owner: p.ownerId, heading: p.base?.heading }
          if (p.ownerId > 0 || p.base?.heading !== undefined) st.sawProjFields = true
        }
        for (const g of st.latest.projectileGone) st.projectiles.delete(g)
        if (st.latest.self) st.id = st.latest.self.robotId
      }
      if (msg.payload.case === 'event') {
        const ev = msg.payload.value.kind
        if (ev.case === 'say') st.msgs.push(ev.value)
        if (ev.case === 'projectileImpact' && ev.value.target === st.id) {
          if (ev.value.shield) st.shieldHits++
          else st.unshieldedHits++
        }
      }
    })
  })
  await page.goto(base)
  await startClient(page)
  await page.fill('#in-room', room)
  await page.fill('#in-nick', nick)
  await page.click('#btn-join')
  // 房主等开始按钮；非房主等房间状态行出现即可。
  if (host) await page.locator('#btn-start').waitFor({ state: 'visible' })
  else await page.locator('#room-state').waitFor({ state: 'visible' })
}

// Drive the editor submit path on the shielder page (real UI, real server compile).
async function submitScript(page) {
  await page.click('#btn-game-manual')
  await page.locator('.workbench-tools [data-panel="editor"]').click()
  const editor = page.getByRole('textbox', { name: '机器人脚本编辑器', exact: true })
  await editor.waitFor({ timeout: 20000 })
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+a')
  await page.evaluate(src => navigator.clipboard.writeText(src), source)
  await page.keyboard.press('ControlOrMeta+v')
  await sleep(400) // draft debounce
  await page.keyboard.press('ControlOrMeta+Enter')
  await until(() => page.locator('.script-console-list').textContent().then(t => t.includes('服务器已加载脚本')), 'script loaded', 20000)
  await page.keyboard.press('m') // close workbench, back to battlefield
}

let browser
try {
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'server')
  browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const gPage = await ctx.newPage(), sPage = await ctx.newPage()
  await joinRoom(gPage, 'PSHIELD', 'gunner', state.gunner, true)
  await joinRoom(sPage, 'PSHIELD', 'shielder', state.shielder)
  await gPage.click('#btn-warmup')
  await sPage.locator('#view-game').waitFor({ state: 'visible' })
  await gPage.locator('#view-game').waitFor({ state: 'visible' })
  await until(() => state.gunner.latest?.self && state.shielder.latest?.self, 'both snapshots')

  await submitScript(sPage)
  await sPage.click('#workbench-assist')
  await until(() => sPage.locator('#workbench-assist').getAttribute('aria-pressed').then(v => v === 'true'), 'assist on')

  // Phase 1: nobody fires — shielder energy must stay near max (no phantom shield).
  { const t0 = Date.now(); while (Date.now() - t0 < 3000) { await sleep(100) } }
  const idleEnergy = state.shielder.robots.get(state.shielder.id)?.energyX10
  assert.ok(idleEnergy === undefined || idleEnergy > 850, `idle energy should stay high, got ${idleEnergy}`)

  // Hybrid approach: the gunner walks until within effective range so it can land
  // aimed shots at the (now stationary) shielder. Dash when stuck.
  const selfPos = () => state.gunner.robots.get(state.gunner.id)?.base?.pos
  const targetPos = () => state.shielder.robots.get(state.shielder.id)?.base?.pos
  await until(() => selfPos() && targetPos(), 'positions')
  const dist = () => Math.hypot(selfPos().x - targetPos().x, selfPos().y - targetPos().y)
  console.log(`initial distance: ${dist().toFixed(1)}m`)
  const t0 = Date.now()
  let lastDist = Infinity, stuck = 0
  while (Date.now() - t0 < 30000) {
    if (dist() < 14) break
    const dx = targetPos().x - selfPos().x, dy = targetPos().y - selfPos().y
    const key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'd' : 'a') : (dy > 0 ? 's' : 'w')
    await gPage.keyboard.down(key)
    if (stuck > 3) { await gPage.keyboard.down('Shift'); await sleep(400); await gPage.keyboard.up('Shift'); stuck = 0 }
    await sleep(200)
    await gPage.keyboard.up(key)
    const d = dist()
    if (d > lastDist - 0.3) stuck++; else stuck = 0
    lastDist = d
  }
  console.log(`engagement distance: ${dist().toFixed(1)}m`)
  if (dist() > 17) throw new Error(`gunner never got in range: ${dist().toFixed(1)}m`)

  // Fire in short bursts; if a wall eats the shots (no projectile ever seen / no impact),
  // strafe and re-approach. Try up to 4 positions before giving up.
  let shielded = 0, unshielded = 0
  for (let attempt = 0; attempt < 4 && shielded + unshielded === 0; attempt++) {
    await gPage.locator('#game-canvas').click({ position: { x: 640, y: 400 } })
    await gPage.mouse.down()
    const seenBefore = state.gunner.everSawProjectile
    for (let i = 0; i < 12; i++) {
      const box = await gPage.locator('#game-canvas').boundingBox()
      const g = selfPos(), t = targetPos()
      const scale = Math.min(box.width / 40, box.height / 25)
      const px = box.x + box.width / 2 + (t.x - g.x) * scale
      const py = box.y + box.height / 2 + (t.y - g.y) * scale // world +y renders downward
      await gPage.mouse.move(Math.max(box.x + 2, Math.min(box.x + box.width - 2, px)), Math.max(box.y + 2, Math.min(box.y + box.height - 2, py)))
      await sleep(250)
    }
    await gPage.mouse.up()
    shielded = state.shielder.shieldHits
    unshielded = state.shielder.unshieldedHits
    if (shielded + unshielded > 0) break
    // No impact: likely a wall in between. Strafe sideways and try again.
    if (attempt < 3) {
      const key = attempt % 2 ? 'a' : 'd'
      await gPage.keyboard.down(key)
      await sleep(1200)
      await gPage.keyboard.up(key)
      await gPage.keyboard.down(key === 'a' ? 'd' : 'a')
      await sleep(400)
      await gPage.keyboard.up(key === 'a' ? 'd' : 'a')
    }
  }
  state.shielder.shieldHits = shielded
  state.shielder.unshieldedHits = unshielded
  // Debug: verify the gunner actually sent fire inputs and sane aim.
  {
    const inp = (state.gunner.inputs || []).slice(-8)
    console.log(`gunner inputs (last 8): ${inp.map(i => `aim=${i.aim?.toFixed(2)} fire=${i.fire}`).join(' | ')}`)
    const g = state.gunner.robots.get(state.gunner.id), s = state.shielder.robots.get(state.shielder.id)
    const mine = [...state.gunner.projectiles.values()].filter(p => p.ownerId === state.gunner.id).slice(0, 4)
    const want = Math.atan2(s.base.pos.y - g.base.pos.y, s.base.pos.x - g.base.pos.x)
    console.log(`gunner proj headings: ${mine.map(p => p.base.heading.toFixed(2)).join(',')} want=${want.toFixed(2)}`)
  }

  // Assertions once the dust settles.
  await sleep(1000)
  assert.ok(state.shielder.sawProjFields, 'snapshot projectiles carry heading/owner through the client')
  const total = state.shielder.shieldHits + state.shielder.unshieldedHits
  console.log(`impacts: shielded=${state.shielder.shieldHits} unshielded=${state.shielder.unshieldedHits} projectiles=${state.shielder.projectiles.size}`)
  await gPage.screenshot({ path: join(shots, 'gunner.png') })
  await sPage.screenshot({ path: join(shots, 'shielder.png') })
  assert.ok(total > 0, `expected at least one impact on shielder, got ${total}`)
  assert.ok(state.shielder.shieldHits > 0, 'expected at least one shielded impact (predictive shield worked)')

  console.log('PREDICTIVE SHIELD E2E OK')
} catch (err) {
  console.error(String(err))
  process.exitCode = 1
} finally {
  server.kill()
  await browser?.close()
}
