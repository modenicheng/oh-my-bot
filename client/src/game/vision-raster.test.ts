import { afterEach, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'
import { emptyWorld } from './world'
import { VisionRaster } from './vision-raster'

const gradient = vi.fn(() => ({ addColorStop: vi.fn() }))
const fill = vi.fn(), clear = vi.fn()
class Raster {
  constructor(public width: number, public height: number) {}
  getContext() {
    return { createRadialGradient: gradient, setTransform() {}, clearRect: clear,
      beginPath() {}, rect() {}, arc() {}, fill, fillRect: fill, drawImage() {} }
  }
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('prepared vision mask', () => {
  it('keeps radial-gradient rasterization out of repeated game drawing', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('document', { fonts: { load: () => Promise.resolve([]) } })
    vi.stubGlobal('Image', class { src = '' })
    vi.stubGlobal('OffscreenCanvas', class extends Raster {
      getContext() {
        return { ...super.getContext(), measureText: () => ({ width: 8 }), fillText() {} }
      }
    })
    const { Renderer } = await import('./render')
    const radialPaint = vi.fn()
    const edge = { addColorStop() {} }
    const target: Record<string, unknown> = {
      createRadialGradient: () => edge,
      measureText: () => ({ width: 8 }),
    }
    const ctx = new Proxy(target, {
      get: (obj, key: string) => obj[key] ?? (() => {}),
      set: (obj, key: string, value) => { if (key === 'fillStyle' && value === edge) radialPaint(); obj[key] = value; return true },
    })
    const renderer = new Renderer({ getContext: () => ctx, width: 800, height: 500 } as unknown as HTMLCanvasElement)
    const cam = new Camera(); cam.resize(800, 500, 80)
    const world = emptyWorld(); world.self = { robotId: 1 } as never
    world.robots.set(1, { base: { id: 1, pos: { x: 0, y: 0 }, heading: 0 }, nick: 'self' } as never)
    const map = { arenaRadius: 80, sectors: [], walls: [], uplinks: [], healthPacks: [], coreZone: { radius: 28, unlockPhase: 2 } } as never
    renderer.prepare(world, map, cam, { bubbles: [] })
    for (let i = 0; i < 20; i++) renderer.render(world, map, cam, { bubbles: [] })
    expect(radialPaint).not.toHaveBeenCalled()
  })

  it('rasterizes the feather once, drawing only images on subsequent frames', () => {
    vi.stubGlobal('OffscreenCanvas', Raster)
    const mask = new VisionRaster()
    const ctx = { drawImage: vi.fn(), save() {}, restore() {}, beginPath() {}, arc() {}, clip() {} } as unknown as CanvasRenderingContext2D
    mask.prepare(800, 500, 2, 400, 250, 400, 330)
    expect(gradient.mock.calls.length).toBeGreaterThan(0)
    expect(fill).toHaveBeenCalledTimes(gradient.mock.calls.length)
    gradient.mockClear(); fill.mockClear(); clear.mockClear()
    for (let i = 0; i < 20; i++) {
      mask.prepare(800, 500, 2, 400, 250, 400, 330)
      expect(mask.draw(ctx)).toBe(true)
    }
    const copiesPerFrame = vi.mocked(ctx.drawImage).mock.calls.length / 20
    expect(copiesPerFrame).toBeGreaterThan(0)
    expect(copiesPerFrame).toBeLessThanOrEqual(16)
    expect(gradient).not.toHaveBeenCalled()
    expect(fill).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    const calls = vi.mocked(ctx.drawImage).mock.calls.slice(0, copiesPerFrame)
    let area = 0
    for (const [source, x, y, w, h] of calls) {
      const image = source as OffscreenCanvas
      expect([w, h]).toEqual([image.width / 2, image.height / 2])
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      area += image.width * image.height
    }
    expect(area).toBeLessThan(1600 * 1000 * .7)
  })

  it('invalidates geometry and resolution while bounding the current tile set', () => {
    vi.stubGlobal('OffscreenCanvas', Raster)
    const mask = new VisionRaster()
    const drawImage = vi.fn(), ctx = { drawImage, save() {}, restore() {}, beginPath() {}, arc() {}, clip() {} } as unknown as CanvasRenderingContext2D
    const prepare = (w = 800, dpr = 1, x = 400, radius = 400) =>
      mask.prepare(w, 500, dpr, x, 250, radius, radius * .825)
    prepare(); mask.draw(ctx)
    const first = drawImage.mock.calls[0]![0]
    const initialPaints = gradient.mock.calls.length
    prepare()
    expect(gradient).toHaveBeenCalledTimes(initialPaints)
    prepare(800, 1, 410); prepare(800, 1, 410)
    prepare(800, 1, 410, 350); prepare(800, 1, 410, 350)
    prepare(900, 2, 410, 350); prepare(900, 2, 410, 350); mask.draw(ctx)
    expect(gradient.mock.calls.length).toBeGreaterThan(initialPaints)
    expect(drawImage.mock.calls.at(-1)![0]).not.toBe(first)
    for (const [image] of drawImage.mock.calls) expect(image.width * image.height).toBeLessThan(1800 * 1000)
  })

  it('avoids raster churn during continuous zoom, caching again when geometry settles', () => {
    vi.stubGlobal('OffscreenCanvas', Raster)
    const mask = new VisionRaster()
    const ctx = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D
    let initialPaints = 0
    for (let i = 0; i < 60; i++) {
      const radius = 400 - i
      mask.prepare(800, 500, 2, 400 + i, 250, radius, radius * .825)
      if (i === 0) initialPaints = gradient.mock.calls.length
      if (i > 0) expect(mask.draw(ctx)).toBe(false)
    }
    expect(gradient).toHaveBeenCalledTimes(initialPaints)
    mask.prepare(800, 500, 2, 459, 250, 341, 341 * .825)
    expect(mask.draw(ctx)).toBe(true)
    expect(gradient.mock.calls.length).toBeGreaterThan(initialPaints)
  })

  it('leaves the vector fallback available when detached canvas rendering is unavailable', () => {
    vi.stubGlobal('OffscreenCanvas', undefined)
    const mask = new VisionRaster()
    mask.prepare(800, 500, 1, 400, 250, 400, 330)
    const drawImage = vi.fn()
    expect(mask.draw({ drawImage } as unknown as CanvasRenderingContext2D)).toBe(false)
    expect(drawImage).not.toHaveBeenCalled()
  })

  it('keeps large displays at full resolution without allocating an unbounded mask', () => {
    vi.stubGlobal('OffscreenCanvas', Raster)
    const mask = new VisionRaster()
    expect(mask.prepare(4000, 3000, 2, 2000, 1500, 2000, 1650)).toBe(false)
    expect(gradient).not.toHaveBeenCalled()
    expect(mask.draw({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)).toBe(false)
  })

  it('copies only the narrow visible feather instead of its transparent bounding box', () => {
    vi.stubGlobal('OffscreenCanvas', Raster)
    const mask = new VisionRaster(), drawImage = vi.fn()
    mask.prepare(800, 500, 2, 400, 250, 400, 330)
    mask.draw({ drawImage } as unknown as CanvasRenderingContext2D)
    const area = drawImage.mock.calls.reduce((sum, [image]) => sum + image.width * image.height, 0)
    expect(area).toBeLessThan(1600 * 1000 * .35)
  })

  it('bounds the complete source surfaces submitted for each frame', () => {
    vi.stubGlobal('OffscreenCanvas', Raster)
    const mask = new VisionRaster(), drawImage = vi.fn()
    mask.prepare(1600, 1000, 2, 800, 500, 800, 660, 1)
    mask.draw({ drawImage } as unknown as CanvasRenderingContext2D)
    // A cropped draw can still snapshot/copy its entire source in Firefox.
    // Counting destination rectangles missed the repeated viewport-size copies.
    const sourcePixels = drawImage.mock.calls.reduce((sum, [image]) => sum + image.width * image.height, 0)
    expect(sourcePixels).toBeLessThan(3200 * 2000 * .35)
  })

  it('does not mistake multiple preparation calls in one snapshot for settled geometry', () => {
    vi.stubGlobal('OffscreenCanvas', Raster)
    const mask = new VisionRaster()
    mask.prepare(800, 500, 2, 400, 250, 400, 330, 1)
    const initialPaints = gradient.mock.calls.length
    mask.prepare(800, 500, 2, 400, 250, 390, 321.75, 2)
    mask.prepare(800, 500, 2, 400, 250, 390, 321.75, 2)
    expect(gradient).toHaveBeenCalledTimes(initialPaints)
    mask.prepare(800, 500, 2, 400, 250, 390, 321.75, 3)
    expect(gradient.mock.calls.length).toBeGreaterThan(initialPaints)
  })

  it('reuses immutable tiles and closes replaced or oversized resources', () => {
    const close = vi.fn()
    vi.stubGlobal('OffscreenCanvas', class extends Raster {
      transferToImageBitmap() { return { width: this.width, height: this.height, close } }
    })
    const mask = new VisionRaster(), drawImage = vi.fn()
    mask.prepare(800, 500, 2, 400, 250, 400, 330, 1)
    mask.draw({ drawImage } as unknown as CanvasRenderingContext2D)
    const tiles = drawImage.mock.calls.map(([image]) => image)
    mask.prepare(800, 500, 2, 400, 250, 400, 330, 2)
    expect(close).not.toHaveBeenCalled()
    mask.prepare(800, 500, 2, 400, 250, 390, 320, 3)
    expect(close).not.toHaveBeenCalled()
    mask.prepare(800, 500, 2, 400, 250, 390, 320, 4)
    expect(close).toHaveBeenCalledTimes(tiles.length)
    close.mockClear()
    mask.prepare(4000, 3000, 2, 2000, 1500, 2000, 1650, 5)
    mask.prepare(4000, 3000, 2, 2000, 1500, 2000, 1650, 6)
    expect(close.mock.calls.length).toBeGreaterThan(0)
    expect(mask.draw({ drawImage } as unknown as CanvasRenderingContext2D)).toBe(false)
  })

  it('releases immutable images when the renderer is discarded and can prepare again', () => {
    const close = vi.fn()
    vi.stubGlobal('OffscreenCanvas', class extends Raster {
      transferToImageBitmap() { return { width: this.width, height: this.height, close } }
    })
    const mask = new VisionRaster(), drawImage = vi.fn()
    mask.prepare(800, 500, 2, 400, 250, 400, 330, 1)
    mask.draw({ drawImage } as unknown as CanvasRenderingContext2D)
    const count = drawImage.mock.calls.length
    mask.dispose()
    expect(close).toHaveBeenCalledTimes(count)
    mask.dispose()
    expect(close).toHaveBeenCalledTimes(count)
    expect(mask.draw({ drawImage } as unknown as CanvasRenderingContext2D)).toBe(false)
    expect(mask.prepare(800, 500, 2, 400, 250, 400, 330, 1)).toBe(true)
  })
})
