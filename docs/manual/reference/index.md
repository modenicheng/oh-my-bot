---
title: API 总览
audience: both
order: 4
tags: [脚本, API]
---

# API 总览

这里是 Bot Script 的完整参考：**全部 14 个动作、全部数据结构、运行语义与陷阱**。写复杂 Bot、排查"为什么不生效"、或让 AI Agent 帮你改码时，查这里。

入门教学（从零到第一个能跑的 Bot）在[写第一个 Bot](../code/bot-scripting.md)；本参考负责深度。

## 怎么读这套参考

- **这套参考讲的是"给你的机器人编程"**——`@omb/bot-api` 的全部内容。它不涉及服务器部署、网络协议等平台内部：那是运营者的事，与写 Bot 无关。
- 冷却、射程、能量和判定半径按当前实现说明；尚未接入对局链路的能力会单独标注。
- **所有"游戏规则"条目都是硬判定**：节流、冷却、合法性检查由游戏统一执行，脚本侧重试、绕过、抢跑均无效。
- 代码示例有多语言标签页（TS / Python / Java）。**游戏只运行 JS/TS**——其他语言的标签页只是同一段逻辑的转写，帮你用熟悉的语言读懂，不能直接提交。

## 分页导航

| 文档 | 内容 |
|---|---|
| [动作参考](actions.md) | L0 原语 7 个：move / aimAt / fire / dash / shield / interact / say。含"锁存"概念的完整讲解 |
| [便利层参考](helpers.md) | L1 便利层 7 个：moveTo / aimAt(target) / nearestEnemy / nearestCore / nearestUplink / partner / pulseScan |
| [数据结构](data.md) | Observation / RobotRef / Self / GameInfo 逐字段，TickContext 与 BotModule 生命周期 |
| [模块语义与陷阱](modules.md) | 按主题拆解运行规则：tick 生命周期 / 感知 / 移动与战斗 / 目标交互 / 存活 / 通信，每个主题附陷阱清单 |

## 三个最贵的坑（先记这三条）

1. **轴锁存**：`fire()` / `dash()` / `interact()` 调用一次 = 持续按住，直到死亡、脚本异常/超时或玩家关辅助。没有 `fire(false)`。详见[动作参考的锁存一节](actions.md)。
2. **一拍延迟**：脚本在第 T 帧看到的世界，指令在 T+1 帧才生效。瞄准留提前量、到点判定留阈值（写 `dist < 2`，别写 `dist == 0`）。
3. **个人黑入冷却不下发**：感知数据里没有"我在这根桩还剩几秒冷却"的字段，成功事件也不下发，`game.time` 只能用于估算等待时间（见示例库 `uplink-rusher`）。

## 提交契约速记

按 TS 写、必须是合法 JS：`import type` 与 `export default` 会被剥掉；类型注解、`type`/`interface`/`enum` 声明、泛型会**整份拒收**（旧脚本继续跑）。完整说明见[写第一个 Bot](../code/bot-scripting.md)。

## 示例库

仓库 `docs/manual/examples/` 下有 6 个完整可跑的示例（每个不超过 60 行，带教学点注释）：

| 示例 | 教学点 |
|---|---|
| `hello-bot.ts` | 最小闭环：感知 → 索敌 → 转向 → 开火 |
| `patrol.ts` | 模块级状态 + 路标循环移动 |
| `core-farmer.ts` | 捡 Core 得分 + 路过交火 |
| `uplink-rusher.ts` | 减速站桩 + 引导计时与等待估算 |
| `shield-brawler.ts` | 近战：护盾 / 位移 / 能量管理 |
| `partner-duo.ts` | 搭档跟随与夹击走位 |

游戏内阅读器只展示 Markdown——示例源码请到仓库里看；各示例的关键片段已内嵌在[模块语义与陷阱](modules.md)对应小节里。
