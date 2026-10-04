import { asciiField, asciiTitle, erodeText } from './startup-art'
import { initAppVersion } from './version'

const root = document.getElementById('startup')!
const status = document.getElementById('startup-status')!
const retry = document.getElementById('startup-retry')!
const progress = document.getElementById('startup-progress') as HTMLProgressElement
const title = document.getElementById('startup-ascii')!
const field = document.getElementById('startup-field')!
const startPrompt = document.getElementById('startup-start')!
const background = ['app', 'audio-settings', 'connection-notice'].map(id => document.getElementById(id)!)
const motion = matchMedia('(prefers-reduced-motion: reduce)')
let application: typeof import('./main') | undefined
let frame = 0
let animation: number | undefined
let ready = false
let starting = false

const EROSION_MS = 900

function paint(): void {
  title.textContent = asciiTitle(frame)
  field.textContent = asciiField(frame++, Math.ceil(innerWidth / 18), Math.ceil(innerHeight / 30))
}
function stopAnimation(): void { window.clearInterval(animation); animation = undefined }
function erodeScreen(): void {
  const canvas = document.createElement('canvas')
  canvas.className = 'startup-erosion'
  canvas.setAttribute('aria-hidden', 'true')
  const width = root.clientWidth, height = root.clientHeight
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) { enter(); return }
  const rect = startPrompt.getBoundingClientRect()
  const ox = rect.left + rect.width / 2, oy = rect.top + rect.height / 2
  const farthest = Math.hypot(Math.max(ox, width - ox), Math.max(oy, height - oy))
  const cell = 24
  const tiles: { x: number; y: number; at: number; glyph: string }[] = []
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      const hash = Math.imul((x / cell + 1) * 73 + (y / cell + 1) * 193, 0x45d9f3b) >>> 0
      const distance = Math.hypot(x + cell / 2 - ox, y + cell / 2 - oy) / farthest
      tiles.push({ x, y, at: 0.15 + distance * 0.52 + (hash % 101) / 101 * 0.17, glyph: '01[]{}+*#'[hash % 9]! })
    }
  }
  const texts = [title, field, startPrompt, status,
    root.querySelector<HTMLElement>('.startup-tagline')!, document.getElementById('startup-help')!]
    .map((element, seed) => ({ element, text: element.textContent ?? '', seed: seed * 173 }))
  const backdrop = getComputedStyle(root).backgroundColor
  ctx.fillStyle = backdrop; ctx.fillRect(0, 0, width, height)
  root.prepend(canvas)
  root.dataset.state = 'eroding'
  // Reveal the app through erased tiles, but keep input locked until completion.
  document.body.dataset.startup = 'eroding'
  const began = performance.now()
  function dissolve(now: number): void {
    if (motion.matches) { canvas.remove(); enter(); return }
    const progress = Math.min(1, (now - began) / EROSION_MS)
    ctx!.clearRect(0, 0, width, height)
    ctx!.font = "14px 'Fusion Pixel', monospace"
    ctx!.textAlign = 'center'; ctx!.textBaseline = 'middle'
    for (const tile of tiles) {
      const age = progress - tile.at
      if (age < 0) {
        ctx!.fillStyle = backdrop; ctx!.fillRect(tile.x, tile.y, cell, cell)
      } else if (age < 0.12) {
        const size = Math.max(2, Math.round((1 - age / 0.12) * cell / 4) * 4)
        ctx!.fillStyle = backdrop
        ctx!.fillRect(tile.x + (cell - size) / 2, tile.y + (cell - size) / 2, size, size)
        ctx!.fillStyle = '#a5e6ef'
        ctx!.fillText(tile.glyph, tile.x + cell / 2, tile.y + cell / 2)
      }
    }
    for (const item of texts) item.element.textContent = erodeText(item.text, progress, item.seed)
    if (progress < 1) window.requestAnimationFrame(dissolve)
    else { canvas.remove(); enter() }
  }
  window.requestAnimationFrame(dissolve)
}
function syncAnimation(): void {
  stopAnimation()
  if (root.hidden || starting || document.hidden) return
  paint()
  if (!motion.matches) animation = window.setInterval(paint, 100)
}
function fail(): void {
  ready = false
  root.dataset.state = 'error'
  root.setAttribute('aria-busy', 'false')
  status.textContent = '客户端加载失败，请重新加载。'
  retry.hidden = false
}
function enter(): void {
  root.hidden = true
  background.forEach(element => { element.inert = false })
  document.body.removeAttribute('data-startup')
  root.removeEventListener('click', activate)
  window.removeEventListener('keydown', activate, true)
  document.removeEventListener('visibilitychange', syncAnimation)
  window.removeEventListener('pageshow', syncAnimation)
  window.removeEventListener('pagehide', stopAnimation)
  motion.removeEventListener('change', syncAnimation)
  const target = [...document.querySelectorAll<HTMLElement>('#app input, #app button, #app [tabindex]')]
    .find(element => element.getClientRects().length > 0 && !element.matches(':disabled'))
  target?.focus({ preventScroll: true })
}
function activate(event: MouseEvent | KeyboardEvent): void {
  if (!event.isTrusted || document.hidden || root.hidden) return
  if ((event.target as Element | null)?.closest('a')) return
  if (starting) {
    // 退出动画期间仍隔离输入，避免连按触发游戏快捷键。
    event.preventDefault()
    event.stopImmediatePropagation()
    return
  }
  if (event instanceof KeyboardEvent) {
    if (event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
    if (['Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key) || /^F[0-9]+$/.test(event.key)) return
  } else if (event.button !== 0) return
  // 加载期不排队手势，就绪后重新按键才能解锁音频。
  event.preventDefault()
  event.stopImmediatePropagation()
  if (!ready || !application) return
  starting = true
  try {
    application.start() // AudioContext 必须在本次真实用户手势中同步解锁。
    stopAnimation()
    if (motion.matches) enter()
    else erodeScreen()
  } catch (error) {
    console.error('Startup failed', error)
    starting = false
    fail()
    retry.focus()
  }
}

async function prepare(): Promise<void> {
  const slow = window.setTimeout(() => {
    status.textContent = '加载时间较长，请检查网络，或重新加载。'
    retry.hidden = false
  }, 15000)
  try {
    application = await import('./main')
    status.textContent = '正在准备字体与机甲素材…'
    let timeout: number | undefined
    // 图片与字体已有渲染兜底，网络挂起不永久阻止进入。
    const assetsLoaded = await Promise.race([
      application.ready.then(() => true),
      new Promise<boolean>(resolve => { timeout = window.setTimeout(() => resolve(false), 8000) }),
    ]).finally(() => window.clearTimeout(timeout))
    progress.max = 1
    progress.value = 1
    root.dataset.state = 'ready'
    root.setAttribute('aria-busy', 'false')
    status.textContent = assetsLoaded ? '准备就绪' : '准备就绪 · 部分素材将继续在后台加载'
    retry.hidden = true
    ready = true
    root.focus({ preventScroll: true })
  } catch (error) {
    console.error('Client loading failed', error)
    fail()
  } finally { window.clearTimeout(slow) }
}

root.addEventListener('click', activate)
window.addEventListener('keydown', activate, true)
document.addEventListener('visibilitychange', syncAnimation)
window.addEventListener('pagehide', stopAnimation)
window.addEventListener('pageshow', syncAnimation)
motion.addEventListener('change', syncAnimation)
syncAnimation()
void prepare()
// 版本页脚：fire-and-forget，不阻塞手势/音频解锁路径。
void initAppVersion()
