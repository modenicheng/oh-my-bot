# 代码库可维护性审计（持续更新）

> 目的：集中记录全库（client / server / 跨端）的可维护性发现，供后续**追加**与**逐条修复**。
> 本文件是唯一的审计台账；聊天记录中的旧报告已全部并入此文件。
>
> **如何追加**：在「追加记录」节添加新条目（日期 + HEAD + 变更范围 + 新发现/复核结论），并同步更新对应发现的「状态」与「位置」。
> **如何修复**：修完一条就把状态改为 ✅ 并注明轮次，**不要删除条目**（保留追溯）；发现已过时改 ❌ 并写明原因。
> **行号基准**：Round 5 快照（HEAD `3d7cdbd` + 工作树，44 M + 3 ??）。未在 R5 复核的条目行号仍为之前快照；行号会漂移，修复前先按符号名重新定位。
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

并行工作流提醒：`TODO.md` 条目由并行 agent 持续实现中，修复前先 `git status` 确认目标文件不在变动中；`client/src/{audio,art,camera,controls,feedback,render,startup}.ts` 与 `server/internal/{sim,mapgen}` 长期处于 in-flux。

---

## 1. 漂移对账表（知识被抄多处的现状清单）

> 这是本审计最高价值的输出：同类知识的多份副本已经分叉或必然分叉。修 X 类条目时以此表为总览。

| # | 知识点 | 副本位置 | 状态 |
|---|---|---|---|
| D1 | Bot Script API 表面 | `packages/bot-api/src/index.ts`（单源）↔ `server/internal/ai/provider_prompt.go:37-83`（手抄）↔ `client/src/workbench/bot-completions.ts:19-39`（手抄）↔ `server/internal/script/context.go`（真实现） | **已漂移**：`navigateTo`（context.go:120 已实现、bot-api 已声明）不在补全表（R4：aim-guard-check 已改经真实编辑器 UI 提交 navigateTo 脚本成功——仅编辑器补全缺失，运行时无恙） |
| D2 | 局长/帧节奏常量 | `glue/match.go:31-33`（本地 tickHz/frameDue/matchTicks）↔ `sim/sim.go:25,28,36` | **已矛盾**：`match.go:237` 结算用 `sim.MatchTicks`，`:622,:661` 终局判定用本地 `matchTicks` |
| D3 | 黑客进度满值 ×10=80 | `sim/gameplay.go:27`（HackDuration=480）↔ `render.ts:82` + `feedback.ts:159`（裸写 `/80`）↔ `hud.ts:18`（`HACK_MAX_X10=80` 已命名但未共享） | 三处客户端各写各的 |
| D4 | 核心区半径 | `mapgen/generator.go:33` coreZoneR=28 ↔ `client/src/game/mapdef.ts:30` RING_CORE=30（仅兜底）↔ `capture.ts` 插画文案写 28（反而正确） | 30 vs 28，当前不出错但一用即偏 |
| D5 | 游戏数值常量（视野 20 / 开火耗能 5 / respawn 180t / 血包 30s / SCORE_RULES 25/10/1 / 无敌 4s） | `sim/gameplay.go` 等 ↔ `hud.ts`、`render.ts:9`、`world.ts:78`（4250ms 近似）、`replay/index.ts:88,389,410` | 当前全部同步，但「客户端复算服务器决策」模式本身脆弱 |
| D6 | `join failed:` 前缀字符串协议 | `cmd/omb/main.go:418,487,512` ↔ `net.ts:57-63` ↔ `main.ts:280,292` | 前缀串出现 3 处（net.ts 已有常量但 main.ts 未复用） |
| D7 | AI say 中文前缀 | `glue/ai_bridge.go:86,91,281-304` ↔ `workbench/ai-assist.ts:36` | 当前一致；改措辞即静默破坏面板分流 |
| D8 | Snippet 目录元数据 | `server/internal/snippet/catalog.go:23-50` ↔ `client/src/workbench/snippets.ts:30-108` | 人肉对齐（客户端注释自认「漂移由服务端回执兜底」） |
| D9 | WS 帧字节/心跳 | `packages/protocol/src/messages.ts:9-11` ↔ `netws/handler.go:35-38`（帧）、`ws.ts:13-16` ↔ `handler.go:131,156`（心跳） | 靠注释互指；golden 测试已部分钉住 |
| D10 | axis_mask 位常量 | proto 注释 ↔ `sim/contract.go:212-217` ↔ `input.ts:15-18` ↔ `axis-src.ts:30`（魔法位 `& 2`） | R3 收敛到 3 份后 R5 **回退**：axis-src.ts:30 手抄 `& 2`（`input.ts:14` 有可 import 的 `AXIS_AIM`）→ 见 X-10 ⚠️ |
| D11 | 颜色字面量 | `art.ts` ink 调色板（规范处）vs 十余处散写 | **R3 恶化**：见 C-11 |
| D12 | 回放 NDJSON `visual` 紧凑数组 | `cmd/omb/replay_visual.go:68-71`（按下标写）↔ `replay/model.ts:269-296`（按下标读） | 无 schema、客户端不校验 schema_version 值，插位即全错 |
| D13 | phaseName / 房态文案 | `render.ts:41-47` vs `replay/index.ts:491-496`；`lobby.ts:117`「空闲」vs `live.ts:235`「等待开场」 | 双实现 + 语义未确认是否刻意 |
| D14 | 手册文档 vs 服务器 decay 数值 | `docs/manual/{rules,reference,start}` vs `sim/gameplay.go:24-37` | R3 核对**一致** ✅（0.5s 宽限 / 每秒回退 0.5s / 30s 冷却全对） |
| D15 | Uplink lift 比例 0.38 | `render.ts:84` ↔ `art.ts:235` ↔ `art.ts:236`（0.48/0.12 新增） | R3 从 2 处恶化到 3 处，阴影贴地依赖三处严格相等 |
| D16 | ASCII 字符方言 | `startup-art.ts:15` `'#%+=*#'`、`startup.ts:49` `'01[]{}+*#'`、`startup-art.ts:19` `'#*+:.'` | R3 从 2 套变 3 套（低危，可读性问题） |
| D17 | HUD 键位摘要 | `index.html:86`（帮助面板）+ `index.html:80`（canvas aria-label）↔ `docs/manual/rules/controls.md` 键位表 | 手抄三处、无对拍（R5 新发现） |

