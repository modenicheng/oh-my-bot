# 代码库可维护性审计（持续更新）

> 目的：集中记录全库（client / server / 跨端）的可维护性发现，供后续**追加**与**逐条修复**。
> 本文件是唯一的审计台账；聊天记录中的旧报告已全部并入此文件。
>
> **如何追加**：在「追加记录」节添加新条目（日期 + HEAD + 变更范围 + 新发现/复核结论），并同步更新对应发现的「状态」与「位置」。
> **如何修复**：修完一条就把状态改为 ✅ 并注明轮次，**不要删除条目**（保留追溯）；发现已过时改 ❌ 并写明原因。
> **行号基准**：Round 9（HEAD `4f8f74d`）。旧条目的历史行号仅供追溯；修复前一律按符号名重新定位。
>
> 状态图例：☐ 待修 · 🔵 需产品/设计拍板 · ⚠️ 部分完成 · ✅ 已修 · ❌ 已过时
> 编号规则：`X-` 跨端 · `S-` 后端 · `C-` 前端；括号内是历史轮次的旧编号，便于对照聊天记录。

---

## 0. 审计轮次日志

| 轮次 | 日期 | 基准 | 范围与要点 |
|---|---|---|---|
| R1 | 2026-10-04 | HEAD `b62c4d0` + 工作树 | 三路并行全库审计（前端 / 后端 / 跨端），建立全部基础发现 |
| R2 | 2026-10-04 | 同上 | 复审并行改动（mapgen Gen6 + uplink decay、game-feel 首波）：旧结论全部成立；新增 cameraZoom bug、decay 机制复查、漂移对账表 |
| R3 | 2026-10-04 | HEAD `3d7cdbd` + 工作树 | 复审 UI 反馈提交（axis-src/hud 重构/help-toggle/startup 侵蚀）+ game-feel 增量：axis_mask 副本 4→3（改善）、B7 计时耦合已修；魔法数/颜色旁路面扩大约一倍 |
| R4 | 2026-10-04 | HEAD `3d7cdbd` + 工作树（41M+3??） | 增量审计 5 文件（controls/input/takeover.test/startup-art.test/aim-guard-check）：C-4 确认未修且双调用点由本轮工作树引入；toggleAssist 三分支对齐并冻结 2 条新契约；aim-guard-check 大幅改善但 harness 欠账微增 |
| R5 | 2026-10-04 | HEAD `3d7cdbd` + 工作树（44M+3??） | 增量审计 12 文件（axis-src/hud/index.html/3 个 check 脚本等）：C-4 三度确认未修；C-20 恶化 2→3 轨；X-10 回退（axis-src 手抄魔法位）；C-16 改善 4→3；新发现 C-28 与 D17 |
| R6 | 2026-10-04 | `1301cdc` → `71925db` | 六批原子修复：前端基础/玩法、脚手架、后端运行时/sim、跨端契约；34 文件 / 317 测试、typecheck/build、Go 全量通过 |
| R7 | 2026-10-04 | `71925db` → `90d5819` | 关闭跨端单源、观战控制、接管/雾效/hash、后端去重；完成语言版本链/body portal、Monaco 开屏预取与真实资源加载器；45 文件 / 477 测试及 Go/race 全通过 |
| R8 | 2026-10-05 | HEAD `6f90d52` + 工作树（X-2 半成品） | repo-steward 全库只读审计：复核 R7 后 88 文件/+3650 行增量（积分榜重设计、kill-feed/shadow/death、64 机填充、墙影、64KiB 帧上限、mapgen Gen7）+ 仓库卫生/文档层；结论：代码增量收敛，C-11 回退、S-6 恶化，新增卫生清理清单（移交 TODO.md 跟踪） |
| R9 | 2026-10-10 | HEAD `4f8f74d`（工作树干净） | 六路并行只读子代理专项审计（渲染管线/交互输入/UI-CSS 设计/Go sim 逻辑/网络会话/周边系统），切换口径专查隐藏 bug·渲染效率·交互·设计（不查复制粘贴类）；新增 S-26~S-35、C-31~C-47 共 27 条，关键断言由主会话逐一实读复核后入库 |
| R9+ | 2026-10-11 | HEAD `4f8f74d` + 工作树 | 实施批：R9 立即批修复（S-26/27、C-31/32/33/43）落地；X-2 收尾关闭（D8 同步）；S-6/C-40 关闭；C-26 部分落地（CanvasStage 三处迁移，行为保持）；S-26 阈值配置化 + 产品语义冻结测试；R8 卫生清单全部执行（含 10 个已并 worktree 清理）。验证：`go test -p 1 ./...`、vitest 555 项、typecheck 全绿 |

R7 收尾时主工作树已干净；后续修复仍应先 `git status`，并以当前符号而非历史行号定位。

---

## 1. 漂移对账表（知识被抄多处的现状清单）

> 这是本审计最高价值的输出：同类知识的多份副本已经分叉或必然分叉。修 X 类条目时以此表为总览。

| # | 知识点 | 副本位置 | 状态 |
|---|---|---|---|
| D1 | Bot Script API 表面 | `packages/bot-api/src/index.ts`（单源）→ Monaco / AI prompt / Go runtime 合约生成物 | ✅ R7：`62d675b` 以 bot-api 为唯一源生成三端表面，并以 TS/Go 漂移测试互钉 |
| D2 | 局长/帧节奏常量 | `glue/match.go:31-33`（本地 tickHz/frameDue/matchTicks）↔ `sim/sim.go:25,28,36` | ✅ R6：glue 已统一引用 `sim.TickRate/FrameBudget/MatchTicks`，并有节奏常量测试 |
| D3 | 黑客进度满值 ×10=80 | `sim/gameplay.go:27`（HackDuration=480）↔ `render.ts:82` + `feedback.ts:159`（裸写 `/80`）↔ `hud.ts:18`（`HACK_MAX_X10=80` 已命名但未共享） | ✅ R6：`HACK_MAX_X10` 由 `mapdef.ts` 单点导出，HUD/渲染/反馈共用 |
| D4 | 核心区半径 | `mapgen/generator.go:33` coreZoneR=28 ↔ `client/src/game/mapdef.ts:30` RING_CORE=30（仅兜底）↔ `capture.ts` 插画文案写 28（反而正确） | ✅ R6：`RING_CORE` 兜底改为服务端 `coreZoneR=28` 并注明来源 |
| D5 | 客户端可见游戏数值（视野 / 开火 / HP/能量 / hack / 无敌 / tick rate） | `sim` 常量 → `SimTuning` → 客户端 `game/tuning.ts`；回放积分走权威 `EvMatchEnd.scores` | ✅ R7：高漂移集由服务器可靠下发，旧服务器兜底值以黄金字节互钉 |
| D6 | join/只读观战错误路由 | proto `EvControlNotice.Code` → Go emit / TS 分流；旧 `EvSay` 仅过渡兼容 | ✅ R7：结构化 code 为主路由，新客户端去重兼容 say，前缀不再是契约 |
| D7 | AI 状态/错误路由 | proto `EvControlNotice.Code` → `ai_bridge.go` / Workbench AI 面板 | ✅ R7：请求失败、禁用、编译失败、stale、说明与回退失败均按枚举分流 |
| D8 | Snippet 目录元数据 | `server/internal/snippet/catalog.go`（单源）→ `EvSnippetResult.sources` 下发 | ✅ R9+：全字段单源下发，客户端 `SNIPPET_ROWS` 退化为离线兜底（往返钉死测试防反向漂移） |
| D9 | WS 帧字节/心跳 | proto 权威常量 → TS `messages.ts`/`ws.ts` 与 Go `netws/handler.go` | ✅ R7：`ceb69bd` 将帧与心跳时序收敛为协议单源，并有双侧黄金/时序测试 |
| D10 | axis_mask 位常量 | proto 注释 ↔ `sim/contract.go:212-217` ↔ `input.ts:15-18` ↔ `axis-src.ts:30`（魔法位 `& 2`） | ✅ R6：`axis-src.ts` 改用 `AXIS_AIM` 导入，删除魔法位 `& 2` |
| D11 | 颜色字面量 | `art.ts` ink 调色板（规范处）vs 十余处散写 | ⚠️ R8：R6 收敛被回退（`#8cff66`/`#ffb066` ×4、scoreboard amber ×2），服务端 bot 色板扩至 8 色（`solo_bots.go:29`）；其余旁路仍待处理 |
| D12 | 回放 NDJSON schema / record type / `visual` 紧凑数组版本 | proto `ReplaySchemaVersion` / `ReplayRecordType` / `ReplayVisualVersion` → Go/TS 磁盘适配层 | ✅ R7：`51cec6e` + `06cd7b6` 单源化并测试未知版本/类型与 protojson 输入 |
| D13 | phaseName / 房态文案 | `render.ts:41-47` vs `replay/index.ts:491-496`；`lobby.ts:117`「空闲」vs `live.ts:235`「等待开场」 | 双实现 + 语义未确认是否刻意 |
| D14 | 手册文档 vs 服务器 decay 数值 | `docs/manual/{rules,reference,start}` vs `sim/gameplay.go:24-37` | R3 核对**一致** ✅（0.5s 宽限 / 每秒回退 0.5s / 30s 冷却全对） |
| D15 | Uplink lift 比例 0.38 | `render.ts:84` ↔ `art.ts:235` ↔ `art.ts:236`（0.48/0.12 新增） | ✅ R6：`UPLINK_LIFT` 由 `art.ts` 单点导出并供渲染复用 |
| D16 | ASCII 字符方言 | `startup-art.ts:15` `'#%+=*#'`、`startup.ts:49` `'01[]{}+*#'`、`startup-art.ts:19` `'#*+:.'` | R3 从 2 套变 3 套（低危，可读性问题） |
| D17 | HUD 键位摘要 | `index.html:86`（帮助面板）+ `index.html:80`（canvas aria-label）↔ `docs/manual/rules/controls.md` 键位表 | 手抄三处、无对拍（R5 新发现） |
| D18 | 称号评选规则文案 | `server/internal/stats/titles.go` ↔ `client/src/game/scoreboard.ts:79-96`（TITLE_DETAILS 注释自认 mirror） | 阈值/占比手抄镜像、无漂移测试（R8 新发现） |

---

## 2. 跨端发现（X-）

