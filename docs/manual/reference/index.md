---
title: API 总览
audience: both
order: 4
tags: [脚本, API]
---

# API 总览

这里是 Bot Script 的完整参考：13 个动作、全部数据结构、运行语义与陷阱。写复杂 Bot、排查"为什么不生效"、或者给 AI Agent 提供上下文，都从这里查。

入门教学在[写第一个 Bot](../code/bot-scripting.md)，这份参考负责深度。

## 怎么读

- 这套参考只讲 `@omb/bot-api`，也就是你的机器人能调用的一切。服务器部署、网络协议属于运营者的事，跟写 Bot 无关。
- 冷却、射程、能量和判定半径都按当前实现写；还没接入对局链路的能力会单独标注。
- 所有"游戏规则"条目都是硬判定。节流、冷却、合法性检查由服务器统一执行，脚本重试、绕过、抢跑都无效。
- 示例统一用 TypeScript。游戏只运行 JS/TS，TS 在浏览器里编译成 JS 再提交；写 JS 的话，去掉类型注解即可。

## 分页导航

| 文档 | 内容 |
|---|---|
| [动作参考](actions.md) | L0 原语 7 个：move / aimAt / fire / dash / shield / interact / say。含每 tick 意图规则 |
| [便利层参考](helpers.md) | L1 便利方法 7 个：moveTo / navigateTo / aimAt(target) / nearestEnemy / nearestCore / nearestUplink / pulseScan |
| [数据结构](data.md) | Observation / RobotRef / Self / GameInfo 逐字段，BotModule 生命周期 |
| [模块语义与陷阱](modules.md) | 按主题拆：tick 生命周期 / 感知 / 移动与战斗 / 目标交互 / 存活 / 通信，每个主题附陷阱 |
| [图鉴：界面与实体](visual.md) | 真实渲染的场地、机器人、拾取物、子弹、图标与界面截图 |

## 六个先记住的坑

1. **每 tick 重算**。这一帧没调用的动作就是中立，不会延续上一帧。想持续开火、冲刺、举盾或引导，就在条件成立的每帧调用。旧 `bot.api` 只是语法兼容，不恢复锁存。
2. **一拍延迟**。第 T 帧看到的世界是 T 时刻的，指令第 T+1 帧生效。到位判定留阈值，写 `dist < 2`，别写 `dist == 0`。
3. **个人黑入冷却不下发**。感知里没有"我在这根桩还剩几秒"，成功事件也不给你。只能拿 `game.time` 估算，估算不等于确认。
4. **非法数字会连坐**。动作参数出现 `NaN` 或 `Infinity`，这一帧你的全部脚本动作作废，人的手操不受影响。
5. **`aimAt` 传实体要先确认可见**。瞄一个被墙挡住的机器人，当场抛异常 `aimAt: entity not visible`，该帧动作全部作废。
6. **开火意图和黑入互斥**。本帧只要调用过 `fire()`，就不能引导 Uplink，哪怕这一帧因为冷却或能量根本没射出子弹。

## 提交契约速记

按 TS 写，产出必须是合法 JS：`import type` 和 `export default` 会被剥掉；类型注解、`type` / `interface` / `enum` 声明、泛型会被**整份拒收**，旧脚本继续跑。整条消息不超过 64 KiB。完整说明见[写第一个 Bot](../code/bot-scripting.md)。

## 示例库

仓库 `docs/manual/examples/` 下有七个完整可跑的示例，每个不超过 80 行，带教学点注释：

| 示例 | 教学点 |
|---|---|
| `hello-bot.ts` | 最小闭环：感知 → 索敌 → 转向 → 开火 |
| `patrol.ts` | 模块级状态 + 路标巡逻 |
| `core-farmer.ts` | 捡 Core 得分 + 路过交火 |
| `uplink-rusher.ts` | 站桩引导与等待估算 |
| `shield-brawler.ts` | 近战：护盾、位移、能量管理 |
| `predictive-shield.ts` | 弹道预测：只在即将命中时开盾，heading + 位移双重校验 |
| `flank-strike.ts` | 侧翼走位与发现敌人时报点 |

游戏内阅读器只显示 Markdown，示例源码请到仓库里看。各示例的关键片段也内嵌在[模块语义与陷阱](modules.md)对应小节。
