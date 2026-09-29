# 对局事件溯源：模拟只产事件，统计皆投影

权威模拟主循环不内置任何统计/结算逻辑，只向追加式 Match Event Log 写入状态变迁事件（输入、命中、拾取、引导完成、转段、热更新、死亡……）。称号结算、赛后统计页、回放与平衡性分析全部作为事件流的投影消费方实现。放弃了内联计数器+事后补日志的方案：事后补事件等于重写模拟器插桩，且新增统计指标无法回溯历史对局。

## 修订（2026-09-29，复审 D4）

原决策不变，补充可执行契约：

- **持久化格式**：JSONL，每局一文件（`data/matches/<match_id>.jsonl`），首行 `schema_version` + `match_start` 事件（含地图种子与玩家表）。
- **回放检查点**：每 60s 追加一份全量状态快照事件，回放器从最近检查点重建，回放启动 O(≤60s 事件)。
- **线上事件 ≠ 完整日志**：omb.proto ServerEvent 是日志的投影子集（带宽裁剪）；完整日志含 EvMatchStart/EvWallHit/EvScriptError 等全部埋点。
- **新增埋点**：EvMatchStart（地图种子）、EvWallHit（0.5s/robot 节流，铁头娃）、EvScriptError（人工智障，含 script_rev）。

依据：docs/design/reviews/2026-09-29-gpt6-astra-audit.md 发现 #5。
