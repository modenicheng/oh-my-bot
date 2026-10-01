import { chromium } from 'playwright'
import { preview } from 'vite'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const shots = resolve(import.meta.dirname, '../../.artifacts/startup')
mkdirSync(shots, { recursive: true })
const server = await preview({ root: resolve(import.meta.dirname, '..'), logLevel: 'silent', preview: { host: '127.0.0.1', port: 18425, strictPort: true } })
const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] })
const errors = []
async function open(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...options })
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(() => {
    window.__startupContexts = []
    window.AudioContext = new Proxy(window.AudioContext, { construct(target, args) {
      const context = Reflect.construct(target, args)
      window.__startupContexts.push({ active: navigator.userActivation.isActive, context })
      return context
    } })
  })
  return page
}
const ready = page => page.locator('#startup[data-state="ready"]').waitFor({ timeout: 20000 })
async function entered(page) {
  await page.locator('#startup').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('#app').evaluate(el => el.inert), false)
  assert.equal(await page.evaluate(() => window.__startupContexts.length), 1)
  assert.equal(await page.evaluate(() => window.__startupContexts[0].active), true)
}
try {
  const page = await open()
  let release
  const held = new Promise(resolve => { release = resolve })
  await page.route('**/assets/main-*.js', async route => { await held; await route.continue() })
  await page.goto('http://127.0.0.1:18425', { waitUntil: 'domcontentloaded' })
  assert.equal(await page.locator('#startup').getAttribute('data-state'), 'loading')
  await page.mouse.click(30, 30)
  assert.equal(await page.evaluate(() => window.__startupContexts.length), 0)
  await page.screenshot({ path: resolve(shots, 'loading.png') })
  release()
  await ready(page)
  assert.equal(await page.locator('#startup button').count(), 0)
  const frame = await page.locator('#startup-ascii').textContent()
  await page.waitForFunction(before => document.getElementById('startup-ascii').textContent !== before, frame)
  await page.evaluate(() => document.getElementById('startup').click())
  assert.equal(await page.evaluate(() => window.__startupContexts.length), 0)
  await page.waitForTimeout(1300)
  await page.screenshot({ path: resolve(shots, 'desktop.png') })
  await page.mouse.click(30, 30)
  await entered(page)
  await page.close()
  for (const key of ['Enter', 'Space', 'a']) {
    const p = await open()
    await p.goto('http://127.0.0.1:18425')
    await ready(p)
    await p.keyboard.press('Shift')
    assert.equal(await p.evaluate(() => window.__startupContexts.length), 0)
    await p.keyboard.press(key)
    await entered(p)
    assert.equal(await p.locator('#in-room').inputValue(), '')
    await p.close()
  }
  const mobile = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  await mobile.goto('http://127.0.0.1:18425')
  await ready(mobile)
  const still = await mobile.locator('#startup-ascii').textContent()
  await mobile.waitForTimeout(350)
  assert.equal(await mobile.locator('#startup-ascii').textContent(), still)
  assert.equal(await mobile.locator('#startup-start').evaluate(el => getComputedStyle(el).animationName), 'none')
  const box = await mobile.locator('#startup-ascii').boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'mobile wordmark fits')
  await mobile.screenshot({ path: resolve(shots, 'mobile.png') })
  await mobile.touchscreen.tap(30, 30)
  await entered(mobile)
  await mobile.close()
  const broken = await open()
  await broken.route('**/assets/main-*.js', route => route.abort())
  await broken.goto('http://127.0.0.1:18425', { waitUntil: 'domcontentloaded' })
  await broken.locator('#startup[data-state="error"]').waitFor()
  assert.equal(await broken.locator('#startup-retry').isVisible(), true)
  assert.equal(await broken.evaluate(() => window.__startupContexts.length), 0)
  await broken.close()
  assert.deepEqual(errors, [])
  console.log('PASS: loading, ASCII motion, trusted click/key/touch, audio, mobile, reduced motion, load error')
} finally {
  await browser.close()
  await new Promise(resolve => server.httpServer.close(resolve))
}
