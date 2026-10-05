import { describe, expect, it } from 'vitest'
import { clamp, clamp01, lerp, lerpAngle } from './math'

describe('clamp', () => {
  it('三点钳制：越界回边界、界内原样、NaN 穿透', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
    expect(Number.isNaN(clamp(Number.NaN, 0, 10))).toBe(true)
  })
})

describe('clamp01', () => {
  it('[0,1] 钳制', () => {
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(-0.1)).toBe(0)
    expect(clamp01(1.2)).toBe(1)
  })
})

describe('lerp', () => {
  it('端点取值与中点线性', () => {
    expect(lerp(2, 4, 0)).toBe(2)
    expect(lerp(2, 4, 1)).toBe(4)
    expect(lerp(2, 4, 0.5)).toBe(3)
  })
})

describe('lerpAngle', () => {
  it('端点取值', () => {
    expect(lerpAngle(1, 2, 0)).toBeCloseTo(1)
    expect(lerpAngle(1, 2, 1)).toBeCloseTo(2)
  })

  it('跨 ±π 走最短弧，不绕远', () => {
    // 3.1 与 -3.1 相差约 0.083 弧度，中点应落在 π 附近而不是 0 附近
    const mid = lerpAngle(3.1, -3.1, 0.5)
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(1e-9)
    // 反向同理：-3.1 → 3.1 的中点靠近 -π
    const midBack = lerpAngle(-3.1, 3.1, 0.5)
    expect(Math.abs(Math.abs(midBack) - Math.PI)).toBeLessThan(1e-9)
  })
})
