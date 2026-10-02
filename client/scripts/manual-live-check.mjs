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

  // 第 6 章（新增）：图鉴页——双 reader 图片断言（真服务器 embed）。
  // reference 章节第 6 个子页（order 45）：正文图片走 /api/manual/ 图片路由并真实加载。
  await page.locator('#manual-sidebar .toc-section', { hasText: 'API 总览' }).locator('> a').first().click()
  await page.locator('#manual-content h1').first().waitFor({ timeout: 10000 })
  await page.locator('#manual-sidebar .toc-children a', { hasText: '图鉴' }).first().click()
  await page.locator('#manual-content h1').first().waitFor({ timeout: 10000 })
  assert.match(await page.locator('#manual-content h1').first().textContent(), /图鉴/)
  const refChildren = await page.locator('#manual-sidebar .toc-section', { hasText: 'API 总览' }).locator('.toc-children a').allTextContents()
  assert.equal(refChildren.length, 6, `live reference children = ${JSON.stringify(refChildren)}`)
  const imgs = page.locator('#manual-content .manual-body img')
  const imgCount = await imgs.count()
  assert.equal(imgCount, 10, `live visual image count = ${imgCount}, want 10`)
  for (let i = 0; i < imgCount; i++) {
    const src = await imgs.nth(i).getAttribute('src')
    assert.match(src, /^\/api\/manual\/reference\/images\/(?:sheet|ui)-[a-z-]+\.png$/, `img src = ${src}`)
  }
  await page.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('#manual-content .manual-body img')]
    return nodes.length === 10 && nodes.every(img => img.complete && img.naturalWidth > 0)
  }, undefined, { timeout: 10000 })
  const natural = await imgs.evaluateAll(nodes => nodes.map(n => ({ ok: n.complete && n.naturalWidth > 0 })))
  assert.ok(natural.every(n => n.ok), `live visual images not loaded: ${JSON.stringify(natural)}`)
  await page.screenshot({ path: resolve(shots, 'live-fullscreen-visual.png') })
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

  // 双 reader 图片断言（workbench 侧）：图鉴页在局内阅读器同样加载真实图片。
  await game.locator('#workbench-toc-toggle').click()
  await game.locator('#workbench-toc .toc-children a', { hasText: '图鉴' }).first().click()
  await game.locator('#workbench-doc-content h1').first().waitFor({ timeout: 10000 })
  assert.match(await game.locator('#workbench-doc-content h1').first().textContent(), /图鉴/)
  const wbImgs = game.locator('#workbench-doc-content .manual-body img')
  const wbImgCount = await wbImgs.count()
  assert.equal(wbImgCount, 10, `live workbench visual image count = ${wbImgCount}, want 10`)
  await game.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('#workbench-doc-content .manual-body img')]
    return nodes.length === 10 && nodes.every(img => img.complete && img.naturalWidth > 0)
  }, undefined, { timeout: 10000 })
  const wbNatural = await wbImgs.evaluateAll(nodes => nodes.map(n => ({ ok: n.complete && n.naturalWidth > 0 })))
  assert.ok(wbNatural.every(n => n.ok), `live workbench visual images not loaded: ${JSON.stringify(wbNatural)}`)
  await game.screenshot({ path: resolve(shots, 'live-workbench-visual.png') })

  // Workbench 先消费编辑上下文；收起后 Esc 才打开对局选项。
  await game.keyboard.press('Escape')
  assert.equal(await game.locator('#game-options').isHidden(), true, 'Esc inside workbench must not open game options')
  await game.locator('#workbench-close').click()
  await game.locator('#game-canvas').focus()
  await game.keyboard.press('Escape')
  await game.locator('#game-options').waitFor({ state: 'visible', timeout: 5000 })
  assert.match(await game.locator('.game-options-note').textContent(), /服务器继续/)
  assert.equal(await game.locator('#options-continue').evaluate(el => el === document.activeElement), true, 'continue receives focus')
  await game.keyboard.press('Escape')
  await game.locator('#game-options').waitFor({ state: 'hidden', timeout: 5000 })
  assert.equal(await game.locator('#game-canvas').evaluate(el => el === document.activeElement), true, 'canvas focus restored')

  // 显式离开清除恢复凭据；刷新后仍停在加入页，不自动重连。
  await game.keyboard.press('Escape')
  await game.locator('#options-leave').click()
  await game.locator('#view-join').waitFor({ state: 'visible', timeout: 10000 })
  assert.equal(await game.evaluate(() => sessionStorage.getItem('omb.join')), null, 'join profile cleared')
  await game.reload({ waitUntil: 'domcontentloaded' })
  await game.locator('#startup[data-state="ready"]').waitFor({ timeout: 20000 })
  await game.keyboard.press('Enter')
  await game.locator('#startup').waitFor({ state: 'hidden' })
  assert.equal(await game.locator('#view-join').isVisible(), true, 'refresh remains on join view')
  assert.equal(await game.locator('#view-game').isHidden(), true, 'refresh does not rejoin game')
  await game.close()

  assert.deepEqual(errors, [], `page errors: ${errors}`)
  console.log(`manual-live-check passed against ${base}: both readers, 10 images, Esc options, explicit leave` )
} finally {
  await browser.close().catch(() => {})
}
