import { describe, expect, it } from 'vitest'
import { goNum, goVec2, goVec2Lenient } from './gojson'

// Go 无 json tag 的结构体走大写键名（X/Y、Min/Max）；两套守卫策略语义不同，
// 这里冻结各自边界：严格版拒绝一切非有限数字，宽容版接受数字型字符串。

describe('goNum', () => {
  it('接受有限数字并按大写优先链回退默认值', () => {
    expect(goNum(3.5)).toBe(3.5)
    expect(goNum(undefined, 7)).toBe(7)
    expect(goNum(null, 7)).toBe(7)
    expect(goNum('12', 7)).toBe(7)
    expect(goNum(Number.NaN, 7)).toBe(7)
    expect(goNum(Number.POSITIVE_INFINITY, 7)).toBe(7)
  })
})

describe('goVec2（严格）', () => {
  it('大写 X/Y 优先、小写兼容、缺失回退 0', () => {
    expect(goVec2({ X: 1, Y: 2 })).toEqual({ x: 1, y: 2 })
    expect(goVec2({ x: 3, y: 4 })).toEqual({ x: 3, y: 4 })
    expect(goVec2({ X: 5, y: 6 })).toEqual({ x: 5, y: 6 })
    expect(goVec2({})).toEqual({ x: 0, y: 0 })
    expect(goVec2(null)).toEqual({ x: 0, y: 0 })
    expect(goVec2(42)).toEqual({ x: 0, y: 0 })
  })

  it('字符串坐标不隐式转换，整成分回退 0', () => {
    expect(goVec2({ X: '1.5', Y: '2.5' })).toEqual({ x: 0, y: 0 })
    expect(goVec2({ X: 1, Y: '2.5' })).toEqual({ x: 1, y: 0 })
  })
})

describe('goVec2Lenient（宽容）', () => {
  it('数字型字符串经 Number() 强转，与回放索引 numOr 同族', () => {
    expect(goVec2Lenient({ X: '1.5', Y: '2.5' })).toEqual({ x: 1.5, y: 2.5 })
    expect(goVec2Lenient({ x: 3, y: 4 })).toEqual({ x: 3, y: 4 })
  })

  it('无法强转的成分得 NaN、缺键回退 0（维持既有行为）', () => {
    expect(goVec2Lenient({ X: 'abc' })).toEqual({ x: Number.NaN, y: 0 })
    expect(goVec2Lenient({})).toEqual({ x: 0, y: 0 })
    expect(goVec2Lenient(null)).toEqual({ x: 0, y: 0 })
  })
})
