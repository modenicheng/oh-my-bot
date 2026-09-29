// canvas 像素级验收：确认回放渲染真实绘制（非纯背景）。
// 统计非背景像素与高亮（荧光）像素占比。
import WebSocket from 'ws'

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
let seq = 0
const pending = new Map()
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(m.error.message)) : res(m.result)
  }
})
const send = (method, params = {}) =>
  new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })) })

await send('Page.navigate', { url: 'http://127.0.0.1:5199' })
await new Promise((r) => setTimeout(r, 2500))
await send('Runtime.evaluate', { expression: `(() => { document.getElementById('view-join').hidden = true; document.getElementById('view-room').hidden = false; document.getElementById('btn-replay').click(); return 1 })()`, awaitPromise: true })
await new Promise((r) => setTimeout(r, 1500))
await send('Runtime.evaluate', { expression: `(() => { const items = [...document.querySelectorAll('#replay-list .replay-item')]; items.find((b) => b.textContent.includes('REPLAY1')).click(); return 1 })()`, awaitPromise: true })
await new Promise((r) => setTimeout(r, 3000))

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    document.getElementById('rp-play').click()
    const tl = document.getElementById('rp-timeline')
    tl.value = String(240*60); tl.dispatchEvent(new Event('input', { bubbles: true }))
    return new Promise(resolve => setTimeout(() => {
      const c = document.getElementById('replay-canvas')
      const ctx = c.getContext('2d')
      const data = ctx.getImageData(0, 0, c.width, c.height).data
      let bg = 0, colored = 0, bright = 0
      for (let i = 0; i < data.length; i += 4) {
        const R = data[i], G = data[i+1], B = data[i+2]
        if (R === 10 && G === 14 && B === 20) { bg++; continue }
        colored++
        if (G > 150 || R > 150 || B > 150) bright++
      }
      resolve(JSON.stringify({ w: c.width, h: c.height, bg, colored, bright }))
    }, 800))
  })()`,
  awaitPromise: true,
  returnByValue: true,
})
console.log('canvas stats:', r.result.value)
const stats = JSON.parse(r.result.value)
if (stats.colored < 1000) throw new Error('canvas 几乎全背景色——渲染缺失')
if (stats.bright < 50) throw new Error('无荧光实体像素（机器人/核心未画）')
console.log('CANVAS RENDER OK')
ws.close()
process.exit(0)