---

## 2. 跨端发现（X-）

### X-1 ☐ Bot Script API 四处平行定义（原 R1-P0.1）— 最高优先
- **证据**：`bot-api/src/index.ts:5-106`（TS 单源，编辑器经 `editor.ts:18` 以 `?raw` 注入 Monaco，做法正确）↔ `provider_prompt.go:37-83`（手抄成 Go 字符串喂 AI）↔ `bot-completions.ts:19-39`（手抄方法+数值表，已漏 `navigateTo`）↔ `script/context.go:63-207`（真实现）。
- **提案**：短期给补全表加对拍单测（diff `index.ts` 方法集合 vs 补全清单）；中期 `go:embed packages/bot-api/src/index.ts` 供 AI prompt（仓库已有 embed 手册先例，`cmd/omb/main.go:42`）；长期以 bot-api 为 IDL。
- **收益**：消除已实际发生的漂移；AI 助手不再给错 API。

### X-2 ☐ Snippet 目录双份（原 R1-P0.2）
- proto 已有 `EvSnippetResult.sources` 且 `snippet-panel.ts` 在消费；扩 `SnippetSourceView` 加 `min/max/step/unit/hint` 字段，面板改服务器驱动，`SNIPPET_ROWS` 退化为离线兜底。proto additive，旧客户端安全。

### X-3 ☐ 游戏数值：协议下发取代客户端复算（原 R1-P0.3 + R2）
- 提案：`EvMatchStart`/bootstrap 捎带 `SimTuning`；回放直接消费事件流已有的 `EvMatchEnd.scores`（`SCORE_RULES` 仅旧录像兜底）；`world.ts:78` 无敌 4250ms 改消费 wire 字段。另见 D3（`/80` 应引用 `hud.ts` 已有的 `HACK_MAX_X10`）。

### X-4 ☐ 字符串协议（join failed / AI 前缀）（原 R1-P0.4 + R3 复核）
- 短期：前缀常量提入 `packages/protocol`，双侧 golden 对拍；main.ts 复用 `net.ts` 已导出的 `isJoinFailed`/`JOIN_FAILED_PREFIX`（省 4 行 + 2 个魔法串）。
- 正解：proto 加 `controlNotice{code,text}` 结构化事件，`EvSay(robot=0)` 兼容一版。另见 S-19（say 当错误通道）。

### X-5 ☐ WS 帧/心跳常量 + 孤儿 `PROTOCOL_VERSION`（原 R1-P1.5）
- `messages.ts:7` `PROTOCOL_VERSION=1` 在 Go 侧无对应物：要么删，要么真正进握手。帧字节/间隔入 proto 注释并扩展 golden 测试覆盖 0x02/0x03。

