// Regression check: activating a movement Snippet from the workbench must
// return focus to the battle canvas so the next WASD press can take over move.
import { startClient } from './startup-helpers.mjs'
import { chromium } from 'playwright'
import { fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema } from '../../packages/protocol/src/index.ts'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'omb-mvpre2-'))
const shots = resolve(process.env.OMB_SHOTS || '../.artifacts/mvpre2')
mkdirSync(shots, { recursive: true })
const addr = `127.0.0.1:${process.env.OMB_PORT || '18443'}`
const base = `http://${addr}`
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', addr], { cwd: work, stdio: 'ignore' })
let spawnError, browser
server.on('error', error => { spawnError = error })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (spawnError) throw spawnError
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}`)
    if (await check()) return
    await sleep(50)
  }
  throw new Error(`timed out: ${label}`)
}

try {
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'server')
  browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  page.setDefaultTimeout(10000)
  let self
  page.on('websocket', socket => {
    socket.on('framereceived', ({ payload }) => {
      if (!Buffer.isBuffer(payload) || payload[0] !== 3) return
      const message = fromBinary(ServerMsgSchema, payload.subarray(1)).payload
      if (message.case === 'snapshot') {
        self = message.value.self ?? self
      }
    })
  })
  await page.goto(base); await startClient(page)
  await page.fill('#in-room', 'MVPRE2'); await page.fill('#in-nick', 'mv')
  await page.click('#btn-join')
  await page.locator('#view-room').waitFor({ state: 'visible' })
  await until(() => page.locator('#room-state').textContent().then(text => text.includes('房主 mv')), 'room joined')
  await page.click('#btn-warmup')
  await until(() => !!self, 'warmup self snapshot')

  // --- Open the assist (snippets) panel via the toolbar button ---
  await page.click('#btn-game-manual')
  await page.locator('.workbench-tools [data-panel="snippets"]').click()
  await page.locator('#workbench-snippets').waitFor({ state: 'visible' })

  // Enable the patrol movement Snippet and apply it through the real UI.
  await page.locator('#snippet-patrol').check({ force: true })
  await page.locator('.snippet-apply').click({ force: true })
  await until(() => self?.assistOn === true, 'assist activated through snippet apply')
  await until(() => self?.moveSrc === 3, 'snippet owns move axis')
  await until(async () => (await page.evaluate(() => document.activeElement?.id)) === 'game-canvas', 'assist activation returns focus to canvas')

  // A fresh key edge must reach the authoritative per-axis arbiter.
  await page.keyboard.down('w')
  await until(() => self?.moveSrc === 1 && (self?.manualAxesMask ?? 0) & 1, 'WASD takes over move axis')
  await page.keyboard.up('w')
  console.log('PASS: Snippet activation returns canvas focus and WASD takes over move')
  await page.screenshot({ path: join(shots, 'final.png') })
} finally {
  await browser?.close()
  server.kill()
  try { rmSync(work, { recursive: true, force: true }) } catch {}
}
