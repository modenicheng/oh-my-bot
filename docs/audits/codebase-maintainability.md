# 代码库可维护性审计（持续更新）

> 目的：集中记录全库（client / server / 跨端）的可维护性发现，供后续**追加**与**逐条修复**。
> 本文件是唯一的审计台账；聊天记录中的旧报告已全部并入此文件。
>
> **如何追加**：在「追加记录」节添加新条目（日期 + HEAD + 变更范围 + 新发现/复核结论），并同步更新对应发现的「状态」与「位置」。
> **如何修复**：修完一条就把状态改为 ✅ 并注明轮次，**不要删除条目**（保留追溯）；发现已过时改 ❌ 并写明原因。
> **行号基准**：Round 7 收尾（HEAD `90d5819`）。旧条目的历史行号仅供追溯；修复前一律按符号名重新定位。
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
| D8 | Snippet 目录元数据 | `server/internal/snippet/catalog.go:23-50` ↔ `client/src/workbench/snippets.ts:30-108` | 人肉对齐（客户端注释自认「漂移由服务端回执兜底」） |
| D9 | WS 帧字节/心跳 | proto 权威常量 → TS `messages.ts`/`ws.ts` 与 Go `netws/handler.go` | ✅ R7：`ceb69bd` 将帧与心跳时序收敛为协议单源，并有双侧黄金/时序测试 |
| D10 | axis_mask 位常量 | proto 注释 ↔ `sim/contract.go:212-217` ↔ `input.ts:15-18` ↔ `axis-src.ts:30`（魔法位 `& 2`） | ✅ R6：`axis-src.ts` 改用 `AXIS_AIM` 导入，删除魔法位 `& 2` |
| D11 | 颜色字面量 | `art.ts` ink 调色板（规范处）vs 十余处散写 | ⚠️ R6：`ink.white` 与 HUD amber 切片已收敛；其余颜色/字体旁路仍待处理 |
| D12 | 回放 NDJSON schema / record type / `visual` 紧凑数组版本 | proto `ReplaySchemaVersion` / `ReplayRecordType` / `ReplayVisualVersion` → Go/TS 磁盘适配层 | ✅ R7：`51cec6e` + `06cd7b6` 单源化并测试未知版本/类型与 protojson 输入 |
| D13 | phaseName / 房态文案 | `render.ts:41-47` vs `replay/index.ts:491-496`；`lobby.ts:117`「空闲」vs `live.ts:235`「等待开场」 | 双实现 + 语义未确认是否刻意 |
| D14 | 手册文档 vs 服务器 decay 数值 | `docs/manual/{rules,reference,start}` vs `sim/gameplay.go:24-37` | R3 核对**一致** ✅（0.5s 宽限 / 每秒回退 0.5s / 30s 冷却全对） |
| D15 | Uplink lift 比例 0.38 | `render.ts:84` ↔ `art.ts:235` ↔ `art.ts:236`（0.48/0.12 新增） | ✅ R6：`UPLINK_LIFT` 由 `art.ts` 单点导出并供渲染复用 |
| D16 | ASCII 字符方言 | `startup-art.ts:15` `'#%+=*#'`、`startup.ts:49` `'01[]{}+*#'`、`startup-art.ts:19` `'#*+:.'` | R3 从 2 套变 3 套（低危，可读性问题） |
| D17 | HUD 键位摘要 | `index.html:86`（帮助面板）+ `index.html:80`（canvas aria-label）↔ `docs/manual/rules/controls.md` 键位表 | 手抄三处、无对拍（R5 新发现） |

---

## 2. 跨端发现（X-）

### X-1 ✅ Bot Script API 四处平行定义（原 R1-P0.1）— R7 已修
- **R7 结果**：`62d675b` 以 `packages/bot-api/src/index.ts` 为唯一源，生成 Monaco 补全/声明、AI provider prompt 与 Go runtime 合约；`bot_api_drift_test.go` / `script/bot_api_drift_test.go` 防止方法与常量重新分叉。