### X-6 ☐ 回放 NDJSON 无版本校验（原 R1-P1.6）
- 最低成本：`visual` 行加 `v:2`；客户端校验 `schema_version` 并对未知版本显式报错（现在只判断「是数字就跳过头行」，`model.ts:131`）。中期：ReplayRecord proto 化。注意服务器当前 `SchemaVersion` 仍 =1（`log.go:21`）。

### X-7 ☐ MapDef/RING_CORE 30 vs 28（原 R1-P1.7 + R2 复核）
- 删除 `mapdef.ts:30` 的 `RING_CORE` 兜底或改 28 并注明来源；`capture.ts` 的 mapgen 骨架插画（28m/45°/13×13 等）会随 GeneratorVer 过期，长期改由真实 `mapgen.Generate(seed)` 产物渲染。客户端不消费 `GeneratorVersion` 字段——若未来按 Gen 分支渲染（如 L 形掩体）这是盲区。

### X-8 ❌ Manual frontmatter 双实现（原 R1-P1.8）
- 复核结论：语义已被两侧单测冻结，客户端副本仅作 MOCK 兜底，**维持现状 + 可选加跨语言 fixture 测试**，不值得动。

### X-9 ☐ LOS 双实现语义差异 + 客户端雾不遮锁区（原 R1-P2.9）
- 语义差异属显示层有意选择（客户端返回墙面远沿供阴影），不必共享代码。**真实缺口**：`render.ts:153` `drawVisionMask` 只投墙影，不遮 4:00 前的未解锁核心区——服务器会裁剪区内实体所以不泄密，但雾效会「照亮」本应全黑的锁区，与弹丸撞锁区消失（`combat.go:169-176`）体验不一致。改一处 render 即可。

### X-10 ⚠️ axis_mask 副本收敛后又回退（R3 ✅ → R5 ⚠️）
- R3：commit `3d7cdbd` 的 hud.ts 重构删除了第 4 份位常量副本，`axis-src.ts` 用 `ControlSource` 枚举投影、不引入位常量。
- R5：`axis-src.ts:30` 的 `aimControlStatus` 出现魔法位 `(self.manualAxesMask ?? 0) & 2`（语义=AXIS_AIM），位知识回到 4 份；`input.ts:14` 已有可 import 的 `AXIS_AIM = 1 << 1`。改 import 即收敛。

---

## 3. 后端发现（S-）

### 高影响
- **S-1 ☐ 节奏常量双源**（原 R1-H1，R2 复核行号未变）：`glue/match.go:31-33` 删本地 `tickHz/frameDue/matchTicks`，改引 `sim.TickRate/FrameBudget/MatchTicks`；`match.go:622,:661` 终局判定统一 `m.tick >= sim.MatchTicks`；`scoreboardEveryTicks`（:685）绑 `sim.TickRate`。~10 行，消除「改局长 glue 不知道」。
- **S-2 ☐ 几何原语 4 包各一份**（原 R1-H2）：segment-AABB ×3（`sim/combat.go:272-289` slab / `snapshot/wallindex.go:155` slab / `nav/nav.go:474-500` Liang-Barsky）；LOS 实质 4 条；point-rect 距离 ×2 逐字符相同（`nav/nav.go:515-519` vs `mapgen/geometry.go:76-86`）；zoneLocked ×3 + view.go:163 内联第 4 份；finite ×5；arena 半径「80−0.6」×2。提案：建 `internal/geom`；**红线：mapgen 刻意零 Sqrt/Hypot 保跨平台确定性（geometry.go:74-77 注释），只合并公式同构部分，配交叉测试**。R2 确认 walls.go 新代码守住了纪律且未加新几何助手。
- **S-3 ☐ 轴/命令五层逐字段样板**（原 R1-H3）：每个轴在 collector/merge/resolve/clone/arbitrate 五层各一段同构代码，散布 8 处（`sim/control.go:118-232,327-344`、`script/collector.go:52-146`、`script/goruntime.go:417-461`、`glue/solo_bots.go:38-55`）。提案：`sim.Axis` 描述表驱动 + `snippetCollector.guarded(axis, set)` 收敛 6 个 setter。-250~300 行；新增轴从「改 10 处」变「改 1 张表」。
- **S-4 ☐ stats projector 双 switch**（原 R1-H4）：`projector.go:197-293` applyEvent 与 `:462-543` eventKey 必须成对维护，漏改 eventKey 该事件被静默去重丢弃（:161-163）；`titles.go:79-114` awardMax 双胞胎泛型合并。表驱动或 protojson 生成指纹，-120 行。
- **S-5 ☐ 三个回放驱动循环**（原 R1-H5，R2 复核仍成立）：`sim/replay.go:104-149` / `sim/replay_visual.go:37-79` / `stats/replay.go:37-100` 同一「读→校验→恢复→跳过→逐 tick」骨架；错误文案已分叉（replay.go:113 vs replay_visual.go:46）；stats 的 seq 分配（:56-58,:87-89）镜像 glue `eventSeq`（match.go:225-226）。提案：`sim.ReplayCursor` + 统一 sentinel `ErrReplayMissingStart` + projector 自持序号。-80 行。
- **S-6 ☐ 每帧 AOI 算两遍**（原 R1-H6）：`match.go` step() 中 `runScripts`（:743-750）与快照循环（:584-591）对同一机器人以相同参数各调一次 `BuildObservation`。提案：step 开头构建 `obsByRobot` 共用。-20 行 + 64 机 60Hz 下省一半 LOS 计算（对 12ms 帧预算实质让利）。

