package ai

import (
	"context"
	"sync"
	"time"
)

// MockProvider 测试用 Provider：可编程延迟/失败/usage，并记录每次调用
// 的 PromptContext 供断言（注入的 system prompt、当前脚本、指令）。
type MockProvider struct {
	// Delay 每次调用前阻塞时长（模拟在途窗口；0 = 立即）。
	Delay time.Duration
	// Fail 若非 nil，Complete 返回该错误（仍消耗 Delay）。
	Fail error
	// Result 固定返回的改码结果（零值 → 生成一个最小可编译占位脚本）。
	Result Result
	// Usage 固定返回的 token 用量（RoundsDelta 不由 provider 关心）。
	Usage Usage

	mu       sync.Mutex
	calls    []PromptContext // 收到的调用上下文（按序）
	systems  []string        // 每次调用的 system prompt（PromptContext 不含，单独记）
	complete []bool          // 每次调用是否走到返回（延迟后未被 panic 打断）
}

var _ Provider = (*MockProvider)(nil)

// Complete 实现 Provider：可编程延迟/失败/usage。
func (m *MockProvider) Complete(ctx context.Context, pc PromptContext) (Result, Usage, error) {
	m.mu.Lock()
	m.calls = append(m.calls, pc)
	m.systems = append(m.systems, buildSystemPrompt(pc.Manual))
	m.mu.Unlock()

	if m.Delay > 0 {
		select {
		case <-time.After(m.Delay):
		case <-ctx.Done():
			return Result{}, Usage{}, ctx.Err()
		}
	}

	m.mu.Lock()
	m.complete = append(m.complete, true)
	m.mu.Unlock()

	if m.Fail != nil {
		return Result{}, Usage{}, m.Fail
	}
	res := m.Result
	if res.NewScript == "" {
		res.NewScript = "function tick(bot) { bot.navigateTo({x: 0, y: 0}) }"
	}
	return res, m.Usage, nil
}

// Calls 返回收到的全部 PromptContext 副本。
func (m *MockProvider) Calls() []PromptContext {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]PromptContext, len(m.calls))
	copy(out, m.calls)
	return out
}

// LastSystemPrompt 返回最近一次调用组装的 system prompt（无调用返回空）。
func (m *MockProvider) LastSystemPrompt() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.systems) == 0 {
		return ""
	}
	return m.systems[len(m.systems)-1]
}

// CompleteCount 返回成功走完 Complete 的调用数。
func (m *MockProvider) CompleteCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.complete)
}
