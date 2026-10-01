import { startClient } from './startup-helpers.mjs'
// Real-server acceptance for recorded, read-only spectator navigation.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const work = mkdtempSync(join(tmpdir(), 'omb-spectator-'))
const shots = resolve(process.env.OMB_SHOTS || '../.artifacts/spectator')
const matchId = 'REPLAY1-000000001'
mkdirSync(join(work, 'data/matches'), { recursive: true })
mkdirSync(shots, { recursive: true })
copyFileSync(new URL(`../src/replay/test/fixtures/${matchId}.jsonl`, import.meta.url), join(work, 'data/matches', `${matchId}.jsonl`))
const addr = `127.0.0.1:${process.env.OMB_PORT || 18424}`
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
  return page.locator('#replay-canvas').evaluate(canvas => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    const colors = new Set()
    let hash = 2166136261
    for (let i = 0; i < data.length; i += 4 * 11) {
      const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
      colors.add(rgb)
      hash = Math.imul(hash ^ rgb, 16777619)
    }
    return { hash, colors: colors.size, width: canvas.width, height: canvas.height }
  })
}
async function seek(page, tick) {
  await page.locator('#rp-timeline').evaluate((el, value) => {
    el.value = String(value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, tick)
}
let browser, page
const errors = []
let sockets = 0
try {
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'server')
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', e => errors.push(String(e)))
  page.on('websocket', () => sockets++)
  await page.goto(`${base}/?view=spectator&replay=${matchId}`)
  await startClient(page)
  await page.locator('#view-replay-player[data-spectator]').waitFor({ state: 'visible' })
  await until(() => page.locator('#sp-follow option').count().then(n => n === 5), 'robot selection')
  await page.click('#rp-play')
  await seek(page, 3600)
  const initial = await pixels(page)
  assert.ok(initial.colors > 20 && initial.width > 500 && initial.height > 250, 'nonblank full-map canvas')
  assert.equal(sockets, 0, 'direct spectator must not join a room or open a WebSocket')
  assert.equal(await page.locator('.spectator-heading').isVisible(), true)
  await page.screenshot({ path: join(shots, 'desktop.png') })

  await page.click('#sp-in')
  assert.notEqual((await pixels(page)).hash, initial.hash, 'zoom changes rendered pixels')
  assert.notEqual(await page.locator('#sp-zoom').textContent(), '1.0\u00d7')
  await page.selectOption('#sp-follow', '2')
  assert.equal(await page.locator('#sp-follow').inputValue(), '2')
  const following = (await pixels(page)).hash
  const box = await page.locator('#replay-canvas').boundingBox()
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 96, y + 36, { steps: 8 })
  await page.mouse.up()
  assert.equal(await page.locator('#sp-follow').inputValue(), '', 'drag exits follow')
  assert.notEqual((await pixels(page)).hash, following, 'drag changes rendered pixels')
  assert.equal(await page.locator('#replay-canvas').evaluate(el => el.classList.contains('dragging')), false)
  await page.locator('#replay-canvas').focus()
  await page.keyboard.press('Home')
  assert.equal(await page.locator('#sp-zoom').textContent(), '1.0\u00d7')
  assert.equal((await pixels(page)).hash, initial.hash, 'reset returns to original full-map pixels')
  await page.keyboard.press('ArrowLeft')
  assert.notEqual((await pixels(page)).hash, initial.hash, 'keyboard pans')
  await page.keyboard.press('w')
  await page.keyboard.press('Enter')
  assert.equal(sockets, 0, 'navigation and gameplay keys never open player transport')

  await page.selectOption('#sp-follow', '3')
  await seek(page, 2400)
  assert.equal(await page.locator('#sp-follow').inputValue(), '3', 'follow survives recorded death')
  await seek(page, 3600)
  assert.equal(await page.locator('#sp-follow').inputValue(), '3', 'follow survives respawn')
  const end = Number(await page.locator('#rp-timeline').getAttribute('max'))
  await seek(page, end)
  assert.equal(await page.locator('#rp-timeline').inputValue(), String(end))
  assert.ok((await pixels(page)).colors > 20, 'terminal frame remains visible')

  await page.reload()
  await startClient(page)
  await until(() => page.locator('#sp-follow option').count().then(n => n === 5), 'reload spectator')
  assert.equal(new URL(page.url()).searchParams.get('view'), 'spectator')
  assert.equal(new URL(page.url()).searchParams.get('replay'), matchId)
  await page.click('#rp-play')
  await seek(page, 3600)
  for (const width of [480, 360]) {
    await page.setViewportSize({ width, height: 780 })
    await page.waitForFunction(() => {
      const c = document.querySelector('#replay-canvas')
      return c.width === Math.round(c.getBoundingClientRect().width * devicePixelRatio)
    })
    const metrics = await page.evaluate(() => {
      const selectors = ['.spectator-heading', '.spectator-camera', '#replay-canvas', '#rp-hud']
      const rects = selectors.map(s => {
        const { left, right, top, bottom } = document.querySelector(s).getBoundingClientRect()
        return { left, right, top, bottom }
      })
      return { rects, width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth }
    })
    assert.ok(metrics.scroll <= width, `no horizontal overflow at ${width}px`)
    for (const [i, rect] of metrics.rects.entries()) {
      assert.ok(rect.left >= -1 && rect.right <= width + 1 && rect.top >= 0 && rect.bottom <= metrics.height + 1, `panel ${i} in viewport at ${width}px`)
      if (i) assert.ok(rect.top >= metrics.rects[i - 1].bottom - 1, `panel ${i} does not overlap at ${width}px`)
    }
    assert.ok((await pixels(page)).colors > 20, `nonblank canvas at ${width}px`)
    await page.screenshot({ path: join(shots, `narrow-${width}.png`) })
  }
  await page.locator('#replay-canvas').focus()
  await page.keyboard.press('Escape')
  await page.locator('#view-replays').waitFor({ state: 'visible' })
  assert.equal(new URL(page.url()).searchParams.has('replay'), false)
  assert.equal(sockets, 0)
  assert.deepEqual(errors, [])
  console.log(`SPECTATOR_OK screenshots=${shots}`)
} catch (error) {
  await page?.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
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