### 中影响
- **S-7 ☐ `snapshot.World{...}` 字面量 ×5**（原 R1-H7）：match.go ×4 + ai_bridge.go:121-124 → 加 `WorldOf(wv sim.WorldView)` 转换。-35 行。
- **S-8 ☐ match.go（818 行）拆分**（原 R1-M1）：装配 / sink 链 / 运行循环 / 观战状态机 / 结算 / 脚本执行 6 种职责 → 拆 5 个文件，每个 ≤300 行。
- **S-9 ☐ sink 链未持有**（原 R1-M2）：Match 增加 `sink` 字段，`ai_bridge.go:362-367` emitNonSimEvent 改调它，消除双路由。
- **S-10 ☐ room.HostCommand 三 case 同构**（原 R1-M3）：`room.go:339-372 / 374-417 / 431-463` 共 ~60 行 8 步重复 → 抽 `prepareLaunchLocked + doLaunch`。-40 行。
- **S-11 ☐ runtime 装配五胞胎**（原 R1-M4）：「取或建 + 注册」×5 → `RunPool.Ensure(id)`；删 `m.runtimes` map（与 scriptPool 双份记录）。-40 行。
- **S-12 ☐ Observation 三份序列化器 + phase 映射三份**（原 R1-M5）：`script/observation.go`（JS）/ `ai_bridge.go:129-219`（AI JSON，DTO 藏函数体内）/ `snapshot/encoder.go:234-301`（proto）。phase 字符串映射三处（ai_bridge.go:171-174 / collector.go:203-210 / encoder.go:227-232）→ 单一函数。AI DTO 提为包级类型。-50 行。
- **S-13 ☐ `WorldView.Observe` 第二套 AOI**（原 R1-M6）：`view.go:173-199` 仅测试用且语义已微差（LineOfSight 不含 arena 边界）→ 删或薄壳化，连带评估 `Observation.PartnerID/IsPartner` 链（见死代码）。
- **S-14 ☐ sim 事件发射样板**（原 R1-M7，R2 复核 15 处未增）：`s.events = append(...)` ×15（combat×7 / sim×4 / objectives×3 / control×1）+ `index[id]`/`ended` 守卫 ×7-8 → `s.emit(kind)` + `robotForWrite(id)`。**下一批事件改动前做掉最便宜**（R2 新增 decay 未加事件，暂未增重）。-40 行。
- **S-15 ☐ sim 双 Phase 类型**（原 R1-M8）：`Sim.phase` 存 `ombv1.Phase` 又到处转回 `sim.Phase`（5+ 处转换）→ 内部存 `sim.Phase`，仅 emit/publish 转 proto。
- **S-24 🔵 uplink decay 机制复查（R2/R3）**：实现干净（无复制状态机、三个重置点统一清 `DecayAt`、SimulationVersion 3 门用法正确、checkpoint 往返有测试）。遗留三点：① **decay 无任何事件**——「中断清零」与「缓慢衰减」在事件流不可区分，回放也不渲染 uplink 进度（`model.ts:234-241` 忽略 `progress_ticks`）；若产品要「进度流失」反馈需加事件 kind 或 proto stall 标记；② **busy 横跳绕过**（`objectives.go:200`）：机器人因 busy 仲裁被清也进保留分支，可在两桩间逐 tick 交替躲衰减（非正确性 bug，削弱资源压力语义）；③ `replay.go:80` 校验 `DecayAt < cp.Tick` 允许等于，意图差一格，改 `<=` 或注释。新常量（Grace 30t / Interval 60t / Progress 30t）无重复、无客户端对应 ✅。

