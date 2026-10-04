import { asciiField, asciiTitle, erodeText } from './startup-art'
import { advanceProgress, asciiProgress, loadingDots, progressPercent, progressTarget, type ResourceState } from './startup-progress'
import { hash32 } from './lib/hash'
import { startupResources } from './startup-resources'
import { initAppVersion } from './version'

const root = document.getElementById('startup')!
const status = document.getElementById('startup-status')!
const retry = document.getElementById('startup-retry')!
const progress = document.getElementById('startup-progress')!
const track = document.getElementById('startup-track')!
const percent = document.getElementById('startup-percent')!
const resourceList = document.getElementById('startup-resources')!
const loadNote = document.getElementById('startup-load-note')!
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
const loadTasks = [
  { id: 'client', label: 'client' },
  ...startupResources.map(({ id, label }) => ({ id, label })),
] as const
type LoadTaskId = typeof loadTasks[number]['id']
const loadStates = new Map<LoadTaskId, ResourceState>(loadTasks.map(task => [task.id, 'loading']))
const loadRows = new Map<LoadTaskId, { row: HTMLElement; text: HTMLElement; dots: HTMLElement; sigil: HTMLElement }>()
let visualProgress = 0
let lastProgressAt = performance.now()
let entryPermitted = false

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text
}

function buildLoadingRows(): void {
  for (const task of loadTasks) {
    const row = document.createElement('p')
    row.className = 'startup-load-row'
    row.dataset.resource = task.id
    row.dataset.state = 'loading'
    const label = document.createElement('span')
    label.className = 'startup-load-label'
    const text = document.createElement('span')
    text.className = 'startup-load-text'
    text.textContent = `Loading ${task.label}`
    const dots = document.createElement('span')
    dots.className = 'startup-load-dots'
    dots.setAttribute('aria-hidden', 'true')
    const sigil = document.createElement('span')
    sigil.className = 'startup-load-sigil'
    sigil.setAttribute('aria-hidden', 'true')
    sigil.textContent = '[>>]'
    label.append(text, dots)
    row.append(label, sigil)
    resourceList.append(row)
    loadRows.set(task.id, { row, text, dots, sigil })
  }
  renderProgress()
}

function renderProgress(now = performance.now()): void {
  if (starting || root.hidden) return
  const target = progressTarget([...loadStates.values()])
  visualProgress = advanceProgress(visualProgress, target, now - lastProgressAt, motion.matches)
  lastProgressAt = now
  // Expose actual and visual values separately for diagnostics, never as download bytes.
  progress.dataset.real = String(target.real)
  progress.dataset.cap = String(target.cap)
  progress.dataset.visual = visualProgress.toFixed(3)
  setText(track, asciiProgress(visualProgress, Math.floor(now / 150), 28, motion.matches))
  const value = String(progressPercent(visualProgress))
  setText(percent, `${value}%`)
  if (progress.getAttribute('aria-valuenow') !== value) progress.setAttribute('aria-valuenow', value)
  for (const [id, elements] of loadRows) {
    if (loadStates.get(id) === 'loading') setText(elements.dots, loadingDots(motion.matches ? 2 : Math.floor(now / 400)))
  }
  if (!entryPermitted || root.dataset.state === 'error') return
  const complete = target.complete && visualProgress === 100
  root.dataset.assets = complete ? 'complete' : target.pending ? 'background' : target.failed ? 'degraded' : 'pending'
  if (target.complete && !complete) return
  const note = complete ? 'ALL SYSTEMS READY' : target.pending
    ? 'READY TO ENTER / RESOURCES STILL LOADING' : 'READY TO ENTER / SOME RESOURCES UNAVAILABLE'
  setText(loadNote, note)
  if (!ready) {
    ready = true
    root.dataset.state = 'ready'
    root.setAttribute('aria-busy', 'false')
    retry.hidden = true
    if (!document.hidden) root.focus({ preventScroll: true })
    setText(status, `${status.textContent} ${note}.`)
  }
}

function settleLoadTask(id: LoadTaskId, state: Exclude<ResourceState, 'loading'>): void {
  // Account for elapsed time under the OLD target before advancing a milestone.
  const now = performance.now()
  renderProgress(now)
  loadStates.set(id, state)
  if (starting || root.hidden) return
  const elements = loadRows.get(id)!
  elements.row.dataset.state = state
  setText(elements.text, `${state === 'done' ? 'Loaded' : 'Unavailable'} ${id}`)
  setText(elements.sigil, state === 'done' ? '[OK]' : '[!!]')
  setText(elements.dots, '')
  // Only resource state changes reach this live region, never animation frames.
  setText(status, loadTasks.map(task => `${loadStates.get(task.id) === 'done' ? 'Loaded' : loadStates.get(task.id) === 'error' ? 'Unavailable' : 'Loading'} ${task.label}.`).join(' '))
  const done = [...loadStates.values()].filter(value => value === 'done').length
  progress.setAttribute('aria-valuetext', `${done} of ${loadTasks.length} resources loaded; progress estimated between milestones`)
  renderProgress(now)
}

function paint(): void {
  title.textContent = asciiTitle(frame)
  field.textContent = asciiField(frame++, Math.ceil(innerWidth / 18), Math.ceil(innerHeight / 30))
  renderProgress()
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
      const hash = hash32((x / cell + 1) * 73 + (y / cell + 1) * 193)
      const distance = Math.hypot(x + cell / 2 - ox, y + cell / 2 - oy) / farthest
      tiles.push({ x, y, at: 0.15 + distance * 0.52 + (hash % 101) / 101 * 0.17, glyph: '01[]{}+*#'[hash % 9]! })
    }
  }
  const texts = [title, field, startPrompt, loadNote,
    ...[...loadRows.values()].flatMap(({ text, sigil, dots }) => [text, sigil, dots]),
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
  lastProgressAt = performance.now()
  paint()
  if (!motion.matches) animation = window.setInterval(paint, 100)
}
function fail(): void {
  ready = false
  root.dataset.state = 'error'
  root.setAttribute('aria-busy', 'false')
  loadNote.textContent = 'CLIENT LOAD FAILED · RELOAD REQUIRED'
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
  buildLoadingRows()
  for (const resource of startupResources) {
    resource.promise.then(
      loaded => settleLoadTask(resource.id, loaded ? 'done' : 'error'),
      error => {
        console.warn(`Startup resource unavailable: ${resource.id}`, error)
        settleLoadTask(resource.id, 'error')
      },
    )
  }
  const slow = window.setTimeout(() => {
    loadNote.textContent = 'STILL LOADING · CHECK NETWORK IF THIS PERSISTS'
    retry.hidden = false
  }, 15000)
  try {
    application = await import('./main')
    settleLoadTask('client', 'done')
    let timeout: number | undefined
    // 图片、字体、音频与编辑器都有降级/重试路径；挂起时不永久阻止进入。
    await Promise.race([
      application.ready,
      new Promise<void>(resolve => { timeout = window.setTimeout(resolve, 8000) }),
    ]).finally(() => window.clearTimeout(timeout))
    entryPermitted = true
    renderProgress()
  } catch (error) {
    console.error('Client loading failed', error)
    settleLoadTask('client', 'error')
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
