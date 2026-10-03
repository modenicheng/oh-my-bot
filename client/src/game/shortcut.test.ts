// 战场按键路由：Space/小键盘 Enter 切辅助总开关，普通 Enter 保留给全场发言，
// R 夺回炮塔轴（辅助脚本正在瞄准时鼠标不抢轴）。
// 修饰键/输入法/焦点守卫在 main.ts 全局 keydown 先行过滤，不属本纯函数职责。
import { describe, expect, it } from 'vitest'
import { battleKeyAction } from './shortcut'

describe('battleKeyAction', () => {
  it('Space 与小键盘 Enter 都映射为辅助总开关', () => {
    expect(battleKeyAction('Space')).toBe('assist')
    expect(battleKeyAction('NumpadEnter')).toBe('assist')
  })

  it('普通 Enter 映射为全场发言，不被辅助吞掉', () => {
    expect(battleKeyAction('Enter')).toBe('chat')
  })

  it('R 映射为炮塔轴夺取（aim guard 的显式入口）', () => {
    expect(battleKeyAction('KeyR')).toBe('aim')
  })

  it('其余按键返回 undefined（不拦截、不 preventDefault）', () => {
    expect(battleKeyAction('KeyW')).toBeUndefined()
    expect(battleKeyAction('Escape')).toBeUndefined()
    expect(battleKeyAction('')).toBeUndefined()
  })
})