### 低影响
- **S-16 ☐ x10 定点换算散布 6 处**（原 R1-L1）→ `sim.HPToX10/HPFromX10`。
- **S-17 ☐ `stableRobotID` 手写 FNV-1a**（原 R1-L2）：`match.go:811-818` 改 `fnv.New32a()`（输出一致，属线上身份算法需回归验证）。
- **S-18 ☐ 错误处理不一致**（原 R1 错误处理节）：room/script/ai 有 sentinel，sim 全 `fmt.Errorf` 无 sentinel → 至少为「match 已开始」「非法地图」立 sentinel；亮点保持（log.go sticky error + errors.Join、ai_bridge errors.As/Is）。
- **S-19 ☐ Say 当错误通道**（原 R1-L4 + X-4）：`cmd/omb/main.go` ×3 内联构造系统 Say → glue 导出 `SystemSay(text)`。
- **S-20 ☐ 杂项**：排序比较器 ×2（projector.go:448 / room.go:516）；`maxLogLine` 16MB 魔数复制到 `cmd/omb/replay_visual.go:37` → sim 导出。
- **S-21 ☐ 测试夹具重复**（原 R1-L7）：script 包 4 套 ScriptFrame 夹具 + `server/tmp/manualcheck` 第 5 套；「写 JSONL 再读回」循环 ×4 → 建 `internal/testutil`。注意：R2 新增的 objectives/mapgen 测试全部复用既有夹具（uplinkSim/stepTicks/recordingSink），零拷贝 ✅。
- **S-22 ☐ 上行消息路由三处维护**（原 R1-L8）：`main.go:395-474` 观战拒绝列表 + 玩家 switch + glue Session 方法 → glue `UpstreamRouter` 注册表。
- **S-23 ☐ main.go 职责混合**（原 R1-L9）：GC 调优 + HTTP 路由 + 关停 + 协议路由 → HTTP 路由抽 `serverapi`，GC 移 `ai`。

---

## 4. 前端发现（C-）

### 高影响
- **C-1 ☐ 观战交互三件套逐字复制**（原 R1-H1）：`live.ts:277-344` vs `replay/player.ts:187-253`——滚轮缩放、键盘导航、指针拖拽、按钮接线，`1.25/0.8` 步进各出现 4 次。抽 `game/spectate-controls.ts`（`bindArenaControls({canvas, camera, invalidate, onExit, enabled}) → dispose`）。-110 行，前端性价比最高单点。
- **C-2 ☐ scripts harness 复用率极低**（原 R1-H3，R3 未加剧、R4/R5 欠账微增但单脚本质量上升）：18 个 .mjs 5,077 行中估计 700-900 行复制粘贴（spawn 服务器 ×9、WS 帧 ×5、Fixture 假服务器 ×2 逐字相同、地图 JSON ×3、静态服务器+MIME ×2、pageerror 样板 ×8、AudioContext Proxy ×2）。建 `scripts/harness.mjs` 分批迁移。-500~800 行，新脚本从「拷 300 行」变「写 30 行断言」。R3：6 个脚本全是就地改断言。R4：aim-guard-check 大幅就地改善（sleep→until 轮询、经真实编辑器 UI 提交 navigateTo、finally 清理）。R5 计数：`data-takeover` 断言 3 文件 7 处（aim-guard :160,:212,:225,:228 / game-feel :498-515 / takeover-live :54 helper）、「编辑器提交脚本」样板 10 份（aim-guard 3 / round2 4 / takeover-live 1 / predictive-shield 1 / game-feel 1）、`until()` 本地副本 11 份；正面样本：game-feel 的 `assertHelpAnchor` 1 份定义 4 处复用、takeover-live 重写为真效果断言（见正面确认）。
- **C-3 ☐ 渲染器脚手架重复 + 分叉扩大**（原 R1-H5，R2/R3 恶化）：game/render.ts vs replay/render.ts——构造函数逐字相同、`resize()` game 有同尺寸短路 replay 没有（拖窗口清屏抖动）、`ROBOT_R`/`FONT_11` 双份、死亡倒计时块重复、drawBubbles 两版；且 game 路径新增 lift/trails/delayedHealth extras，replay 全没有，**分叉在扩大**。提案：art.ts 加 `createCanvas2d/resizeCanvas2d/drawRespawnCountdown` + 常量归一。等 game-feel 波次合入后动。
- **C-4 ☐ cameraZoom 双推进真 bug**（原 R2-B1；R3/R4/R5 三轮确认未修）：`feedback.ts:306-314` 有状态指数平滑（无 per-tick 缓存）被 `controls.ts:411`（drawFrame，rAF）与 `controls.ts:440`（sampleAndSend，60Hz interval）各调一次——两行逐字相同，R4 工作树引入（HEAD 零调用点），R5 的 +4 行未触及。同 tick 第二次调用 elapsed 兜底为 1，每 tick 走两步，收敛速度随刷新率变化（144Hz ≈ 204 步/s）；`camera.ts:30-31` setZoom 钳制 [0.85,1.05] 使误差有界但仍在。R5 新增的缓出方向测试（feedback.test.ts:389-397）全用不同 tick，**未覆盖同 tick 双调用**。附带：该行（含 `!!self?.dashing && !self.dead` 谓词）在两条循环间整行复制，是 C-26 双循环共享可变状态的直接实证。修法 ~3 行：tick 未变返回缓存，或只留 drawFrame 一处调用。
- **C-5 ☐ Go 大写 Vec2/num 解析三份**（原 R1-H4）：`mapdef.ts:39-52` / `replay/model.ts:309-316` / `replay/index.ts:478-489`（+health-check.mjs 内联第 4 份）→ `lib/gojson.ts`。-40 行。