### X-1 ✅ Bot Script API 四处平行定义（原 R1-P0.1）— R7 已修
- **R7 结果**：`62d675b` 以 `packages/bot-api/src/index.ts` 为唯一源，生成 Monaco 补全/声明、AI provider prompt 与 Go runtime 合约；`bot_api_drift_test.go` / `script/bot_api_drift_test.go` 防止方法与常量重新分叉。

### X-2 ✅ Snippet 目录双份（原 R1-P0.2；R9+ 收尾关闭）
- proto 已有 `EvSnippetResult.sources` 且 `snippet-panel.ts` 在消费；扩 `SnippetSourceView` 加 `min/max/step/unit/hint` 字段，面板改服务器驱动，`SNIPPET_ROWS` 退化为离线兜底。proto additive，旧客户端安全。
- ~~R8 工作树现状（未提交）~~：proto 字段与 catalog 结构已加但唯一下发点零填充、客户端未动。
- **R9+ 收尾（2026-10-11）**：`buf generate` 补跑 TS/Go 双端生成物；catalog 六条目补齐 `Key/Hint/Param（含 Step）/DefaultEnabled`（数值行 Step 与 Hint 取自原客户端表，Param 边界与 Validate 边界由 `TestCatalogMetadataSelfConsistent` 互钉）；`snippetSourceViews()` 全字段下发；客户端 `snippetRowsFromSources` 为服务器元数据唯一落地，面板检测目录差异后重建行 DOM（未知 key 合成 `kind{n}`、图标兜底）；`snippets.test.ts` 增「兜底表 ↔ 服务器形态往返一致」漂移钉死；gofmt 通过。D8 同步关闭。

### X-3 ✅ 游戏数值：协议下发取代客户端复算（原 R1-P0.3 + R2）
- R7：`dbd7c66` 在 `EvMapBootstrap` 可靠下发 `SimTuning`（tick/HP/能量/开火/hack/无敌/视野），客户端集中经 `game/tuning.ts` 消费；黄金字节与 sim 常量测试锁定，旧服务器仍有兼容兜底。

### X-4 ✅ 字符串协议（join failed / AI 前缀）（原 R1-P0.4 + R3 复核）
- R7：`dbd7c66` 新增 `EvControlNotice{code,text}`，覆盖 join/只读观战/AI/回退错误；过渡期保留旧 `EvSay` 并由新客户端去重，字符串前缀不再承担主路由。

### X-5 ✅ WS 帧/心跳常量 + 孤儿 `PROTOCOL_VERSION`（原 R1-P1.5）
- R7：`ceb69bd` 将帧字节与心跳时序放入协议权威定义，由 TS/Go 共用；覆盖 0x00–0x03、ping/pong 周期与超时边界。

### X-6 ✅ 回放 NDJSON 版本与记录类型单源（原 R1-P1.6）
- R7：`51cec6e` 将 `ReplaySchemaVersion`、`ReplayRecordType`、`ReplayVisualVersion` 放入 proto 权威源，Go/TS 仅保留磁盘形态适配；`06cd7b6` 进一步冻结语义 protojson 输入。

### X-7 ✅ MapDef/RING_CORE 30 vs 28（原 R1-P1.7 + R2 复核）
- 删除 `mapdef.ts:30` 的 `RING_CORE` 兜底或改 28 并注明来源；`capture.ts` 的 mapgen 骨架插画（28m/45°/13×13 等）会随 GeneratorVer 过期，长期改由真实 `mapgen.Generate(seed)` 产物渲染。客户端不消费 `GeneratorVersion` 字段——若未来按 Gen 分支渲染（如 L 形掩体）这是盲区。

### X-8 ❌ Manual frontmatter 双实现（原 R1-P1.8）
- 复核结论：语义已被两侧单测冻结，客户端副本仅作 MOCK 兜底，**维持现状 + 可选加跨语言 fixture 测试**，不值得动。

### X-9 ✅ LOS 双实现语义差异 + 客户端雾不遮锁区（原 R1-P2.9）
- LOS 显示层差异保留；`5087ce8` 为 `drawVisionMask` 增加锁区圆形遮罩，并以 `render.test.ts` 验证锁定阶段遮挡、解锁阶段撤除。

### X-10 ✅ axis_mask 副本收敛后又回退（R3 ✅ → R5 ⚠️）
- R3：commit `3d7cdbd` 的 hud.ts 重构删除了第 4 份位常量副本，`axis-src.ts` 用 `ControlSource` 枚举投影、不引入位常量。
- R5：`axis-src.ts:30` 的 `aimControlStatus` 出现魔法位 `(self.manualAxesMask ?? 0) & 2`（语义=AXIS_AIM），位知识回到 4 份；`input.ts:14` 已有可 import 的 `AXIS_AIM = 1 << 1`。改 import 即收敛。

---

## 3. 后端发现（S-）

### 高影响
- **S-1 ✅ 节奏常量双源**（原 R1-H1，R2 复核行号未变）：`glue/match.go:31-33` 删本地 `tickHz/frameDue/matchTicks`，改引 `sim.TickRate/FrameBudget/MatchTicks`；`match.go:622,:661` 终局判定统一 `m.tick >= sim.MatchTicks`；`scoreboardEveryTicks`（:685）绑 `sim.TickRate`。~10 行，消除「改局长 glue 不知道」。
- **S-2 ☐ 几何原语 4 包各一份**（原 R1-H2）：segment-AABB ×3（`sim/combat.go:272-289` slab / `snapshot/wallindex.go:155` slab / `nav/nav.go:474-500` Liang-Barsky）；LOS 实质 4 条；point-rect 距离 ×2 逐字符相同（`nav/nav.go:515-519` vs `mapgen/geometry.go:76-86`）；zoneLocked ×3 + view.go:163 内联第 4 份；finite ×5；arena 半径「80−0.6」×2。提案：建 `internal/geom`；**红线：mapgen 刻意零 Sqrt/Hypot 保跨平台确定性（geometry.go:74-77 注释），只合并公式同构部分，配交叉测试**。R2 确认 walls.go 新代码守住了纪律且未加新几何助手。R8：Gen7 增量（generator.go/walls.go）仍守住红线（`math.Sqrt2` 常量合规；geometry.go 本轮零 diff，唯一 Sqrt 仍是 sanction 的 slotDirection 用点）；新增微缩复制——`objectives.go:355` replenishCores 与 `:374` spawnCore 的「锁区外核心」谓词同构，可抽 `coreOutsideLock`。
- **S-3 ☐ 轴/命令五层逐字段样板**（原 R1-H3）：每个轴在 collector/merge/resolve/clone/arbitrate 五层各一段同构代码，散布 8 处（`sim/control.go:118-232,327-344`、`script/collector.go:52-146`、`script/goruntime.go:417-461`、`glue/solo_bots.go:38-55`）。提案：`sim.Axis` 描述表驱动 + `snippetCollector.guarded(axis, set)` 收敛 6 个 setter。-250~300 行；新增轴从「改 10 处」变「改 1 张表」。
- **S-4 ⚠️ stats projector 双 switch**（原 R1-H4）：`projector.go:197-293` applyEvent 与 `:462-543` eventKey 必须成对维护，漏改 eventKey 该事件被静默去重丢弃（:161-163）；`titles.go:79-114` awardMax 双胞胎泛型合并。表驱动或 protojson 生成指纹，-120 行。
- **S-5 ☐ 三个回放驱动循环**（原 R1-H5，R2 复核仍成立）：`sim/replay.go:104-149` / `sim/replay_visual.go:37-79` / `stats/replay.go:37-100` 同一「读→校验→恢复→跳过→逐 tick」骨架；错误文案已分叉（replay.go:113 vs replay_visual.go:46）；stats 的 seq 分配（:56-58,:87-89）镜像 glue `eventSeq`（match.go:225-226）。提案：`sim.ReplayCursor` + 统一 sentinel `ErrReplayMissingStart` + projector 自持序号。-80 行。
- **S-6 ✅ 每帧 AOI 算两遍**（原 R1-H6）：`match.go` step 开头构建 `obsByRobot` 共用（R9+ 2026-10-11 落地：脚本池与快照循环共享同一观测，`runScripts` 签名收 `obsByRobot`；64 机 60Hz 下 LOS 计算减半）。R8 恶化背景：`2e5e74f` 将 SOLO 默认提到 63 机（`room.go:98,350`）。
- **S-26 ✅ 空房间 warmup 对局 60Hz 永动、房间永不回收（R9，P1）**：`glue/match.go:626,658` 终止条件 `m.tick >= sim.MatchTicks && !m.warmup`——warmup 永不自我终止；`hub.go:59` 建房后全仓无任何 `delete(h.rooms)`（Unregister 只 `releaseHumanLocked`）。任意 Join→发 WARMUP→断开即留下永久 60Hz tick goroutine + goja runtime + sim 全量步进（0 接收者照跑，单房间可耗 ~0.7 核），`rooms/identities/scriptVersions` 无界增长，脚本化循环建房可 DoS。修法：空房（sessions+spectators=0）超阈值 `match.Stop()` 并逐出，或 warmup 设 tick 上限。**R9 当轮修复**：hub 增加清道夫（`StartJanitor`/`janitorSweep`，main 30s 一拍）——空置 >15s 停 warmup 并经新增的 `room.Room.EndWarmup()` 转 Ended（Warmup 此前无终局转换，从 Warmup 发 WARMUP 本就是非法转移）；空置 >5min 关停房间（`closed` 门卫拒 Bind/BindSpectator、publish 丢弃在途装配防孤儿对局）并从 `h.rooms` 逐出；`hub_janitor_test.go` 4 用例冻结。**R9+ 配置化（2026-10-11，语义由产品确认）**：`OMB_WARMUP_IDLE_STOP`/`OMB_ROOM_EVICT_AFTER`（duration 字符串，解析失败回退默认并打日志）；`Hub.SetWarmupIdleStop/SetRoomEvictAfter` 拒绝非正值——清道夫可调快慢、不可被配置关闭。冻结语义：正式局终局后只要房间有人（含观战者）等多久都不逐出/不踢人、模拟保持停止、RESTART/WARMUP 重开新模拟且新对局期间房间同样免疫；非空房间（含 idle warmup 有人在场）清道夫完全不碰。`hub_idle_policy_test.go`（5 用例）+ `janitor_config_test.go`（env 解析）冻结。
- **S-27 ✅ 局中/热身中新身份加入收 bootstrap 却永不进快照花名册（R9，P1）**：`hub.go:193-195` 对激活对局无条件 `bootstrapLocked(s)` 下发 MapBootstrap，但快照循环（`match.go:580-584`）按 `NewMatch` 装配时冻结的 `playerOf` 花名册驱动，`forceResyncLocked`（:309-316）对无 robotOf 的 pid 置位后无人消费；room.Join 允许 Running 加入（room.go:264-267）。新昵称局中加入 → 客户端 `awaitingFull=true` 卡「正在同步对局」直到下一局 publish（正式局最长 8 分钟；纯 warmup 房见 S-26 无限期）。修法：bootstrap 前查 `m.robotOf`，不在花名册只留大厅不发 bootstrap。**R9 当轮修复**：`Bind` 对激活对局先查 `m.robotOf` 再 bootstrap；`TestBindMidMatchNonRosterGetsNoBootstrap` 以花名册成员路径作对照冻结。
- **S-28 ☐ RestoreCheckpoint 不校验机器人位置/战斗字段与 NextProjectile（R9，P1）**：`sim/replay.go:36-47` 机器人循环只查 ID/sector/State；Position/HP/Energy、`cp.NextProjectile`、DamageBy 键全未校验（对比装配入口 `SetSpawn` 强制 insideArena+非 overlapsWall）。篡改的 checkpoint 可造出「卡墙且弹道被墙拦截的不可击杀机器人」（slideRobot 接触清速 / sweepWall t=0 推不动 / traceSolid 先挡射线）或 `NextProjectile=0` 触发耗尽守卫全员禁射到局终。live/回放同错不破坏确定性，但破坏 sim 核心不变量；回放分享属功能，日志可被手工编辑。修法：恢复时复用 insideArena/overlapsWall/HP 范围谓词 + NextProjectile 非零。
- **S-29 ☐ ControlRecord.Toggles 无上界，恶意记录令消费循环空转至 2^32（R9，P1）**：`sim/control.go:271` `for i := uint32(0); i < c.ToggleCount; i++`；写侧 uint32 无约束，`log.go validateRecord` 对 control 记录恰漏这个纯算力字段。`omb replay` / 可视化回放处理损坏或篡改的分享录像时，单条记录卡 ~4.3e9 次迭代（秒到分钟级 DoS）。修法：validateRecord 对 Toggles 设上限（≤ 机器人数×常数），越界拒整条日志。

