// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LandscapeViewport } from '../app/landscape'
import { Workbench } from './workbench'

let viewport: LandscapeViewport | undefined

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
})

afterEach(() => {
  viewport?.dispose()
  viewport = undefined
  delete document.documentElement.dataset.workbenchResize
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function resizeFixture(rotated: boolean) {
  vi.stubGlobal('innerWidth', rotated ? 390 : 1200)
  vi.stubGlobal('innerHeight', rotated ? 1200 : 390)
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: rotated }))
  viewport = new LandscapeViewport()
  document.body.innerHTML = `
    <section id="view-game">
      <div id="game-stage"></div>
      <aside>
        <div id="width"></div>
        <section id="docs"></section>
        <div id="split"></div>
        <section id="editor"></section>
      </aside>
    </section>`
  const el = (id: string) => document.getElementById(id)!
  const gameView = el('view-game')
  Object.defineProperty(gameView, 'clientWidth', { configurable: true, value: 1200 })
  const docsPane = el('docs'), editorPane = el('editor')
  // Each pane is 120px tall logically; its physical height is 400px after rotation.
  vi.spyOn(docsPane, 'getBoundingClientRect').mockReturnValue(
    rotated ? new DOMRect(270, 800, 120, 400) : new DOMRect(800, 0, 400, 120),
  )
  vi.spyOn(editorPane, 'getBoundingClientRect').mockReturnValue(
    rotated ? new DOMRect(138, 800, 120, 400) : new DOMRect(800, 132, 400, 120),
  )
  const resizeHandle = el('width'), splitHandle = el('split')
  for (const handle of [resizeHandle, splitHandle]) {
    handle.tabIndex = 0
    let captured: number | undefined
    Object.assign(handle, {
      setPointerCapture: (id: number) => { captured = id },
      hasPointerCapture: (id: number) => captured === id,
      releasePointerCapture: () => { captured = undefined },
    })
  }
  // Exercise the real drag listeners and size updates without loading editor/AI views.
  const workbench = Object.assign(Object.create(Workbench.prototype), {
    deps: { gameView, onLayout: vi.fn() },
    panels: new Set(['docs', 'editor']),
    docsPane, editorPane, resizeHandle, splitHandle,
    width: 400, ratio: 50,
    scriptConsole: { refreshLayout: vi.fn() },
  })
  workbench.bindResize(resizeHandle, 'width')
  workbench.bindResize(splitHandle, 'split')
  workbench.renderSizes()
  const pointer = (handle: HTMLElement, type: string, x: number, y: number) => {
    handle.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, isPrimary: true, button: 0,
      clientX: rotated ? 390 - y : x,
      clientY: rotated ? x : y,
    }))
  }
  return { workbench, gameView, docsPane, editorPane, resizeHandle, splitHandle, pointer }
}

describe.each([false, true])('workbench resize (rotated=%s)', rotated => {
  it('resizes the sidebar along the logical horizontal axis', () => {
    const { workbench, gameView, resizeHandle, pointer } = resizeFixture(rotated)
    expect(resizeHandle.hidden).toBe(false)
    pointer(resizeHandle, 'pointerdown', 800, 100)
    pointer(resizeHandle, 'pointermove', 720, 100)
    expect(gameView.style.getPropertyValue('--workbench-width')).toBe('480px')
    pointer(resizeHandle, 'pointerup', 720, 100)
    expect(workbench.deps.onLayout).toHaveBeenCalledOnce()
    expect(JSON.parse(localStorage.getItem('omb.workbench.layout')!).width).toBe(480)
    expect(document.documentElement.dataset.workbenchResize).toBeUndefined()
  })

  it('updates the split ratio using logical pointer travel and pane heights', () => {
    const { docsPane, editorPane, splitHandle, pointer } = resizeFixture(rotated)
    pointer(splitHandle, 'pointerdown', 900, 126)
    pointer(splitHandle, 'pointermove', 900, 150)
    expect(docsPane.style.flexGrow).toBe('60')
    expect(editorPane.style.flexGrow).toBe('40')
    pointer(splitHandle, 'pointerup', 900, 150)
    expect(JSON.parse(localStorage.getItem('omb.workbench.layout')!).ratio).toBe(60)
  })
})

it('keeps the width handle hidden for a touch overlay even on a wide logical viewport', () => {
  const { workbench, resizeHandle } = resizeFixture(true)
  document.getElementById('game-stage')!.classList.add('touch-battle')
  workbench.renderSizes()
  expect(resizeHandle.hidden).toBe(true)
})

it('falls back to logical viewport width before the game view has been laid out', () => {
  const { workbench, gameView } = resizeFixture(true)
  Object.defineProperty(gameView, 'clientWidth', { value: 0 })
  expect(workbench.maxWidth()).toBe(840)
})
