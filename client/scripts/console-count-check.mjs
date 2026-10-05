import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { create, fromBinary } from '@bufbuild/protobuf'
import {
  ClientMsgSchema, EvMapBootstrapSchema, EvRoomStateSchema, EvScriptLogSchema,
  ServerMsgSchema, SnapshotDeltaSchema,
} from '../../packages/protocol/src/index.ts'
import { FixtureServer, gen2MapJson, sleep, startStaticServer, until, frame } from './harness.mjs'
import { startClient } from './startup-helpers.mjs'

// console-count-check.mjs — Console 计数槽位稳定性（真实渲染几何回归）。
//
// 单测 console-count-layout.test.ts 锁样式约定；这里在真实浏览器里验证
// 行为：计数从 1→2→3→4→5 位数增长时，两个计数槽自身与相邻控件（辅助 ON、
// 收起按钮、"清空"、"×"）的几何（左边缘/宽度）不得变化——右对齐 + 预留
// 4ch 槽吸收位数增长（折叠计数可上 4 位，如截图 2773），>4 位才自然扩展；
// 重复折叠徽标 9→10 时同一行的 t/level 文本不得位移。字体断言钉住
// tabular-nums 约定落在渲染结果上。
//
// 前置：`pnpm --filter client build`（服务 dist/）。确定性 protobuf WS
// fixture，不打真实服务器；不提交脚本、不改折叠/日志/清空语义。

const PORT = 18436
const BASE = `http://127.0.0.1:${PORT}`
const CLIENT_DIR = resolve(import.meta.dirname, '..')
const DIST = join(CLIENT_DIR, 'dist')
const SHOTS = resolve(process.env.OMB_SHOTS || '../.artifacts/console-count')

const R_WARMUP = 1
const SELF_ID = 101
const REV = 3
const MAP_JSON = gen2MapJson('concnt01')

/** warmup 快照：单个机器人站桩，脚本日志经 scriptLog 事件注入。 */
function freshState() {
  return {
    tick: 8000, phase: 1, timeLeftS: 480,
    robots: [{ base: { id: SELF_ID, pos: { x: 0, y: 0 }, heading: 0 }, hpX10: 1000, energyX10: 1000, nick: 'concnt', color: '#22d3ee' }],
    projectiles: [], cores: [], healthPacks: [], uplinks: [],
    self: { robotId: SELF_ID, moveSrc: 1, turretSrc: 1, aiRoundsLeft: 0, aiTokensLeftK: 0, assistOn: false },
    gone: { robots: [], projectiles: [], cores: [] },
  }
}

class ConsoleCountFixture extends FixtureServer {
  constructor() {
    super()
    this.st = freshState()
  }

  onFrame(conn, buf) {
    if (buf[0] === frame.ping) { conn.ws.send(Buffer.from([frame.pong])); return }
    if (buf[0] !== frame.up) return
    try { fromBinary(ClientMsgSchema, buf.subarray(1)) } catch { return }
  }

  accept(conn) {
    conn.joined = true
    this.st = freshState()
    this.send(conn, this.event('roomState', EvRoomStateSchema, { state: R_WARMUP, robotsOnline: 1, hostNick: 'concnt' }, 0))
    this.send(conn, this.event('mapBootstrap', EvMapBootstrapSchema, { mapJson: MAP_JSON, mapHash: 'concnt01', generatorVersion: 2 }, 0))
    this.sendFull(conn)
  }

  log(conn, tick, text) {
    this.send(conn, this.event('scriptLog', EvScriptLogSchema, { robotId: SELF_ID, scriptRev: REV, tick, level: 'log', text, truncated: false }))
  }

  snapshotMsg(full) {
    const st = this.st
    st.tick += 1
    return create(ServerMsgSchema, { payload: { case: 'snapshot', value: create(SnapshotDeltaSchema, {
      tick: st.tick, ackSeq: 0, phase: st.phase, timeLeftS: st.timeLeftS, full,
      robots: st.robots.map(r => ({ base: r.base, hpX10: r.hpX10, energyX10: r.energyX10, nick: r.nick, color: r.color })),
      robotGone: [], projectiles: [], projectileGone: [], cores: [], coreGone: [],
      healthPacks: [], uplinks: [], self: st.self,
    }) } })
  }

  sendFull(conn) { this.send(conn, this.snapshotMsg(true)) }
}

/** 控件几何：三个计数槽自身 + 相邻控件（左边缘为主，宽度兜底）。 */
async function geometry(page) {
  return page.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x * 10) / 10, w: Math.round(r.width * 10) / 10 } }
    const q = s => document.querySelector(s)
    return {
      toggleCount: box(q('[data-console-trigger-count]')),
      assist: box(q('#workbench-assist')),
      collapse: box(q('[data-panel="editor"]')),
      tabCount: box(q('.script-console-tab [data-console-count]')),
      clear: box(q('.script-console-clear')),
      closeButton: box(q('.script-console-close')),
    }
  })
}