### 中影响
- **S-7 ✅ `snapshot.World{...}` 字面量 ×5**（原 R1-H7）：match.go ×4 + ai_bridge.go:121-124 → 加 `WorldOf(wv sim.WorldView)` 转换。-35 行。
- **S-8 ☐ match.go（818 行）拆分**（原 R1-M1）：装配 / sink 链 / 运行循环 / 观战状态机 / 结算 / 脚本执行 6 种职责 → 拆 5 个文件，每个 ≤300 行。
- **S-9 ✅ sink 链未持有**（原 R1-M2）：Match 增加 `sink` 字段，`ai_bridge.go:362-367` emitNonSimEvent 改调它，消除双路由。
- **S-10 ✅ room.HostCommand 三 case 同构**（原 R1-M3）：`436f46d` 抽出 `prepareLaunchLocked`，WARMUP/START/SOLO 共用错误优先级与准备步骤，并由 room 测试冻结。
- **S-11 ✅ runtime 装配五胞胎**（原 R1-M4）：`436f46d` 增加 `RunPool.Ensure(id)` 并迁移调用方，取或建/注册语义集中且有池级测试。
- **S-12 ☐ Observation 三份序列化器 + phase 映射三份**（原 R1-M5）：`script/observation.go`（JS）/ `ai_bridge.go:129-219`（AI JSON，DTO 藏函数体内）/ `snapshot/encoder.go:234-301`（proto）。phase 字符串映射三处（ai_bridge.go:171-174 / collector.go:203-210 / encoder.go:227-232）→ 单一函数。AI DTO 提为包级类型。-50 行。
- **S-13 ☐ `WorldView.Observe` 第二套 AOI**（原 R1-M6）：`view.go:173-199` 仅测试用且语义已微差（LineOfSight 不含 arena 边界）→ 删或薄壳化，连带评估 `Observation.PartnerID/IsPartner` 链（见死代码）。
- **S-14 ☐ sim 事件发射样板**（原 R1-M7，R2 复核 15 处未增）：`s.events = append(...)` ×15（combat×7 / sim×4 / objectives×3 / control×1）+ `index[id]`/`ended` 守卫 ×7-8 → `s.emit(kind)` + `robotForWrite(id)`。**下一批事件改动前做掉最便宜**（R2 新增 decay 未加事件，暂未增重）。-40 行。
- **S-15 ☐ sim 双 Phase 类型**（原 R1-M8）：`Sim.phase` 存 `ombv1.Phase` 又到处转回 `sim.Phase`（5+ 处转换）→ 内部存 `sim.Phase`，仅 emit/publish 转 proto。
- **S-24 🔵 uplink decay 机制复查（R2/R3）**：实现干净（无复制状态机、三个重置点统一清 `DecayAt`、SimulationVersion 3 门用法正确、checkpoint 往返有测试；R6 已将 `DecayAt == Tick` 判为非法）。仍需产品决定两点：① **decay 无事件**——「中断清零」与「缓慢衰减」在事件流不可区分，回放也不渲染 uplink 进度；若需要「进度流失」反馈，应加事件 kind 或 proto stall 标记；② **busy 横跳绕过**——机器人可在两桩间逐 tick 交替躲衰减（非正确性 bug，但会削弱资源压力语义）。
- **S-30 ☐ 非激活窗口 ScriptSubmit/ScriptRollback/AiPrompt 静默丢弃零回执（R9，P2）**：`hub.go:317-320,345-349,357-361` `m == nil || !m.activeLocked() → return`；对照 `snippets.go:26-44` 自注「任何合法玩家请求都有 EvSnippetResult，不得静默悬空」。热身→开局的装配窗口（旧 warmup handle 已 Abort、新 match 未 publish，几十~几百 ms）与 Ended 态内提交全部无响应，客户端只能等 10s 超时提示「结果未知」，脚本实际未入库。修法：非激活分支回结构化 nack（对齐 D6/D7 路由单源做法）。
- **S-31 ☐ 上行 Join 参数零校验（R9，P2）**：`main.go:509-527` 直接 `EnsureRoom(join.GetRoomCode())`+`Bind`，无非空/字符集校验；客户端 lobby 仅 trim 昵称。空房码使互不相干用户共享 `""` 房；空昵称使身份碰撞从「需知道对方昵称」降为默认碰撞，第二连接静默接管并夺走第一人控制轴（hub.go:185-189）且旧端无提示（见 S-33）。修法：room_code 限 GenerateCode 字母表、nick trim 后非空，失败走 `sendJoinFailedReliable`。
- **S-32 ☐ AI 流式增量逐 SSE chunk 走可靠通道，可撑爆 1024 帧队列（R9，P2）**：`ai_bridge.go:257-264` 每个 StreamDelta 一次 SendReliable；deepseek provider 每 SSE chunk 至少一条 delta，长回答数千帧 ×~100B。弱网 + 长回答 → `netws/handler.go:122-126` reliableCh（容量 1024）满即 kill 断连（玩家掉线重连、AI pending 作废、回答不可恢复）。AI 增量属可丢可补数据却是压垮一致性通道的最大单源。修法：50ms/512B 聚合 flush，或移独立可丢低优先队列（同 scriptLog 模式带 gap 提示）。
- **S-33 ☐ 同身份接管后旧连接成永默僵尸（R9，P2）**：`hub.go:185-195` 接管只处理新会话，被替换旧 Session 不通知不关闭；`withRoom` 被 `rc.sessions[pid]==s` 屏障挡住、broadcast 不再遍历，但旧 WS 未关、心跳照常。旧标签页保持「connected · rtt」而世界永久冻结、输入静默失效，直至手动关闭（同用户重开或被同昵称者顶掉均可触发）。修法：检测替换时向旧会话定向发 takeover notice 并关闭其连接（复用 Unregister 链路）。
- **S-34 ☐ 玩家终局帧走 lossy、观战者强制 reliable 不对称（R9，P2）**：`match.go:613-620` 玩家帧无 ended 特判，`:636-638` 观战者 `ForceFull+SendReliable`（自注「No next tick can repair a dropped final frame」）。终局帧被丢时该玩家世界定格倒数第二帧（分数走 reliable 不受影响，表现层缺口）。修法：ended 时玩家帧与观战者同样 ForceFull+reliable。

### 低影响
- **S-16 ✅ x10 定点换算散布 6 处**（原 R1-L1）→ `sim.HPToX10/HPFromX10`。
- **S-17 ✅ `stableRobotID` 手写 FNV-1a**（原 R1-L2）：`match.go:811-818` 改 `fnv.New32a()`（输出一致，属线上身份算法需回归验证）。
- **S-18 ✅ 错误处理不一致**（原 R1 错误处理节）：room/script/ai 有 sentinel，sim 全 `fmt.Errorf` 无 sentinel → 至少为「match 已开始」「非法地图」立 sentinel；亮点保持（log.go sticky error + errors.Join、ai_bridge errors.As/Is）。
- **S-19 ✅ Say 当错误通道**（原 R1-L4 + X-4）：`cmd/omb/main.go` ×3 内联构造系统 Say → glue 导出 `SystemSay(text)`。
- **S-20 ✅ 杂项**：R6 已收敛 `MaxLogLine`；`436f46d` 以 `sortedRobots()` 统一 stats 的机器人排序比较器并增加排序契约测试。
- **S-21 ☐ 测试夹具重复**（原 R1-L7）：script 包 4 套 ScriptFrame 夹具 + `server/tmp/manualcheck` 第 5 套；「写 JSONL 再读回」循环 ×4 → 建 `internal/testutil`。注意：R2 新增的 objectives/mapgen 测试全部复用既有夹具（uplinkSim/stepTicks/recordingSink），零拷贝 ✅。
- **S-22 ☐ 上行消息路由三处维护**（原 R1-L8）：`main.go:395-474` 观战拒绝列表 + 玩家 switch + glue Session 方法 → glue `UpstreamRouter` 注册表。
- **S-23 ☐ main.go 职责混合**（原 R1-L9）：GC 调优 + HTTP 路由 + 关停 + 协议路由 → HTTP 路由抽 `serverapi`，GC 移 `ai`。
- **S-25 ☐ R8 小件杂项**：`mapgen/generator.go:124` `targetAlive = 4 + (participants-1+1)/2` 的 `-1+1` 恒等死算术（读者会误读为 ceiling/偏移意图）；solo bot 数量 clamp 三连（`cmd/omb/main.go:167-181` / `glue/hub.go:37-45` / `room/room.go:234-243`）同一不变量三份平行实现（防御性冗余，收敛属可选）。
- **S-35 ☐ R9 sim 小件（两处 FP/扫掠边界，理论隐患）**：① `objectives.go:386-397` spawnCore 加权采样「先求和再按组序连减、仅 `pick < 0` 命中」，末组 1ulp 浮点残差可使 pick 恰不小于 0 → 本周期静默少刷一个 Core（~2^-53 量级，确定性不受影响）——循环耗尽兜底取末组或以 `pick <= 0` 判末组；② `objectives.go:279-288` + `collision.go:92-96` 机器人贴墙收尾 tick 的 `sweepWallNormal` t=0 退化接触把 sweptReach 中段拾取检测整体裁掉，物品落在距 PathStart [0.95,1.22]m 环带且本 tick 撞墙收尾时漏捡，违背 :259-263「dash/knockback 不得跳过身体触到的物品」注释承诺——t=0 退化接触不裁剪，仅 t>0 真实偏转处截断。