### 中影响
- **C-6 ☐ setText/setTxt ×3 + fmtClock ×3**（原 R1-M1，R3 复核 hud 重构未合并）：`live.ts:17` / `replay/player.ts:528` / `hud.ts:413`；fmtClock `player.ts:537` + live.ts:140 + hud.ts:149 内联。→ `ui/dom.ts`。
- **C-7 ☐ workbench 分隔条拖拽两份**（原 R1-M2）：`workbench.ts:420-478` vs `script-console.ts:359-399` → `ui/resizable.ts`。-70 行。
- **C-8 ☐ 三面板 pending/掉线文案/可用性门/防抖落盘**（原 R1-M3）：`workbench.ts` / `snippet-panel.ts` / `ai-panel.ts` → `panel-common.ts`（PendingTracker/DebouncedPersist/Availability）。-90 行。
- **C-9 ☐ editor 双补全 provider 逐字相同**（原 R1-M4）：`editor.ts:200-243` 两个 22 行一致块 → for 循环注册。-22 行。
- **C-10 ☐ `$(id)` helper 四种写法**（原 R1-M5）：main.ts:28 / lobby.ts:6 / auxiliary-views.ts:6 + live/workbench/hud 变体 → 并入 `ui/dom.ts`。-30 行。
- **C-11 ☐ 颜色/字体字面量扩散（R2 发现、R3 恶化一倍、R4 复核行号微漂）**：
  - `'#22d3ee'` 系 11+ 处（art.ts ink.cyan 是规范处）；
  - `'#a5e6ef'` 三文件：`feedback.ts:389`（新）+ `startup.ts:70`（新）+ `startup.css:28-29`；
  - `'#f4fbff'`：`feedback.ts:15` 已常量 vs `art.ts:184,246,286`（286 新）；
  - **`hud.css` amber 系硬编码 7 处：`#fbbf24`×5（:73-77）+ `#a68b4b`（:79）+ `#d1b46b`（:80，R5 standby 轨新增）vs `app.css:13` 已有 `--amber` token**；R5 app.css 又复制 3 个调色板字面量（#416779/#1c3340/#122733）；
  - 伤害阴影 `'#071019'`（feedback.ts:409）vs ink.bg 近似色；
  - 字体旁路 ×2：`feedback.ts:402` `'14px ui-monospace'` 绕过 `art.ts:9` mono；`startup.ts:60` 重写 Fusion Pixel 串（startup 不能 import art.ts 属合理，但应提本地 const 或 tokens 文件）。
  - 提案：ink 补 `white/glow`，CSS 用 var(--amber)，伤害飘字接 art.mono。
