# Round 2 实现计划（v2 — 按 2026-09-29 astra 审核重写）

> 审核报告：docs/design/reviews/（plan-auditor 会话）；9 阻塞项全部吸收。
> 结构改为四相：A 契约冻结（主线） → B 六包并行 → C 客户端+视觉验证 → D 集成验收。
> 模型分配：astra=最难（T1+调度契约复核）、glm-5.3=有难度（T0/T2/T3/T5/T4）、glm-5.3-flash=常规静态件。

## Phase A：契约冻结（主线亲自实现，唯一公共提交，B 相开工的前置）

### A1 proto 修订（主线唯一修改者）
- `ClientInput` 增 `axis_mask`（bit0 move / bit1 aim / bit2 fire / bit3 ability）：本帧实际操作过的轴才置位——**解决"fire=false 抢轴"问题**；仲裁器只认 mask 内的轴。
- 新增 `EvMapBootstrap { map_json, map_hash, generator_version }`（可靠通道，开赛时一次）：服务器序列化 MapDef 下发，客户端不自己生成地图（跨语言同算法风险，审核阻塞项 2）。
- 新增 `ClientMsg.ResyncRequest`；`SnapshotDelta` 增 `base_tick`（本 delta 基于的上一快照 tick）。
- `EvScriptResult` 增 `script_rev`；新增 `EvAiUsage { robot, rounds_delta, tokens_delta, global_left_k }`（配额事实，审核阻塞项 7/8）。
- 修误：`my_cooldown_s` 确认在 `UplinkState`（v1 文档笔误已在 proto 正确）。

### A2 netws 双通道（主线）
- 可靠通道（事件/tombstone/MatchEnd/ScriptResult/MapBootstrap/重同步全量）：队列满改为**断开连接**（丢任何一条都破坏状态一致性）。
- 不可靠通道（delta 快照）：可丢，客户端靠 `base_tick` 检测缺口 → 发 ResyncRequest → 服务器回全量 full 快照。

### A3 契约包 `server/internal/sim/`（扩展公共 API，主线编写、astra 复核）
```go
// 地图（T0 产、T1/T3/T4 消费）——墙为 AABB 实心矩形（对齐现有 collision.go）
type MapDef struct {
    Version, GeneratorVer int; Seed uint64; MapHash string
    Walls []Wall                    // {ID, Min, Max} 米制，统一碰撞/遮挡/绘制三用
    Sectors [8]Sector               // {ID, SpawnArea Rect, Center}
    Uplinks []UplinkDef             // {ID, Pos, Main bool, InteractR, ActivePhase}
    CorePads []CorePadDef           // {ID, Pos, Group, Value}
    CoreZone struct{ Radius float64; UnlockPhase Phase }  // 锁区：unlock 前挡移动+弹丸+视线
    CoreRules struct{ PeriodTicks int; GroupWeights map[Phase][]float64 } // 刷新规则唯一 owner
}
// 帧视图（T1 产、T2/T3 消费）——每 tick 一次、不可变、观察者绑定
type FrameView struct { Tick uint32; Phase Phase; TimeLeftS uint32; Map *MapDef }
type RobotView struct{ ID uint32; Pos, Vel Vec2; Turret float64; HP, Energy int32 /*×10*/;
    Shield, Dashing, Dead bool; RespawnInS uint32; Nick, Color string; InvulnS uint32 }
type ProjView struct{ ID, Owner uint32; Pos Vec2; Heading float64 }
type CoreView struct{ ID uint32; Pos Vec2; Value int32; Alive bool }
type UplinkView struct{ ID uint32; Pos Vec2; Main, Active bool; HackingID uint32;
    ProgressS float64; PersonalCDs map[uint32]uint32 } // 观察者取自身
// T3 产出裁剪后的 Observation（AOI+墙+Partner 豁免+Core/Uplink 全量），T2 只吃它
type Observation struct { FrameView; Robots []RobotView /*AOI 裁剪后+isPartner 标记*/;
    Cores []CoreView; Uplinks []UplinkView; Projs []ProjView }
// 脚本命令通道（扩展 sim.Input，解决 say/pulseScan 表达缺失）
type ScriptCommands struct { Move *Vec2; Aim *float64; Fire, Dash, Shield, Interact *bool;
    Say *string; PulseScan bool } // 指针=本 tick 脚本操作过该轴（与 axis_mask 同构）
// 仲裁结果：idle 只清脚本轴，不碰人类轴（阻塞项 4 陷阱）
```
- 帧时序唯一 owner = `Sim.Tick()`：input → FrameView 构建 → T3 Observation → 脚本池（deadline 12ms 内）→ 仲裁 → 物理 → 事件 → 快照。脚本接口沿用现有 `Run(ctx, ScriptFrame) (Input, error)`，`ScriptFrame` 携带 Observation。
- ID 映射：`uint64 playerID ↔ uint32 robotID` 由主线 glue 层持有映射表（含昵称/颜色/搭档注入）。