---

## 4. 前端发现（C-）

### 高影响
- **C-1 ✅ 观战交互三件套逐字复制**（原 R1-H1）：`10ec947` 新增 `replay/spectate-controls.ts`，Live/Replay 共用 wheel、键盘、指针拖拽、按钮接线与 dispose；调用方保留 Space/重绘差异，440 行契约测试冻结行为。
- **C-2 ⚠️ scripts harness 复用率极低**（原 R1-H3，R3 未加剧、R4/R5 欠账微增但单脚本质量上升）：18 个 .mjs 5,077 行中估计 700-900 行复制粘贴（spawn 服务器 ×9、WS 帧 ×5、Fixture 假服务器 ×2 逐字相同、地图 JSON ×3、静态服务器+MIME ×2、pageerror 样板 ×8、AudioContext Proxy ×2）。建 `scripts/harness.mjs` 分批迁移。-500~800 行，新脚本从「拷 300 行」变「写 30 行断言」。R3：6 个脚本全是就地改断言。R4：aim-guard-check 大幅就地改善（sleep→until 轮询、经真实编辑器 UI 提交 navigateTo、finally 清理）。R5 计数：`data-takeover` 断言 3 文件 7 处（aim-guard :160,:212,:225,:228 / game-feel :498-515 / takeover-live :54 helper）、「编辑器提交脚本」样板 10 份（aim-guard 3 / round2 4 / takeover-live 1 / predictive-shield 1 / game-feel 1）、`until()` 本地副本 11 份；正面样本：game-feel 的 `assertHelpAnchor` 1 份定义 4 处复用、takeover-live 重写为真效果断言（见正面确认）。R8：console-count/kill-feed 两脚本消费 FixtureServer，kill-feed-check 作为 pass 函数被 game-feel-check 跨脚本复用（新形态）；残余欠账：freshState/快照 robot 映射仍逐脚本手抄、startup-check 未迁 FixtureServer。
- **C-3 ⚠️ 渲染器脚手架重复**（原 R1-H5；R8：`6f90d52` 部分关闭）：已收敛——art.ts 新增 `createCanvas2d/resizeCanvas2d/visibleWorld/ROBOT_R` 且 game/replay 双侧消费，replay 获得同尺寸短路（拖窗清屏抖动两处同修）；未收——`FONT_11` 仍 3 份（art.ts 私有未导出 / render.ts 自定义 / replay 内联）、死亡倒计时两版、drawBubbles 两版、game-only extras（trails/delayedHealth/localAim）仍单侧，art.ts 内部 `drawRobot`/`drawVitals` 仍写 `0.6` 字面量而非 ROBOT_R。
- **C-4 ✅ cameraZoom 双推进真 bug**（原 R2-B1；R3/R4/R5 三轮确认未修）：`feedback.ts:306-314` 有状态指数平滑（无 per-tick 缓存）被 `controls.ts:411`（drawFrame，rAF）与 `controls.ts:440`（sampleAndSend，60Hz interval）各调一次——两行逐字相同，R4 工作树引入（HEAD 零调用点），R5 的 +4 行未触及。同 tick 第二次调用 elapsed 兜底为 1，每 tick 走两步，收敛速度随刷新率变化（144Hz ≈ 204 步/s）；`camera.ts:30-31` setZoom 钳制 [0.85,1.05] 使误差有界但仍在。R5 新增的缓出方向测试（feedback.test.ts:389-397）全用不同 tick，**未覆盖同 tick 双调用**。附带：该行（含 `!!self?.dashing && !self.dead` 谓词）在两条循环间整行复制，是 C-26 双循环共享可变状态的直接实证。修法 ~3 行：tick 未变返回缓存，或只留 drawFrame 一处调用。R8 复核：修复保持；R5 指出的「同 tick 双调用无测试」缺口已由 feedback.test.ts 新用例补上（draw/sample 同 tick 各调一次 + 两实例双推对照）。
- **C-5 ✅ Go 大写 Vec2/num 解析三份**（原 R1-H4）：`mapdef.ts:39-52` / `replay/model.ts:309-316` / `replay/index.ts:478-489`（+health-check.mjs 内联第 4 份）→ `lib/gojson.ts`。-40 行。

### 中影响
- **C-6 ✅ setText/setTxt ×3 + fmtClock ×3**（原 R1-M1，R3 复核 hud 重构未合并）：`live.ts:17` / `replay/player.ts:528` / `hud.ts:413`；fmtClock `player.ts:537` + live.ts:140 + hud.ts:149 内联。→ `ui/dom.ts`。
- **C-7 ☐ workbench 分隔条拖拽两份**（原 R1-M2）：`workbench.ts:420-478` vs `script-console.ts:359-399` → `ui/resizable.ts`。-70 行。
- **C-8 ☐ 三面板 pending/掉线文案/可用性门/防抖落盘**（原 R1-M3）：`workbench.ts` / `snippet-panel.ts` / `ai-panel.ts` → `panel-common.ts`（PendingTracker/DebouncedPersist/Availability）。-90 行。
- **C-9 ✅ editor 双补全 provider 逐字相同**（原 R1-M4）：`editor.ts:200-243` 两个 22 行一致块 → for 循环注册。-22 行。
- **C-10 ✅ `$(id)` helper 四种写法**（原 R1-M5）：main.ts:28 / lobby.ts:6 / auxiliary-views.ts:6 + live/workbench/hud 变体 → 并入 `ui/dom.ts`。-30 行。
- **C-11 ⚠️ 颜色/字体字面量扩散（R2 发现、R3 恶化一倍、R4 复核行号微漂）**：
  - `'#22d3ee'` 系 11+ 处（art.ts ink.cyan 是规范处）；
  - `'#a5e6ef'` 三文件：`feedback.ts:389`（新）+ `startup.ts:70`（新）+ `startup.css:28-29`；
  - `'#f4fbff'`：`feedback.ts:15` 已常量 vs `art.ts:184,246,286`（286 新）；
  - **`hud.css` amber 系硬编码 7 处：`#fbbf24`×5（:73-77）+ `#a68b4b`（:79）+ `#d1b46b`（:80，R5 standby 轨新增）vs `app.css:13` 已有 `--amber` token**；R5 app.css 又复制 3 个调色板字面量（#416779/#1c3340/#122733）；
  - 伤害阴影 `'#071019'`（feedback.ts:409）vs ink.bg 近似色；
  - 字体旁路 ×2：`feedback.ts:402` `'14px ui-monospace'` 绕过 `art.ts:9` mono；`startup.ts:60` 重写 Fusion Pixel 串（startup 不能 import art.ts 属合理，但应提本地 const 或 tokens 文件）。
  - 提案：ink 补 `white/glow`，CSS 用 var(--amber)，伤害飘字接 art.mono。
  - **R8 回退（首次出现「修复中被回退」样本）**：`art.ts:369,371` 原 `ink.white`/`ink.lime` 改裸字面量 `'#ffb066'`/`'#8cff66'`（git show 对照实锤），同对手抄 `app.css:114-115`（#hud-hp-fill/#hud-hp-delay），共 4 处无 token；`scoreboard.css:13,85` 新增 amber 族字面量 2 处（`app.css:13` 已有 `--amber`）。