- **C-12 ☐ phaseName / 房态文案双份**（原 R1-H2 + M7）：phaseName 合并入 `@omb/protocol`（枚举名映射属协议知识）；`roomStateName(state, ctx?)` 参数化「空闲/等待开场」差异。
- **C-13 ☐ music Worker 消息类型双份**（原 R1-M8）：`renderer.ts:9-19` vs `render.worker.ts:10-20` → `render-protocol.ts`。
- **C-14 ☐ escapeHtml ×3**（原 R1-M9）：`manual/render.ts:23` / `replay/library.ts:141` / `ai-markdown.ts:32`（+ai-panel.ts 内联）→ 合并 manual/replay 侧；ai-markdown 是独立懒加载 chunk 可保留。
- **C-15 ☐ math 微函数**（原 R1-L1）：clamp（music/music.ts:35 export vs camera.ts:56 私有）、clamp01（hud.ts:419）、lerp/lerpAngle（replay/index.ts:356）→ `lib/math.ts`。
- **C-16 ☐ 测试脚手架**（原 R1-L3；R3 恶化 4 份、R5 回落 3 份）：`Target extends EventTarget` 双份（input.test.ts:5 / takeover.test.ts:5-9）；**feedback.test.ts 的 stub 三连（clearAllMocks+matchMedia+document）现 3 份**（:42-45、:354-357、:415-418；R5 把两个 describe 合并为共享一份）→ `stubFeedbackEnv()` + `test-targets.ts`。-18 行。
- **C-17 ☐ feedback.ts 单类 11 职责**（原 R2-B6/B8 + R3-A2）：现 520+ 行；未命名魔法数批量存在——飘字寿命 `850` 裸写两处（:356,:404，与 DAMAGE_HOLD_MS/DAMAGE_FADE_MS 互不相干）→ `DAMAGE_POPUP_MS`；连击窗口 520/上限 6/步进 0.07；zoom 目标 0.92/混合 0.64,0.78；slam 曲线 -8/4.5/10/4；低血闪 180/240、噪声质数 997/101。draw() 内 splash 照抄 impact 骨架、`reduced.matches` 守卫散布 7 处 → `Record<EffectKind, DrawFn>` 注册表 + motionScale getter。拆 `game/feedback/`（effects/vitals/trails/camera-feel），-60~90 行。**红线：`delayedHealth` 是带回写 getter 且被新测试冻结（「连续受击白条保持」），勿改纯函数**。
- **C-18 ☐ hash2d/imul 哈希三份**（R3-A2；R4 计数不变、行号微漂）：`startup-art.ts:22` / `startup.ts:41` / `feedback.ts:424-425`（双轮变体），mix 步骤略有差异 → 共享 `hash2d(x,y,seed)`。-10~12 行。
- **C-19 ☐ startup 侵蚀（R2-B7 已修 ✅、R3 新增三项、R4 部分测试覆盖）**：JS/CSS 计时耦合已消除（单时钟 EROSION_MS=900 + rAF）✅；遗留：字符方言三套（D16）、erodeText/erodeScreen 魔法数（0.58/0.3/cell=24/0.15+dist*0.52+hash*0.17/0.12）→ 常量块；`startup.ts:56` querySelector 非空断言建议降级可选。R4：`erodeText` 已被 startup-art.test.ts:6-21 冻结（单调性/行宽/progress 0 与 1）；`erodeScreen`（startup.ts:26，canvas tile）仍无测试。
- **C-20 ☐ HUD 多轨接管标记（R3 发现，R4 未修，R5 恶化 2 轨→3 轨）**：`hud.css` 三套选择器并存——`[data-takeover='script']`（:73-75）、`[data-state='takeover']`（:76-77，微光只在此轨）、`[data-state='standby']`（:78-80，R5 新增）；`hud.ts:369-370/375-376` move/aim 卡双写两套属性（aim 的 standby 语义本身合理，但实现走两条轨）；uplink 卡 R5 起也加入 setTakeover（共 5 卡）。统一为 `data-takeover` 轨 + 独立 standby 语义位，微光移入 `.skill-icon`，颜色 `var(--amber)`。-8~10 行。
- **C-21 ☐ lift 0.38 三处**（D15/R3-A3，R4 复核仍成立）：`render.ts:84` + `art.ts:235`（`lift*0.38`）+ `art.ts:236`（`0.48 - lift*0.12`）→ art.ts export `UPLINK_LIFT`。
- **C-22 ☐ join-failed 判定分裂**（原 R1-L5）：并入 X-4 短期项（net.ts 导出复用）。
- **C-23 ☐ 三段会话拆除八连**（原 R1 架构-2，R3 复核未动）：`main.ts:185-192 / 281-294 / 372-396` 重复 `stopRttLoop/close/exit/resetMatch/syncWorkbench` 八步 → `teardownSession({keepIdentity})`。-18~24 行。
- **C-24 ☐ hud updateTakeover/updateSkills 重复推导**（R3-A7）：self/dead 推导 ×2 → 传参。-2 行（次要，顺手）。
- **C-25 ☐ help-toggle escape/leave 语义不可区分**（R3-A5，R5 复核仍成立）：`help-toggle.ts:10` 两 action 同返回 false → 合并 `'close'` 或给 leave 附加语义。
- **C-28 ☐ aim 归属判定的客户端双投影**（R5 新发现）：`axis-src.ts:28-32` `aimControlStatus`（HUD 文案用，谓词含魔法位 `& 2`）与 `controls.ts:316-323` `syncAimGuard`（实际 guard，谓词含 `holdsAim()`）是同一「aim 是否归脚本」问题的两份不同源实现；check 脚本只钉住文案、未钉两者行为一致性。提案：axis-src 导出单一 `isAimUnderScript(aimCapable, holdsAim)` 供两处复用（顺带修 D10 的 import）。

