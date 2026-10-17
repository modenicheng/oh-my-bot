import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'
import type { MapDefParsed } from './mapdef'

beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('document', { fonts: { load: () => Promise.resolve([]) } })
  vi.stubGlobal('Image', class { src = '' })
})
afterAll(() => vi.unstubAllGlobals())

const terrain = { arenaRadius: 280, sectors: [], coreZone: { radius: 28, unlockPhase: 2 } } as unknown as MapDefParsed
function context() {
  const clip = vi.fn(), strokes: number[] = []
  let radius = 0
  const ctx = new Proxy({
    clip, beginPath() { radius = 0 }, arc(_x: number, _y: number, r: number) { radius = r },
    stroke() { if (radius) strokes.push(radius) },
  } as Record<string, unknown>, {
    get: (obj, key: string) => obj[key] ?? (() => {}),
    set: (obj, key: string, value) => { obj[key] = value; return true },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, clip, strokes }
}

describe('arena viewport work', () => {
  it('avoids a world-sized clip and invisible circle strokes inside the arena', async () => {
    const { drawArena } = await import('./art')
    const cam = new Camera(); cam.resize(1280, 800, 280); cam.follow(120, 30)
    const { ctx, clip, strokes } = context()
    drawArena(ctx, terrain, cam, 2)
    expect(clip).not.toHaveBeenCalled()
    expect(strokes).toEqual([])
  })

  it('retains the arena clip and fence where the viewport crosses the boundary', async () => {
    const { drawArena } = await import('./art')
    const cam = new Camera(); cam.resize(1280, 800, 280); cam.follow(270, 0)
    const { ctx, clip, strokes } = context()
    drawArena(ctx, terrain, cam, 2)
    expect(clip).toHaveBeenCalledOnce()
    expect(strokes.filter(radius => radius === terrain.arenaRadius * cam.scale)).toHaveLength(2)
  })

  it('prepares visible sector polygons instead of submitting giant offscreen arcs', async () => {
    const { prepareArena, drawArena } = await import('./art')
    const cam = new Camera(); cam.resize(1280, 800, 280); cam.follow(120, 30)
    const { ctx } = context()
    const arc = vi.spyOn(ctx, 'arc')
    prepareArena(terrain, ctx, 1, cam)
    arc.mockClear()
    drawArena(ctx, terrain, cam, 2)
    expect(arc).not.toHaveBeenCalled()
  })
})
