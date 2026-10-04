import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'

type DrawUplink = typeof import('./art')['drawUplink']
interface Op { op: string; args: unknown[]; fillStyle: unknown }
let drawUplink: DrawUplink
let ink: typeof import('./art')['ink']
const motion = { matches: false }

beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => motion)
  vi.stubGlobal('document', { fonts: { load: () => Promise.resolve([]) } })
  vi.stubGlobal('Image', class { complete = true; naturalWidth = 64; src = '' })
  ;({ drawUplink, ink } = await import('./art'))
})
afterAll(() => vi.unstubAllGlobals())

/** Real sprite path plus recorded Canvas geometry; style changes are not geometry. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = []
  const target: Record<string, unknown> = { fillStyle: '', strokeStyle: '', globalAlpha: 1 }
  for (const op of ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'ellipse',
    'fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'setLineDash',
    'translate', 'rotate', 'scale', 'transform', 'setTransform']) {
    target[op] = (...args: unknown[]) => ops.push({ op, args, fillStyle: target.fillStyle })
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, ops }
}

function fixture(scale = 20) {
  const cam = new Camera()
  cam.resize(scale * 40, scale * 25, 80)
  cam.follow(2, -4)
  const wx = 7, wy = -3
  const x = cam.toPxX(wx), y = cam.toPxY(wy)
  return {
    x, y,
    draw(main: boolean, ready = true, progress = 0, lift = 0): Op[] {
      const { ctx, ops } = recordingCtx()
      drawUplink(ctx, cam, wx, wy, main, ready, progress, lift)
      return ops
    },
  }
}

function geometry(ops: Op[]): unknown[] {
  // Only progress-colored cell fills and text content may change.
  return ops.filter(o => o.op !== 'fillText' && !(o.op === 'fillRect' && o.fillStyle === ink.cyan))
    .map(({ op, args }) => ({ op, args }))
}

function chassisCenter(ops: Op[]): number[] {
  const end = ops.findIndex(o => o.op === 'closePath')
  const points = ops.slice(0, end).filter(o => o.op === 'moveTo' || o.op === 'lineTo')
  const xs = points.map(o => o.args[0] as number), ys = points.map(o => o.args[1] as number)
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}

function centerIndicator(ops: Op[]): number[] {
  const rect = ops.filter(o => o.op === 'fillRect' && o.fillStyle === ink.lime && o.args[2] === o.args[3]).at(-1)!
  return [(rect.args[0] as number) + (rect.args[2] as number) / 2, (rect.args[1] as number) + (rect.args[3] as number) / 2]
}

describe('main Uplink command-relay art', () => {
  it('replaces the ordinary disc/sprite with armored paths, a crown and eight energy cells', () => {
    const { x, y, draw } = fixture()
    const normal = draw(false), main = draw(true)
    expect(normal.filter(o => o.op === 'drawImage')).toHaveLength(1)
    expect(normal.filter(o => o.op === 'arc')).toHaveLength(1)
    expect(normal.find(o => o.op === 'arc')?.args).toEqual([x, y, 34 * 0.7, 0, Math.PI * 2])
    expect(main.filter(o => o.op === 'drawImage' || o.op === 'arc')).toHaveLength(0)
    expect(main.filter(o => o.op === 'closePath')).toHaveLength(2)
    expect(main.filter(o => o.op === 'fillRect' && o.fillStyle === '#486768')).toHaveLength(8)
    expect(main).toContainEqual(expect.objectContaining({ op: 'lineTo', args: [x, y - 42 * 1.12] }))
  })

  it.each([1, 8, 20, 30])('shares the ground center with the normal Uplink at scale %s', scale => {
    const { x, y, draw } = fixture(scale)
    const normal = draw(false), main = draw(true)
    expect(normal.find(o => o.op === 'arc')?.args.slice(0, 2)).toEqual([x, y])
    expect(chassisCenter(main)[0]).toBeCloseTo(x)
    expect(chassisCenter(main)[1]).toBeCloseTo(y)
    expect(centerIndicator(main)[0]).toBeCloseTo(x)
    expect(centerIndicator(main)[1]).toBeCloseTo(y)
    expect(main.filter(o => ['translate', 'rotate', 'scale', 'transform', 'setTransform'].includes(o.op))).toHaveLength(0)
  })

  it('keeps all main hardware fixed across inactive, ready and hacking states', () => {
    const { draw } = fixture()
    const idle = geometry(draw(true, false))
    expect(geometry(draw(true))).toEqual(idle)
    for (const progress of [0.01, 0.125, 0.5, 0.99, 1, 1.4]) {
      expect(geometry(draw(true, false, progress))).toEqual(idle)
    }
  })

  it('fills paired banks monotonically without changing the cell positions or progress semantics', () => {
    const { x, y, draw } = fixture()
    const cells = (progress: number) => draw(true, false, progress).filter(o => o.op === 'fillRect' && o.fillStyle === ink.cyan)
    const halfCell = cells(0.125), halfBank = cells(0.5), full = cells(1)
    expect(halfCell).toHaveLength(2)
    expect(halfBank).toHaveLength(4)
    expect(full).toHaveLength(8)
    expect(halfCell[0]?.args.slice(0, 2)).toEqual(full[0]?.args.slice(0, 2))
    expect(halfCell[0]?.args[2]).toBeCloseTo((full[0]!.args[2] as number) / 2)
    expect(cells(1.4)).toEqual(full)
    for (const progress of [0.125, 0.5, 1, 1.4]) {
      expect(draw(true, false, progress).find(o => o.op === 'fillText')?.args)
        .toEqual([`${Math.min(100, Math.floor(progress * 100))}%`, x, y + 42 + 5])
    }
    expect(draw(true).filter(o => o.op === 'fillText')).toHaveLength(0)
  })

  it('preserves the ordinary sprite and centered progress arc', () => {
    const { x, y, draw } = fixture()
    const idleSprite = draw(false).find(o => o.op === 'drawImage')
    for (const progress of [0.01, 0.5, 1]) {
      const ops = draw(false, false, progress)
      expect(ops.find(o => o.op === 'drawImage')).toEqual(idleSprite)
      const arcs = ops.filter(o => o.op === 'arc')
      expect(arcs).toHaveLength(3)
      expect(arcs.map(o => o.args.slice(0, 2))).toEqual([[x, y], [x, y], [x, y]])
      expect(arcs[2]?.args.slice(2)).toEqual([34 * 0.9, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2])
    }
  })

  it.each([false, true])('ignores legacy lift entirely, including any shadow geometry (main=%s)', main => {
    const { draw } = fixture()
    for (const progress of [0, 0.125, 0.5, 1]) {
      const baseline = draw(main, true, progress)
      expect(baseline.filter(o => o.op === 'ellipse')).toHaveLength(0)
      for (const lift of [0.2, 0.5, 1]) expect(draw(main, true, progress, lift)).toEqual(baseline)
    }
  })

  it('is deterministic and static with either motion preference', () => {
    const { draw } = fixture()
    const normalMotion = draw(true, false, 0.6, 1)
    motion.matches = true
    try {
      expect(draw(true, false, 0.6, 1)).toEqual(normalMotion)
      expect(draw(true, false, 0.6, 1)).toEqual(normalMotion)
    } finally { motion.matches = false }
  })
})
