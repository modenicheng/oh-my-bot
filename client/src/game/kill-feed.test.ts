import { afterEach, describe, expect, it, vi } from 'vitest'
import { KillFeed, KILL_FEED_ROWS } from './kill-feed'

// Same lightweight DOM convention as ui/dom.test.ts; real DOM/layout is covered by test:feel.
class Node {
  children: Node[] = []
  parent?: Node
  className = ''
  hidden = false
  textContent = ''
  attrs = new Map<string, string>()
  style: Record<string, string> = {}
  appendCalls = 0
  animate = vi.fn(() => ({ cancel: vi.fn() }))
  getAnimations = vi.fn(() => [])
  constructor(readonly tag: string) {}
  append(...nodes: Node[]) {
    this.appendCalls++
    for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node) }
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = undefined }
  setAttribute(key: string, value: string) { this.attrs.set(key, value) }
  removeAttribute(key: string) { this.attrs.delete(key) }
}

function fixture(reduced = false) {
  vi.useFakeTimers()
  let now = 0, nextFrame = 0
  const frames = new Map<number, FrameRequestCallback>()
  const created: Node[] = []
  const media = { matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal('document', { createElement: (tag: string) => { const n = new Node(tag); created.push(n); return n } })
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++nextFrame, cb); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const parent = new Node('main')
  const feed = new KillFeed(parent as unknown as HTMLElement)
  const root = parent.children[0]!, list = root.children[1]!
  const rows = () => list.children.filter(n => !n.hidden && n.attrs.get('aria-hidden') !== 'true').map(n => n.textContent)
  const advance = (ms: number, render = true) => {
    now += ms; vi.advanceTimersByTime(ms)
    if (render) { const batch = [...frames.values()]; frames.clear(); batch.forEach(cb => cb(now)) }
  }
  return { feed, parent, root, list, rows, created, frames, advance, media }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('bounded tactical kill feed', () => {
  it('1000 synchronous kills allocate no extra nodes and render once in chronological order', () => {
    const f = fixture(), nodes = [...f.created], initialWrites = f.list.appendCalls
    for (let i = 0; i < 1000; i++) f.feed.push(`bot-${i} 击毁 target`)
    expect(f.created).toEqual(nodes)
    expect(f.rows()).toEqual([])
    f.advance(99); expect(f.rows()).toEqual([])
    f.advance(1)
    expect(f.list.appendCalls - initialWrites).toBe(1)
    expect(f.rows()).toEqual(Array.from({ length: 6 }, (_, i) => `bot-${994 + i} 击毁 target`))
    expect(f.list.children).toHaveLength(KILL_FEED_ROWS + 1)
    expect(f.created).toHaveLength(10) // section, heading, ol, 7 permanently pooled rows
    expect(f.root.attrs.get('aria-live')).toBe('off')
    f.feed.dispose()
  })

  it('1000 sustained kills use ten micro-batches, retain order, and reuse the exact node pool', () => {
    const f = fixture(), nodes = [...f.created], initialWrites = f.list.appendCalls
    for (let i = 0; i < 1000; i++) { f.feed.push(String(i)); f.advance(1) }
    expect(f.list.appendCalls - initialWrites).toBe(10)
    expect(f.created).toEqual(nodes)
    expect(f.rows()).toEqual(['994', '995', '996', '997', '998', '999'])
    expect(f.list.children).toHaveLength(7)
    f.feed.dispose()
  })

  it('coalesces adjacent duplicates without reordering interleaved killers', () => {
    const f = fixture()
    for (const text of ['A', 'A', 'B', 'A', 'A', 'A']) f.feed.push(text)
    f.advance(100)
    expect(f.rows()).toEqual(['A ×2', 'B', 'A ×3'])
    f.feed.dispose()
  })

  it('merges consecutive same-source kills but not equal nicknames or interleaved sources', () => {
    const f = fixture()
    const a = { id: 1, name: '同名' }, b = { id: 2, name: '同名' }
    f.feed.push('同名 击毁 X', a); f.feed.push('同名 击毁 Y', a)
    f.feed.push('同名 击毁 Y', b); f.feed.push('同名 击毁 Z', a)
    f.advance(100)
    expect(f.rows()).toEqual(['同名 连续击毁 ×2', '同名 击毁 Y', '同名 击毁 Z'])
    f.feed.dispose()
  })

  it('1000 same-source kills become a single counted row', () => {
    const f = fixture()
    for (let i = 0; i < 1000; i++) f.feed.push(`A 击毁 ${i}`, { id: 1, name: 'A' })
    f.advance(100)
    expect(f.rows()).toEqual(['A 连续击毁 ×1000'])
    expect(f.created).toHaveLength(10)
    f.feed.dispose()
  })

  it('suspends at one pending frame with a bounded queue even when backgrounded', () => {
    const f = fixture()
    f.feed.push('old'); f.advance(100, false)
    for (let i = 0; i < 1000; i++) { f.feed.push(String(i)); f.advance(1, false) }
    expect(f.frames.size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    f.advance(0)
    expect(f.rows()).toEqual(['994', '995', '996', '997', '998', '999'])
    f.feed.dispose()
  })

  it('scrolls old rows upward and fades the recycled departure without layout reads', () => {
    const f = fixture()
    for (let i = 0; i < 6; i++) f.feed.push(String(i))
    f.advance(100)
    const previous = f.list.children.find(n => n.textContent === '1')!
    const outgoing = f.list.children.find(n => n.textContent === '0')!
    f.feed.push('6'); f.advance(100)
    expect(previous.style.transform).toBe('translateY(0%)')
    expect(outgoing.style.transform).toBe('translateY(-100%)')
    expect(outgoing.style.opacity).toBe('0')
    expect(outgoing.attrs.get('aria-hidden')).toBe('true')
    expect(f.rows()).toEqual(['1', '2', '3', '4', '5', '6'])
    f.feed.dispose()
  })

  it('reduced motion keeps static positions and performs no animations', () => {
    const f = fixture(true)
    f.feed.push('A'); f.advance(100); f.feed.push('B'); f.advance(100)
    expect(f.rows()).toEqual(['A', 'B'])
    for (const n of f.created) expect(n.animate).not.toHaveBeenCalled()
    f.advance(6000)
    expect(f.root.hidden).toBe(true)
    f.feed.dispose()
  })

  it('clear/dispose cancels pending timers and frames and permits a fresh session', () => {
    const f = fixture()
    f.feed.push('old'); f.advance(100, false); f.feed.clear()
    expect(f.frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    f.feed.push('new'); f.advance(100); expect(f.rows()).toEqual(['new'])
    f.feed.dispose(); f.feed.push('ignored'); f.advance(10000)
    expect(f.parent.children).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.media.removeEventListener).toHaveBeenCalledOnce()
  })
})
