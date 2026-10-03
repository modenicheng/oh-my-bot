import { describe, it, expect } from 'vitest'
import { completionContext, seedsForContext } from './bot-completions'

describe('completionContext', () => {
  it('检测 bot 点号触发并剥离无参调用括号', () => {
    expect(completionContext('bot.')).toEqual({ atDot: true, chain: ['bot'], word: '' })
    expect(completionContext('bot.scan().')).toEqual({ atDot: true, chain: ['bot', 'scan'], word: '' })
  })

  it('带参调用与未知接收者不成链，交给 TS 补全', () => {
    expect(completionContext('bot.move(1, 2).')).toEqual({ atDot: true, chain: [], word: '' })
    expect(completionContext('const enemy = en')).toEqual({ atDot: false, chain: [], word: 'en' })
  })
})

describe('seedsForContext', () => {
  it('bot. 同时给出动作、self/game/scan，不突出旧 api/partner', () => {
    const labels = seedsForContext(completionContext('bot.')).map(s => s.label)
    expect(labels).toContain('move')
    expect(labels).toContain('nearestEnemy')
    expect(labels).toContain('self')
    expect(labels).toContain('game')
    expect(labels).toContain('scan')
    expect(labels).not.toContain('api')
    expect(labels).not.toContain('partner')
  })

  it('bot.scan(). 给出 healthPacks、walls 等 Observation 成员', () => {
    const seeds = seedsForContext(completionContext('bot.scan().'))
    const labels = seeds.map(s => s.label)
    expect(labels).toContain('robots')
    expect(labels).toContain('uplinks')
    expect(labels).toContain('healthPacks')
    expect(labels).toContain('walls')
    expect(seeds.find(s => s.label === 'healthPacks')?.detail).toContain('id/x/y/available/respawnInS')
  })

  it('scan().projectiles. 给出 id/owner/x/y/heading 弹体字段', () => {
    const seeds = seedsForContext(completionContext('bot.scan().projectiles.'))
    const labels = seeds.map(s => s.label)
    expect(labels).toContain('id')
    expect(labels).toContain('owner')
    expect(labels).toContain('heading')
    expect(seeds).toHaveLength(5)
  })

  it('词前缀只推荐 canonical bot 入口', () => {
    expect(seedsForContext(completionContext('b')).map(s => s.label)).toEqual(['bot', 'botmod'])
    expect(seedsForContext(completionContext('tick'))).toHaveLength(1)
    expect(seedsForContext(completionContext('ctx'))).toEqual([])
  })

  it('未知接收者返回空，避免与 TS 补全重复', () => {
    expect(seedsForContext(completionContext('foo.bar.'))).toEqual([])
  })
})