- **C-12 ☐ phaseName / 房态文案双份**（原 R1-H2 + M7）：phaseName 合并入 `@omb/protocol`（枚举名映射属协议知识）；`roomStateName(state, ctx?)` 参数化「空闲/等待开场」差异。R8 延伸：重生倒计时文案三处（`death.ts:8` 整数秒 / `scoreboard.ts:17` toFixed(1) / `render.ts:93` canvas），`deathStatus` 已抽但 scoreboard 未复用。
- **C-13 ✅ music Worker 消息类型双份**（原 R1-M8）：`renderer.ts:9-19` vs `render.worker.ts:10-20` → `render-protocol.ts`。
- **C-14 ⚠️ escapeHtml ×3**（原 R1-M9）：R6 已合并 manual/AI 三处语义一致的 `&<>` 变体；`replay/library.ts` 还需转义引号，保留独立实现。
- **C-15 ✅ math 微函数**（原 R1-L1）：clamp（music/music.ts:35 export vs camera.ts:56 私有）、clamp01（hud.ts:419）、lerp/lerpAngle（replay/index.ts:356）→ `lib/math.ts`。
- **C-16 ✅ 测试脚手架**（原 R1-L3）：`5087ce8` 新增 `game/test-targets.ts`，input/takeover 测试共用 `Target/send`；`feedback.test.ts` 使用共享 `stubFeedbackEnv()`，个别 reduced-motion 用例仅覆盖必要差异。
- **C-17 ⚠️ feedback.ts 单类 11 职责**（原 R2-B6/B8 + R3-A2）：现 520+ 行；未命名魔法数批量存在——飘字寿命 `850` 裸写两处（:356,:404，与 DAMAGE_HOLD_MS/DAMAGE_FADE_MS 互不相干）→ `DAMAGE_POPUP_MS`；连击窗口 520/上限 6/步进 0.07；zoom 目标 0.92/混合 0.64,0.78；slam 曲线 -8/4.5/10/4；低血闪 180/240、噪声质数 997/101。draw() 内 splash 照抄 impact 骨架、`reduced.matches` 守卫散布 7 处 → `Record<EffectKind, DrawFn>` 注册表 + motionScale getter。拆 `game/feedback/`（effects/vitals/trails/camera-feel），-60~90 行。**红线：`delayedHealth` 是带回写 getter 且被新测试冻结（「连续受击白条保持」），勿改纯函数**。
- **C-18 ✅ hash2d/imul 哈希三份**（R3-A2）：`5087ce8` 新增 `lib/hash.ts` 统一确定性 hash2d，startup/startup-art/feedback 共用并有向量测试。
- **C-19 ☐ startup 侵蚀（R2-B7 已修 ✅、R3 新增三项、R4 部分测试覆盖）**：JS/CSS 计时耦合已消除（单时钟 EROSION_MS=900 + rAF）✅；遗留：字符方言三套（D16）、erodeText/erodeScreen 魔法数（0.58/0.3/cell=24/0.15+dist*0.52+hash*0.17/0.12）→ 常量块；`startup.ts:56` querySelector 非空断言建议降级可选。R4：`erodeText` 已被 startup-art.test.ts:6-21 冻结（单调性/行宽/progress 0 与 1）；`erodeScreen`（startup.ts:26，canvas tile）仍无测试。
- **C-20 ✅ HUD 多轨接管标记**（R3/R5）：`5087ce8` 将脚本接管统一为 `data-takeover="script"`，微光移到 `.skill-icon` 并使用 `var(--amber)`；`data-state="standby"` 只保留独立的瞄准待命语义，结构测试防回退。
- **C-21 ✅ lift 0.38 三处**（D15/R3-A3，R4 复核仍成立）：`render.ts:84` + `art.ts:235`（`lift*0.38`）+ `art.ts:236`（`0.48 - lift*0.12`）→ art.ts export `UPLINK_LIFT`。
- **C-22 ✅ join-failed 判定分裂**（原 R1-L5）：并入 X-4 短期项（net.ts 导出复用）。
- **C-23 ☐ 三段会话拆除八连**（原 R1 架构-2，R3 复核未动）：`main.ts:185-192 / 281-294 / 372-396` 重复 `stopRttLoop/close/exit/resetMatch/syncWorkbench` 八步 → `teardownSession({keepIdentity})`。-18~24 行。
- **C-24 ✅ hud updateTakeover/updateSkills 重复推导**（R3-A7）：self/dead 推导 ×2 → 传参。-2 行（次要，顺手）。
- **C-25 ☐ help-toggle escape/leave 语义不可区分**（R3-A5，R5 复核仍成立）：`help-toggle.ts:10` 两 action 同返回 false → 合并 `'close'` 或给 leave 附加语义。
- **C-28 ✅ aim 归属判定的客户端双投影**（R5）：`5087ce8` 抽出 `axis-src.isAimUnderScript`，HUD 文案与 controls guard 共用同一真值表，并覆盖 assist/能力/权威 turret source/手操轴组合。
- **C-29 ☐ titleBadge 第 3 份浮层定位实现**（R8）：`scoreboard.ts:123-137` `positionTitleDetail` 手写 anchor 钳制/上下翻转/body portal（`:216`），而 `workbench/script-version-placement.ts:40` 已有可复用 `computePanelPlacement`（同为 body portal 形态）。
- **C-30 ☐ kill-feed 行数双写**（R8）：`kill-feed.ts:4` `KILL_FEED_ROWS = 6` ↔ `kill-feed.css:6` `calc(6 * var(--feed-row))`，改行数需两处同步。
- **C-31 ✅ 回放积分板缓存签名混入 `frame.tick`，播放期每帧全量重写积分 DOM（R9，P1 效率）**：`replay/player.ts:402` 签名含 tick → 每帧必失配 → 每帧 `scoreRenderer.update` + aria-label 重写，`displays` 逐行展开重建；下游 `fillScoreRow`（scoreboard.ts:239-245）每行无条件 textContent 多次写，titles=false 时还每行 `badges.replaceChildren()`。8 分钟局 60Hz × N 人的 DOM mutation 风暴，与 live 侧 `Scoreboard.display` 引用缓存 + 等值守卫纪律相悖。修法：签名去 tick（rows 内容已覆盖变化）或建引用级缓存。**R9 当轮修复**：签名去掉 `frame.tick`——evidence 与 score 同源单调，行相同即 evidence 相同，不进签名（代码注释已记）。
- **C-32 ✅ Esc/全局快捷键层级三连（R9，P1 交互）**：① `script-version-drawer.ts:117-118` 版本浮层（body portal）内按钮获焦按 Esc：`main.ts:441` 的 `gameOptions.handleGlobalKey` 先触发（window 上先注册且不 stopPropagation），portal 不在 `options.ts:3` EDITING_TARGETS → 先开选项层，drawer 自己的 window keydown 才关抽屉——一按 Esc 双浮层联动，关掉选项层后再按又弹，形成 Esc 循环；② `help-toggle.ts:29` Esc 处理绑在 panel 元素上，焦点移回画布后面板残留，Esc 反而开选项层（与 C-25 的语义问题正交，是监听器作用域缺陷，C-25 拍板后依然存在）；③ 选项层（aria-modal）打开时 M/C 全局快捷键仍生效（main.ts:445-451 不检查 options.isOpen，排除表也不含 button）→ 焦点被移出模态对话框、Tab 焦点圈失效。修法：浮层类统一「开窗期挂 window 级 Esc（capture）+ 关窗摘除」，handleGlobalKey 在 options.isOpen 时短路。**R9 当轮修复**：① drawer 增加捕获段 Esc 监听（焦点在 Monaco/输入框时仍走冒泡，保留「编辑器先消费 Esc」的既有语义）；② help-toggle 开窗期挂 window 级捕获 Esc、关窗摘除（焦点原本就在面板内才把焦点还给 ? 按钮）；③ main.ts 在 `gameOptions.isOpen`（本就是公开 getter）处短路其余全局快捷键。
- **C-33 ✅ 回放库并发 load 无在途守卫（R9，P2）**：`replay/library.ts:114-133` 快速双击两个条目 → 两次 `player.load` 并发 fetch+parse 各自整体覆盖 index/map，慢回包覆盖新回放，路由/标签与画面错配（低速网可复现）。修法：load 加代际号，或 library 记在途 matchId 重复点击直接返回。**R9 当轮修复**：`ReplayPlayer.load` 加 `loadGen` 代际号并改返回 `'loaded'|'failed'|'superseded'`——superseded 静默返回且不触发 onError/setBusy 回写，library 按返回值分流（只有 failed 才回列表）。
- **C-34 ☐ 震屏 translate 后视野雾矩形仍按 (0,0) 起画（R9，P2）**：`render.ts:55` 震屏 `ctx.translate(shake.x, shake.y)`（振幅 ±8/±6px）后，`drawVisionMask` 的 `ctx.rect(0, 0, cam.cw, cam.ch)`（:144）随坐标系偏移——自机阵亡 ~267ms 内震屏反向侧边缘留 1–8px 未压暗亮缝。修法：雾罩矩形外扩 |shake| 或遮罩前还原屏幕坐标。验证：实战阵亡瞬间逐帧看画面边缘。
- **C-35 ☐ visual 回放插值恒置 respawnAt:null（R9，P2）**：`replay/index.ts:294,310` 两个插值分支都写死 `respawnAt: null`，事件叠加关键帧分支（:380）才有 `ev.tick+180`；`replay/render.ts:39-41` 的倒计时文本分支对带 visual 行的新格式录像不可达——同一局实况显示「2.3s」、新格式回放只有骷髅图标。修法：插值结果携带工作态 respawnAt，或渲染侧按 alive=false 固定估算。
- **C-36 ☐ #game-chat 与 kill-feed 通讯栏同位重叠（R9，P1 视觉/交互）**：`app.css:366` chat `bottom:280px` 只避让 hud-left 本体（实高 ~148px），未算挂到 hud-left 顶上的通讯栏（kill-feed.css:2 `inset: auto auto calc(100% + 12px) -2px`，顶边 ~365px）；chat 占 280–395px 带、x 20–440，不透明背景 + z-index:8 压住 feed 底部最新 2–3 条击毁记录，打字时不可见。CSS 值与结构已核实，精确重叠带建议实机确认。修法：chat 锚点计入 comms 实高，或 chat 打开时 feed 下沉。
- **C-37 ☐ 全站未声明 color-scheme:dark（R9，P1 设计）**：全 src 与 index.html 零 `color-scheme`/`scrollbar-color`/`::-webkit-scrollbar`/`::selection`；深色滚动容器遍布（`#replay-list` app.css:194、manual 双栏、`#hud-score-rows` scoreboard.css:35、`.end-list`、`.ai-feed`、`.script-console-list`），`<select>`（#live-follow/#sp-follow）下拉弹层与滑轨走 UA 亮色 scheme——深底像素风被成排系统亮条打破，全站一致性破绽。修法：`:root{color-scheme:dark}` + meta，按需补暗色 scrollbar/selection token。
- **C-38 ☐ 动效健康度：workbench.css 全文无 prefers-reduced-motion + AI 无限动画动 layout 属性（R9）**：`workbench.css:221-223` `.snippet-apply[data-dirty]` 无限 box-shadow 脉冲（开启 snippet 未点应用即常驻闪烁）——其余 6 个 CSS 都有 reduced-motion 块，app.css:497 全局兜底只禁 transition 不禁 animation，违反 STYLE.md:56 自定规则；另 `ai-panel.css:100,113` 扫描线动 `left`、meter 5 根动 `height`（:145-146），生成横幅可见期间每帧 layout+paint。修法：workbench 补 reduced-motion 块（dirty 态改静态 amber 描边）；scan/meter 改 transform（对齐 snippet-switch::before 做法）。
- **C-39 ☐ 窄容器布局三处（R9，P2）**：① `workbench.css:141` ≤560px 编辑器控制行 4 轨网格装 5 个子项（版本 drawer 的 span 未计入轨），Console 开关跌落第二行与 lang-switch 同列叠行；② `app.css:399,402,403` ≤420px 下 Uplink 面板 min-content（nowrap 文案 + 90px bar + padding）超出 `.hud-right` 46vw 上限，向左越界压进战场画面（已声明支持的 320 档在列）；③ `app.css:241-244` `.rp-mark-tip` nowrap 无 max-width，窄屏长 detail 文本伸出视口/控制条。
- **C-40 ✅ 渲染热路径小分配群（R9，P2 效率）**：① `art.ts:41` 三块全屏不透明画布 getContext 未传 `{alpha:false}`（每帧首操作都是不透明全量 fillRect），合成器走不了不透明加速路径；② `feedback.ts:124,134` 快照热路径每机器人每 tick 新建 4 字段对象 + 每快照重建 cores Set（60Hz×64 ≈ 3840 对象/s，与 world.ts:77 已修的同类纪律相悖）——prev 只读可原地复用；③ `replay/render.ts:34,55` 回放每帧重建 owner→color Map + 逐气泡 `robots.find` 线性扫（live 侧同逻辑走 Map 直查）。**R9+ 修复（2026-10-11）**：三处全落——`createCanvas2d` 传 `alpha:false`；feedback prev 原地改写 + cores 集合原地增删（spawn 检测仍用旧集合语义不变）；回放一次建 id→robot 索引供弹丸取色与气泡定位共用。
- **C-41 ☐ 回放时间轴标记 6×6px 纯 hover，无键盘/触摸可达（R9，P2）**：`app.css:231-233` + `player.ts:285-290` 生成 div 非 button、无 tabindex/aria，tip 仅 PointerEvent 驱动——触屏点不中 6px 目标、键盘完全触达不了事件标记。修法：透明扩大热区 + role/aria-label + 触摸即显 tip。
- **C-42 ☐ workbench 微字 8–9px 配 ~3:1 低对比（R9，P2）**：`workbench.css:205-206`（snippet-range-scale 8px `#49616d`、format 9px `#4d6875`）、`ai-panel.css:29,161`（ai-model-mode、窄容器 8px 状态行）对深底 3.0–3.4:1（<4.5:1），8px 亦低于可读下限；全 px 体系浏览器 zoom 不缓解。修法：微字下限 10px、颜色提一档（--fg-dim 档）。
- **C-43 ✅ audio.ts ensure() 创建分支不 resume()（R9，P2）**：`audio.ts:268-293` 新建 AudioContext 分支无 resume，仅复用分支有 `state==='suspended' → resume()`；WebKit 即使可信手势内 new 也起始 suspended，且 `installUI` 的 wake 捕获监听在当前事件派发过程中注册、按 DOM 规范不被本次事件触发——PRESS TO START 后 Safari 音效+BGM 全静默直至下次手势。修法：创建分支补 `void ctx.resume()`（与复用分支一致）。**R9 当轮修复**：创建分支补 `if (ctx.state === 'suspended') void ctx.resume().catch(...)`。
- **C-44 ☐ ai-markdown 链接不过滤 scheme（R9，P2）**：`ai-markdown.ts:50-61` renderer.link 仅加 target/rel，`javascript:` href 原样经 innerHTML 注入（ai-panel.ts:315,320,432,440）；原始 HTML token 已被 `renderer.html = escapeHtml` 挡住但链接漏网。`target="_blank"+noopener` 把执行压到隔离新上下文，危害有限，属应修打磨。修法：href scheme 白名单（http/https/mailto/相对路径），其余替换 `#`。
- **C-45 ☐ 回放 NDJSON 任意一行损坏即整局不可播（R9，P2）**：`replay/model.ts:172-175` 逐行 JSON.parse 失败即 throw → player onError 整局放弃；NDJSON 是服务器增量写盘，进程被杀/磁盘满最常见的产物是尾部截断行。存档类数据丢整局代价远大于丢最后一秒。修法：容忍末行解析失败（跳过并照常 finish），中间行维持显式报错；未知 schema/类型严格拒绝保持不变。
- **C-46 ☐ bots/oracle.ts 站桩宽限 45 tick 超服务器 30 且 gap 整段计入进度（R9，P2）**：`bots/oracle.ts:47` 常量注释自认服务器 0.5s 宽限（=30 tick）却写 45；`maintainHack` 把 2–45 tick 的中断 gap 整段按站桩进度累加（:595-604），记忆衰减估算同源高估——服务器跳 tick/站桩被打断场景下本地进度虚高，提前停止 interact 并错误拉黑该桩 30s（服务器侧桩仍可用）。修法：宽限 ≤30；gap>1 只计 1 tick。
- **C-47 ☐ #audio-settings 与 .game-tools 工具栏形态不统一（R9，P2 设计）**：`app.css:153-154` 工具栏按钮是「无边框+底边线」tab 形态，`:348-349` audio-settings 是「四边描边+异底色」浮盒，main.ts:90 将其 append 进同一行——同行两种视觉语言，`#btn-game-help[aria-expanded]` 的激活态样式也不作用于它。修法：补 `.game-tools > #audio-settings` 形态对齐规则（浮层不变）。

