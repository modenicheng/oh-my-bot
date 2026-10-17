// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LandscapeViewport, landscapeSize, viewportPoint, viewportRect } from './landscape'

let viewport: LandscapeViewport | undefined
let coarse: EventTarget & { matches: boolean }
let lock: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  coarse = Object.assign(new EventTarget(), { matches: true })
  vi.stubGlobal('matchMedia', () => coarse)
  vi.stubGlobal('innerWidth', 390)
  vi.stubGlobal('innerHeight', 844)
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
  lock = vi.fn().mockRejectedValue(new Error('unsupported'))
  vi.stubGlobal('screen', { orientation: { lock, unlock: vi.fn() } })
})
afterEach(() => {
  viewport?.dispose()
  viewport = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mobile landscape surface', () => {
  it('renders portrait immediately as a full landscape surface without waiting for fullscreen or lock', async () => {
    viewport = new LandscapeViewport()
    expect(document.documentElement.classList.contains('mobile-rotated')).toBe(true)
    expect(landscapeSize()).toEqual({ width: 844, height: 390 })
    expect(viewportPoint(300, 700)).toEqual({ x: 700, y: 90 })
    const rect = viewportRect({ getBoundingClientRect: () => new DOMRect(200, 600, 120, 160) })
    expect(rect).toMatchObject({ left: 600, top: 70, width: 160, height: 120, right: 760, bottom: 190 })
    await expect(viewport.requestNativeLandscape()).resolves.toBeUndefined()
    expect(viewport.rotated).toBe(true)
    expect(lock).toHaveBeenCalledWith('landscape')
  })

  it('switches back to native landscape and reports the geometry boundary', () => {
    const changed = vi.fn()
    window.addEventListener('landscapechange', changed)
    viewport = new LandscapeViewport()
    vi.stubGlobal('innerWidth', 844)
    vi.stubGlobal('innerHeight', 390)
    window.dispatchEvent(new Event('resize'))
    expect(document.documentElement.classList.contains('mobile-rotated')).toBe(false)
    expect(viewportPoint(700, 90)).toEqual({ x: 700, y: 90 })
    expect(landscapeSize()).toEqual({ width: 844, height: 390 })
    expect(changed).toHaveBeenCalledTimes(2)
    window.removeEventListener('landscapechange', changed)
  })

  it('keeps the orientation stable when a keyboard reduces the visual viewport and applies its offset', () => {
    const visual = Object.assign(new EventTarget(), { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual })
    viewport = new LandscapeViewport()
    document.body.innerHTML = '<textarea></textarea>'
    document.querySelector('textarea')!.focus()
    vi.stubGlobal('innerHeight', 300)
    visual.height = 300
    visual.offsetTop = 12
    visual.dispatchEvent(new Event('resize'))
    expect(viewport.rotated).toBe(true)
    expect(landscapeSize()).toEqual({ width: 300, height: 390 })
    expect(viewportPoint(300, 112)).toEqual({ x: 100, y: 90 })
  })

  it('preserves desktop layout, honors the manual override and removes listeners on disposal', () => {
    coarse.matches = false
    viewport = new LandscapeViewport()
    expect(viewport.enabled).toBe(false)
    viewport.setLayout('touch')
    expect(viewport.rotated).toBe(true)
    viewport.setLayout('desktop')
    expect(viewport.enabled).toBe(false)
    coarse.matches = true
    coarse.dispatchEvent(new Event('change'))
    expect(viewport.enabled).toBe(false)
    viewport.dispose()
    window.dispatchEvent(new Event('resize'))
    expect(document.documentElement.classList.contains('mobile-landscape')).toBe(false)
  })
})
