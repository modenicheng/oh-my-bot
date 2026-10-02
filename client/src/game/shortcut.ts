// 战场按键路由（纯函数，便于单测）：
// - Space：驾驶辅助总开关（三分支，权威在服务器）。
// - NumpadEnter：Space 的无冲突备用（普通 Enter 保留给全场发言）。
// 修饰键/输入法/焦点守卫由调用方（main.ts 全局 keydown）先行过滤。

export type BattleKeyAction = 'assist' | 'chat'

/** 战场画布获焦时的按键语义；未识别按键返回 undefined（不拦截）。 */
export function battleKeyAction(code: string): BattleKeyAction | undefined {
  if (code === 'Space' || code === 'NumpadEnter') return 'assist'
  if (code === 'Enter') return 'chat'
  return undefined
}