### 架构建议
- **C-26 ⚠️ CanvasStage**（原 R1 架构-1）：**R9+ 部分落地（2026-10-11）**：新增 `game/canvas-stage.ts`（canvas+DPR 后备缓冲+RO+逐帧 DPR 漂移检测+rAF 宿主，代际号保证 draw 内 stop 安全），controls（恒绘）/live（脏标记，气泡保活语义保留）/replay-player（播放时钟 pump + 恒绘）三处循环全部迁移，行为保持；同尺寸短路单源化。**未做**：controls 的「空闲不重绘」——画面含指针瞄准预览，朴素跳帧不正确，需 feedback 暴露静默判定后另行设计。原描述：三处手写 canvas+DPR+rAF 循环 → 统一宿主，把「同尺寸短路」「空闲不重绘」变默认。C-4 的 bug 正是双循环耦合的代价。
- **C-27 ❌ 事件总线**（原 R1 架构-2）：明确不做——main.ts 消息分发单点且时序敏感（awaitingFull 状态机），总线会掩盖时序。

---

## 5. 死代码清单

| 项 | 位置 | 备注 |
|---|---|---|
| `noteAt()` | `music/render.ts:254-261` | ✅ R6 已删除（`efb8217`） |
| `usingWorker` getter | `music/renderer.ts:45-47` | ✅ R6 已删除（`efb8217`） |
| `RING_MID` | `game/mapdef.ts:31` | ✅ R6 已删除（`efb8217`） |
| `Sim.ProjectileViews/CoreViews/HealthPackViews` | `sim/view.go:96-100` | ✅ R6 已删除三个零调用 getter（`91c354d`） |
| `Sim.View/RobotViews/UplinkViews/Arbitrated` | `sim/view.go:84,93,105,106` | 仅 sim 测试；`LineOfSight` 被 objectives.go 内部用，应降 unexported。R8 更正：`Snapshot` 不存在（基线即无，旧条目名过时） |
| `Sim.SetSpawn/Respawn/SetWalls` | `sim/sim.go:238,286` / `collision.go:167` | 生产零调用但 sim 测试广泛使用（R8 更正：非纯死）；SetWalls 墙校验与 SetMap 的重复（留一删一） |
| `Observation.PartnerID/IsPartner` 链 | `sim/contract.go:154-166` + `stats.SetPartnerMap` + encoder.go:247-248 恒 false | deprecated 兼容层，随旧数据支持到期评估删除 |
| `handleUpstream` 的 `sendLossy` 参数 | `cmd/omb/main.go:472` | `_ = sendLossy` |
| 根目录 `omb.exe`、`server/tmp/omb.exe`、`server/combat.log`、`server/crash.log` | — | 均已被 .gitignore 覆盖（R8 降级为本地磁盘卫生，非「在库里」）；`server/tmp/manualcheck/` 已消失 |
| `ScoreRowRenderer.renderedOptions` | `client/src/game/scoreboard.ts:315,329,347` | R8 新增：声明/赋值/清零但全库零读取（死字段） |

（R4 复核：客户端三件套仍死，行号未变。）

---

## 6. 正面确认（保持现状，勿动）

- **golden 跨语言字节测试**（`packages/protocol/test/golden.test.ts` ↔ `protocol_test.go`）是全库最好的跨端契约实践，应扩展而非替代。
- **Title 枚举**：枚举值来自生成代码（scoreboard.ts 用 `Title.WAR_MACHINE`），服务器仅授 ID、中文显示名仅客户端——无重复，好样本。
- **mapgen 确定性纪律**：零 Hypot/Cos/Sin、字面量乘加；R2/R3 新代码均守住（walls.go 只做整数旋转）；`math.Sqrt` 唯一用在 slotDirection 且 Go spec 保证跨平台一致。
- **测试夹具复用**：R2 新增 sim/mapgen 测试零拷贝；sim 包内共享良好。
- **SimulationVersion 门**：v3 gate 四处（validateRecord / 生命周期校验 / per-uplink 校验 / 运行时分支），旧二进制读新日志干净失败，用法正确。
- **冻结契约全部遵守**（R2/R3 复核）：`cameraShake` 返回新对象、`aimAt` 每次重读 rect、`frameAt` 返回隔离克隆；唯一注意点是 `delayedHealth` 的回写副作用也是冻结契约（见 C-17 红线）。
- **R3 提交质量**：`axis-src.ts` 是好模块（纯投影 + 6 用例测试）；hud.ts 删除自己的第 4 份轴常量副本；帮助面板抽成可测纯函数（help-toggle.ts + vitest）；script-console 滚动锚定修复干净。
- **R4 仲裁语义改善**：`input.ts:183-189` `toggleAssist(serverManualAxes)` 三分支与服务端完全对齐（开+手操→交回且保持开），`releaseAxes` 覆盖失焦清零场景；**2 条新契约由 takeover.test.ts:28-45 冻结**（Space 三分支镜像、服务器保留轴参数）——建议并入 perf-contracts 记忆。配套：`controls.ts:287-292` `activateAssist` 归还手操轴且绝不反向关闭（幂等）；`controls.ts:316-321` `syncAimGuard` 部分收回 b62c4d0 的纯本地策略、重新采信服务器 `turret_src` 回显（有意回摆，记为语义决策）。
- **R4 check 脚本质量**：aim-guard-check.mjs 断言升级为真效果（炮塔角差 <0.08 rad、真实弹丸 owner、fireSrc 1↔2 转换）、`scriptError` 事件即 throw、finally 清理临时目录；erodeText 获得测试冻结（startup-art.test.ts:6-21）。
- **R5 检查脚本与测试质量**：takeover-live-check.mjs 大重写（try/finally 全套清理、until 轮询带 self 快照、WS framereceived 嗅授权威态、断言全真效果：位移 >0.3 / owner==self 弹丸 / shieldOn 真开真关 / Space 三分支权威态 / 6 卡全量琥珀断言）；game-feel-check 的 `assertHelpAnchor` 1 份定义 4 处复用（harness 化正面样本）+ 低血 mosaic 像素级断言；feedback.test.ts 合并 describe 使 stub 三连 4→3，并冻结低血 mosaic / delayedHealth 保持 / cameraZoom 缓出方向 / hit 音高连击四组新契约；axis-src.test 冻结 5 用例（standby 态、CS_SCRIPT/CS_SNIPPET→aiming、manual 优先级、mask=13 不误报、undefined→unavailable，含中文文案契约）；hud uplink 卡纳入接管标记。
- **手册 vs 代码数值一致**（D14 ✅）。
- **不做的事**：ECS 式 sim 重构（确定性契约收益不抵风险）；事件总线（C-27 ❌）；强行合并 mapgen 几何（S-2 红线）；强行合并 manual frontmatter（X-8 ❌）；L4 实体视图类型三份（形态差异真实，渲染层已解耦）。

