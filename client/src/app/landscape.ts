export interface ViewportPoint { x: number; y: number }
export interface ViewportRect extends ViewportPoint {
  left: number; top: number; right: number; bottom: number; width: number; height: number
}
type Layout = 'auto' | 'touch' | 'desktop'
type LockableScreen = ScreenOrientation & { lock?: (orientation: 'landscape') => Promise<void> }

let current: LandscapeViewport | undefined

/** All canvas and drag geometry uses this same logical space, including CSS rotation. */
export function viewportPoint(clientX: number, clientY: number): ViewportPoint {
  if (!current?.enabled) return { x: clientX, y: clientY }
  if (!current.rotated) return { x: clientX - current.offsetLeft, y: clientY - current.offsetTop }
  return { x: clientY - current.offsetTop, y: current.physicalWidth - clientX + current.offsetLeft }
}

export function viewportRect(element: { getBoundingClientRect(): DOMRect }): ViewportRect {
  const rect = element.getBoundingClientRect()
  const first = viewportPoint(rect.left, rect.top)
  const last = viewportPoint(rect.left + rect.width, rect.top + rect.height)
  const left = Math.min(first.x, last.x), top = Math.min(first.y, last.y)
  const width = Math.abs(last.x - first.x), height = Math.abs(last.y - first.y)
  return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height }
}

export function landscapeSize(): { width: number; height: number } {
  return current?.enabled ? { width: current.width, height: current.height }
    : { width: window.innerWidth, height: window.innerHeight }
}

export function setLandscapeLayout(layout: Layout): void { current?.setLayout(layout) }

/** Native locking is optional; a rejected lock never delays the usable landscape UI. */
export function initLandscapeViewport(): LandscapeViewport {
  return current ?? new LandscapeViewport()
}

export class LandscapeViewport {
  enabled = false
  rotated = false
  width = 0
  height = 0
  physicalWidth = 0
  offsetLeft = 0
  offsetTop = 0
  private layout: Layout = 'auto'
  private readonly coarse = matchMedia('(pointer: coarse)')
  private readonly viewport = window.visualViewport
  private previousWidth = 0
  private lockAttempted = false
  private locked = false
  private disposed = false
  private readonly refresh = () => this.update()
  private readonly gesture = (event: Event) => {
    if (event.isTrusted && this.enabled) void this.requestNativeLandscape()
  }
  private readonly scrolling = new RotatedTouchScroll(() => this.enabled && this.rotated)

  constructor() {
    current = this
    try {
      const stored = localStorage.getItem('omb.mobile.layout')
      if (stored === 'touch' || stored === 'desktop') this.layout = stored
    } catch { /* Storage access is optional. */ }
    window.addEventListener('resize', this.refresh)
    window.addEventListener('orientationchange', this.refresh)
    this.viewport?.addEventListener('resize', this.refresh)
    this.viewport?.addEventListener('scroll', this.refresh)
    this.coarse.addEventListener('change', this.refresh)
    document.addEventListener('pointerdown', this.gesture, true)
    document.addEventListener('keydown', this.gesture, true)
    this.scrolling.attach()
    this.update()
  }

  setLayout(layout: Layout): void {
    this.layout = layout
    this.update()
  }

  async requestNativeLandscape(): Promise<void> {
    if (this.disposed || !this.enabled || this.lockAttempted) return
    this.lockAttempted = true
    const orientation = window.screen?.orientation as LockableScreen | undefined
    try {
      await orientation?.lock?.('landscape')
      if (!orientation?.lock) return
      if (this.disposed) orientation.unlock?.()
      else this.locked = true
    } catch { /* Safari and embedded browsers use the rotated surface instead. */ }
  }

