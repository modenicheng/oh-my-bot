// 回放 UI 端到端验收（CDP 驱动 headless Chrome，无需 Playwright 依赖）。
// 流程：加入表单（不入房）→ 大厅不可达时直接 URL 参数进入回放库 →
//       实际上回放库入口在大厅；为免依赖 WS，直接操作 DOM：dispatch click。
// 验收：列表加载 → 点击 REPLAY1 → 时间轴拖动 → HUD 更新 → 截图。
import WebSocket from 'ws'
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://127.0.0.1:5199'
const SHOT_DIR = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

mkdirSync(SHOT_DIR, { recursive: true })

// ---- CDP 基础 ----------------------------------------------------------------

async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  let seq = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, { res, rej })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { ws, send }
}

const { ws, send } = await cdp()
await send('Page.enable')
await send('Runtime.enable')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(SHOT_DIR + name + '.png', Buffer.from(r.data, 'base64'))
  console.log('shot:', name)
}

// ---- 流程 --------------------------------------------------------------------

console.log('打开首页…')
await send('Page.navigate', { url: BASE })
await sleep(2500)

console.log('检查 join 视图存在…')
const hasJoin = await evalJs(`!!document.getElementById('view-join')`)
if (!hasJoin) throw new Error('join 视图缺失')
console.log('join 视图 OK')

// 回放库入口在大厅；大厅需要进房（WS）。为验收 UI 本体，直接调用 openReplays
// 等价路径：模拟点击 btn-replay 前需先显示 room 视图。main.ts 的 btn-replay
// 监听器挂在按钮上，只要视图可见即可点击 —— 但 view-room hidden 由 showView
// 控制。这里直接手动 unhide 并 click（等价于已进房状态）。
console.log('直接进入回放库（等价点击大厅「回放库」）…')
await evalJs(`
  (() => {
    // 模拟已在大厅：显示 room 视图（不影响回放库自身逻辑）
    document.getElementById('view-join').hidden = true
    document.getElementById('view-room').hidden = false
    document.getElementById('btn-replay').click()
    return true
  })()
`)
await sleep(1500)

const listCount = await evalJs(`document.querySelectorAll('#replay-list .replay-item').length`)
console.log('对局列表条数:', listCount)
if (!(listCount > 0)) throw new Error('对局列表为空')
await shot('1-replay-list')

console.log('点击 REPLAY1 对局…')
await evalJs(`
  (() => {
    const items = [...document.querySelectorAll('#replay-list .replay-item')]
    const target = items.find((b) => b.textContent.includes('REPLAY1'))
    if (!target) throw new Error('REPLAY1 不在列表')
    target.click()
    return true
  })()
`)
await sleep(2500)

const playerVisible = await evalJs(`!document.getElementById('view-replay-player').hidden`)
console.log('回放器可见:', playerVisible)
if (!playerVisible) throw new Error('回放器未打开')
await shot('2-replay-player-initial')

// 等待播放推进几秒
await sleep(3000)
const timeText = await evalJs(`document.getElementById('rp-time').textContent`)
const phaseText = await evalJs(`document.getElementById('rp-phase').textContent`)
const scoreRows = await evalJs(`document.querySelectorAll('#rp-score .rp-score-row').length`)
const markCount = await evalJs(`document.querySelectorAll('#rp-marks .rp-mark').length`)
console.log('播放中时间:', timeText, '阶段:', phaseText, '比分行:', scoreRows, '时间轴标记:', markCount)
await shot('3-replay-playing')

console.log('暂停并拖动时间轴到 240s（阶段切换点）…')
await evalJs(`
  (() => {
    document.getElementById('rp-play').click() // 暂停
    const tl = document.getElementById('rp-timeline')
    tl.value = String(240 * 60)
    tl.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()
`)
await sleep(800)
const time240 = await evalJs(`document.getElementById('rp-time').textContent`)
const phase240 = await evalJs(`document.getElementById('rp-phase').textContent`)
console.log('拖动后:', time240, phase240)
await shot('4-replay-seek-240s')

console.log('步进 +1s ×2 …')
await evalJs(`document.getElementById('rp-fwd').click(); document.getElementById('rp-fwd').click()`)
await sleep(400)
const timeStep = await evalJs(`document.getElementById('rp-time').textContent`)
console.log('步进后:', timeStep)

console.log('倍速切换 4×…')
await evalJs(`for (let i=0;i<2;i++) document.getElementById('rp-speed').click()`)
const speedText = await evalJs(`document.getElementById('rp-speed').textContent`)
console.log('倍速:', speedText)
await evalJs(`document.getElementById('rp-play').click()`)
await sleep(2500)
await shot('5-replay-4x')

console.log('返回列表…')
await evalJs(`document.getElementById('rp-return').click()`)
await sleep(600)
const backOk = await evalJs(`!document.getElementById('view-replays').hidden`)
console.log('回到列表:', backOk)
await shot('6-back-to-list')

// 断言汇总
if (timeText === '0:00') throw new Error('播放未推进')
if (phase240 !== '核心开放') throw new Error(`240s 阶段应为核心开放，实际 ${phase240}`)
if (markCount < 6) throw new Error('时间轴标记不足')
console.log('E2E OK')
ws.close()
process.exit(0)
