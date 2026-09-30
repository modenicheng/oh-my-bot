---
title: oh-my-bot 玩家手册
audience: both
---

# oh-my-bot 玩家手册

64 人实时机器人派对大乱斗：任何人手操入场，按自己的节奏把机器人逐步交给 Snippet、AI Agent 或自写代码。**编程抬高天花板，但绝不是入场门槛。**

## 三分钟上手（零代码路径）

1. **进房**：打开进房链接（或输入房间码），填昵称、选配色，进入房间。
2. **热身**：开赛前你在热身场（Warmup）里自由漫游全图，试试 WASD 手操和鼠标射击。
3. **开赛**：房主点"开始"，8 分钟一局。前 4 分钟在外环争夺 Core 与 Uplink，4:00 转段后中央核心区开放，仅此而已——基础规则全程不变。
4. **开 Snippet**：按 `Tab` 打开编辑器，在 Snippet 面板启用"自动瞄准""自动拾取"等驾驶辅助，按你手感留几根轴自己控。
5. **打完**：结算页看总分和 13 个称号。局散房不散，房主开下一局，累计 Session 积分。

想更进一步时再看：[进房前准备](prepare.md) · [操作与仲裁](controls.md) · [游戏规则](game-rules.md) · [写代码](bot-scripting.md) · [库手册](library/index.md) · [AI 改码](ai-agent.md)

## 手册目录

| 文档 | 内容 | 适合谁 |
|---|---|---|
| [prepare.md](prepare.md) | 进房方式、昵称配色、热身场、编辑器布局 | 所有人 |
| [controls.md](controls.md) | 手操、驾驶辅助、分轴仲裁、Space 开关、快捷键 | 所有人 |
| [game-rules.md](game-rules.md) | 地图三环八扇区、得分、Uplink、搭档、复活、称号 | 所有人 |
| [bot-scripting.md](bot-scripting.md) | 从五行代码开始写 Bot Script：tick 模型、scan()、API 表 | 想写代码的人 |
| [library/](library/index.md) | Bot Script 库手册：全部 API 真实语义、服务端强制行为、可跑示例库 | 写复杂 Bot / AI 语料 |
| [ai-agent.md](ai-agent.md) | 让 AI Agent 用自然语言帮你改码、配额与称号 | 不想手写代码的人 |

## 核心概念速查（与官方术语表一致）

| 术语 | 含义 |
|---|---|
| Robot | 你在场上控制的唯一战斗实体（一台机器人） |
| Player | Robot 背后的人：手操、装 Snippet、写码或让 AI 改码 |
| Bot Script | 你为 Robot 写的控制程序（JS/TS），不是 AI |
| Snippet | 官方预置、可开关的驾驶辅助组件，本质是官方维护的 Bot Script 模块 |
| Observation / Scan | 服务器算好的可见实体集合；`scan()` 免费任意读 |
| Pulse Scan | 耗能的主动增强感知，半径更大，仍不穿墙 |
| Ring / Sector | 地图三环 / 外环八个出生扇区 |
| Core / Mega Core | 触碰即拾取的得分+能量资源 |
| Uplink | 靠近引导 1.5s 完成黑入的可反复争夺得分设备 |
| Partner | 开局随机配对、整局固定的搭档：不可互伤、隔墙可见 |
| Phase | 一局仅两段：OUTER_RING（0:00–4:00）、CORE_OPEN（4:00–8:00） |
| Driving Assist | 仲裁后由 Bot Script / Snippet 接管的那部分操作 |
| Hot Swap | 对局中提交新代码、下一 tick 生效 |
| AI Agent | 平台内嵌改码代理：自然语言→改你的 Bot Script |
| Room / Session / Warmup | 房间 / 累计积分的场次 / 开赛前自由漫游期 |
| Title | 从对局事件日志投影的单局个人奖项，共 13 项 |

## 三条铁律

1. **一局内基础规则不变**：8 分钟内移动/开火/护盾/感知的规则与数值全程稳定。
2. **感知免费**：Observation 由服务器持续计算，`scan()` 零成本读取。
3. **人类输入随时优先**：你的手永远压过程序（ADR-0009）。
