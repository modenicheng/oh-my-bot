import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'
import type { PointDropIntro } from './art'

type DrawPointDrop = typeof import('./art')['drawPointDrop']
interface Op { op: string; args: unknown[]; strokeStyle: unknown; fillStyle: unknown; lineWidth: unknown; globalAlpha: unknown }
let drawPointDrop: DrawPointDrop
let ink: typeof import('./art')['ink']
const motion = { matches: false }

beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => motion)
  vi.stubGlobal('document', { fonts: { load: () => Promise.resolve([]) } })
  vi.stubGlobal('Image', class { complete = true; naturalWidth = 64; src = '' })
  ;({ drawPointDrop, ink } = await import('./art'))
})
afterAll(() => vi.unstubAllGlobals())

function recordingCtx(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = []
  const target: Record<string, unknown> = { fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1 }
  for (const op of ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'ellipse',
    'fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'setLineDash',
    'translate', 'rotate', 'scale', 'transform', 'setTransform']) {
    target[op] = (...args: unknown[]) => ops.push({ op, args, strokeStyle: target.strokeStyle, fillStyle: target.fillStyle, lineWidth: target.lineWidth, globalAlpha: target.globalAlpha })
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, ops }
}

function draw(points: number, intro?: PointDropIntro, width = 400): { ops: Op[]; cam: Camera } {
  const cam = new Camera()
  cam.resize(width, width * 0.75, 1)
  cam.follow(0, 0)
  const { ctx, ops } = recordingCtx()
  drawPointDrop(ctx, cam, 0, 0, points, 30, intro)
  return { ops, cam }
}

describe('point drop chip', () => {
  it.each([400, 1200, 2000])('draws a compact amber diamond at viewport width %d', (width) => {
    const { ops, cam } = draw(1, undefined, width)
    expect(ops.some(o => o.op === 'fillText')).toBe(false)
    const fills = ops.filter(o => o.op === 'fill' && o.fillStyle === ink.amber)
    expect(fills.length).toBeGreaterThanOrEqual(2) // 微光外菱 + 本体
    expect(ops.some(o => o.op === 'fill' && o.fillStyle === '#070d14')).toBe(true) // 内菱
    // 0.315m 本体：外菱纵向跨度 = 2 × 0.85 × size，小视口下同样缩小 25%。
    const s = Math.max(4.5, 0.315 * cam.scale)
    const ys = ops.filter(o => o.op === 'moveTo' || o.op === 'lineTo').slice(0, 4).map(o => o.args[1] as number)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2 * 0.85 * s, 5)
  })

  it('labels the value only above 1 point', () => {
    const labels = draw(3).ops.filter(o => o.op === 'fillText')
    expect(labels).toHaveLength(1)
    expect(labels[0]?.args[0]).toBe('3')
  })

  it('trails an amber streak from the scatter origin while flying and stops when settled', () => {
    const flying = draw(2, { p: 0.4, fromX: -3, fromY: 0.5 }).ops
    const streak = flying.filter(o => o.op === 'stroke' && o.strokeStyle === ink.amber)
    expect(streak).toHaveLength(1)
    const settled = draw(2).ops
    expect(settled.filter(o => o.op === 'stroke')).toHaveLength(0)
  })

  it('drops the intro streak under reduced motion', () => {
    motion.matches = true
    try {
      expect(draw(2, { p: 0.4, fromX: -3, fromY: 0.5 }).ops.filter(o => o.op === 'stroke')).toHaveLength(0)
    } finally {
      motion.matches = false
    }
  })
})
