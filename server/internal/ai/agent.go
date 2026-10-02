package ai

import (
	"context"
	"fmt"
)

// ScriptSource 当前脚本查询（glue 层桥接 script 包 Hot Swap 状态）。
type ScriptSource interface {
	// CurrentScript 返回玩家当前生效脚本源码与版本号（rev 单调递增）。
	CurrentScript(playerID uint64) (source string, rev uint32)
}

// ScriptSubmitter 改码结果落地（glue 层桥接 script 包 Hot Swap 提交）。
// 提交按 rev 乐观并发控制：AI 基于的旧 rev 已被手动提交超越时 accepted=false
// （迟到结果丢弃，旧脚本继续运行）。
type ScriptSubmitter interface {
	// SubmitSource 以玩家身份提交新版脚本源码；rev 为 AI 基于的旧版本。
	// 编译失败同样 accepted=false（err 仅为传输类异常）。
	SubmitSource(playerID uint64, rev uint32, source string) (newRev uint32, accepted bool, err error)
}

// Scripts 玩家脚本桥（glue 注入；nil 时 Agent 走无脚本落地模式）。
type Scripts interface {
	ScriptSource
	ScriptSubmitter
}

// HandleOutcome HandlePrompt 的一次完整结果。
type HandleOutcome struct {
	Accepted bool   // 改码结果已落地（ScriptSubmitter 接受）
	NewRev   uint32 // 落地后的新版本号（Accepted=false 时为 0）
	Result   Result // Provider 产出（Explain 即使 rev 失配也可下发给玩家）
	Usage    Usage  // 本次记账载荷（EvAiUsage 事件源：RoundsDelta/TokensDelta/GlobalLeftK）
}

// Agent 编排一次 AI 改码：TryAcquire → Provider.Complete → SubmitSource → Commit。
//
// Manual 语料（audience=both 手册章节）在构造时注入，组装进 system prompt。
type Agent struct {
	quota      QuotaService
	provider   Provider
	scripts    Scripts // 可为 nil：跳过脚本读写（配额+Provider 链路测试用）
	manual     []string
	perception string // 当前玩家可见的只读感知快照（紧凑 JSON）
}

// NewAgent 组装 Agent。
func NewAgent(q QuotaService, p Provider, s Scripts) *Agent {
	return &Agent{quota: q, provider: p, scripts: s}
}

// SetManual 注入手册语料（docs/manual 中 audience=both 章节，glue 启动时加载）。
func (a *Agent) SetManual(corpus []string) { a.manual = corpus }

// SetPerception 注入本次请求开始时的玩家可见快照。它只用于模型上下文，
// 不参与脚本落地或配额记账；空串表示当前无可用快照。
func (a *Agent) SetPerception(snapshot string) { a.perception = snapshot }

// HandlePrompt 处理一次玩家 AI 改码请求。
//
// 流程：读当前脚本 → TryAcquire（拒因原样上抛：ErrBusy/ErrRoundsExhausted/
// ErrTokensExhausted/ErrGlobalGuardrail/ErrConcurrency）→ Provider.Complete →
// （成功时）SubmitSource（rev 失配则脚本丢弃但仍 Commit 记账——玩家确实
// 消耗了 token）→ Commit（无论 Provider 成败都必须执行，释放串行位/并发位）。
//
// 返回的 Outcome.Usage.RoundsDelta 恒为 1（一次提示一轮）；TokensDelta 为
// Provider 实测；GlobalLeftK 由 Commit 后 Snapshot 回填。
func (a *Agent) HandlePrompt(ctx context.Context, playerID uint64, instruction string) (HandleOutcome, error) {
	if a.quota == nil || a.provider == nil {
		return HandleOutcome{}, fmt.Errorf("agent: quota/provider not wired")
	}

	var curScript string
	var curRev uint32
	if a.scripts != nil {
		curScript, curRev = a.scripts.CurrentScript(playerID)
	}
	pc := PromptContext{
		PlayerID:      playerID,
		Instruction:   instruction,
		Manual:        a.manual,
		CurrentScript: curScript,
		ScriptRev:     curRev,
		Perception:    a.perception,
	}

	lease, err := a.quota.TryAcquire(ctx, playerID)
	if err != nil {
		return HandleOutcome{}, err
	}

	result, usage, perr := a.provider.Complete(ctx, pc)
	if perr != nil {
		// 失败也必须 Commit：释放串行位与并发位。轮次在 TryAcquire 时已
		// 预留，所以 Commit 成功时仍返回一轮 usage 事实（token 为 0）。
		out := a.commitOutcome(playerID, lease, HandleOutcome{}, Usage{})
		return out, perr
	}

	out := HandleOutcome{Result: result}
	if a.scripts != nil {
		newRev, accepted, serr := a.scripts.SubmitSource(playerID, pc.ScriptRev, result.NewScript)
		out.Accepted, out.NewRev = accepted, newRev
		if serr != nil {
			out = a.commitOutcome(playerID, lease, out, usage)
			return out, fmt.Errorf("script submit: %w", serr)
		}
	} else {
		out.Accepted = true
	}
	return a.commitOutcome(playerID, lease, out, usage), nil
}

func (a *Agent) commitOutcome(playerID uint64, lease Lease, out HandleOutcome, usage Usage) HandleOutcome {
	if !a.quota.Commit(lease, usage) {
		out.Usage = Usage{} // 跨局迟到：不得把旧局用量归入新局。
		return out
	}
	out.Usage = usage
	out.Usage.RoundsDelta = 1
	_, _, out.Usage.GlobalLeftK = a.quota.Snapshot(playerID)
	return out
}