---

## 7. 建议落地顺序（R7 后）

1. **立即剩余项**：C-25 help action 语义（需产品决定）· C-11 剩余颜色/字体旁路。
2. **高收益去重**：C-2 harness 后续批次（剩余 spawn/WS/Fixture）· S-2 `internal/geom` + 交叉测试 · S-3 轴表驱动 · S-4 projector `eventKey/applyEvent` 同源 · S-14 · C-8 面板公共件 · C-17 feedback 拆分。
3. **需产品拍板**：S-24① decay 可观测性 · S-24② busy 横跳 · C-12 房态文案差异 · C-25 Help Escape/Leave 是否应区分。
4. **协议演进**：X-2 SnippetSourceView 扩字段；ReplayRecord 当前已单源版本/类型，但若未来需要字段级演进可进一步改为完整 proto 信封。
5. **结构性**：C-26 CanvasStage · S-8 match.go 拆分 + S-6 单次 AOI · S-5 ReplayCursor · S-22/S-23。

> R7 已移除完成项；部分完成项保留在上述后续范围中。
> R8：落地顺序不变；X-2 已开工（工作树半成品，见条目）；R8 新增项（D18/C-29/C-30/S-25）并入第 2/3/4 节对应优先级；可执行的清理与在办清单移至根 `TODO.md` 跟踪。
> R9：正确性/健壮性批次优先级——**立即**：S-26（资源泄漏/DoS 面）、S-27（局中玩家卡死）、C-32①（Esc 双浮层联动）、C-31、C-36/C-37；**硬化批次**：S-28/S-29/S-30/S-31/S-32/S-33/S-34；**打磨批次**：C-33~C-35、C-38~C-47、S-35。既有落地顺序不变。R9 立即批中的 S-26/S-27/C-31/C-32 与打磨批中的 C-33/C-43 已于当轮修复（✅，含 `hub_janitor_test.go` 4 用例与 `TestBindMidMatchNonRosterGetsNoBootstrap`）；余项待修。

---

## 8. 追加记录

### Round 9 补充（2026-10-11，HEAD `4f8f74d` + 工作树，实施批）
- **R9 立即批修复**：S-26（清道夫 + `EndWarmup` 新 room API + closed 门卫）、S-27（花名册门卫）、C-31（回放积分签名去 tick）、C-32 三连（浮层捕获段 Esc / 帮助面板 window 级 Esc / 选项层打开短路快捷键）、C-33（回放 load 代际号，返回值改 `'loaded'|'failed'|'superseded'`）、C-43（AudioContext 创建分支补 resume）。
- **X-2 收尾关闭**（D8 同步）：双端代码生成补跑；catalog 六条目补齐元数据（Step/Hint 取自原客户端表，边界与 Validate 由新测试互钉）；`snippetSourceViews()` 全字段下发；面板改服务器驱动 + 兜底往返钉死测试。
- **S-6 关闭**：`match.go` step 单次构建 `obsByRobot`，脚本池与快照循环共用。**C-40 关闭**：`alpha:false`、feedback 原地改写 + cores 原地增删、回放 byId 索引复用。**C-26 部分落地**：`canvas-stage.ts`（恒绘/脏标记双模式、代际号防 draw 内 stop 泄漏）三处循环迁移，行为保持；controls 空闲不重绘待 feedback 静默判定设计。
- **S-26 阈值配置化**（语义由产品确认）：env `OMB_WARMUP_IDLE_STOP`/`OMB_ROOM_EVICT_AFTER`；setter 拒绝非正值（清道夫不可被配置关闭）；冻结语义：终局后房间有人（含观战者）永不逐出不踢人、模拟停止、RESTART/WARMUP 重开新模拟；非空房间（含有人 idle warmup）完全免疫。新增 `hub_idle_policy_test.go`（5 用例）、`janitor_config_test.go`（env 解析）。
- **R8 卫生清单全部执行**：package-lock/artifacts png 删除并入 gitignore、三份 plan 归档 `docs/plans/archive/`、oracle-bot worktree 删除（另清 10 个「已并入 main 且干净」的 Temp/D 盘 worktree；6 个 dirty/未并的保留）、本地 ~105MB 旧二进制/日志删除、runbook 两处 `pnpm -r typecheck` 修正、README 补 `bots/` 行。遗留一项待产品确认：根/client package.json 版本 `0.1.0` 是否刻意。
- **验证**：`go vet ./server/...`、`go test -p 1 ./...`（与 CI 串行 timing 门一致；并行全量下 `TestScanWalls64WithinRuntimeBudget` 有既有计时抖动，单独/串行均稳过）、vitest 50 文件 555 项、`pnpm typecheck` 全绿；gofmt 干净。
- **台账动作**：X-2 ✅、S-6 ✅、C-40 ✅、C-26 ☐→⚠️、S-26 ✅ 补配置化注、D8 ✅；轮次日志 +R9+ 行；TODO.md 重写（已完成/待办分区）。

### Round 9（2026-10-10，HEAD `4f8f74d`，工作树干净，六路并行子代理专项审计）
- **范围与方法**：R8 后仅 `4f8f74d` 一个提交（HUD 打磨/接管改进/X-2 推进）。本轮应用户要求切换审计口径：不再查复制粘贴/单源类（第 1、2、5 节框架照旧），专查**隐藏正确性 bug、渲染效率、交互、视觉设计**。六路 Explore 只读子代理并行（渲染管线/交互输入/UI-CSS/Go sim/网络会话/周边系统），各路带既有台账去重；高影响断言由主会话逐一实读复核（S-26/27/28/29、C-31/32/36 的 CSS 值/37/38/43 均复核成立）后才入库，原始 31 条归并为 27 条。
- **headline**：服务端两条 P1——空房间 warmup 60Hz 永动不回收（S-26，可脚本化 DoS）与局中新身份 bootstrap 死等（S-27，客户端卡「正在同步」最长 8 分钟）；回放/交互链路 P1——积分 DOM 每帧重写（C-31）、Esc 双浮层联动循环（C-32①）、恶意 checkpoint/ToggleCount 两个硬化缺口（S-28/S-29）、chat 压 kill-feed（C-36）。前端视觉层首次系统性过 CSS：color-scheme 缺失（C-37）与 reduced-motion 缺口（C-38）是全站级而非单点。
- **复核后排除的集中疑点**（各路子代理已查证，汇总留档）：输入 blur/visibility 清理、rAF/timer 生命周期与双循环、canvas save/restore 状态泄漏、DPR/resize 失配、相机围绕点缩放数学、拖尾/飘字/气泡数组界、墙影几何、锁区遮罩互补性、心跳边界、锁序、并发 map、弹丸 tunneling、同 tick 双碰撞、无敌帧边界、uplink 争抢确定性、启动加载卡死/双击、Monaco 生命周期与浮层 portal 清理、AI pending 终态、awaitingFull 正常重连恢复、房码路径穿越、快照 NaN——均排除无新发现。
- **台账动作**：轮次日志 +R9；行号基准更新至 `4f8f74d`；新增 S-26~S-35（高影响 4/中影响 5/低影响 1）、C-31~C-47；第 7 节补 R9 优先级注。
- **未验证**：静态只读审计，未运行测试/构建；C-36 的精确重叠带、C-34 的震屏亮缝、C-43 的 Safari 行为建议实机/真机确认（验证方法已写入条目）。

### Round 8（2026-10-05，HEAD `6f90d52` + 工作树，repo-steward 全库只读审计）
- **范围**：R7 基线 `90d5819..6f90d52` 共 88 文件/+3650−559（积分榜重设计、kill-feed/shadow/death 新模块、ScoreRowRenderer 三端统一、64 机填充、墙影投影、64KiB 帧上限、mapgen Gen7/coreSupply、invuln 下发、beta.2 发布链）+ 未提交 X-2 半成品 + 仓库卫生/文档层；三路并行评审，关键断言（颜色回退、零填充、死字段）逐一实锤。
- **headline**：代码增量整体**收敛**——C-3 脚手架单源、C-4 测试缺口补上、ScoreRowRenderer 三端统一、盾牌比例与帧上限魔法数归一、C-2 沿 harness 方向继续（出现跨脚本 pass 复用新形态）、本区间新增约 1600 行测试。熵增三点：C-11 首次回退（R6 收敛被部分撤销）、TITLE_DETAILS 新手抄（D18）、S-6 在 64 机下成常态。
- **红线/契约复核（全过）**：mapgen 确定性零违反（唯一 `math.Sqrt` 仍是 sanction 的 slotDirection 用点，本轮 geometry.go 零 diff）；X-7 插画逐常量对比零漂移（Gen7 的内环掩体层与 coreSupply 均不触碰插画骨架常量）；冻结契约（aimAt/cameraShake/frameAt/delayedHealth 回写）全部遵守；C-20 接管标记单轨保持。
- **正面样本**：`MAX_FRAME_BYTES` 协议单源（proto → `netws/handler.go` → `ts-submit.ts` 三侧）+ golden/timing 互钉，并修复 coder/websocket 默认 32768 静默断连 ~53KiB TS 提交帧的真实 bug；coreSupply 把参与人数编码进 MapDef（入 hashDef 与回放）而非墙钟，设计正确。
- **台账动作**：轮次日志 +R8；行号基准更新至 `6f90d52`；X-2 ☐→⚠️（工作树零填充+gofmt 未过）；C-3 ☐→⚠️（部分关闭）；C-2/C-4/C-11/C-12/S-2/S-6/D8/D11 增补；新增 D18、C-29、C-30、S-25；死代码清单三处更正 + `renderedOptions` 入列。
- **仓库卫生（发现移交 TODO.md 跟踪，本轮零清理动作）**：`package-lock.json` 冗余可删（全仓零引用，CI/脚本全 pnpm）；`client/artifacts/*.png` 误提交（4929dd5 带入，零引用）；`docs/plans/{ci-cd-release,docs-rewrite,round-2}.md` 已完结可归档；TODO.md 全勾选需重开（本轮已重开）；`.worktrees/oracle-bot` 分支已并入 main 可 remove；本地 ~130MB 旧二进制/日志（均已被 ignore）。CI 版本链（go 1.25 / node 22 / pnpm 读 packageManager）与 `-p 1` 串行 timing 门核对一致。
- **未验证**：本轮为静态只读审计，未运行测试/构建（沿用 R7 记录的 477 测试基线）；工作树 X-2 的运行时行为未验证（服务端尚未填充，无新行为可测）。

