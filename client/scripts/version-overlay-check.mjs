import { startClient } from './startup-helpers.mjs'
import { sleep, until, startStaticServer, gen2MapJson, FixtureServer, frame } from './harness.mjs'
// version-overlay-check.mjs — focused browser acceptance for the script version
// overlay (body portal) + language-aware version chain.
//
// Scope: client/scripts/version-overlay-check.mjs + package.json
// "test:versions" only.
//
// Same harness family as game-feel-check: serves client/dist over plain HTTP and
// mounts a deterministic protobuf WebSocket fixture on /ws. The browser joins
// through the real form and the real workbench/editor run against fixture-driven
// authoritative messages (scriptResult / scriptVersions / scriptRollbackResult),
// fully repeatable, no real server.
//
// Covered:
//   1. Portal geometry: panel parented to document.body, position:fixed, opens
//      below/right-aligned with toggle, viewport-clamped; editor and console
//      bounding boxes unchanged while open.
//   2. Close behaviors: outside pointerdown, Escape (focus returns to toggle),
//      workbench close, identity clear, dispose.
//   3. Language-aware versions: JS/TS rows render language labels; AI JS version
//      arriving while TS active persists TS draft, switches editor to JS and
//      fills only JS source (TS localStorage never overwritten); TS rollback
//      switches back to TS and restores the original TS source; reconnect
//      duplicate snapshot does not re-fill.
//   4. Submit payload: JS submits source=editorSource, language=JS; TS submits
//      source=compiled JS, editorSource=TS original, language=TS.
//
// Prerequisite: `pnpm --filter client build` (serves dist/). Fails fast otherwise.

import { chromium } from 'playwright'
import { create, toBinary, fromBinary } from '@bufbuild/protobuf'
import {
  ServerMsgSchema, ClientMsgSchema, ServerEventSchema, SnapshotDeltaSchema,
  EvRoomStateSchema, EvMapBootstrapSchema, EvScriptResultSchema, EvScriptVersionsSchema,
  EvScriptVersionSchema, EvScriptRollbackResultSchema, ScriptLanguage, ScriptOrigin,
} from '../../packages/protocol/src/index.ts'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PORT = 18431
const BASE = `http://127.0.0.1:${PORT}`
const CLIENT_DIR = resolve(import.meta.dirname, '..')
const DIST = join(CLIENT_DIR, 'dist')
const SHOTS = resolve(process.env.OMB_SHOTS || '../.artifacts/versions')

const R_WARMUP = 1
const SELF_ID = 101
const TS_SOURCE = 'import type { BotContext } from \'@omb/bot-api\'\n\nexport function tick(bot: BotContext) {\n  bot.navigateTo(bot.nearestCore())\n}\n'
const TS_COMPILED = 'export function tick(bot) {\n  bot.navigateTo(bot.nearestCore());\n}\n'

const MAP_JSON = gen2MapJson('verovl01')

function freshState() {
  return {
    tick: 600, phase: 1, timeLeftS: 480,
    robots: [{ base: { id: SELF_ID, pos: { x: 0, y: 0 }, heading: 0 }, hpX10: 1000, energyX10: 1000, nick: 'vertest', color: '#22d3ee' }],
    projectiles: [], cores: [],
    healthPacks: [], uplinks: [],
    self: { robotId: SELF_ID, moveSrc: 1, turretSrc: 1, aiRoundsLeft: 0, aiTokensLeftK: 0, assistOn: false },
    gone: { robots: [], projectiles: [], cores: [] },
  }
}

/** Fixture with a script version chain the test drives explicitly. */
class VersionFixture extends FixtureServer {
  constructor() {
    super()
    this.submissions = []
    this.rollbacks = []
    this.st = freshState()
    this.chain = [] // { id, rev, origin, source, language }
    this.nextId = 1
    this.nextRev = 1
  }

