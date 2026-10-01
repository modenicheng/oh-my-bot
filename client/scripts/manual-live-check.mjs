// 真服务器（server/omb.exe，embed 资源）双 reader 手册验收：
// 全屏手册 + 局内 workbench 阅读器目录/排序/标签一致，中文导航可用。
// 用法：OMB_URL=http://127.0.0.1:18440 npx tsx scripts/manual-live-check.mjs
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const base = process.env.OMB_URL ?? 'http://127.0.0.1:18440'
const shots = resolve(import.meta.dirname, '../../.artifacts/manual')
mkdirSync(shots, { recursive: true })

const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] })
const errors = []

async function open(url) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('#startup[data-state="ready"]').waitFor({ timeout: 20000 })
  await page.keyboard.press('Enter')
  await page.locator('#startup').waitFor({ state: 'hidden' })
  return page
}

try {
  // ---- 全屏手册 ----
  const page = await open(`${base}/?view=manual`)
  await page.locator('#manual-content .manual-body').waitFor({ timeout: 10000 })
  const chapters = await page.locator('#manual-sidebar .toc-section > a').allTextContents()
  assert.deepEqual(chapters.map(c => c.trim()), ['oh-my-bot 玩家手册', '快速上手', '游戏规则', '写自己的 Bot', 'API 总览'],
    `live fullscreen chapter order = ${JSON.stringify(chapters)}`)
  // 点击 order 最小的“快速上手”章节落地页。
  await page.locator('#manual-sidebar .toc-section', { hasText: '快速上手' }).locator('> a').first().click()
  await page.locator('#manual-content h1').first().waitFor({ timeout: 10000 })
  assert.match(await page.locator('#manual-content h1').first().textContent(), /快速上手/)
  await page.screenshot({ path: resolve(shots, 'live-fullscreen-start.png') })
  // 子页标签。
  await page.locator('#manual-sidebar .toc-children a', { hasText: '进房前准备' }).first().click()
  await page.locator('#manual-content .manual-tag').first().waitFor({ timeout: 10000 })
  const chips = await page.locator('#manual-content .manual-tag').allTextContents()
  assert.ok(chips.includes('新手'), `live tag chips = ${JSON.stringify(chips)}`)
  await page.close()

  // ---- 局内 workbench（真 WS：进房即热身，接受即入局） ----
  const game = await open(`${base}/`)
  await game.locator('#in-room').fill('lv01')
  await game.locator('#in-nick').fill('live-manual')
  await game.locator('#btn-join').click()
  // 真服务器：热身房等待开始按钮（host），点击 START 进对局视图。
  await game.locator('#btn-start').waitFor({ state: 'visible', timeout: 15000 })
  await game.locator('#btn-start').click()
  await game.locator('#view-game').waitFor({ state: 'visible', timeout: 15000 })
  await game.locator('#game-canvas').focus()
  await game.keyboard.press('c')
  await game.locator('#workbench').waitFor({ state: 'visible', timeout: 10000 })
  await game.keyboard.press('m')
  await game.locator('#workbench-toc-toggle').click()
  await game.locator('#workbench-toc').waitFor({ state: 'visible' })
  const wbChapters = await game.locator('#workbench-toc .toc-section > a').allTextContents()
  assert.deepEqual(wbChapters.map(c => c.trim()), ['oh-my-bot 玩家手册', '快速上手', '游戏规则', '写自己的 Bot', 'API 总览'],
    `live workbench chapter order = ${JSON.stringify(wbChapters)}`)
  await game.locator('#workbench-toc .toc-section', { hasText: 'API 总览' }).locator('> a').first().click()
  await game.locator('#workbench-doc-content h1').first().waitFor({ timeout: 10000 })
  assert.match(await game.locator('#workbench-doc-content h1').first().textContent(), /API 总览/)
  await game.screenshot({ path: resolve(shots, 'live-workbench-manual.png') })
  await game.close()

  assert.deepEqual(errors, [], `page errors: ${errors}`)
  console.log(`manual-live-check passed against ${base}: both readers, Chinese TOC, order, tags`)
} finally {
  await browser.close().catch(() => {})
}
