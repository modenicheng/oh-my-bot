// Real-server acceptance for fine-grained manual takeover (ADR-0009):
// Space three-branch semantics, held-key no-regrab, per-axis SelfState
// sources, and HUD per-axis hint. Own spawned server + own port (default
// 18431); never touches the coordinator's 18420.
import { startClient } from './startup-helpers.mjs'
import { chromium } from 'playwright'
import { fromBinary, toBinary, create } from '@bufbuild/protobuf'
import { ClientMsgSchema, ServerMsgSchema, RoomActionSchema, RoomAction_Kind, AssistToggleSchema, ClientInputSchema } from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const work = mkdtempSync(join(tmpdir(), 'omb-takeover-'))
const shots = resolve(process.env.OMB_SHOTS || '../.artifacts/takeover-live')
mkdirSync(shots, { recursive: true })
const port = process.env.OMB_PORT || '18431'
const addr = `127.0.0.1:${port}`
const base = `http://${addr}`
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', addr], { cwd: work, stdio: 'ignore' })
let spawnError
server.on('error', e => { spawnError = e })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout
  let lastErr = null
  while (Date.now() < end) {
    if (spawnError) throw spawnError
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}`)
    try {
      if (await fn()) return
    } catch (e) {
      lastErr = e // locator 可能因 DOM 重建瞬时失联，继续轮询
    }
    await sleep(50)
  }
  throw new Error(`timed out: ${label}${lastErr ? ` (last: ${String(lastErr).slice(0, 120)})` : ''}`)
}

// ---- browser client (authoritative HUD + real input path) ------------------
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto(base)
await page.evaluate(() => localStorage.clear())
await page.reload()
await startClient(page) // activate past the startup gate
// Join via the real UI.
await page.fill('#in-room', 'TAKEOVER')
await page.fill('#in-nick', 'taker')
await page.click('#btn-join')
await sleep(600)
await page.locator('#btn-solo-bots').waitFor({ state: 'visible' })
await page.click('#btn-solo-bots')
await sleep(600)
await page.click('#btn-start')
await sleep(600)
await page.screenshot({ path: join(shots, 'lobby-debug.png') }).catch(() => {})

const text = () => page.locator('#hud-assist').textContent().then(t => (t || '').trim())
const hint = () => page.locator('#hud-assist-hint').textContent().then(t => (t || '').trim())
const assistOn = async () => /ON/i.test(await text())
const dump = async (label) => {
  console.log(`[${label}] room=${await page.evaluate(() => document.getElementById('room-state')?.textContent || 'n/a').catch(() => 'n/a')} assist=${await text()} hint=${JSON.stringify(await hint())} active=${await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName).catch(() => 'n/a')}`)
}

// Start a solo-bots round through the room UI so a real match is live.
await until(async () => page.locator('#hud-assist').isVisible().catch(() => false), 'in-match assist HUD visible')
// --- branch semantics via real Space presses --------------------------------
// Baseline: assist defaults off; manual drive is normal (no hint).
assert.equal(await assistOn(), false, 'assist defaults off')
await page.mouse.click(640, 360) // focus game canvas
await sleep(150)
assert.equal(await hint(), '', 'no hint while assist off (manual drive is normal)')

// Branch 1: assist off -> Space on (+clear any takeover).
await dump('before-space')
await page.keyboard.down('Space'); await sleep(120); await page.keyboard.up('Space')
await dump('after-space')
await until(async () => (await text()).includes('ON'), 'branch1: Space turns assist on')
await until(async () => (await hint()) === '', 'branch1: no manual axes after enabling')

// Take over move+fire with real NEW keydown/mousedown (edge-triggered).
await page.keyboard.down('w')
await page.mouse.move(700, 380)
await page.mouse.down()
await until(async () => /移动/.test(await hint()) && /开火/.test(await hint()), 'branch2 setup: HUD lists 移动+开火 with Space hint')
await page.screenshot({ path: join(shots, 'live-manual-axes.png') })

// Branch 2: single Space returns axes, assist stays ON; held W/LMB must not re-grab.
await page.keyboard.down('Space'); await sleep(120); await page.keyboard.up('Space')
await dump('b2-after-space'); await until(async () => (await text()).includes('ON'), 'branch2: assist stays on')
await until(async () => (await hint()) === '', 'branch2: manual axes returned with one Space')
await sleep(600) // keys still held down; no re-grab
assert.equal(await hint(), '', 'held W/LMB must not re-grab after restore')
await page.keyboard.up('w')
await page.mouse.up()

// Branch 3: all-script control + Space -> assist off.
await sleep(200)
await page.keyboard.down('Space'); await sleep(120); await page.keyboard.up('Space')
await until(async () => (await text()).includes('OFF'), 'branch3: Space turns assist off when all-script')
assert.equal(await hint(), '', 'no hint while assist off')

console.log('live three-branch + HUD ok')
await browser.close()
server.kill()
try { rmSync(work, { recursive: true, force: true }) } catch {}
console.log('=== takeover-live-check PASS ===')
