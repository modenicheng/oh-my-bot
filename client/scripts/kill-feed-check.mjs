import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EvKillSchema } from '../../packages/protocol/src/index.ts'
import { sleep, until } from './harness.mjs'

export async function killFeedFloodPass(page, fix, { reduced, shots }) {
  await page.evaluate(() => {
    const root = document.querySelector('.kill-feed'), list = root.querySelector('ol')
    const original = list.append.bind(list)
    const m = window.__killFeedMetric = { commits: 0, maxNodes: 0, reads: 0, frame: 0, frames: [], animations: [], nodes: [...root.querySelectorAll('*')] }
    let running = true
    const clock = () => { if (running) { m.frame++; requestAnimationFrame(clock) } }; requestAnimationFrame(clock)
    list.append = (...nodes) => {
      m.commits++; m.frames.push(m.frame); original(...nodes)
      m.maxNodes = Math.max(m.maxNodes, root.querySelectorAll('*').length)
      m.animations.push(...list.getAnimations({ subtree: true }).map(a => a.effect.getKeyframes()))
    }
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const bounds = Element.prototype.getBoundingClientRect
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { ...width, get() { if (root.contains(this)) m.reads++; return width.get.call(this) } })
    Element.prototype.getBoundingClientRect = function (...args) { if (root.contains(this)) m.reads++; return bounds.apply(this, args) }
    m.stop = () => { running = false; list.append = original; Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width); Element.prototype.getBoundingClientRect = bounds }
  })
  const status = await page.locator('#hud-msg').textContent()
  // 1000 distinct pairs drawn from 64 robot IDs, all in one authoritative tick.
  for (let i = 0; i < 1000; i++) fix.bcast(fix.event('kill', EvKillSchema, { killer: 1000 + i % 64, victim: 1000 + Math.floor(i / 64) }))
  const latest = Array.from({ length: 6 }, (_, j) => { const i = 994 + j; return `robot-${1000 + i % 64} 击毁 robot-${1000 + Math.floor(i / 64)}` })
  const visibleRows = () => page.locator('.kill-feed-line:not([hidden]):not([aria-hidden=true])').allTextContents()
  await until(async () => JSON.stringify(await visibleRows()) === JSON.stringify(latest), '1000 kills retain last six in order')
  assert.equal(await page.locator('#hud-msg').textContent(), status, 'kill flood preserves uplink live region')
  const result = await page.evaluate(() => {
    const m = window.__killFeedMetric, root = document.querySelector('.kill-feed')
    return { events: 1000, commits: m.commits, maxNodes: m.maxNodes, geometryReads: m.reads, uniqueFrames: new Set(m.frames).size, reused: m.nodes.every(n => root.contains(n)), animations: m.animations.length }
  })
  assert.ok(result.commits < 30, `1000 events coalesced into ${result.commits} DOM commits`)
  assert.equal(result.uniqueFrames, result.commits, 'at most one commit per animation frame')
  assert.equal(result.maxNodes, 9, 'heading, list and seven pooled rows stay bounded')
  assert.equal(result.geometryReads, 0, 'no forced layout')
  assert.ok(result.reused, 'identical pool nodes survive flood')
  if (reduced) assert.equal(result.animations, 0)
  else assert.ok(result.animations > 0)
  await sleep(120)
  const row = page.locator('.kill-feed-line').filter({ hasText: latest[1] })
  const before = await row.evaluate(el => el.style.transform)
  fix.bcast(fix.event('kill', EvKillSchema, { killer: 1063, victim: 1062 }, fix.st.tick + 1))
  await until(async () => (await row.evaluate(el => el.style.transform)) !== before, 'old row scrolls upward')
  assert.equal(await row.evaluate(el => el.style.transform), 'translateY(0%)')
  if (!reduced) {
    assert.ok(await page.evaluate(() => window.__killFeedMetric.animations.some(keys => parseFloat(keys[0].transform.slice(11)) > parseFloat(keys.at(-1).transform.slice(11)))), 'recorded upward transform animation')
  }
  await page.evaluate(() => window.__killFeedMetric.stop())
  await page.screenshot({ path: join(shots, reduced ? 'kill-feed-flood-reduced.png' : 'kill-feed-flood.png') })
  const viewport = page.viewportSize()
  await page.setViewportSize({ width: 390, height: 844 })
  const mobile = await page.locator('.kill-feed').boundingBox()
  assert.ok(mobile.x >= 0 && mobile.x + mobile.width <= 390 && mobile.y >= 0, 'mobile rail stays in viewport')
  assert.ok(await page.locator('.kill-feed-line').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 12), 'mobile rows remain readable')
  await page.screenshot({ path: join(shots, reduced ? 'kill-feed-mobile-reduced.png' : 'kill-feed-mobile.png') })
  await page.setViewportSize(viewport)
  for (let i = 0; i < 32; i++) fix.bcast(fix.event('kill', EvKillSchema, { killer: 1060, victim: 1000 + i }, fix.st.tick + 2))
  await until(async () => (await visibleRows()).at(-1) === 'robot-1060 连续击毁 ×32', 'same-source streak uses one counted row')
  writeFileSync(join(shots, `kill-feed-metrics-${reduced ? 'reduced' : 'motion'}.json`), JSON.stringify(result, null, 2))
  console.log('kill-feed metrics', JSON.stringify(result))
}