  private update(): void {
    if (this.disposed) return
    const enabled = this.layout === 'touch' || this.layout === 'auto' && this.coarse.matches
    // Pinch zoom changes the visible area, not the layout viewport. Let the browser
    // magnify/pan the surface instead of reflowing it into the zoomed-in rectangle.
    const scale = this.viewport?.scale || 1
    const zoomed = scale > 1.01
    const physicalWidth = zoomed ? window.innerWidth : this.viewport?.width || window.innerWidth
    const physicalHeight = zoomed ? window.innerHeight : this.viewport?.height || window.innerHeight
    const offsetLeft = scale > 1.01 ? this.offsetLeft : this.viewport?.offsetLeft || 0
    const offsetTop = scale > 1.01 ? this.offsetTop : this.viewport?.offsetTop || 0
    const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]')
    // An on-screen keyboard changes height, not device orientation. Preserve the axis
    // until the device's width changes so focusing a composer never flips the surface.
    const portrait = editing && this.previousWidth === window.innerWidth
      ? this.rotated : window.innerHeight > window.innerWidth
    const rotated = enabled && portrait
    const width = rotated ? physicalHeight : physicalWidth
    const height = rotated ? physicalWidth : physicalHeight
    const changed = enabled !== this.enabled || rotated !== this.rotated ||
      width !== this.width || height !== this.height ||
      this.offsetLeft !== offsetLeft || this.offsetTop !== offsetTop
    this.enabled = enabled
    this.rotated = rotated
    this.width = width
    this.height = height
    this.physicalWidth = physicalWidth
    this.offsetLeft = offsetLeft
    this.offsetTop = offsetTop
    this.previousWidth = window.innerWidth
    const root = document.documentElement
    root.classList.toggle('mobile-landscape', enabled)
    root.classList.toggle('mobile-rotated', rotated)
    root.style.setProperty('--app-width', `${width}px`)
    root.style.setProperty('--app-height', `${height}px`)
    root.style.setProperty('--app-offset-left', `${this.offsetLeft}px`)
    root.style.setProperty('--app-offset-top', `${this.offsetTop}px`)
    if (changed) window.dispatchEvent(new Event('landscapechange'))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('resize', this.refresh)
    window.removeEventListener('orientationchange', this.refresh)
    this.viewport?.removeEventListener('resize', this.refresh)
    this.viewport?.removeEventListener('scroll', this.refresh)
    this.coarse.removeEventListener('change', this.refresh)
    document.removeEventListener('pointerdown', this.gesture, true)
    document.removeEventListener('keydown', this.gesture, true)
    this.scrolling.dispose()
    if (this.locked) {
      try { window.screen.orientation.unlock?.() } catch { /* Optional enhancement. */ }
    }
    if (current === this) {
      current = undefined
      document.documentElement.classList.remove('mobile-landscape', 'mobile-rotated')
    }
  }
}

/** Chromium does not reliably project native scrolling through a rotated root.
 * Only the CSS fallback needs this adapter; native landscape keeps browser scrolling.
 * Multi-touch is left entirely to the browser, including pinch zoom.
 */
class RotatedTouchScroll {
  private gesture?: { id: number; x: number; y: number; moved: boolean; nodes: HTMLElement[] }
  constructor(private readonly enabled: () => boolean) {}

  private readonly start = (event: TouchEvent) => {
    this.gesture = undefined
    if (!this.enabled() || event.touches.length !== 1 || !(event.target instanceof Element)) return
    if (event.target.closest('select, input[type="range"]')) return
    const nodes: HTMLElement[] = []
    for (let node: Element | null = event.target; node && node !== document.body; node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue
      const style = getComputedStyle(node)
      if ((/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) ||
          (/auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1)) nodes.push(node)
    }
    if (!nodes.length) return
    const touch = event.touches[0]!
    const point = viewportPoint(touch.clientX, touch.clientY)
    this.gesture = { id: touch.identifier, ...point, moved: false, nodes }
  }

  private readonly move = (event: TouchEvent) => {
    const gesture = this.gesture
    if (!gesture || !this.enabled() || event.touches.length !== 1) { this.gesture = undefined; return }
    const touch = Array.from(event.touches).find(touch => touch.identifier === gesture.id)
    if (!touch) return
    const point = viewportPoint(touch.clientX, touch.clientY)
    const dx = gesture.x - point.x, dy = gesture.y - point.y
    if (!gesture.moved && Math.hypot(dx, dy) < 6) return
    gesture.moved = true
    event.preventDefault()
    const horizontal = Math.abs(dx) > Math.abs(dy)
    for (const node of gesture.nodes) {
      const style = getComputedStyle(node)
      const delta = horizontal ? dx : dy
      const position = horizontal ? node.scrollLeft : node.scrollTop
      const max = horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight
      if (!/auto|scroll/.test(horizontal ? style.overflowX : style.overflowY) || max <= 1) continue
      if (delta < 0 && position <= 0 || delta > 0 && position >= max) continue
      if (horizontal) node.scrollLeft += delta
      else node.scrollTop += delta
      break
    }
    gesture.x = point.x
    gesture.y = point.y
  }

  private readonly end = () => {
    this.gesture = undefined
  }
  attach(): void {
    document.addEventListener('touchstart', this.start, { passive: true })
    document.addEventListener('touchmove', this.move, { passive: false })
    document.addEventListener('touchend', this.end)
    document.addEventListener('touchcancel', this.end)
  }
  dispose(): void {
    this.gesture = undefined
    document.removeEventListener('touchstart', this.start)
    document.removeEventListener('touchmove', this.move)
    document.removeEventListener('touchend', this.end)
    document.removeEventListener('touchcancel', this.end)
  }
}