/** 重复折叠徽标与其后的 t/level 文本（meta 内的 position span，inline 盒即文本盒）。 */
async function badgeProbe(page) {
  return page.evaluate(() => {
    const r1 = v => Math.round(v * 10) / 10
    const badge = document.querySelector('.script-console-repeat')
    if (!badge) return null
    const position = [...badge.parentElement.children].find(el => el !== badge && el.classList && el.classList.contains('script-console-meta'))
    if (!position) return null
    const b = badge.getBoundingClientRect()
    const t = position.getBoundingClientRect()
    return { count: badge.textContent, badgeX: r1(b.x), badgeW: r1(b.width), textX: r1(t.x) }
  })
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`dist missing: ${join(DIST, 'index.html')} — run "pnpm --filter client build" first`)
  process.exit(1)
}
mkdirSync(SHOTS, { recursive: true })

const server = await startStaticServer(PORT, DIST)
const fix = new ConsoleCountFixture()
fix.attach(server)
let browser
const errors = []
try {
  browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE)
  await startClient(page)
  await page.fill('#in-room', 'CONCNT')
  await page.fill('#in-nick', 'concnt')
  await page.click('#btn-join')
  await page.locator('#view-game').waitFor({ timeout: 10000 })
  await page.click('#btn-game-editor')
  await page.locator('#workbench-console-toggle').waitFor({ timeout: 20000 })

  // 字体就绪后再取几何基线，避免首屏字体 swap 混进测量。
  await page.evaluate(() => document.fonts.ready)
  await sleep(150)

  const conn = () => [...fix.conns][0]
  const countText = () => page.locator('[data-console-trigger-count]').textContent()
  const tick = { value: 8000 }

  // ---- 1. 1→2→3→4→5 位数：计数槽与相邻控件几何不变 ------------------
  fix.log(conn(), ++tick.value, 'count-probe')
  await until(async () => (await countText()) === '1', 'first log counted', 10000)
  const base = await geometry(page)
  assert.ok(base.toggleCount.w >= 20 && base.tabCount.w >= 20, 'both slots actually reserve their 4ch slot')

  for (const count of [2, 10, 250, 1250, 21250]) {
    while (await countText() !== String(count)) {
      fix.log(conn(), ++tick.value, `flood-${count}`)
      await sleep(5)
    }
    await until(async () => (await countText()) === String(count), `count reaches ${count}`, 15000)
    const g = await geometry(page)
    for (const [key, label] of [['toggleCount', 'toggle count slot'], ['assist', '辅助 ON'], ['collapse', 'collapse button'], ['tabCount', 'tab count slot'], ['clear', '清空'], ['closeButton', '×']]) {
      assert.equal(g[key].x, base[key].x, `${label} left edge fixed at count ${count}`)
      assert.equal(g[key].w, base[key].w, `${label} width fixed at count ${count}`)
    }
  }
  await page.screenshot({ path: join(SHOTS, '01-count-4-digits.png') })

  // ---- 2. 渲染层钉住 tabular-nums -----------------------------------
  const numeric = await page.evaluate(() => {
    const cs = el => getComputedStyle(el).fontVariantNumeric
    return {
      toggle: cs(document.querySelector('[data-console-trigger-count]')),
      tab: cs(document.querySelector('.script-console-tab [data-console-count]')),
    }
  })
  assert.equal(numeric.toggle, 'tabular-nums', 'toggle count uses tabular-nums')
  assert.equal(numeric.tab, 'tabular-nums', 'tab count uses tabular-nums')

  // ---- 3. 清空：计数归零，槽位几何不变，空态提示恢复 ------------------
  await page.click('.script-console-clear')
  await until(async () => (await countText()) === '0', 'count resets after clear', 10000)
  const cleared = await geometry(page)
  assert.equal(cleared.toggleCount.w, base.toggleCount.w, 'count slot width survives clear')
  assert.equal(cleared.assist.x, base.assist.x, 'neighbors survive clear')
  assert.ok((await page.locator('.script-console-list').textContent()).includes('等待脚本输出'), 'clear restores empty-state hint')

  // ---- 4. 重复折叠徽标 9→10：相邻同文本折叠，同行 t/level 文本不位移 ---
  // 注意重复折叠只合并 robotId/rev/level/text 完全一致的相邻行；
  // flood-* 每条文本不同，不会混进这一组。
  for (let i = 1; i <= 9; i++) fix.log(conn(), ++tick.value, 'repeat-probe')
  await until(async () => (await badgeProbe(page))?.count === '9', 'badge folds to 9', 10000)
  const at9 = await badgeProbe(page)
  fix.log(conn(), ++tick.value, 'repeat-probe')
  await until(async () => (await badgeProbe(page))?.count === '10', 'badge folds to 10', 10000)
  const at10 = await badgeProbe(page)
  assert.equal(at10.badgeX, at9.badgeX, 'repeat badge left edge fixed from 9 to 10')
  assert.equal(at10.badgeW, at9.badgeW, 'repeat badge width fixed from 9 to 10')
  assert.equal(at10.textX, at9.textX, 'adjacent tick/level text does not shift from 9 to 10')
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.script-console-repeat')).fontVariantNumeric), 'tabular-nums', 'repeat badge uses tabular-nums')
  await page.screenshot({ path: join(SHOTS, '02-repeat-badge-10.png') })

  assert.deepEqual(errors, [], 'no page errors during console count acceptance')
  console.log('\n=== console-count-check PASS ===')
  console.log('count slots, neighbors, and repeat badge stay fixed across digit growth')
  console.log(`screenshots in: ${SHOTS}`)
} finally {
  if (browser) await browser.close()
  for (const c of fix.conns) { try { c.ws.terminate() } catch {} }
  try { fix.wss.close() } catch {}
  server.close()
}
