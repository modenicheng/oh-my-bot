// Package script 提供 Bot Script 运行时（ADR-0007 r2：60Hz 单时钟、并行脚本池）。
//
// v1 唯一实现是 GojaRuntime：goja ES5.1 沙箱。玩家脚本以全局 tick(ctx)
// 为入口（手册 §五行代码起步），每 tick 由仲裁器调用，产出 sim.ScriptCommands。
//
// 与 @omb/bot-api（packages/bot-api/src/index.ts + runtime.ts）对齐：
// TickContext { self, game, scan(), api }，api = L0 原语 + L1 便利层。
// 手册 docs/manual/bot-scripting.md 是行为基准。
//
// 配额：单 tick wall-clock（默认 10ms，Config 可调）。到期通过 goja
// interrupt 强制中断，返回 ErrQuotaExceeded，该 tick 脚本轴全清（idle）。
//
// TypeScript：v1 拒绝 TS 源码（ErrTypeScript）。启发式探测类型注解 /
// export type / interface 声明；编译器引入延后（手册以 JS 为准，玩家可
// 在本地用 tsc 编译后提交产物 JS）。
//
// 并行池 RunPool：worker = min(64, NumCPU)，Submit/Collect 帧级 API；
// 超 deadline 未完成的脚本标记 Deferred（顺延下一 tick，计 idle 不计异常）。
package script

import "github.com/modenicheng/oh-my-bot/server/internal/sim"

// 编译期契约：GojaRuntime 实现 sim.Runtime。
var _ sim.Runtime = (*GojaRuntime)(nil)
