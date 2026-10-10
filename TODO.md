# TODO

> 2026-10-05 重开：旧清单（动效/平衡/操作/UI 反馈）已全部完成，归档于 git 历史。
> 2026-10-11 批量落地：X-2 收尾、S-6、C-40、C-26（部分）、R8 卫生清单、S-26 阈值配置化（详情见台账 Round 9 补充）。
> 2026-10-11 R10 RC 并行实施批：S-28~S-34 硬化七条、C-36/C-37/C-45、C-17 拆分、C-26 跳帧收尾（详情见台账 Round 10）。
> 以下未勾选项仍待做；审计详情与证据见
> [docs/audits/codebase-maintainability.md](docs/audits/codebase-maintainability.md)。

## 已完成

- [x] **R10 硬化批 S-28~S-34**（2026-10-11）：checkpoint/回放日志校验（S-28/S-29）；非激活提交回执（S-30）；join/观战房码+昵称校验（S-31，含检查脚本房码改名与 D19 遗留）；AI 流式 50ms/512B 聚合（S-32）；接管通知+graceful 关闭旧连接（S-33，proto additive CN_TAKEOVER）；终局玩家帧 reliable（S-34）。
- [x] **R10 前端打磨**（2026-10-11）：C-36 chat/kill-feed 让位（:has 单规则）；C-37 color-scheme:dark + ::selection；C-45 回放尾行截断容忍。待实机复核：C-36 动效、C-37 滚动条/select 观感。
- [x] **R10 feedback 拆分 + 空闲跳帧**（2026-10-11）：C-17 `game/feedback/` 目录化 + 魔法数命名 + DRAWERS 注册表；C-26 controls awake 门 + `quiet()` 静默判定 + requestDraw 脏保底。
- [x] **X-2 Snippet 目录服务器单源**（2026-10-11 收尾）：proto 双端代码生成补跑；catalog 六条目补齐 Key/Hint/Param/DefaultEnabled；`snippetSourceViews()` 全字段下发；客户端 `snippet-panel.ts` 改服务器驱动（`snippetRowsFromSources`），`SNIPPET_ROWS` 退化为离线兜底并有往返漂移钉死测试；catalog.go 已过 gofmt。
- [x] **S-6 AOI 单次构建**（2026-10-11）：`match.go` step 开头构建 `obsByRobot`，脚本池与快照循环共用。
- [x] **C-40 渲染热路径小分配群**（2026-10-11）：`alpha:false` / feedback 原地改写 / 回放 byId 索引复用。
- [x] **C-26 CanvasStage（部分）**（2026-10-11）：`canvas-stage.ts` 落地，controls/live/replay-player 三处循环迁移，行为保持；「空闲不重绘」已于 R10 完成（见上）。
- [x] **仓库卫生**（2026-10-11）：package-lock/artifacts png 已删并入 gitignore；三份已完结 plan 归档至 `docs/plans/archive/`；oracle-bot worktree 已删（另清掉 10 个「已并入 main 且干净」的 Temp/D 盘 worktree，6 个含未提交改动或未并分支的保留）；本地 ~105MB 旧二进制/日志已删；runbook `pnpm -r typecheck` 两处修正、README 布局表补 `bots/` 行（版本号 0.1.0 保留原样，是否刻意仍待确认）。
- [x] **S-26 阈值配置化**（2026-10-11）：`OMB_WARMUP_IDLE_STOP` / `OMB_ROOM_EVICT_AFTER`（duration 字符串，解析失败回退默认并打日志）；`Hub.SetWarmupIdleStop/SetRoomEvictAfter` 拒绝非正值——清道夫可调快慢、不可被配置关闭；语义冻结测试 6 个（终局后有人在线永不逐出/非空免疫/阈值生效/观战者保活等）。

## 代码待办（按台账编号）

- R9 打磨批余项：**C-34**（震屏雾缝，需实机逐帧确认）、**C-35**（回放 respawnAt 插值缺失）、**C-38**（workbench reduced-motion + AI 动画动 layout）、**C-39**（窄容器三处）、**C-41**（时间轴标记可达性）、**C-42**（微字对比度）、**C-44**（ai-markdown 链接 scheme 白名单）、**C-46**（oracle 宽限 45>30）、**C-47**（工具栏形态）、**S-35**（spawnCore 1ulp / sweepWall t=0 两处 sim 边界）。
- [ ] **C-11 颜色收口**：`art.ts:369,371` 的 `#ffb066`/`#8cff66` 收进 ink/token（R6 收敛被本轮回退），同对手抄的 `app.css:114-115` 一并 token 化；`scoreboard.css:13,85` amber 字面量接 `var(--amber)`。
- [ ] **D18 称号规则漂移测试**：`scoreboard.ts:79-96` TITLE_DETAILS 手抄 `stats/titles.go` 评选阈值，建漂移测试或改服务器下发文案。
- [ ] **C-29** `scoreboard.ts:123-137` `positionTitleDetail` 复用 `script-version-placement.ts` 的 `computePanelPlacement`。
- [ ] **C-30** kill-feed 行数单源（`kill-feed.ts:4` ↔ `kill-feed.css:6`）。
- [ ] **S-25** `generator.go:124` 的 `-1+1` 死算术；solo bot clamp 三连收敛（可选）。
- [ ] 死代码：`scoreboard.ts` `renderedOptions` 死字段删除；台账死代码清单其余项（`Sim.View/...` 降 unexported 等）。

## 需产品拍板

- [ ] **D19**（R10 新增）：join 房码规则客户端表单 `ROOM_CODE_RE`（允许 0/O/1/I）比服务端 `ValidCode` 宽——对齐方式需拍板（客户端抄字母表 vs 协议下发 vs 维持服务器文案兜底）。
- [ ] C-25 Help Escape/Leave 语义是否区分。
- [ ] S-24① decay 可观测性（中断清零 vs 缓慢衰减不可区分）；② busy 横跳绕过衰减。
- [ ] C-12 文案统一：phaseName/房态双份；重生倒计时文案三处（`death.ts:8` / `scoreboard.ts:17` / `render.ts:93`）。
- [ ] D17 HUD 键位摘要三处对拍机制。

## 仓库卫生

（R8 清单已于 2026-10-11 全部执行，见顶部「已完成」；仅剩一项待确认：根/client package.json 版本仍 `0.1.0`，release-please 只管 VERSION，是否刻意保留待产品确认。）

## 已决策（不再列为任务）

- 护盾成功抵挡后有 CD —— 暂时不加。