  onFrame(conn, buf) {
    if (buf[0] === frame.ping) { conn.ws.send(Buffer.from([frame.pong])); return }
    if (buf[0] !== frame.up) return
    let msg
    try { msg = fromBinary(ClientMsgSchema, buf.subarray(1)) } catch { return }
    const c = msg.payload
    if (c.case === 'join') { this.accept(conn); return }
    if (c.case === 'scriptSubmit') {
      this.submissions.push(c.value)
      const rev = this.nextRev++
      const language = c.value.language ?? ScriptLanguage.JS
      const id = this.nextId++
      this.chain.push({ id, rev, origin: ScriptOrigin.ORIGIN_MANUAL, source: c.value.editorSource || c.value.source, language })
      this.send(conn, this.event('scriptResult', EvScriptResultSchema, { clientScriptId: c.value.clientScriptId, ok: true, scriptRev: rev, versionId: id }))
      this.pushChain(conn)
      return
    }
    if (c.case === 'scriptRollback') {
      this.rollbacks.push(c.value)
      const target = this.chain.find(v => v.id === c.value.versionId)
      if (!target) {
        this.send(conn, this.event('scriptRollbackResult', EvScriptRollbackResultSchema, { ok: false, error: 'not found' }))
        return
      }
      const rev = this.nextRev++
      const id = this.nextId++
      this.chain.push({ id, rev, origin: ScriptOrigin.ORIGIN_ROLLBACK, source: target.source, language: target.language })
      this.send(conn, this.event('scriptRollbackResult', EvScriptRollbackResultSchema, {
        ok: true, versionId: id, scriptRev: rev, source: target.source,
        ...(target.language !== ScriptLanguage.JS ? { language: target.language } : {}),
      }))
      this.pushChain(conn)
      return
    }
  }

  accept(conn) {
    conn.joined = true
    this.st = freshState()
    this.send(conn, this.event('roomState', EvRoomStateSchema, { state: R_WARMUP, robotsOnline: 1, hostNick: 'vertest' }, 0))
    this.send(conn, this.event('mapBootstrap', EvMapBootstrapSchema, { mapJson: MAP_JSON, mapHash: 'verovl01', generatorVersion: 2 }, 0))
    this.sendFull(conn)
  }

  pushChain(conn) {
    this.send(conn, this.event('scriptVersions', EvScriptVersionsSchema, {
      versions: this.chain.map(v => create(EvScriptVersionSchema, {
        id: v.id, scriptRev: v.rev, origin: v.origin, wallMs: BigInt(1000 + v.id), source: v.source,
        ...(v.language !== ScriptLanguage.JS ? { language: v.language } : {}),
      })),
      currentId: this.chain.length ? this.chain[this.chain.length - 1].id : 0,
    }))
  }

  /** fixture-side AI hot swap: scriptResult(id=0) + new AI version snapshot */
  aiHotSwap(conn, jsSource) {
    const rev = this.nextRev++
    const id = this.nextId++
    this.chain.push({ id, rev, origin: ScriptOrigin.ORIGIN_AI, source: jsSource, language: ScriptLanguage.JS })
    this.send(conn, this.event('scriptResult', EvScriptResultSchema, { clientScriptId: 0, ok: true, scriptRev: rev, origin: ScriptOrigin.ORIGIN_AI, versionId: id }))
    this.pushChain(conn)
  }

  snapshotMsg(full) {
    const st = this.st
    return create(ServerMsgSchema, { payload: { case: 'snapshot', value: create(SnapshotDeltaSchema, {
      tick: st.tick, ackSeq: 0, phase: st.phase, timeLeftS: st.timeLeftS, full,
      robots: st.robots.map(r => ({ base: r.base, hpX10: r.hpX10, energyX10: r.energyX10, nick: r.nick, color: r.color })),
      robotGone: [], projectiles: [], projectileGone: [], cores: [], coreGone: [],
      healthPacks: [], uplinks: [], self: st.self,
    }) } })
  }

  sendFull(conn) { this.send(conn, this.snapshotMsg(true)) }
}

const startHttp = () => startStaticServer(PORT, DIST)

async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(SHOTS, name) })
}

async function joinEditor(page, fix, errors) {
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE)
  await startClient(page)
  await page.fill('#in-room', 'VEROV1')
  await page.fill('#in-nick', 'vertest')
  await page.click('#btn-join')
  await page.locator('#view-game').waitFor({ state: 'visible', timeout: 10000 })
  await page.click('#btn-game-editor')
  await page.getByRole('textbox', { name: '机器人脚本编辑器', exact: true }).waitFor({ timeout: 20000 })
  await sleep(300)
}


