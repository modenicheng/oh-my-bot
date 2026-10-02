// Package ai — AI Agent 配额与代理服务（Round 2 计划 A4 契约冻结）。
//
// QuotaService 是 T5(ai) 的实现目标、glue 层的消费接口。
// 生命周期：房间作用域——Warmup 起生效、Restart 重置、跨局不保留。
package ai

import "context"

// Lease 一次已获批的 AI 调用：携带归属（玩家+局序号），用于迟到结果归属判定。
type Lease struct {
	PlayerID   uint64
	MatchSeq   int    // 签发时的局序号（Restart 后旧 lease 的结果不再入账）
	RoundsLeft uint32 // 签发后剩余轮次
}

// Usage 一次调用的实际消耗（EvAiUsage 的事件载荷）。
type Usage struct {
	RoundsDelta uint32
	TokensDelta uint32 // 实际 usage 字段累加（provider 返回）
	GlobalLeftK uint32 // 全局护栏余量（千 token）
}

// QuotaService 配额记账（并发安全）。
// 规则（ADR-0010 r2）：
//   - 双轨：每玩家每局 20 轮提示 + 300k token
//   - 单玩家串行：同玩家在途请求 ≤1
//   - 全局并发 20（可配置，对齐 DeepSeek 官方）
//   - 全局护栏 2M token/局：触顶全员禁用
//   - 热身场同池计费
type QuotaService interface {
	// TryAcquire 尝试为玩家获取一次调用资格。
	// 拒绝原因经 error 返回：ErrRoundsExhausted / ErrTokensExhausted /
	// ErrGlobalGuardrail / ErrBusy（该玩家已有在途请求）/ ErrConcurrency。
	TryAcquire(ctx context.Context, playerID uint64) (Lease, error)
	// Commit 记录实际消耗并释放串行位。lease 失效（局已 Restart）时静默丢弃
	// 并返回 false——AI 迟到结果不得入账新局。
	Commit(lease Lease, usage Usage) (accepted bool)
	// Snapshot 当前配额状态（下发 EvAiUsage / HUD）。
	Snapshot(playerID uint64) (roundsLeft uint32, tokensLeftK uint32, globalLeftK uint32)
}

// sentinel errors
var (
	ErrRoundsExhausted = err("rounds exhausted")
	ErrTokensExhausted = err("player token budget exhausted")
	ErrGlobalGuardrail = err("match global token guardrail hit")
	ErrBusy            = err("player request in flight")
	ErrConcurrency     = err("global concurrency limit")
)

type err string

func (e err) Error() string { return string(e) }

// Provider 是 LLM 通道抽象（v1 唯一实现：DeepSeek deepseek-chat）。
type Provider interface {
	// Complete 执行一次改码请求。promptCtx 含手册语料+bot-api 类型+当前脚本。
	// 返回改码结果与 usage（token 计量读响应 usage 字段）。
	Complete(ctx context.Context, promptCtx PromptContext) (Result, Usage, error)
}

type PromptContext struct {
	PlayerID      uint64
	Instruction   string   // 玩家自然语言指令
	Manual        []string // docs/manual 中 audience=both 的相关章节
	CurrentScript string   // 当前 Bot Script 源码
	ScriptRev     uint32   // 当前版本（AI 结果落地时校验，被超越则丢弃）
	Perception    string   // 当前玩家的只读感知快照（紧凑 JSON；不含他人私有数据）
}

type Result struct {
	NewScript string
	Explain   string // 改动摘要（下发给玩家）
}
