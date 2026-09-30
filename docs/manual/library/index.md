---
title: Bot Script 库手册
audience: coder
---

# Bot Script 库手册

[bot-scripting.md](../bot-scripting.md) 负责「从零到第一个能跑的 Bot」；本库是它的深度参考——**每个 API 的真实语义、服务器强制行为与可跑示例**。写复杂 Bot、排查「为什么不生效」、或让 AI Agent 帮你改码时，查这里。

## 双受众说明

本库与 `@omb/bot-api` 的类型定义共同构成 AI Agent 的注入语料：

- 所有数值（冷却、射程、能量、判定半径）与服务器实现逐一对齐（`server/internal/sim/gameplay.go` 等处常量）；
- 每个 API 标注「服务端强制」——节流、冷却、判定由服务器执行，脚本侧重试或绕过均无效；
- 与设计文档的暂差（如 pulseScan 扩视野尚未接入脚本观测管线）如实标注 **v1 当前实现**，不粉饰。

## 写作契约：TS 书写、JS 语义

编辑器里按 TS 写（享受 `@omb/bot-api` 补全），但提交的源码必须是**合法 JS**：

- 允许：`import type { ... } from '@omb/bot-api'`、`export default bot`——提交时被服务器剥除；
- 拒绝：任何类型注解（`const bot: BotModule`、`tick(ctx: TickContext)`）、`type/interface/enum` 声明、`as const`、`Array<number>` 泛型。命中即整份拒载，旧脚本继续运行（Hot Swap 安全）；
- 入口二选一：顶层 `function tick(ctx) {}`，或 `const bot = { tick(ctx) {} }` + `export default bot`。

## 五行起步

```ts
import type { BotModule } from '@omb/bot-api'

const bot = {
  tick(ctx) {
    const e = ctx.api.nearestEnemy()
    if (e) { ctx.api.aimAt(e); ctx.api.fire() }
  },
}
export default bot
```

五行之外想要完整行为（捡分、占桩、缠斗、协作），从示例库拿走即改：

| 示例 | 教学点 |
|---|---|
| [examples/hello-bot.ts](examples/hello-bot.ts) | 最小闭环：感知 → 索敌 → 转向 → 开火 |
| [examples/patrol.ts](examples/patrol.ts) | 模块级状态 + 路标循环移动 |
| [examples/core-farmer.ts](examples/core-farmer.ts) | 捡 Core 得分 + 路过交火 |
| [examples/uplink-rusher.ts](examples/uplink-rusher.ts) | 占桩黑入 + 个人 CD 自记 |
| [examples/shield-brawler.ts](examples/shield-brawler.ts) | 近战：护盾 / 位移 / 能量管理 |
| [examples/partner-duo.ts](examples/partner-duo.ts) | 搭档跟随与夹击走位 |

## 导航

| 文档 | 内容 |
|---|---|
| [modules.md](modules.md) | 六大模块语义与陷阱：tick 生命周期 / 感知 / 移动与战斗 / 目标交互 / 存活 / 通信 |
| [api.md](api.md) | L0+L1 全部 14 个 API、Observation/Self/GameInfo 逐字段、TickContext/BotModule 生命周期 |

## 三个最贵的坑（先记这三条）

1. **轴锁存**：`fire()/dash()/interact()` 调用一次 = 持续按住，直到死亡或玩家关辅助。没有 `fire(false)`。详见 [modules.md §3](modules.md#3-移动与战斗)。
2. **一拍延迟**：脚本看到的是 tick T 的世界，命令在 T+1 才生效。瞄准留提前量、到点判定留阈值。
3. **个人黑入 CD 不下发**：Observation 没有「我在这根桩的 CD」字段，30s 冷却自己用 `game.time` 记。

## 与入门文档的分工

| | bot-scripting.md | 本库 |
|---|---|---|
| 定位 | 入门：写出第一个 Bot | 参考：全部 API 与真实行为 |
| 深度 | tick 模型概览、API 速查表 | 逐 API 服务端行为、数据结构逐字段、模块级陷阱 |
| 示例 | 五行起步 | 六个完整可跑示例（每个 ≤60 行、含教学点注释） |
