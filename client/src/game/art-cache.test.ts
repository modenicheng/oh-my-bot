import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'

const rasterDraw = vi.fn()
class RasterCanvas {
  constructor(readonly width: number, readonly height: number) {}
  getContext() { return { drawImage: rasterDraw } }
}
let GameController: typeof import('./controls')['GameController']
beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('document', { fonts: { load: () => Promise.resolve([]) } })
  vi.stubGlobal('Image', class { src = ''; complete = true; naturalWidth = 64 })
  vi.stubGlobal('OffscreenCanvas', RasterCanvas)
  ;({ GameController } = await import('./controls'))
}, 15000)

describe('prepared sprite assets', () => {
  it('rasterizes SVG assets before drawing and reuses a bounded size per sprite', async () => {
    const { prepareArt, drawCore } = await import('./art')
    prepareArt(20, 1)
    expect(rasterDraw).toHaveBeenCalledTimes(5)
    rasterDraw.mockClear()
    prepareArt(20, 1)
    expect(rasterDraw).not.toHaveBeenCalled()
    const drawImage = vi.fn()
    const ctx = {
      save() {}, restore() {}, beginPath() {}, ellipse() {}, fill() {}, drawImage,
    } as unknown as CanvasRenderingContext2D
    const cam = new Camera(); cam.resize(800, 500, 80)
    for (let i = 0; i < 20; i++) drawCore(ctx, cam, 0, 0, false)
    expect(drawImage).toHaveBeenCalledTimes(20)
    expect(drawImage.mock.calls.every(call => call[0] instanceof RasterCanvas)).toBe(true)
    expect(rasterDraw).not.toHaveBeenCalled()
  })

  it('restores game raster quality after another view prepares smaller sprites', async () => {
    const { prepareArt, drawCore } = await import('./art')
    prepareArt(4, 1)
    const cam = new Camera(); cam.resize(800, 500, 80)
    const controller = Object.assign(Object.create(GameController.prototype), {
      active: false, map: {}, inputEnabled: false, cam, world: {},
      feedback: { ambience() {} }, preparePresentation() {},
      stage: { dpr: 1, requestDraw() {} },
    })
    controller.setActive(true)
    const drawImage = vi.fn()
    const ctx = { save() {}, restore() {}, beginPath() {}, ellipse() {}, fill() {}, drawImage } as unknown as CanvasRenderingContext2D
    drawCore(ctx, cam, 0, 0, false)
    expect((drawImage.mock.calls[0]![0] as RasterCanvas).width).toBe(Math.ceil(1.05 * cam.scale * 1.05))
  })
})
