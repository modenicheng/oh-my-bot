import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Camera } from '../../game/camera'

beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('document', { fonts: { load: () => Promise.resolve([]) } })
  vi.stubGlobal('Image', class { src = '' })
})

afterEach(() => vi.restoreAllMocks())

describe('replay drawing boundary', () => {
  it('prepares countdown labels and refreshes them when seeking', async () => {
    const { ReplayRenderer } = await import('../render')
    const fillText = vi.fn()
    const ctx = new Proxy({ fillText } as Record<string, unknown>, {
      get: (target, key: string) => target[key] ?? (() => {}),
    })
    const renderer = new ReplayRenderer({ getContext: () => ctx, width: 800, height: 500 } as unknown as HTMLCanvasElement)
    const cam = new Camera(); cam.resize(800, 500, 80)
    const map = { partial: true, walls: [], sectors: [], uplinks: [] } as unknown as import('../../game/mapdef').MapDefParsed
    const frame = {
      tick: 0, phase: 1, bubbles: [], projectiles: [], cores: [],
      robots: [{ id: 7, alive: false, pos: { x: 0, y: 0 }, respawnAt: 90 }],
      healthPacks: [{ id: 2, pos: { x: 0, y: 0 }, readyAt: 120 }],
      pointDrops: [{ id: 3, pos: { x: 0, y: 0 }, points: 3 }],
    } as unknown as import('../index').ReplayFrame
    renderer.prepare(frame, cam)
    const format = vi.spyOn(Number.prototype, 'toFixed')
    renderer.render(frame, map, cam, -1)
    expect(fillText.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['1.5s', '2s', '3']))
    expect(format).not.toHaveBeenCalled()
    frame.tick = 60
    renderer.prepare(frame, cam)
    format.mockClear(); fillText.mockClear()
    renderer.render(frame, map, cam, -1)
    expect(fillText.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['0.5s', '1s', '3']))
    expect(format).not.toHaveBeenCalled()
  })

  it('prepares speech measurements and projectile trails outside render', async () => {
    const { ReplayRenderer } = await import('../render')
    const { emptyWorld } = await import('../../game/world')
    const measureText = vi.fn((text: string) => ({ width: text.length * 8 }))
    const createLinearGradient = vi.fn(() => ({ addColorStop() {} }))
    const ctx = { save() {}, restore() {}, measureText, createLinearGradient }
    const renderer = new ReplayRenderer({ getContext: () => ctx } as unknown as HTMLCanvasElement)
    const cam = new Camera(); cam.resize(800, 500, 80)
    const frame = {
      ...emptyWorld(), robots: [], cores: [], healthPacks: [], pointDrops: [],
      projectiles: [{ id: 1, pos: { x: 0, y: 0 }, heading: 0, owner: 7 }],
      bubbles: [{ robot: 7, text: 'Prepared replay speech', tick: 1 }],
    } as unknown as import('../index').ReplayFrame
    renderer.prepare(frame, cam)
    expect(measureText).toHaveBeenCalledOnce()
    expect(createLinearGradient).toHaveBeenCalledOnce()
    renderer.prepare(frame, cam)
    expect(measureText).toHaveBeenCalledOnce()
    expect(createLinearGradient).toHaveBeenCalledOnce()
  })
})
