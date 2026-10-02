---
title: 图鉴：界面与实体
audience: both
order: 45
tags: [图鉴, 界面, 实体]
---

# 图鉴：界面与实体

这一页汇总客户端的真实渲染资产。实体图由游戏同一套 `draw*` 与 SVG sprite 生成，界面图由 Playwright 驱动正式客户端页面截取；不是手绘示意图。

> 重新生成：`pnpm --dir client capture:manual`。输出固定写入 `docs/manual/reference/images/`，便于随界面与美术一起审查。

## 场地

外环 80m、核心区、墙体掩体与出生区都来自实际渲染器。核心区在阶段 2 开放后变为青色。

![场地、核心区与掩体](images/sheet-arena.png)

- 外环是硬边界，机器人不能离开竞技场。
- 核心区开放前后使用不同视觉状态；Mega Core 只在核心区内刷新。
- 墙体挡移动、子弹和冲刺路径。

## 机器人状态

本体、炮塔、护盾、持续冲刺与复活保护使用相同的正式绘制代码。

![机器人与战斗状态](images/sheet-robots.png)

- 绿条是 HP，青条是能量。
- 青色虚环表示复活保护，期间不会受到伤害。
- 护盾与冲刺互斥；持续冲刺需要一直按住 Shift / 右键，或让脚本每 tick 调用 `bot.dash()`。

## 拾取物

血包恢复最多 **30 HP**，拾取后冷却 **30 秒**；满血或阵亡机器人不会消耗血包。普通 Core、Mega Core 与 Uplink 也使用正式渲染。

![血包、Core 与 Uplink](images/sheet-pickups.png)

- 血包的虚影和秒数表示仍在冷却。机器人圆与血包圆接触即可拾取，不需要中心覆盖。
- Uplink 引导时显示进度环；被打断后重新开始。
- Uplink 的个人冷却不会下发到脚本感知，需要用 `bot.game.time` 自行估算。

## 子弹与玩家色

每个玩家拥有自己的颜色，投射物拖尾沿用发射者颜色，便于判断火力来源。

![八种玩家色的投射物](images/sheet-projectiles.png)

## 常用图标

HUD、技能卡组与音频控件共用的像素图标按 2× 尺寸展示。

![HUD 与控件图标](images/sheet-icons.png)

## 大厅

加入页保留房间码、昵称、颜色和观战入口；音频设置在不同页面间共享。

![大厅与加入表单](images/ui-lobby.png)

## 对局 HUD

HUD 同时显示 HP、能量、阶段、技能和逐轴控制来源；场内可见真实血包、Core、Uplink 与玩家色投射物。

![对局 HUD 与场内实体](images/ui-hud.png)

## Esc 选项

对局中按 Esc 打开本地选项层。打开时只释放本人的 held 输入，服务器对局不会暂停；可继续、调整共享音频、离开房间或注销本地身份。

![对局 Esc 选项层](images/ui-options.png)

## 工作台

按 `C` 打开脚本工作台。编辑器、Console 与玩家手册共享侧栏，本地草稿在离开房间后仍保留。

![脚本工作台](images/ui-workbench.png)

## 结算

结算层展示最终得分和称号；离开结算后返回房间状态。

![比赛结算与称号](images/ui-match-end.png)