### X-2 ☐ Snippet 目录双份（原 R1-P0.2）
- proto 已有 `EvSnippetResult.sources` 且 `snippet-panel.ts` 在消费；扩 `SnippetSourceView` 加 `min/max/step/unit/hint` 字段，面板改服务器驱动，`SNIPPET_ROWS` 退化为离线兜底。proto additive，旧客户端安全。

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
- **S-2 ☐ 几何原语 4 包各一份**（原 R1-H2）：segment-AABB ×3（`sim/combat.go:272-289` slab / `snapshot/wallindex.go:155` slab / `nav/nav.go:474-500` Liang-Barsky）；LOS 实质 4 条；point-rect 距离 ×2 逐字符相同（`nav/nav.go:515-519` vs `mapgen/geometry.go:76-86`）；zoneLocked ×3 + view.go:163 内联第 4 份；finite ×5；arena 半径「80−0.6」×2。提案：建 `internal/geom`；**红线：mapgen 刻意零 Sqrt/Hypot 保跨平台确定性（geometry.go:74-77 注释），只合并公式同构部分，配交叉测试**。R2 确认 walls.go 新代码守住了纪律且未加新几何助手。
- **S-3 ☐ 轴/命令五层逐字段样板**（原 R1-H3）：每个轴在 collector/merge/resolve/clone/arbitrate 五层各一段同构代码，散布 8 处（`sim/control.go:118-232,327-344`、`script/collector.go:52-146`、`script/goruntime.go:417-461`、`glue/solo_bots.go:38-55`）。提案：`sim.Axis` 描述表驱动 + `snippetCollector.guarded(axis, set)` 收敛 6 个 setter。-250~300 行；新增轴从「改 10 处」变「改 1 张表」。
- **S-4 ⚠️ stats projector 双 switch**（原 R1-H4）：`projector.go:197-293` applyEvent 与 `:462-543` eventKey 必须成对维护，漏改 eventKey 该事件被静默去重丢弃（:161-163）；`titles.go:79-114` awardMax 双胞胎泛型合并。表驱动或 protojson 生成指纹，-120 行。
- **S-5 ☐ 三个回放驱动循环**（原 R1-H5，R2 复核仍成立）：`sim/replay.go:104-149` / `sim/replay_visual.go:37-79` / `stats/replay.go:37-100` 同一「读→校验→恢复→跳过→逐 tick」骨架；错误文案已分叉（replay.go:113 vs replay_visual.go:46）；stats 的 seq 分配（:56-58,:87-89）镜像 glue `eventSeq`（match.go:225-226）。提案：`sim.ReplayCursor` + 统一 sentinel `ErrReplayMissingStart` + projector 自持序号。-80 行。
- **S-6 ☐ 每帧 AOI 算两遍**（原 R1-H6）：`match.go` step() 中 `runScripts`（:743-750）与快照循环（:584-591）对同一机器人以相同参数各调一次 `BuildObservation`。提案：step 开头构建 `obsByRobot` 共用。-20 行 + 64 机 60Hz 下省一半 LOS 计算（对 12ms 帧预算实质让利）。

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

### 低影响
- **S-16 ✅ x10 定点换算散布 6 处**（原 R1-L1）→ `sim.HPToX10/HPFromX10`。
- **S-17 ✅ `stableRobotID` 手写 FNV-1a**（原 R1-L2）：`match.go:811-818` 改 `fnv.New32a()`（输出一致，属线上身份算法需回归验证）。
- **S-18 ✅ 错误处理不一致**（原 R1 错误处理节）：room/script/ai 有 sentinel，sim 全 `fmt.Errorf` 无 sentinel → 至少为「match 已开始」「非法地图」立 sentinel；亮点保持（log.go sticky error + errors.Join、ai_bridge errors.As/Is）。
- **S-19 ✅ Say 当错误通道**（原 R1-L4 + X-4）：`cmd/omb/main.go` ×3 内联构造系统 Say → glue 导出 `SystemSay(text)`。
- **S-20 ✅ 杂项**：R6 已收敛 `MaxLogLine`；`436f46d` 以 `sortedRobots()` 统一 stats 的机器人排序比较器并增加排序契约测试。
- **S-21 ☐ 测试夹具重复**（原 R1-L7）：script 包 4 套 ScriptFrame 夹具 + `server/tmp/manualcheck` 第 5 套；「写 JSONL 再读回」循环 ×4 → 建 `internal/testutil`。注意：R2 新增的 objectives/mapgen 测试全部复用既有夹具（uplinkSim/stepTicks/recordingSink），零拷贝 ✅。
- **S-22 ☐ 上行消息路由三处维护**（原 R1-L8）：`main.go:395-474` 观战拒绝列表 + 玩家 switch + glue Session 方法 → glue `UpstreamRouter` 注册表。
- **S-23 ☐ main.go 职责混合**（原 R1-L9）：GC 调优 + HTTP 路由 + 关停 + 协议路由 → HTTP 路由抽 `serverapi`，GC 移 `ai`。

---

## 4. 前端发现（C-）

