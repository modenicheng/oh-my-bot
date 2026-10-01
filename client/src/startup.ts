import { asciiField, asciiTitle } from './startup-art'

const root = document.getElementById('startup')!
const status = document.getElementById('startup-status')!
const retry = document.getElementById('startup-retry')!
const progress = document.getElementById('startup-progress') as HTMLProgressElement
const title = document.getElementById('startup-ascii')!
const field = document.getElementById('startup-field')!
const background = ['app', 'audio-settings', 'connection-notice'].map(id => document.getElementById(id)!)
const motion = matchMedia('(prefers-reduced-motion: reduce)')
let application: typeof import('./main') | undefined
let frame = 0
let animation: number | undefined
let ready = false
let starting = false

function paint(): void {
  title.textContent = asciiTitle(frame)
  field.textContent = asciiField(frame++, Math.ceil(innerWidth / 18), Math.ceil(innerHeight / 30))
}
function stopAnimation(): void { window.clearInterval(animation); animation = undefined }
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
  if (!event.isTrusted || root.hidden) return
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
    root.dataset.state = 'leaving'
    window.setTimeout(enter, motion.matches ? 0 : 240)
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