### 架构建议
- **C-26 ☐ CanvasStage**（原 R1 架构-1）：三处手写 canvas+DPR+rAF 循环（controls.ts / live.ts / replay/player.ts）→ 统一宿主，把「同尺寸短路」「空闲不重绘」变默认。C-4 的 bug 正是双循环耦合的代价；R4 又一笔实证：cameraZoom 调用行（含 dashing 谓词）在 drawFrame 与 sampleAndSend 间逐字复制（controls.ts:411/440）。**等 game-feel 波次合入后做**。
- **C-27 ❌ 事件总线**（原 R1 架构-2）：明确不做——main.ts 消息分发单点且时序敏感（awaitingFull 状态机），总线会掩盖时序。

---

## 5. 死代码清单

| 项 | 位置 | 备注 |
|---|---|---|
| `noteAt()` | `music/render.ts:254-261` | 无调用方；可能为计划中琴卷 UI 预留，删前确认 |
| `usingWorker` getter | `music/renderer.ts:45-47` | 无读取者 |
| `RING_MID` | `game/mapdef.ts:31` | 无引用（RING_CORE/RING_OUTER 有内部使用） |
| `Sim.ProjectileViews/CoreViews/HealthPackViews` | `sim/view.go:96-100` | 全仓零调用 |
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

## 7. 建议落地顺序

1. **立即（≤5 行/条，多为顺手修）**：C-4 cameraZoom bug（R5 三度确认未修，调用点 controls.ts:411/440）· X-10/D10 回退修复（axis-src.ts:30 改 import `AXIS_AIM`）· C-11 字体旁路×2 + hud.css 用 `var(--amber)` · C-21 `UPLINK_LIFT` 导出 · D3 `/80` 引用 `HACK_MAX_X10` · C-17 `DAMAGE_POPUP_MS` · S-24③ `DecayAt <=` · 死代码 3 处（客户端）。
2. **零风险快赢**：`ui/dom.ts` + `lib/`（C-6/C-10/C-14/C-15/C-5 地基）· C-18 hash2d · 颜色收敛 ink（C-11 全量）· C-20 HUD 双轨统一 · X-4 短期（前缀常量 + main.ts 复用 isJoinFailed）· S-1 glue 引 sim 常量 · X-1 短期（补全表对拍单测）· S-17/S-20。
3. **高收益去重**：C-1 spectate-controls（-110）· C-2 harness.mjs（分批，-500~800）· S-2 internal/geom + 交叉测试 · S-3 轴表驱动（-250~300）· S-4 projector 表驱动 · S-10/S-11/S-14 · C-8 面板公共件 · C-17 feedback 拆分。
4. **需产品拍板**：S-24① decay 可观测性（事件 kind / proto stall / 回放补 progress_ticks 渲染）· S-24② busy 横跳是否处理 · C-12 房态文案差异是否刻意。
5. **协议演进（additive 平滑）**：X-2 SnippetSourceView 扩字段 · X-3 SimTuning 下发 + 回放消费 EvMatchEnd.scores · X-4 controlNotice · X-6 回放版本校验 · X-5 帧常量/golden 扩展。
6. **结构性（等 game-feel 波次合入）**：C-26 CanvasStage · S-8 match.go 拆分 + S-6 单次 AOI · S-5 ReplayCursor · S-22/S-23。

**总量估计**：全部落地净删 ~2000+ 行生产代码 + ~200 行测试代码，消除 D1-D17 全部漂移面。

---

## 8. 追加记录

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