### 高影响
- **C-1 ✅ 观战交互三件套逐字复制**（原 R1-H1）：`10ec947` 新增 `replay/spectate-controls.ts`，Live/Replay 共用 wheel、键盘、指针拖拽、按钮接线与 dispose；调用方保留 Space/重绘差异，440 行契约测试冻结行为。
- **C-2 ⚠️ scripts harness 复用率极低**（原 R1-H3，R3 未加剧、R4/R5 欠账微增但单脚本质量上升）：18 个 .mjs 5,077 行中估计 700-900 行复制粘贴（spawn 服务器 ×9、WS 帧 ×5、Fixture 假服务器 ×2 逐字相同、地图 JSON ×3、静态服务器+MIME ×2、pageerror 样板 ×8、AudioContext Proxy ×2）。建 `scripts/harness.mjs` 分批迁移。-500~800 行，新脚本从「拷 300 行」变「写 30 行断言」。R3：6 个脚本全是就地改断言。R4：aim-guard-check 大幅就地改善（sleep→until 轮询、经真实编辑器 UI 提交 navigateTo、finally 清理）。R5 计数：`data-takeover` 断言 3 文件 7 处（aim-guard :160,:212,:225,:228 / game-feel :498-515 / takeover-live :54 helper）、「编辑器提交脚本」样板 10 份（aim-guard 3 / round2 4 / takeover-live 1 / predictive-shield 1 / game-feel 1）、`until()` 本地副本 11 份；正面样本：game-feel 的 `assertHelpAnchor` 1 份定义 4 处复用、takeover-live 重写为真效果断言（见正面确认）。
- **C-3 ☐ 渲染器脚手架重复 + 分叉扩大**（原 R1-H5，R2/R3 恶化）：game/render.ts vs replay/render.ts——构造函数逐字相同、`resize()` game 有同尺寸短路 replay 没有（拖窗口清屏抖动）、`ROBOT_R`/`FONT_11` 双份、死亡倒计时块重复、drawBubbles 两版；且 game 路径新增 lift/trails/delayedHealth extras，replay 全没有，**分叉在扩大**。提案：art.ts 加 `createCanvas2d/resizeCanvas2d/drawRespawnCountdown` + 常量归一。等 game-feel 波次合入后动。
- **C-4 ✅ cameraZoom 双推进真 bug**（原 R2-B1；R3/R4/R5 三轮确认未修）：`feedback.ts:306-314` 有状态指数平滑（无 per-tick 缓存）被 `controls.ts:411`（drawFrame，rAF）与 `controls.ts:440`（sampleAndSend，60Hz interval）各调一次——两行逐字相同，R4 工作树引入（HEAD 零调用点），R5 的 +4 行未触及。同 tick 第二次调用 elapsed 兜底为 1，每 tick 走两步，收敛速度随刷新率变化（144Hz ≈ 204 步/s）；`camera.ts:30-31` setZoom 钳制 [0.85,1.05] 使误差有界但仍在。R5 新增的缓出方向测试（feedback.test.ts:389-397）全用不同 tick，**未覆盖同 tick 双调用**。附带：该行（含 `!!self?.dashing && !self.dead` 谓词）在两条循环间整行复制，是 C-26 双循环共享可变状态的直接实证。修法 ~3 行：tick 未变返回缓存，或只留 drawFrame 一处调用。
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
- **C-12 ☐ phaseName / 房态文案双份**（原 R1-H2 + M7）：phaseName 合并入 `@omb/protocol`（枚举名映射属协议知识）；`roomStateName(state, ctx?)` 参数化「空闲/等待开场」差异。
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

### 架构建议
- **C-26 ☐ CanvasStage**（原 R1 架构-1）：三处手写 canvas+DPR+rAF 循环（controls.ts / live.ts / replay/player.ts）→ 统一宿主，把「同尺寸短路」「空闲不重绘」变默认。C-4 的 bug 正是双循环耦合的代价；R4 又一笔实证：cameraZoom 调用行（含 dashing 谓词）在 drawFrame 与 sampleAndSend 间逐字复制（controls.ts:411/440）。**等 game-feel 波次合入后做**。
- **C-27 ❌ 事件总线**（原 R1 架构-2）：明确不做——main.ts 消息分发单点且时序敏感（awaitingFull 状态机），总线会掩盖时序。

---

## 5. 死代码清单

| 项 | 位置 | 备注 |
|---|---|---|
| `noteAt()` | `music/render.ts:254-261` | ✅ R6 已删除（`efb8217`） |
| `usingWorker` getter | `music/renderer.ts:45-47` | ✅ R6 已删除（`efb8217`） |
| `RING_MID` | `game/mapdef.ts:31` | ✅ R6 已删除（`efb8217`） |
| `Sim.ProjectileViews/CoreViews/HealthPackViews` | `sim/view.go:96-100` | ✅ R6 已删除三个零调用 getter（`91c354d`） |
| `Sim.View/RobotViews/UplinkViews/Arbitrated/Snapshot` | `sim/view.go:86-113` | 仅 sim 测试；`LineOfSight` 被 objectives.go:260 内部用，应降 unexported |
| `Sim.SetSpawn/Respawn/SetWalls` | `sim/sim.go:238,286` / `collision.go:167` | 生产死；SetWalls 墙校验与 SetMap 的重复（留一删一） |
| `Observation.PartnerID/IsPartner` 链 | `sim/contract.go:154-166` + `stats.SetPartnerMap` + encoder.go:247-248 恒 false | deprecated 兼容层，随旧数据支持到期评估删除 |
| `handleUpstream` 的 `sendLossy` 参数 | `cmd/omb/main.go:472` | `_ = sendLossy` |
| `server/tmp/manualcheck/`、`server/combat.log`、`server/crash.log`、根目录 `omb.exe` | — | 遗留产物，建议清出库 |

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

---

## 8. 追加记录

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
