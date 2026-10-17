// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrientationGate } from './orientation'

let root: HTMLElement
let screenOrientation: EventTarget & { lock?: ReturnType<typeof vi.fn>; unlock?: ReturnType<typeof vi.fn> }
let viewport: EventTarget
const gates: OrientationGate[] = []
function gate(onChange = vi.fn()): OrientationGate {
  const result = new OrientationGate(root, onChange)
  gates.push(result)
  return result
}

beforeEach(() => {
  document.body.innerHTML = '<section id="view-game"><div id="game-stage"></div><div id="game-options"></div></section>'
  root = document.getElementById('game-stage')!
  screenOrientation = Object.assign(new EventTarget(), { lock: vi.fn().mockResolvedValue(undefined), unlock: vi.fn() })
  viewport = new EventTarget()
  vi.stubGlobal('screen', { orientation: screenOrientation })
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
  vi.stubGlobal('innerWidth', 844)
  vi.stubGlobal('innerHeight', 390)
})
afterEach(() => {
  gates.splice(0).forEach(value => value.dispose())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('battle orientation gate', () => {
  it('does not require fullscreen/lock support for an already landscape viewport', async () => {
    delete screenOrientation.lock
    const value = gate()
    expect(value.portrait).toBe(false)
    await expect(value.requestLandscape()).resolves.toBeUndefined()
    expect(value.portrait).toBe(false)
  })

  it('gates portrait and reports resize/orientation/visual viewport/fullscreen invalidations', () => {
    vi.stubGlobal('innerWidth', 390)
    vi.stubGlobal('innerHeight', 844)
    const changed = vi.fn(), value = gate(changed)
    expect(value.portrait).toBe(true)
    expect(changed).not.toHaveBeenCalled()
    vi.stubGlobal('innerWidth', 844)
    vi.stubGlobal('innerHeight', 390)
    window.dispatchEvent(new Event('resize'))
    expect(value.portrait).toBe(false)
    screenOrientation.dispatchEvent(new Event('change'))
    viewport.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
    document.dispatchEvent(new Event('fullscreenchange'))
    expect(changed).toHaveBeenCalledTimes(5)
    value.dispose()
    window.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('resize'))
    screenOrientation.dispatchEvent(new Event('change'))
    expect(changed).toHaveBeenCalledTimes(5)
  })

  it('requests fullscreen only explicitly, keeps options in fullscreen and locks afterwards', async () => {
    const order: string[] = []
    const request = vi.fn(async () => { order.push('fullscreen') })
    Object.defineProperty(root.parentElement, 'requestFullscreen', { value: request, configurable: true })
    screenOrientation.lock!.mockImplementation(async () => { order.push('lock') })
    const value = gate()
    expect(request).not.toHaveBeenCalled()
    expect(screenOrientation.lock).not.toHaveBeenCalled()
    await value.requestLandscape()
    expect(request).toHaveBeenCalledOnce()
    expect(order).toEqual(['fullscreen', 'lock'])
    expect(screenOrientation.lock).toHaveBeenCalledWith('landscape')
    value.dispose()
    expect(screenOrientation.unlock).toHaveBeenCalledOnce()
  })

  it('swallows synchronous/rejected fullscreen and lock failures without blocking landscape', async () => {
    Object.defineProperty(root.parentElement, 'requestFullscreen', {
      value: () => { throw new Error('not allowed') }, configurable: true,
    })
    screenOrientation.lock!.mockRejectedValue(new Error('unsupported'))
    const value = gate()
    await expect(value.requestLandscape()).resolves.toBeUndefined()
    expect(value.portrait).toBe(false)
  })

  it('does not acquire a late orientation lock after disposal during fullscreen request', async () => {
    let finish!: () => void
    Object.defineProperty(root.parentElement, 'requestFullscreen', {
      value: () => new Promise<void>(resolve => { finish = resolve }), configurable: true,
    })
    const value = gate()
    const pending = value.requestLandscape()
    value.dispose()
    finish()
    await pending
    expect(screenOrientation.lock).not.toHaveBeenCalled()
  })
})