### Round 7（2026-10-04，`71925db` → `90d5819`）
- **跨端单源**：`62d675b` 关闭 X-1/D1（Bot API → Monaco/AI/runtime）；`dbd7c66` 关闭 X-3/X-4/D5（`SimTuning` + `EvControlNotice`）；`ceb69bd` 关闭 X-5/D9（帧与心跳）；`51cec6e` + `06cd7b6` 完成 Replay schema/type/visual 版本单源。
- **维护性修复**：`d644281` 推进 C-2 harness 第二批；`5087ce8` 关闭 X-9、C-18、C-20、C-28，并抽共享 test target；`436f46d` 关闭 S-10/S-11/S-20；`10ec947` 关闭 C-1，以 `spectate-controls.ts` 共用 Live/Replay 的 wheel/键盘/拖拽/按钮/清理逻辑。
- **脚本版本链**：`4a1dbde` + `30b2f53` 将 runtime JS 与 editor source/language 分离；`90d5819` 完成 JS/TS 提交、AI-JS-while-TS 路由、带语言 stash/回退，以及编辑器标题栏锚定的 `document.body` portal 浮层（外点/Escape/workbench close/identity/dispose 清理，窄屏翻转与 viewport clamp）。
- **启动性能与体验**：`cdbeb14` 将 Monaco 预取移到开屏资源期（Vite dev 冷启动 852 个 Monaco 请求在进入房间前完成，进入后新增 0）；`0a0177d` + `11c3cf5` 增加真实资源里程碑驱动、单调视觉追赶的字符加载器，pending 上限 95%，全部成功后才到 100%，并覆盖 2540×1520 至 844×390 / 320×740 响应式布局；加载期不渲染 `PRESS TO START`。
- **验证**：45 个 Vitest 文件 / 477 项测试；`pnpm typecheck`、`pnpm build`；`test:startup`、`test:versions`、Live takeover 浏览器流程；`go test ./...`；`go test -race ./server/internal/{glue,script,ai,protocol}` 全通过。版本浮层浏览器证据位于 `.artifacts/versions/`。
- **已知基线/保留决策**：Replay 旧 fixture 的 `/api/replay/<id>?visual=1` 仍可返回 `200 + 空正文`（在引入 C-1 前同样复现，非本轮回归）；`C-25` Help Escape/Leave 语义继续保留，等待产品决定。
- **提交**：`62d675b` · `dbd7c66` · `ceb69bd` · `51cec6e` · `06cd7b6` · `d644281` · `5087ce8` · `436f46d` · `10ec947` · `4a1dbde` · `30b2f53` · `cdbeb14` · `0a0177d` · `11c3cf5` · `90d5819`。

### Round 6（2026-10-04，核实基线 `1301cdc`，修复合入至 `71925db`）
- **流程**：先将既有工作树原子提交为 `1301cdc`；6 个 `glm-5.3:max` 子代理按前端玩法/地基/脚手架、后端运行时/模拟、跨端契约并行核实，再在隔离 worktree 修改。主分支期间新增的发布、样式与 lint 提交全部保留。
- **已修**：C-4/C-5/C-6/C-9/C-10/C-13/C-15/C-21/C-22/C-24；S-1/S-7/S-9/S-16/S-17/S-18/S-19；X-6/X-7/X-10；D2/D3/D4/D6/D10/D15；客户端死代码三件套与 sim 三个零调用 View getter。
- **部分收敛**：C-2（首批 harness）、C-11（white/amber 切片）、C-14（仅合并语义一致变体）、C-16（feedback 环境 stub）、C-17（常量命名）、C-20（颜色切片）；X-1（补全修正 + 漂移测试）、X-4（字符串协议短期防线）、X-5（帧字节 + 删除孤儿版本常量）；S-4（仅 awardMax）、S-20（仅 MaxLogLine）、S-24③（`DecayAt <= Tick`）；D1/D9/D11/D12。
- **关键正确性修复**：cameraZoom 同 tick 幂等缓存；非 sim 事件改走有效 sink 并写入正确 tick；回放拒绝未知 schema；`RING_CORE` 兜底 30→28；checkpoint 拒绝 `DecayAt == Tick`。
- **验证**：`pnpm test` 34 文件 / 317 测试通过；`pnpm typecheck` 通过；`pnpm build` 通过（仅既有大 chunk 警告）；`go test ./...` 全包通过。
- **提交**：`b4b8f13` harness · `b9eb154` frontend foundations · `efb8217` gameplay · `2146269` server runtime · `91c354d` sim · `71925db` contracts。

### Round 5（2026-10-04，HEAD `3d7cdbd` + 工作树，44 M + 3 ??）
- **范围**：相对 R4 的真增量 12 文件——controls.ts(+4)、hud.ts(±25)、hud.css(+3)、axis-src.ts(±17)+test(+37)、index.html(±24)、app.css(±28)、workbench.css(+12)、feedback.test.ts(+61)、takeover-live-check(±164)、game-feel-check(±73)、aim-guard-check(±147)。服务器侧仍与 R2-R4 相同，未重审。审计期间零漂移（结束 status 与基准一致）。
- **headline**：C-4 cameraZoom 三度确认未修（411/440 原样，R5 的 +4 行在 activateAssist/syncAimGuard 语义处）；C-20 未统一且 2→3 轨（`data-state='standby'` 第三轨 + amber 硬编码 5→7）。
- **回退**：X-10/D10——axis-src.ts:30 出现魔法位 `& 2`（第 4 份 axis_mask 位知识；`input.ts:14` 有 `AXIS_AIM` 可 import）。X-10 从 ✅ 降回 ⚠️。
- **改善**：C-16 stub 三连 4→3（describe 合并）；takeover-live-check 重写质量高（真效果断言 + 全套清理）；game-feel `assertHelpAnchor` 复用样本；axis-src.test 冻结 5 新用例；hud uplink 卡纳入接管标记。
- **不变**：C-25/C-21/D3/死代码三件套复核仍成立。
- **新增**：C-28（aim 归属双投影，axis-src 文案谓词 vs controls guard 谓词不同源）、D17（HUD 键位摘要手抄三处无对拍）。
- **台账动作**：更新 C-2/C-4/C-11/C-16/C-20、X-10 ✅→⚠️、D10、正面确认 +R5 条、落地顺序；新增 C-28/D17；轮次日志加 R5 行。

### Round 4（2026-10-04，HEAD `3d7cdbd` + 工作树，41 M + 3 ??）
- **范围**：相对 R3 的真增量仅 5 文件——controls.ts（±15）、input.ts（±9）、takeover.test.ts（+19）、startup-art.test.ts（±18）、aim-guard-check.mjs（±124）；feedback.ts/startup.ts 等其余文件与 R3 审计状态逐字一致（numstat 核对）。服务器侧仍与 R2/R3 完全相同，未重审。
- **headline**：C-4 cameraZoom 双推进**仍未修**，且两条循环的调用行（controls.ts:411/:440，含谓词逐字复制）正是 R4 工作树引入——HEAD 零调用点。R4 还确认该行在双循环间复制属 C-26 的新实证。
- **改善**：input.ts `toggleAssist(serverManualAxes)` 三分支与服务端对齐（takeover.test.ts:28-45 冻结 2 条新契约）；`activateAssist` 幂等归还；`syncAimGuard` 重采信 turret_src（相对 b62c4d0 的语义回摆，已记录为决策）；aim-guard-check 轮询化 + 断言真效果化 + 经真实编辑器 UI 提交 navigateTo（顺带实证 D1：脚本可运行，仅补全缺失）。
- **不变**：C-11/C-20/C-21/D3/死代码三件套复核仍成立（行号微漂：startup.ts 字体串 69→60）；C-16/C-18 计数不变。
- **台账动作**：更新 C-2/C-4/C-11/C-16/C-18/C-19/C-26 与 D1；正面确认新增 R4 两条；轮次日志加 R4 行。

### Round 3（2026-10-04，HEAD `3d7cdbd` + 工作树）
- **范围**：commit `3d7cdbd`「pi-agent: 实现 UI 反馈 TODO」（axis-src.ts+test 新模块、hud.ts 接管标记重构、main.ts/icons/index.html）+ 未提交增量（help-toggle.ts+test 新文件、startup 侵蚀扩写、script-console 滚动、6 个 check 脚本断言更新、5 份手册文档）。服务器侧与 R2 完全一致未重审。
- **改善**：axis_mask 副本 4→3（X-10 ✅）；B7 startup JS/CSS 计时耦合已修（C-19 部分完成）；help-toggle 抽取净 -28 行且带测试。
- **恶化**：C-11 颜色/字体面扩大一倍（#a5e6ef 三文件、hud.css #fbbf24×5、字体旁路 +startup.ts）；C-21 lift 0.38 二处→三处；C-16 stub 三连 3→4 份；D16 字符方言 2→3 套。
- **不变**：C-4 cameraZoom bug、C-1/C-2/C-3/C-5/C-6/C-12、死代码清单、全部 S- 条目。
- **新增**：C-19/C-20/C-21/C-22/C-23/C-24/C-25、S-24 decay 复查、D14 手册数值核对一致。
- **树漂移备注**：审计期间 aim-guard-check.mjs（sleep→轮询）与 takeover.test.ts（+1 用例）有测试加固改动，不影响结论（R4 已并入正式审计）。
