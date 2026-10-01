// 脚本运行时入口约定：玩家代码导出 tick 函数，60Hz 与模拟同频调用。
// 模块级状态跨 tick 存活；单 tick 配额默认 10ms（可配置），超时该 tick idle。

import type { BotContext } from './index'

/** @deprecated 使用 BotContext；旧脚本类型名继续兼容。 */
export type TickContext = BotContext

export type BotModule = { tick(bot: BotContext): void }
