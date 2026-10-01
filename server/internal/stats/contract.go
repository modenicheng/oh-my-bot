// Package stats — 对局统计投影（Round 2 计划 A4 契约冻结）。
//
// StatsProjector 消费 EventSink 流，维护实时比分与全部 13 称号投影。
// v1 目标（维护者指令）：完整事件记录 + 完整对局回放 + 全部 13 称号评估。
package stats

import (
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// TitleID 与 ombv1.Title 枚举数值一致。
type TitleID = ombv1.Title

// ScoreRow 玩家最终行（EvMatchEnd 与 room.AddMatchResult 的载荷）。
type ScoreRow struct {
	RobotID  uint32
	PlayerID uint64
	Nick     string
	Score    int32
	Titles   []TitleID
}

// LiveSnapshot 实时榜（HUD 下发用）。
type LiveSnapshot struct {
	Tick uint32
	Rows []ScoreRow // 按 Score 降序
}

// Projector 从事件流投影统计。幂等消费：同一事件重放不产生重复计数。
// 事件身份有两种（不可冲突）：
//   - OnEventRecord(sequence,…)：有序源身份（glue 实时流、JSONL 回放按行序
//     分配），序号即去重键——同 tick 同 payload 的两条独立事件（如同 tick 两枚
//     弹丸对同目标等伤 EvHit）各自计分，不丢 ScoreHit/BARRAGE。
//   - OnEvent(tick,…)：legacy 内容身份（tick+kind+payload），供无序/旧调用方；
//     内容重复即合并，同 tick 同 payload 的真实双事件会计一次。
//
// 这是"JSONL 回放重算 = 实时投影"验收门的基础。
type Projector interface {
	// OnEvent 消费一条事件（与 EventSink 同序，内容去重——legacy 路径）。
	OnEvent(tick uint32, ev *ombv1.ServerEvent)
	// Live 当前实时榜快照。
	Live() LiveSnapshot
	// Final 结算（每局恰一次；room.AddMatchResult 的数据源）。
	Final() []ScoreRow
	// PlayerMap robotID→playerID 解析（开局 EvMatchStart 后由 glue 注入）。
	SetPlayerMap(m map[uint32]uint64)
}

// 13 称号判定规则（v0.3 §13，全部实现——用户指令）：
//   WAR_MACHINE 击毁最多 / SCAVENGER Core 最多 / SIGNAL_THIEF Uplink 最多 /
//   RUNNER 移动距离最长（EvWallHit 不足——需位置差分，见下）/ WALL_HEAD 撞墙最多 /
//   SURVIVOR 最长连续存活 / PEACEMAKER 高积分零击毁 / AI_IDIOT 脚本异常最多 /
//   BARRAGE 射击最多 / KILL_STEAL 抢人头最多 / AI_REGULAR AI 轮次最多 /
//   OLD_SCHOOL 零 AI 零 Snippet 完赛 / CNMB 被击毁最多
//
// RUNNER 依赖位置数据：事件流中没有逐 tick 位置，Projector 消费 60s 检查点
// （checkpoint 行含全量 robot 状态）差分近似距离（误差 ≤ 检查点间隔内折返），
// 验收标准：与 sim 内部真值误差 < 10%（统计用途足够）。
