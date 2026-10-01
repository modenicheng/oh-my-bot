import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpectatorCamera } from '../spectator'
import { readRoute, writeRoute } from '../../route'

function camera(): SpectatorCamera {
  const view = new SpectatorCamera()
  view.resize(900, 600, 100)
  return view
}

describe('recorded spectator camera', () => {
  it('fits the complete arena and reuses Camera coordinate transforms', () => {
    const view = camera()
    expect(view.camera.toPxX(-100)).toBeGreaterThan(0)
    expect(view.camera.toPxY(-100)).toBeGreaterThan(0)
    expect(view.camera.toPxX(100)).toBeLessThan(900)
    expect(view.camera.toPxY(100)).toBeLessThan(600)
    expect(view.camera.toWorldX(view.camera.toPxX(42))).toBeCloseTo(42)
  })

  it('zooms at the pointer without moving the anchored world coordinate', () => {
    const view = camera()
    const x = view.camera.toWorldX(600), y = view.camera.toWorldY(350)
    view.zoomAt(2, 600, 350)
    expect(view.zoom).toBe(2)
    expect(view.camera.toWorldX(600)).toBeCloseTo(x)
    expect(view.camera.toWorldY(350)).toBeCloseTo(y)
  })

  it('pans in CSS pixels, leaves follow mode and retains the free center', () => {
    const view = camera()
    view.follow(2)
    view.update([{ id: 2, pos: { x: 10, y: -8 } }])
    const scale = view.camera.scale
    view.pan(40, -20)
    expect(view.followId).toBeNull()
    expect(view.camera.cx).toBeCloseTo(10 - 40 / scale)
    expect(view.camera.cy).toBeCloseTo(-8 + 20 / scale)
    view.update([{ id: 2, pos: { x: -40, y: 8 } }])
    expect(view.camera.cx).toBeCloseTo(10 - 40 / scale)
  })

  it('follows any selected id through absent frames and recorded respawns', () => {
    const view = camera()
    view.follow(9)
    view.update([{ id: 1, pos: { x: 0, y: 0 } }, { id: 9, pos: { x: 50, y: 20 } }])
    expect(view.camera.cx).toBe(50)
    expect(view.camera.cy).toBe(20)
    view.update([])
    expect(view.camera.cx).toBe(50)
    view.zoomAt(2, 0, 0)
    expect(view.camera.cx).toBe(50)
    view.update([{ id: 9, pos: { x: -60, y: -70 } }])
    expect(view.camera.cx).toBe(-60)
    expect(view.camera.cy).toBe(-70)
    view.follow(null)
    expect(view.camera.cx).toBe(-60)
  })

  it('preserves navigation across responsive resizing and resets explicitly', () => {
    const view = camera()
    view.zoomAt(3)
    view.pan(45, 30)
    const center = [view.camera.cx, view.camera.cy]
    view.resize(360, 260, 100)
    expect(view.zoom).toBe(3)
    expect([view.camera.cx, view.camera.cy]).toEqual(center)
    expect(view.camera.scale).toBeCloseTo(260 / 210 * 3)
    view.fit()
    expect(view.zoom).toBe(1)
    expect(view.followId).toBeNull()
    expect([view.camera.cx, view.camera.cy]).toEqual([0, 0])
  })

  it('bounds wheel bursts and panning so the arena remains reachable', () => {
    const view = camera()
    view.zoomAt(1e8)
    expect(view.zoom).toBe(24)
    view.zoomAt(Infinity)
    view.zoomAt(NaN)
    expect(view.zoom).toBe(24)
    view.zoomAt(1e-8)
    expect(view.zoom).toBe(1)
    view.pan(1e8, -1e8)
    expect([view.camera.cx, view.camera.cy]).toEqual([-100, 100])
    view.fit()
    expect([view.camera.cx, view.camera.cy]).toEqual([0, 0])
  })
})

describe('spectator route', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('recognizes spectator deep links without requiring a room', () => {
    expect(readRoute(new URL('https://example.test/?view=spectator&replay=DEMO-1'))).toMatchObject({
      view: 'spectator', replay: 'DEMO-1', roomCode: '',
    })
  })

  it('keeps the replay id for spectator playback and clears it for the library', () => {
    vi.stubGlobal('location', { href: 'https://example.test/?view=game&panels=editor&doc=index.md' })
    const replaceState = vi.fn()
    vi.stubGlobal('history', { replaceState })
    writeRoute('spectator', undefined, { replay: 'DEMO-1' })
    const url = replaceState.mock.calls[0]![2] as URL
    expect(url.searchParams.get('view')).toBe('spectator')
    expect(url.searchParams.get('replay')).toBe('DEMO-1')
    expect(url.searchParams.has('panels')).toBe(false)
    expect(url.searchParams.has('doc')).toBe(false)
    vi.stubGlobal('location', { href: url.href })
    writeRoute('spectator')
    expect((replaceState.mock.calls[1]![2] as URL).searchParams.has('replay')).toBe(false)
  })
})
