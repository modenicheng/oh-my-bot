import { describe, it, expect } from 'vitest'
import { completionContext, seedsForContext } from './bot-completions'

describe('completionContext', () => {
  it('检测点号触发并剥离无参调用括号', () => {
    expect(completionContext('ctx.')).toEqual({ atDot: true, chain: ['ctx'], word: '' })
    expect(completionContext('ctx.scan().')).toEqual({ atDot: true, chain: ['ctx', 'scan'], word: '' })
  })

  it('带参调用与未知接收者不成链，交给 TS 补全', () => {
    expect(completionContext('ctx.api.move(1, 2).')).toEqual({ atDot: true, chain: [], word: '' })
    const word = completionContext('const enemy = en')
    expect(word).toEqual({ atDot: false, chain: [], word: 'en' })
  })

  it('提取标识符前缀', () => {
    expect(completionContext('').word).toBe('')
    expect(completionContext('  ne').word).toBe('ne')
  })
})

describe('seedsForContext', () => {
  it('ctx. 给出 api/self/game/scan', () => {
    const labels = seedsForContext(completionContext('ctx.')).map(s => s.label)
    expect(labels).toEqual(['api', 'self', 'game', 'scan'])
  })

  it('ctx.api. 给出 L0+L1 动作', () => {
    const labels = seedsForContext(completionContext('ctx.api.')).map(s => s.label)
    expect(labels).toContain('move')
    expect(labels).toContain('nearestEnemy')
    expect(labels).toContain('pulseScan')
    expect(labels).toHaveLength(13)
  })

  it('ctx.scan(). 给出 Observation 成员', () => {
    const labels = seedsForContext(completionContext('ctx.scan().')).map(s => s.label)
    expect(labels).toContain('robots')
    expect(labels).toContain('uplinks')
  })

  it('词前缀过滤顶层种子', () => {
    expect(seedsForContext(completionContext('c')).map(s => s.label)).toEqual(['ctx'])
    expect(seedsForContext(completionContext('botm'))).toHaveLength(1)
    expect(seedsForContext(completionContext('zzz'))).toEqual([])
  })

  it('未知接收者返回空，避免与 TS 补全重复', () => {
    expect(seedsForContext(completionContext('foo.bar.')).map(s => s.label)).toEqual([])
  })
})
