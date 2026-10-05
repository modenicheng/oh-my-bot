import { setText } from '../ui/dom'
import './kill-feed.css'

export const KILL_FEED_ROWS = 6
export const KILL_FEED_BATCH_MS = 100
const HOLD_MS = 6000
const MOTION_MS = 90 // Finishes before the next micro-batch; never restarted by individual kills.
export interface KillFeedSource { id: number; name: string }
interface Entry { id: number; text: string; count: number; at: number; source?: KillFeedSource; streak: boolean }
interface Slot { el: HTMLLIElement; id: number; y: number; opacity: number }

/** Bounded at ingestion as well as rendering, including while rAF is suspended. */
export class KillFeed {
  private readonly root = document.createElement('section')
  private readonly list = document.createElement('ol')
  private readonly slots: Slot[] = []
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)')
  private pending: Entry[] = []
  private entries: Entry[] = []
  private serial = 0
  private timer: number | undefined
  private frame: number | undefined
  private disposed = false

  constructor(parent: HTMLElement) {
    this.root.className = 'kill-feed'
    this.root.hidden = true
    this.root.setAttribute('aria-label', '战术通讯 · 最近击毁记录')
    // Reviewable on demand, never one spoken interruption per kill. Status/death retain their own live regions.
    this.root.setAttribute('aria-live', 'off')
    const heading = document.createElement('div')
    heading.className = 'kill-feed-heading'
    heading.textContent = '战术通讯 / 击毁'
    this.list.className = 'kill-feed-lines'
    for (let i = 0; i <= KILL_FEED_ROWS; i++) {
      const el = document.createElement('li')
      el.className = 'kill-feed-line'
      el.hidden = true
      this.slots.push({ el, id: -1, y: 0, opacity: 0 })
      this.list.append(el)
    }
    this.root.append(heading, this.list)
    parent.append(this.root)
    this.reduced.addEventListener('change', this.motionChanged)
  }

  push(text: string, source?: KillFeedSource): void {
    if (this.disposed) return
    const at = performance.now()
    const tail = this.pending[this.pending.length - 1]
    // Only adjacent duplicates/same-attacker streaks coalesce: A, B, A stays in order.
    if (tail && (source ? tail.source?.id === source.id : !tail.source && tail.text === text)) {
      tail.streak ||= tail.text !== text
      tail.count++; tail.at = at; tail.text = text
    } else {
      this.pending.push({ id: ++this.serial, text, count: 1, at, source, streak: false })
      if (this.pending.length > KILL_FEED_ROWS) this.pending.shift()
    }
    if (this.pending.length === 1 && !tail && this.frame === undefined) {
      window.clearTimeout(this.timer)
      this.schedule(KILL_FEED_BATCH_MS)
    }
  }

  clear(): void {
    window.clearTimeout(this.timer)
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.timer = this.frame = undefined
    this.pending = []; this.entries = []
    this.root.hidden = true
    for (const slot of this.slots) {
      slot.el.getAnimations().forEach(animation => animation.cancel())
      slot.el.hidden = true
      setText(slot.el, '')
      slot.id = -1
    }
  }

  dispose(): void {
    this.disposed = true
    this.clear()
    this.reduced.removeEventListener('change', this.motionChanged)
    this.root.remove()
  }

  private readonly motionChanged = (): void => {
    if (this.reduced.matches) for (const slot of this.slots) {
      slot.el.getAnimations().forEach(animation => animation.cancel())
    }
  }

  private schedule(delay: number): void {
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      if (this.frame === undefined) this.frame = requestAnimationFrame(this.flush)
    }, delay)
  }

  private readonly flush = (): void => {
    this.frame = undefined
    if (this.disposed) return
    const now = performance.now()
    this.entries = [...this.entries, ...this.pending].filter(entry => now - entry.at < HOLD_MS).slice(-KILL_FEED_ROWS)
    this.pending = []
    const ids = new Set(this.entries.map(entry => entry.id))
    // One additional pooled row can leave the clipped top; all other obsolete slots are recycled.
    const exiting = this.slots.filter(slot => slot.id >= 0 && !ids.has(slot.id) && !slot.el.hidden).sort((a, b) => a.y - b.y)[0]
    const free = this.slots.filter(slot => !ids.has(slot.id) && slot !== exiting)
    const ordered: Slot[] = []
    for (const [index, entry] of this.entries.entries()) {
      const existing = this.slots.find(slot => slot.id === entry.id)
      const slot = existing ?? free.shift()!
      const y = index * 100
      const opacity = 0.5 + (index + 1) / this.entries.length * 0.5
      const label = entry.streak ? `${entry.source!.name} 连续击毁 ×${entry.count}` : entry.count > 1 ? `${entry.text} ×${entry.count}` : entry.text
      setText(slot.el, label)
      slot.el.hidden = false
      slot.el.removeAttribute('aria-hidden')
      this.move(slot, existing ? slot.y : y + 100, y, existing ? slot.opacity : 0, opacity)
      slot.id = entry.id
      ordered.push(slot)
    }
    if (exiting) {
      exiting.el.setAttribute('aria-hidden', 'true')
      this.move(exiting, exiting.y, -100, exiting.opacity, 0)
      exiting.id = -1
    }
    for (const slot of free) { slot.el.hidden = true; slot.id = -1 }
    // Keep accessibility/DOM order chronological without creating any new nodes.
    this.list.append(...ordered.map(slot => slot.el))
    this.root.hidden = !this.entries.length
    if (this.entries.length) this.schedule(Math.max(KILL_FEED_BATCH_MS, this.entries[0]!.at + HOLD_MS - now))
  }

  private move(slot: Slot, from: number, to: number, fromOpacity: number, opacity: number): void {
    const transform = `translateY(${to}%)`
    slot.el.style.transform = transform
    slot.el.style.opacity = String(opacity)
    // Numeric slots supply geometry: no offsetWidth/getBoundingClientRect or read/write layout loop.
    if (!this.reduced.matches && (from !== to || fromOpacity !== opacity)) {
      slot.el.animate([{ transform: `translateY(${from}%)`, opacity: fromOpacity }, { transform, opacity }],
        { duration: MOTION_MS, easing: 'ease-out' })
    }
    slot.y = to; slot.opacity = opacity
  }
}
