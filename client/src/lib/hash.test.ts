import { describe, expect, it } from 'vitest'
import { HASH_MIX, hash32 } from './hash'

// 视觉冻结契约（C-18）：共享助手必须与原三处内联实现逐位一致，
// 否则 startup 侵蚀瓦片 / 标题碎片 / 低血噪声的时序外观全部漂移。
describe('hash32 / HASH_MIX visual freeze', () => {
  it('reproduces the literal inline expression Math.imul(v, 0x45d9f3b) >>> 0', () => {
    expect(HASH_MIX).toBe(0x45d9f3b)
    // startup-art erodeText: index + 1 + seed
    expect(hash32(0 + 1 + 0)).toBe(Math.imul(0 + 1 + 0, 0x45d9f3b) >>> 0)
    expect(hash32(41 + 1 + 691)).toBe(Math.imul(41 + 1 + 691, 0x45d9f3b) >>> 0)
    // startup erodeScreen: (x/cell + 1) * 73 + (y/cell + 1) * 193
    expect(hash32((12 + 1) * 73 + (7 + 1) * 193)).toBe(Math.imul((12 + 1) * 73 + (7 + 1) * 193, 0x45d9f3b) >>> 0)
    // feedback low-health noise first round
    expect(hash32((30 + 1) ^ (1 * 193) ^ (2 * 941))).toBe(Math.imul((30 + 1) ^ (1 * 193) ^ (2 * 941), 0x45d9f3b) >>> 0)
  })

  it('stays a uint32 across sign flips and large inputs', () => {
    for (const v of [0, 1, -1, 2 ** 31, 2 ** 31 - 1, -(2 ** 31), 0xdeadbeef, 987654321]) {
      const h = hash32(v)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
      expect(h).toBe(Math.imul(v, 0x45d9f3b) >>> 0)
    }
  })

  it('mixes adjacent inputs differently (noise stays irregular)', () => {
    expect(hash32(1000)).not.toBe(hash32(1001))
    const values = Array.from({ length: 64 }, (_, i) => hash32(i + 1))
    expect(new Set(values).size).toBe(64)
  })
})
