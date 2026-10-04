import { describe, expect, it } from 'vitest'
import { appendWallShadow } from './shadow'

// 纯几何契约：世界坐标输入/输出，不依赖 Canvas。range=20m 与渲染视野一致。

interface P { x: number; y: number }
const wall = (minx: number, miny: number, maxx: number, maxy: number) => ({ min: { x: minx, y: miny }, max: { x: maxx, y: maxy } })
const run = (sx: number, sy: number, w: ReturnType<typeof wall>, range = 20): P[] => {
  const pts: number[] = []
  appendWallShadow(pts, sx, sy, w, range)
  expect(pts.length % 2).toBe(0)
  const out: P[] = []
  for (let i = 0; i < pts.length; i += 2) out.push({ x: pts[i]!, y: pts[i + 1]! })
  return out
}
/** 轴对齐方向角 c_i（CCW）→ 预期角点，方便断言链顺序。 */
const cw = (w: ReturnType<typeof wall>) => [
  { x: w.min.x, y: w.min.y }, { x: w.max.x, y: w.min.y }, { x: w.max.x, y: w.max.y }, { x: w.min.x, y: w.max.y },
]

/** 射线法（even-odd）点在多边形内判定：足够本测试的简单（凸/近凸）影多边形。 */
function inside(p: P, poly: P[]): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}
/** 影多边形不得覆盖墙身内部（墙本体保持可见）。 */
function expectWallVisible(w: ReturnType<typeof wall>, poly: P[]): void {
  const cx = (w.min.x + w.max.x) / 2, cy = (w.min.y + w.max.y) / 2
  expect(inside({ x: cx, y: cy }, poly)).toBe(false)
}

