// 脚本运行时入口约定：玩家代码导出 tick 函数，60Hz 与模拟同频调用。
// 模块级状态跨 tick 存活；单 tick 配额默认 10ms（可配置），超时该 tick idle。

import type { Observation, Self, GameInfo, L0, L1 } from './index'

export interface TickContext {
  self: Self
  game: GameInfo
  scan(): Observation
  api: L0 & L1
}

export type BotModule = { tick(ctx: TickContext): void }
