import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'

type DrawRobot = typeof import('./art')['drawRobot']
type DrawVitals = typeof import('./art')['drawVitals']
interface Op { op: string; args: unknown[]; strokeStyle: unknown; fillStyle: unknown; lineWidth: unknown; globalAlpha: unknown }
let drawRobot: DrawRobot
let drawVitals: DrawVitals
let ink: typeof import('./art')['ink']
const motion = { matches: false }

beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => motion)
  vi.stubGlobal('document', { fonts: { load: () => Promise.resolve([]) } })
  vi.stubGlobal('Image', class { complete = true; naturalWidth = 64; src = '' })
  ;({ drawRobot, drawVitals, ink } = await import('./art'))
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

function draw(scale: number, invulnerable: boolean, dashing = false): Op[] {
  const cam = new Camera()
  cam.resize(scale * 40, scale * 25, 80)
  cam.follow(0, 0)
  const { ctx, ops } = recordingCtx()
  drawRobot(ctx, cam, 0, 0, 0, '#22d3ee', false, false, dashing, invulnerable, 12)
  return ops
}

function previousArc(ops: Op[], before: number): Op | undefined {
  for (let i = before - 1; i >= 0; i--) if (ops[i]?.op === 'arc') return ops[i]
  return undefined
}

describe('robot state shields', () => {
  it.each([8, 20, 30])('draws invulnerability as a green shield proportional to robot radius at scale %s', scale => {
    const ops = draw(scale, true)
    const r = Math.max(6, 0.6 * scale)
    const strokes = ops.map((op, index) => ({ op, index })).filter(({ op }) => op.op === 'stroke' && op.strokeStyle === ink.lime)
    expect(strokes).toHaveLength(2)
    const radii = strokes.map(({ index }) => {
      return previousArc(ops, index)?.args[2]
    })
    expect(radii).toEqual([r * 2.05, r * 2.05 * 1.16])
    expect(strokes.map(({ op }) => op.lineWidth)).toEqual([r * 0.12, r * 0.06])
    expect(ops.some(o => o.op === 'fill' && o.fillStyle === `${ink.lime}14`)).toBe(true)
  })

  it('uses the same radius as the ordinary shield while keeping invulnerability green', () => {
    const scale = 20, r = 0.6 * scale
    const invulnerable = draw(scale, true)
    const green = invulnerable.map((op, index) => ({ op, index })).filter(({ op }) => op.op === 'stroke' && op.strokeStyle === ink.lime)
      .map(({ index }) => previousArc(invulnerable, index)?.args[2])
    const cam = new Camera(); cam.resize(scale * 40, scale * 25, 80); cam.follow(0, 0)
    const { ctx, ops } = recordingCtx()
    drawRobot(ctx, cam, 0, 0, 0, '#22d3ee', false, true, false, false, 12)
    const white = ops.map((op, index) => ({ op, index })).filter(({ op }) => op.op === 'stroke' && (op.strokeStyle === ink.white || op.strokeStyle === '#ffffff70'))
      .map(({ index }) => previousArc(ops, index)?.args[2])
    expect(green).toEqual([r * 2.05, r * 2.05 * 1.16])
    expect(white).toEqual(green)
  })

  it('keeps the invulnerability shield green and distinct from the cyan dash ring', () => {
    const r = 0.6 * 20
    const stateRadii = (ops: Op[], color: string) => ops.map((op, index) => ({ op, index }))
      .filter(({ op }) => op.op === 'stroke' && op.strokeStyle === color)
      .map(({ index }) => previousArc(ops, index)?.args[2] as number)

    const invulnerable = draw(20, true, true)
    expect(stateRadii(invulnerable, ink.lime)).toEqual([r * 2.05, r * 2.05 * 1.16])
    expect(stateRadii(invulnerable, ink.cyan)).not.toContain(r * 1.75)

    const dash = draw(20, false, true)
    expect(stateRadii(dash, ink.cyan)).toContain(r * 1.75)
    expect(stateRadii(dash, ink.lime)).toHaveLength(0)
  })

  it('draws a bright green actual HP bar and a warm delayed-damage segment only for lost health', () => {
    const cam = new Camera(); cam.resize(800, 500, 80); cam.follow(0, 0)
    const { ctx, ops } = recordingCtx()
    drawVitals(ctx, cam, 0, 0, 40, 80, 'BOT', false, false, 75)
    const fills = ops.filter(o => o.op === 'fillRect')
    const actual = fills.find(o => o.fillStyle === '#8cff66')
    const delayed = fills.find(o => o.fillStyle === '#ffb066')
    expect(actual?.args[2]).toBeCloseTo(Math.max(24, 0.6 * cam.scale * 2.5) * 0.4)
    expect(delayed?.args[2]).toBeCloseTo(Math.max(24, 0.6 * cam.scale * 2.5) * 0.35)
    expect(delayed?.args[0]).toBeCloseTo((actual?.args[0] as number) + (actual?.args[2] as number))
  })

  it('uses a static green shield under reduced motion', () => {
    motion.matches = true
    try {
      const first = draw(20, true), second = draw(20, true)
      expect(first).toEqual(second)
      expect(first.filter(o => o.op === 'stroke' && o.strokeStyle === ink.lime).map(o => o.globalAlpha)).toEqual([0.64, 0.33280000000000004])
    } finally { motion.matches = false }
  })
})