### A4 冻结服务接口（主线）
- `QuotaService`：房间作用域生命周期（Warmup 起、Restart 重置、跨局不保留）；`TryAcquire(player) (lease, err)`（单玩家串行+全局并发 20+2M 护栏）；usage 事件化（EvAiUsage）；AI 迟到结果对局归属=lease 签发局。
- `StatsProjector`：消费 EventSink，维护实时比分+P0 称号投影，`FinalScores()`（幂等，每局一次）喂 `room.AddMatchResult`。
- 脚本版本规则：`script_rev` 单调；AI 返回时 rev 已被手动提交超越 → 丢弃并通知。

### A5 Phase A 验收
- proto+双语言生成绿；契约包编译+文档注释齐全；astra 复核报告通过（迭代至无阻塞）。

## Phase B：六包并行（对 A 契约编程，目录互斥）

| 任务 | 包 | 模型 | 要点（增量于 v1） |
|---|---|---|---|
| T0 mapgen | `internal/mapgen/` | glm-5.3 | 产 MapDef；**墙 AABB**；测试加：出生点合法、通道可达（BFS）、锁区前后连通性；八辐骨架 45° 对称（**Uplink 集合不要求**，审核建议 3） |
| T1 gameplay | `internal/sim/`（独占） | **astra** | 消费 MapDef 全量；四轴仲裁器（axis_mask）；弹丸/伤害/助攻/复活三无敌规则/Uplink 8s+30s 个人 CD/Core 刷新（CoreRules）/能量/say/pulseScan；搭档免伤+软碰撞显式实现；**不做投影** |
| T2 script | `internal/script/` | glm-5.3 | goja 按 A3 契约（Run/ScriptFrame/ScriptCommands）；配额 10ms interrupt→只清脚本轴；Hot Swap rev 原子；并行池由主线 A3 时序驱动，包内只提供 Pool API |
| T3 obs/snap | `internal/snapshot/` | glm-5.3 | Observation 构建（AOI+墙遮挡+Partner 豁免）；SnapshotDelta full/delta/tombstone+base_tick；**慢消费者丢帧→ResyncRequest 语义**测试；非 full 帧 AOI 新入实体带完整元数据（nick/color）——proto 已有字段，语义写死 |
| T5 ai | `internal/ai/` | glm-5.3 | 按 A4 QuotaService 接口实现 + DeepSeekProvider + Mock；集成验收=真 WS AiPrompt→MockProvider→脚本生效→EvScriptResult/EvAiUsage |
| T-stats | `internal/stats/` | glm-5.3 | StatsProjector：P0 八称号+比分；从 JSONL 回放重算一致性测试 |

## Phase C：客户端 + 视觉（B 相 T3 契约稳定后）
- T4a 游戏（glm-5.3）：Pixi 渲染（MapDef JSON 直绘、机器人/弹丸/Uplink 状态色）、HUD、输入状态机（axis_mask 生成）、快照消费+缺口重同步、对局进出实体表生命周期。
- T4b 静态件（glm-5.3-flash）：比分板/称号/结算页样式件（按 STYLE.md，固定契约）。
- **视觉验证代理**（审美好模型，审核新规）：加载 `.agents/skills/frontend-design/SKILL.md` + 截图（起服务器+浏览器截图），四维评审：科技感符合度/配色协调/操作流畅/UI 逻辑。不过关→回炉 T4。

## Phase D：主线集成与验收门（最高难度，主线亲自）

1. glue：netws 会话→Room→SimLauncher（错误反馈/回滚：Launch 失败→房态回 Warmup）；路由全部 7 类 ClientMsg（身份绑定/状态校验/错误应答）；Warmup=全图漫游模拟实例（无死亡无计分）。
2. 生命周期：自然结束/Abort/Restart（Session 恰一次累计）/断线停表清输入/日志 Err/Flush/Close 检查（失败≠成功对局）。
3. 验收门（修正 v1 两处硬错误）：
   - **4 客户端**（两组搭档）进房→开赛→手操移动/开火/**搭档免伤验证**/敌方 Hit→Kill→Respawn/黑桩个人 CD 隔离/4:00 解锁/8:00 自然结束/Restart 一次（Session 榜恰一次累计）。
   - 脚本链：真提交→编译失败保旧版→超时只清脚本轴→手操抢占/Space 交还。
   - AI 链：AiPrompt→Mock→生效+配额扣减+护栏触顶禁用。
   - 丢帧：杀网络→重同步恢复；断线→输入停止。
   - 日志：JSONL 全事件链（含 EvAiUsage/script_rev/checkpoint 覆盖弹丸/Core 状态/CD/无敌）→ stats 回放重算=实时投影。
   - **性能门（对齐 ADR-0007 原文）**：64 台满配额（10ms）脚本+模拟+感知+快照整帧 <12ms（注明硬件/worker 数/时长/超时统计）；不足→降单脚本预算复测。
4. 提交推送 + astral todo 全量更新（done + 新任务登记）。

## 延期清单（明确不做）
回放 UI、P1 称号、客户端预测实现（决策已定暂缓）、编辑器、Snippet UI、多语言运行时、docker。