describe('appendWallShadow silhouette geometry', () => {
  it('axis-aligned viewpoint east: full wraparound exit chain with two tangent extensions', () => {
    const w = wall(10, -2, 14, 2)
    const poly = run(0, 0, w)
    // 光线在 y 范围内：出口边绕满一圈 → 链 = 全部 4 角 + 经 c3/c0 的延长点。
    expect(poly.slice(0, 4)).toEqual(cw(w))
    expect(poly).toHaveLength(6)
    for (const ext of poly.slice(4)) expect(Math.hypot(ext.x, ext.y)).toBeGreaterThan(20)
    // 延长点在「光源→切线角点」射线上（叉积≈0 且在角点外侧）。
    for (const [ext, c] of [[poly[4]!, cw(w)[3]!], [poly[5]!, cw(w)[0]!]] as const) {
      const cross = c.x * ext.y - c.y * ext.x
      expect(Math.abs(cross)).toBeLessThan(1e-6)
      expect(c.x * (ext.x - c.x) + c.y * (ext.y - c.y)).toBeGreaterThan(0)
    }
    expectWallVisible(w, poly)
    // 阴影覆盖墙背后的采样点、不覆盖墙前方。
    expect(inside({ x: 16, y: 0 }, poly)).toBe(true)
    expect(inside({ x: 5, y: 0 }, poly)).toBe(false)
  })

  it('axis-aligned viewpoint west (across the +/-pi direction): wraparound chain without angle sort', () => {
    const w = wall(-14, -2, -10, 2)
    const poly = run(0, 0, w)
    // start=c2：链从右上角起绕满 4 角（c2,c3,c0,c1），无任何 atan2 排序。
    expect(poly.slice(0, 4)).toEqual([cw(w)[2], cw(w)[3], cw(w)[0], cw(w)[1]])
    expect(poly).toHaveLength(6)
    for (const ext of poly.slice(4)) {
      expect(Math.hypot(ext.x, ext.y)).toBeGreaterThan(20)
      expect(Number.isFinite(ext.x) && Number.isFinite(ext.y)).toBe(true)
    }
    expectWallVisible(w, poly)
    expect(inside({ x: -16, y: 0 }, poly)).toBe(true)
  })

  it('thin wall below the light: 3-corner chain, no NaN from the small span', () => {
    const w = wall(10, -0.2, 14, 0.2)
    const poly = run(0, 5, w)
    expect(poly.slice(0, 3)).toEqual([cw(w)[0], cw(w)[1], cw(w)[2]])
    expect(poly).toHaveLength(5)
    for (const p of poly) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
    expectWallVisible(w, poly)
  })

  it('diagonal viewpoint (NE of source): 3-corner far chain', () => {
    const w = wall(10, 10, 14, 14)
    const poly = run(0, 0, w)
    // start=c1：链 c1,c2,c3 = 右下→右上→左上。
    expect(poly.slice(0, 3)).toEqual([cw(w)[1], cw(w)[2], cw(w)[3]])
    expect(poly).toHaveLength(5)
    for (const p of poly) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    expectWallVisible(w, poly)
    expect(inside({ x: 16, y: 16 }, poly)).toBe(true)
  })

  it('light collinear with a wall edge line (sy == min.y): stable 3-corner chain', () => {
    const w = wall(10, 0, 14, 4)
    const poly = run(0, 0, w)
    expect(poly.slice(0, 3)).toEqual([cw(w)[1], cw(w)[2], cw(w)[3]])
    for (const p of poly) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
  })

  it('light exactly on a corner ray: still finite, far corner on the chain', () => {
    const w = wall(4, 4, 8, 8)
    const poly = run(0, 0, w)
    expect(poly.length).toBeGreaterThanOrEqual(4)
    for (const p of poly) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    expect(poly).toContainEqual(cw(w)[2])
    expectWallVisible(w, poly)
  })

  it('self inside a wall: vision box minus wall body (NaN-separated subpaths)', () => {
    const w = wall(-2, -3, 4, 5)
    const pts: number[] = []
    expect(appendWallShadow(pts, 1, 1, w, 20)).toBe(18)
    expect(pts.length).toBe(18)
    // reach = 20*2.5 + max(6,8) = 58 → pad=58，大框以自机为中心。
    expect(pts.slice(0, 8)).toEqual([1 - 58, 1 - 58, 1 + 58, 1 - 58, 1 + 58, 1 + 58, 1 - 58, 1 + 58])
    expect(pts.slice(8, 12)).toEqual([Number.NaN, Number.NaN, -2, -3])
    // 第二子路径 = CCW 墙身矩形，nonzero 下与正向大框相消 → 墙身可见。
    expect(pts.slice(12)).toEqual([-2, 5, 4, 5, 4, -3])
  })

  it('self exactly on a wall edge (epsilon inside): treated as in-wall', () => {
    const pts: number[] = []
    expect(appendWallShadow(pts, 10, 0, wall(10, -2, 14, 2), 20)).toBe(18)
  })

  it('zero-area / degenerate walls project nothing', () => {
    expect(run(0, 0, wall(10, 10, 10, 14))).toEqual([])
    expect(run(0, 0, wall(10, 10, 14, 10))).toEqual([])
    expect(run(0, 0, { min: { x: Number.NaN, y: 0 }, max: { x: 4, y: 4 } })).toEqual([])
  })

  it('wall entirely outside the vision radius projects nothing', () => {
    expect(run(0, 0, wall(30, -2, 34, 2))).toEqual([])
    // min 在圆外但墙身与圆相交 → 仍投影（保守正确侧）。
    expect(run(0, 0, wall(19.0001, 0, 30, 8), 20)).not.toEqual([])
  })
})

function signedArea(poly: P[]): number {
  let s = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j]!.x - poly[i]!.x) * (poly[j]!.y + poly[i]!.y)
  return s / 2
}

describe('appendWallShadow overlap strength (L assembly)', () => {
  it('both pieces shadow the far overlap region; single-fill contract keeps one strength', () => {
    // L 形两件套：base (4×0.7) + 垂直 stub，0.7×0.7 正面积重叠（mapgen 语义）。
    const base = wall(9.3, -0.35, 13.3, 0.35)
    const stub = wall(12.6, -0.35, 13.3, 3.5)
    const pb = run(0, 0, base)
    const ps = run(0, 0, stub)
    // 两片绕向一致（链沿 CCW 角序 → 影多边形统一为 CW/负面积）：重叠远区绕向数
    // 叠加为 -2，但渲染契约（render.test.ts）单次 fill()，nonzero 下仍是一次强度。
    expect(signedArea(pb)).toBeLessThan(0)
    expect(signedArea(ps)).toBeLessThan(0)
    for (const p of [{ x: 16, y: 0 }, { x: 16, y: 0.3 }, { x: 15, y: 0.15 }, { x: 17, y: 0.2 }]) {
      expect(inside(p, pb)).toBe(true)
      expect(inside(p, ps)).toBe(true)
    }
    // 墙身内部不被任何一片覆盖。
    expectWallVisible(base, pb)
    expectWallVisible(stub, ps)
  })
})
