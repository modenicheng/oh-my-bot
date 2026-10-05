# TODO

> 2026-10-05 重开：旧清单（动效/平衡/操作/UI 反馈）已全部完成，归档于 git 历史。
> 以下为 R8 全库只读审计（HEAD `6f90d52`）后的在办与未做项；审计详情与证据见
> [docs/audits/codebase-maintainability.md](docs/audits/codebase-maintainability.md) 的 Round 8 条目。

## 进行中（工作树未提交）

- [ ] **X-2 Snippet 目录服务器单源**——半成品，当前状态合入无效：
  - 服务端：`glue/snippets.go` `snippetSourceViews()` 补填 `Key/Param/DefaultEnabled`；`catalog.go` 各条目补数据；`gofmt`（当前是全库唯一未格式化文件，CI 会挂）。
  - 客户端：`snippet-panel.ts` 改服务器驱动；`snippets.ts` 的 `SNIPPET_ROWS` 退化为离线兜底。

## 代码待办（按台账编号）

- [ ] **C-11 颜色收口**：`art.ts:369,371` 的 `#ffb066`/`#8cff66` 收进 ink/token（R6 收敛被本轮回退），同对手抄的 `app.css:114-115` 一并 token 化；`scoreboard.css:13,85` amber 字面量接 `var(--amber)`。
- [ ] **D18 称号规则漂移测试**：`scoreboard.ts:79-96` TITLE_DETAILS 手抄 `stats/titles.go` 评选阈值，建漂移测试或改服务器下发文案。
- [ ] **C-29** `scoreboard.ts:123-137` `positionTitleDetail` 复用 `script-version-placement.ts` 的 `computePanelPlacement`。
- [ ] **S-6 AOI 单次构建**：`match.go` 快照循环/runScripts 两处 `BuildObservation` 合并为 `obsByRobot`；SOLO 默认 63 机后（`2e5e74f`）LOS 64→128 次/tick 已成常态。
- [ ] **C-30** kill-feed 行数单源（`kill-feed.ts:4` ↔ `kill-feed.css:6`）。
- [ ] **S-25** `generator.go:124` 的 `-1+1` 死算术；solo bot clamp 三连收敛（可选）。
- [ ] 死代码：`scoreboard.ts` `renderedOptions` 死字段删除；台账死代码清单其余项（`Sim.View/...` 降 unexported 等）。
- [ ] C-17 延续：feedback.ts 拆分与新内联视觉参数（0.012/0.004/steps 等）命名。

## 需产品拍板

- [ ] C-25 Help Escape/Leave 语义是否区分。
- [ ] S-24① decay 可观测性（中断清零 vs 缓慢衰减不可区分）；② busy 横跳绕过衰减。
- [ ] C-12 文案统一：phaseName/房态双份；重生倒计时文案三处（`death.ts:8` / `scoreboard.ts:17` / `render.ts:93`）。
- [ ] D17 HUD 键位摘要三处对拍机制。

## 仓库卫生（R8 审计发现，均未执行）

- [ ] 删除 `package-lock.json`（npm 化石，全仓零引用；CI/脚本统一 `pnpm install --frozen-lockfile`）。
- [ ] `git rm client/artifacts/*.png`（4929dd5 误提交的评审证据，零引用）并在 `.gitignore` 加 `client/artifacts/`。
- [ ] 归档 `docs/plans/{ci-cd-release,docs-rewrite,round-2}.md`（三份已完结）。
- [ ] `git worktree remove .worktrees/oracle-bot`（feat/oracle-bot 已并入 main，worktree 内含整套 node_modules）；顺带 prune Temp/D 盘根的旧 worktree。
- [ ] 本地磁盘清理（均已被 ignore，不入库）：根/server/server/tmp 三处 ~130MB 旧 `omb.exe`/`omb.exe~`、`combat.log`/`crash.log`。
- [ ] 文档小漂移：`docs/runbook.md` 构建步骤 `pnpm -r typecheck` → `pnpm typecheck`；README 布局表补 `bots/` 一行；根/client package.json 版本仍 `0.1.0`（release-please 只管 VERSION，确认是否刻意保留）。

## 已决策（不再列为任务）

- 护盾成功抵挡后有 CD —— 暂时不加。
