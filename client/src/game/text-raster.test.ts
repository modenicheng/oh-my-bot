import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'
import { emptyWorld } from './world'
import type { MapDefParsed } from './mapdef'

const rasterText = vi.fn()
const measureText = vi.fn((text: string) => ({ width: text.length * 8,
  actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 8,
  actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3,
  fontBoundingBoxAscent: 11, fontBoundingBoxDescent: 3 }))

class TextCanvas {
  constructor(public width: number, public height: number) {}
  getContext() { return { measureText, fillText: rasterText, setTransform() {}, clearRect() {},
    beginPath() {}, rect() {}, arc() {}, fill() {}, fillRect() {},
    createRadialGradient: () => ({ addColorStop() {} }) } }
}

beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('document', { fonts: { load: () => Promise.resolve([]) } })
  vi.stubGlobal('Image', class { src = '' })
  vi.stubGlobal('OffscreenCanvas', TextCanvas)
})
afterAll(() => vi.unstubAllGlobals())

describe('game text raster preparation', () => {
  it('draws prepared labels and speech without touching the on-screen text/font APIs', async () => {
    const { Renderer } = await import('./render')
    const { Vitals } = await import('./feedback/vitals')
    const fillText = vi.fn()
    const font = vi.fn()
    const drawImage = vi.fn()
    const target: Record<string, unknown> = { fillText, drawImage,
      measureText, createRadialGradient: () => ({ addColorStop() {} }) }
    const ctx = new Proxy(target, {
      get: (obj, key: string) => obj[key] ?? (() => {}),
      set: (obj, key: string, value) => { if (key === 'font') font(value); obj[key] = value; return true },
    })
    const renderer = new Renderer({ getContext: () => ctx, width: 800, height: 500 } as unknown as HTMLCanvasElement)
    const cam = new Camera(); cam.resize(800, 500, 80)
    const world = emptyWorld()
    world.phase = 1
    world.robots.set(7, { base: { id: 7, pos: { x: 0, y: 0 }, heading: 0 },
      hpX10: 1000, energyX10: 1000, nick: 'prepared nickname', seenAt: 0 } as never)
    const map = { walls: [], sectors: [], uplinks: [], corePads: [], healthPacks: [],
      arenaRadius: 80, coreZone: { radius: 28, unlockPhase: 2 } } as unknown as MapDefParsed
    const extras = { bubbles: [{ robotId: 7, text: 'prepared speech', at: performance.now() }] }
    renderer.prepare(world, map, cam, extras)
    const vitals = new Vitals({ matches: false } as MediaQueryList)
    vitals.popup(7, { x: 0, y: 0 }, 100, performance.now(), 1)
    fillText.mockClear(); font.mockClear(); rasterText.mockClear(); measureText.mockClear()
    renderer.render(world, map, cam, extras)
    vitals.draw(ctx as unknown as CanvasRenderingContext2D, cam)
    expect(fillText).not.toHaveBeenCalled()
    expect(font).not.toHaveBeenCalled()
    expect(measureText).not.toHaveBeenCalled()
    expect(rasterText).not.toHaveBeenCalled()
    expect(drawImage.mock.calls.some(call => call[0] instanceof TextCanvas)).toBe(true)
  })

  it('retains the current snapshot when the reuse cache evicts old entries', async () => {
    const { beginTextPreparation, drawText, prepareText } = await import('./text-raster')
    const drawImage = vi.fn()
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D
    beginTextPreparation(ctx)
    const label = prepareText('current robot', '11px monospace', '#fff', 2, ctx)
    for (let i = 0; i < 600; i++) prepareText(`expired robot ${i}`, '11px monospace', '#fff')
    drawText(ctx, 'current robot', '11px monospace', '#fff', 40, 20)
    expect(drawImage.mock.calls[0]?.[0]).toBe(label.image)
  })

  it('reuses unchanged labels when consecutive snapshots exceed the shared pixel budget', async () => {
    const { beginTextPreparation, invalidateTextRasters, prepareText } = await import('./text-raster')
    invalidateTextRasters()
    const ctx = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D
    const labels = Array.from({ length: 64 }, (_, i) => [
      { text: `robot-${i}`.padEnd(16, 'x'), color: '#fff' },
      { text: `robot-${i}`.padEnd(16, 'x'), color: '#0ff' },
      { text: `speech-${i}`.padEnd(40, 'x'), color: '#fff' },
    ]).flat()
    const prepare = (dpr = 3) => {
      beginTextPreparation(ctx)
      return labels.map(({ text, color }) => prepareText(text, '11px monospace', color, dpr, ctx))
    }
    const first = prepare()
    expect(first.reduce((sum, entry) => sum + entry.image!.width * entry.image!.height, 0))
      .toBeGreaterThan(4 * 1024 * 1024)
    rasterText.mockClear(); measureText.mockClear()
    const second = prepare()
    second.forEach((entry, i) => expect(entry).toBe(first[i]))
    expect(rasterText).not.toHaveBeenCalled()
    expect(measureText).not.toHaveBeenCalled()
    const resized = prepare(2)
    resized.forEach((entry, i) => expect(entry).not.toBe(second[i]))
    invalidateTextRasters()
    prepare(2).forEach((entry, i) => expect(entry).not.toBe(resized[i]))
  })

  it('prepares replay labels and speech before rendering a frame', async () => {
    const { ReplayRenderer } = await import('../replay/render')
    const fillText = vi.fn(), drawImage = vi.fn(), font = vi.fn()
    const ctx = new Proxy({ fillText, drawImage, measureText } as Record<string, unknown>, {
      get: (obj, key: string) => obj[key] ?? (() => {}),
      set: (obj, key: string, value) => { if (key === 'font') font(value); obj[key] = value; return true },
    })
    const renderer = new ReplayRenderer({ getContext: () => ctx, width: 800, height: 500 } as unknown as HTMLCanvasElement)
    const cam = new Camera(); cam.resize(800, 500, 80)
    const map = { walls: [], sectors: [], uplinks: [], corePads: [], healthPacks: [],
      arenaRadius: 80, coreZone: { radius: 28, unlockPhase: 2 } } as unknown as MapDefParsed
    const frame = { tick: 0, phase: 1, projectiles: [], cores: [], pointDrops: [], healthPacks: [],
      robots: [{ id: 7, pos: { x: 0, y: 0 }, alive: true, nick: 'replay robot', hp: 100, energy: 100 }],
      bubbles: [{ robot: 7, text: 'replay speech', tick: 0 }] } as unknown as import('../replay').ReplayFrame
    renderer.prepare(frame, cam, map)
    fillText.mockClear(); rasterText.mockClear(); measureText.mockClear(); font.mockClear()
    renderer.render(frame, map, cam, 7)
    expect(fillText).not.toHaveBeenCalled()
    expect(rasterText).not.toHaveBeenCalled()
    expect(measureText).not.toHaveBeenCalled()
    expect(font).not.toHaveBeenCalled()
    expect(drawImage.mock.calls.some(call => call[0] instanceof TextCanvas)).toBe(true)
  })

  it('refreshes a label after DPR or font readiness changes', async () => {
    const { invalidateTextRasters, prepareText } = await import('./text-raster')
    const first = prepareText('pixel text', '11px monospace', '#fff', 1)
    expect(prepareText('pixel text', '11px monospace', '#fff', 1)).toBe(first)
    const retina = prepareText('pixel text', '11px monospace', '#fff', 2)
    expect(retina.image?.width).toBe((first.image?.width ?? 0) * 2)
    invalidateTextRasters()
    expect(prepareText('pixel text', '11px monospace', '#fff', 2)).not.toBe(retina)
  })
})