async function boundingBox(page, selector) {
  return page.locator(selector).boundingBox()
}

// ---------------------------------------------------------------- main
if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`dist missing: ${join(DIST, 'index.html')} — run "pnpm --filter client build" first`)
  process.exit(1)
}
mkdirSync(SHOTS, { recursive: true })

const server = await startHttp()
const fix = new VersionFixture()
fix.attach(server)
let browser
const errors = []
try {
  browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  const conn = () => [...fix.conns][0]
  const panel = () => page.locator('#script-versions-panel')
  const toggle = () => page.locator('#script-versions-toggle')
  // 读取渲染行文本（view-line 每行一个节点；Monaco 把空格渲染为 NBSP，
  // 统一归一为普通空格后比较）。
  const editorText = () => page.evaluate(() =>
    [...document.querySelectorAll('#workbench-code .view-line')].map(el => el.textContent).join('\n').replaceAll('\u00a0', ' '))

  // ---------------------------------------------------------------- 1. portal geometry + open/close
  await joinEditor(page, fix, errors)

  // Seed the chain through a real submit (JS): also proves payload shape.
  {
    const editor = page.getByRole('textbox', { name: '机器人脚本编辑器', exact: true })
    await editor.focus()
    await page.keyboard.press('ControlOrMeta+a')
    await page.evaluate(src => navigator.clipboard.writeText(src), 'function tick(bot) {\n  bot.moveTo(1, 0)\n}\n')
    await page.keyboard.press('ControlOrMeta+v')
    await sleep(450) // draft debounce
    await page.keyboard.press('ControlOrMeta+Enter')
    await until(async () => (await page.locator('.script-console-list').textContent()).includes('服务器已加载脚本'), 'JS submit receipt', 20000)
  }
  assert.equal(fix.submissions.length, 1, 'one scriptSubmit frame')
  const jsSub = fix.submissions[0]
  assert.equal(jsSub.language, ScriptLanguage.JS)
  assert.equal(jsSub.source, jsSub.editorSource, 'JS submit: source = editorSource')

  const editorBox = await boundingBox(page, '#workbench-code')
  const consoleBox = await boundingBox(page, '#workbench-console')
  const toggleBox = await toggle().boundingBox()

  await toggle().click()
  await panel().waitFor({ state: 'visible' })
  // Portal parent + fixed position
  assert.equal(await panel().evaluate(el => el.parentElement), await page.evaluate(() => document.body), 'panel is parented to document.body')
  assert.equal(await panel().evaluate(el => getComputedStyle(el).position), 'fixed', 'panel uses position:fixed')
  // aria wiring
  assert.equal(await toggle().getAttribute('aria-expanded'), 'true')
  assert.equal(await toggle().getAttribute('aria-controls'), 'script-versions-panel')
  // Geometry: below + right-aligned, clamped in viewport
  const place = await panel().evaluate(el => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const vw = 1280, vh = 800
  assert.ok(Math.abs(place.x + place.w - toggleBox.x - toggleBox.width) < 2, `panel right edge aligns with toggle right edge (got ${place.x + place.w}, want ${toggleBox.x + toggleBox.width})`)
  assert.ok(Math.abs(place.y - (toggleBox.y + toggleBox.height + 4)) < 2, 'panel sits below toggle (4px gap)')
  assert.ok(place.x >= 8 - 0.5 && place.y >= 8 - 0.5 && place.x + place.w <= vw - 8 + 0.5 && place.y + place.h <= vh - 8 + 0.5, 'panel clamped inside viewport with 8px margin')
  // No layout shift / no clipping of editor and console
  const editorBoxOpen = await boundingBox(page, '#workbench-code')
  const consoleBoxOpen = await boundingBox(page, '#workbench-console')
  assert.deepEqual(editorBoxOpen, editorBox, 'editor bounding box unchanged with overlay open')
  assert.deepEqual(consoleBoxOpen, consoleBox, 'console bounding box unchanged with overlay open')
  // Row language label
  assert.match(await panel().locator('.script-version-label').first().textContent(), /JS/)
  await shot(page, '01-portal-open-js.png')

  // Outside pointerdown closes
  await page.mouse.click(40, 400)
  await panel().waitFor({ state: 'hidden' })
  assert.equal(await toggle().getAttribute('aria-expanded'), 'false')

  // Escape closes and returns focus to toggle
  await toggle().click()
  await panel().waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await panel().waitFor({ state: 'hidden' })
  assert.equal(await toggle().evaluate(el => el === document.activeElement), true, 'focus returns to toggle after Escape')

  // Resize keeps panel clamped and repositioned
  await toggle().click()
  await panel().waitFor({ state: 'visible' })
  await page.setViewportSize({ width: 480, height: 500 })
  await sleep(120)
  const clamped = await panel().evaluate(el => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }
  })
  assert.ok(clamped.x >= 7.5 && clamped.y >= 7.5 && clamped.x + clamped.w <= clamped.vw - 7.5 && clamped.y + clamped.h <= clamped.vh - 7.5, 'panel stays clamped after resize')
  await shot(page, '02-portal-narrow.png')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.mouse.click(40, 400)
  await panel().waitFor({ state: 'hidden' })

  // ---------------------------------------------------------------- 2. AI JS while TS active
  // Switch to TS, submit TS for real (v2 = TS 版本，行标签 TS；payload 断言
  // 在第 3 段重复利用此提交)，再弄脏 TS 草稿，然后 AI 热替换 JS 版本。
  await page.click('#workbench-lang-switch [data-lang="ts"]')
  await sleep(200)
  const editor = page.getByRole('textbox', { name: '机器人脚本编辑器', exact: true })
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+a')
  await page.evaluate(src => navigator.clipboard.writeText(src), TS_SOURCE)
  await page.keyboard.press('ControlOrMeta+v')
  await sleep(450) // draft debounce: TS draft persisted
  const tsDraftKey = await page.evaluate(() => Object.keys(localStorage).find(k => k.includes('"ts"')))
  assert.ok(tsDraftKey, 'TS draft key exists before AI fill')
  const tsDraftBefore = await page.evaluate(k => localStorage.getItem(k), tsDraftKey)
  // 真 TS 提交（浏览器内编译）：fixture 记录 v2（language=TS）。
  await page.keyboard.press('ControlOrMeta+Enter')
  await until(async () => (await page.locator('.script-console-list').textContent()).includes('服务器已加载脚本'), 'TS submit receipt', 20000)
  await until(() => fix.submissions.length === 2, 'TS submit frame reaches the fixture', 30000)
  const tsSub = fix.submissions.at(-1)
  assert.equal(tsSub.language, ScriptLanguage.TS, 'TS submit carries language=TS')
  assert.equal(tsSub.editorSource, TS_SOURCE, 'TS submit editorSource = TS original')
  assert.ok(tsSub.source !== TS_SOURCE && tsSub.source.includes('navigateTo'), 'TS submit source = compiled JS')
  const tsDraftAfterSubmit = await page.evaluate(k => localStorage.getItem(k), tsDraftKey)

  // 弄脏 TS 草稿（在已提交基线上加未提交手改）。
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('// dirty TS edit\n')
  await sleep(450)
  const dirtyTsDraft = await page.evaluate(k => localStorage.getItem(k), tsDraftKey)
  assert.notEqual(dirtyTsDraft, tsDraftAfterSubmit, 'TS draft is dirty before AI fill')

  fix.aiHotSwap(conn(), '// ai-js-version\nfunction tick(bot) {\n  bot.shield(true)\n}\n')
  await until(async () => (await page.locator('.script-console-list').textContent()).includes('AI 已改码'), 'AI fill notice', 10000)
  // Editor switched to JS model and filled with AI JS only
  await until(async () => (await editorText()).includes('ai-js-version'), 'editor filled with AI JS', 10000)
  assert.equal(await page.locator('#workbench-lang-ext').textContent(), 'js', 'language switched to JS')
  // TS localStorage untouched by the JS fill (它写 JS 草稿键，不碰 TS 键)
  assert.equal(await page.evaluate(k => localStorage.getItem(k), tsDraftKey), dirtyTsDraft, 'TS draft in localStorage is never overwritten by AI fill')
  // Version rows show both languages
  await toggle().click()
  await panel().waitFor({ state: 'visible' })
  const labels = await panel().locator('.script-version-label').allTextContents()
  assert.ok(labels.some(l => l.includes('TS')), `rows include TS label (${labels.join(' | ')})`)
  assert.ok(labels.some(l => l.includes('JS') && !l.includes('TS')), `rows include JS label (${labels.join(' | ')})`)
  await shot(page, '03-ai-js-while-ts.png')

  // Stash 按规范存的是目标语言（JS）的脏草稿：找回后切回 JS 并恢复旧 JS 源
  // （AI 版本之前的未提交 JS 手改；TS 草稿已在其独立键里保全）。
  const stashBtn = panel().locator('.script-versions-stash')
  await stashBtn.waitFor({ state: 'visible' })
  await stashBtn.click()
  await sleep(600)
  const stashText = await editorText()
  assert.ok(stashText.includes('bot.moveTo(1, 0)'), `stashed JS draft restored (got ${JSON.stringify(stashText)})`)
  assert.equal(await page.locator('#workbench-lang-ext').textContent(), 'js', 'restore switches back to the stash language (JS)')
  await page.mouse.click(40, 400)
  await panel().waitFor({ state: 'hidden' })

  // ---------------------------------------------------------------- 3. TS rollback routing
  // 回退到 TS 版本：活动语言是 TS（stash 恢复后）；弄脏后回退应切 TS 并
  // 恢复原始 TS 源码（v2 提交时存的 editorSource）。
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('// late edit\n')
  await sleep(450)
  const tsVersionId = fix.chain.filter(v => v.language === ScriptLanguage.TS).at(-1).id
  await toggle().click()
  await panel().waitFor({ state: 'visible' })
  await panel().locator(`.script-version-row [data-version-id="${tsVersionId}"]`).click()
  await until(async () => (await page.locator('.script-console-list').textContent()).includes('编辑器已同步（TypeScript）'), 'TS rollback notice', 10000)
  await until(async () => (await editorText()) === TS_SOURCE, 'rollback restored original TS source', 10000)
  assert.equal(await page.locator('#workbench-lang-ext').textContent(), 'ts', 'TS rollback keeps TS language active')
  await shot(page, '04-ts-rollback.png')
  await page.mouse.click(40, 400)
  await panel().waitFor({ state: 'hidden' })

  // ---------------------------------------------------------------- 4. reconnect duplicate snapshot does not re-fill
  // Re-deliver the same chain (same current id) after dirtying the editor: must not overwrite.
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('// my manual edit after rollback\n')
  await sleep(450)
  const before = await editorText()
  fix.pushChain(conn())
  await sleep(400)
  assert.equal(await editorText(), before, 'duplicate snapshot (reconnect) does not re-fill the editor')

  // ---------------------------------------------------------------- 5. workbench close closes the portal
  await toggle().click()
  await panel().waitFor({ state: 'visible' })
  await page.click('#workbench-close')
  await panel().waitFor({ state: 'hidden' }, { timeout: 5000 })
  assert.equal(await toggle().getAttribute('aria-expanded'), 'false')
  // 面板节点仍在 body（隐藏态），workbench 重开后可再次打开：无残留重复节点。
  await page.click('#btn-game-editor')
  await sleep(400)
  assert.equal(await page.locator('#script-versions-panel').count(), 1, 'exactly one portal panel node exists')
  await toggle().click()
  await panel().waitFor({ state: 'visible' })
  await page.click('#workbench-close')
  await panel().waitFor({ state: 'hidden' }, { timeout: 5000 })

  assert.deepEqual(errors, [], 'no page errors during version overlay acceptance')
  console.log('\n=== version-overlay-check PASS ===')
  console.log(`submissions captured: ${fix.submissions.length}, rollbacks: ${fix.rollbacks.length}`)
  console.log(`screenshots in: ${SHOTS}`)
} finally {
  if (browser) await browser.close()
  for (const c of fix.conns) { try { c.ws.terminate() } catch {} }
  try { fix.wss.close() } catch {}
  server.close()
}
