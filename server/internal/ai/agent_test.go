package ai

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// memScripts 内存脚本桥：模拟 script 包 Hot Swap 的 rev 单调 + 乐观并发。
type memScripts struct {
	mu     sync.Mutex
	source map[uint64]string
	rev    map[uint64]uint32
}

func newMemScripts() *memScripts {
	return &memScripts{source: map[uint64]string{}, rev: map[uint64]uint32{}}
}

func (m *memScripts) CurrentScript(playerID uint64) (string, uint32) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.source[playerID], m.rev[playerID]
}

func (m *memScripts) SubmitSource(playerID uint64, rev uint32, source string) (uint32, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur, ok := m.rev[playerID]; ok && rev != cur {
		return 0, false, nil // rev 被手动提交超越 → 迟到结果丢弃
	}
	m.source[playerID] = source
	m.rev[playerID] = rev + 1
	return rev + 1, true, nil
}

func (m *memScripts) flash(playerID uint64) { // 模拟玩家手动提交超越 rev
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rev[playerID]++
}

// ---- 基本链路 ----

func TestAgentHappyPath(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	mock := &MockProvider{Result: Result{NewScript: "export default { tick() {} }", Explain: "加了个 tick"}, Usage: Usage{TokensDelta: 1234}}
	a := NewAgent(q, mock, newMemScripts())

	out, err := a.HandlePrompt(context.Background(), 9, "写个脚本")
	if err != nil {
		t.Fatal(err)
	}
	if !out.Accepted || out.NewRev != 1 {
		t.Fatalf("out = %+v", out)
	}
	if out.Usage.RoundsDelta != 1 || out.Usage.TokensDelta != 1234 || out.Usage.GlobalLeftK != 1998 {
		t.Fatalf("usage = %+v", out.Usage)
	}
	r, tokK, _ := q.Snapshot(9)
	if r != 19 || tokK != 298 {
		t.Fatalf("snapshot = (%d,%d)", r, tokK)
	}
	// 落地的脚本成为下一次的 CurrentScript。
	if calls := mock.Calls(); calls[0].CurrentScript != "" {
		t.Fatalf("current script = %q", calls[0].CurrentScript)
	}
	out2, err := a.HandlePrompt(context.Background(), 9, "再改")
	if err != nil {
		t.Fatal(err)
	}
	if out2.NewRev != 2 {
		t.Fatalf("rev chain broken: %+v", out2)
	}
	if calls := mock.Calls(); calls[1].CurrentScript != "export default { tick() {} }" || calls[1].ScriptRev != 1 {
		t.Fatalf("second call ctx = %+v", calls[1])
	}
}

func TestAgentQuotaRejectionPropagates(t *testing.T) {
	q := NewQuotaService(QuotaConfig{PlayerRounds: 1, PlayerTokens: 1000, GlobalTokens: 10_000})
	mock := &MockProvider{Usage: Usage{TokensDelta: 1000}}
	a := NewAgent(q, mock, nil)
	if _, err := a.HandlePrompt(context.Background(), 1, "x"); err != nil {
		t.Fatal(err)
	}
	// 轮次已尽。
	if _, err := a.HandlePrompt(context.Background(), 1, "x"); err != ErrRoundsExhausted {
		t.Fatalf("err = %v", err)
	}
	// token 也耗尽（第一次提交用掉 1000/1000）。
	q2 := NewQuotaService(QuotaConfig{PlayerRounds: 5, PlayerTokens: 1000, GlobalTokens: 10_000})
	a2 := NewAgent(q2, mock, nil)
	a2.HandlePrompt(context.Background(), 1, "x")
	if _, err := a2.HandlePrompt(context.Background(), 1, "x"); err != ErrTokensExhausted {
		t.Fatalf("err = %v", err)
	}
}

func TestAgentProviderErrorStillCommits(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	mock := &MockProvider{Fail: errors.New("boom")}
	a := NewAgent(q, mock, nil)

	if _, err := a.HandlePrompt(context.Background(), 5, "x"); err == nil {
		t.Fatal("want provider error")
	}
	// 关键：失败后串行位/并发位必须释放——同玩家可立即重试。
	if mock.CompleteCount() != 1 {
		t.Fatalf("complete count = %d", mock.CompleteCount())
	}
	mock.Fail = nil
	if _, err := a.HandlePrompt(context.Background(), 5, "retry"); err != nil {
		t.Fatalf("retry after failure: %v", err)
	}
	// 失败调用 token 记 0：只消耗成功那次。
	if _, tokK, _ := q.Snapshot(5); tokK != 300 {
		t.Fatalf("failed call leaked tokens: tokK=%d", tokK)
	}
}

func TestAgentStaleRevDiscarded(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	scripts := newMemScripts()
	mock := &MockProvider{
		Delay:  30 * time.Millisecond, // 在途窗口内玩家手动提交
		Result: Result{NewScript: "export default { ai() {} }", Explain: "AI 版"},
		Usage:  Usage{TokensDelta: 500},
	}
	a := NewAgent(q, mock, scripts)

	scripts.SubmitSource(1, 0, "export default { manual() {} }") // rev 0→1
	var wg sync.WaitGroup
	var out atomic.Value
	wg.Add(1)
	go func() {
		defer wg.Done()
		o, err := a.HandlePrompt(context.Background(), 1, "改")
		if err != nil {
			t.Error(err)
		}
		out.Store(o)
	}()
	time.Sleep(10 * time.Millisecond) // 等 AI 已读到 rev=1 并在途
	scripts.flash(1)                  // 手动提交：rev 1→2，AI 的 1 已过时
	wg.Wait()

	o := out.Load().(HandleOutcome)
	if o.Accepted {
		t.Fatal("stale rev accepted, want discarded")
	}
	// 但 token 仍要记账（玩家确实消耗了）。
	if _, tokK, _ := q.Snapshot(1); tokK != 299 {
		t.Fatalf("stale usage not billed: tokK=%d", tokK)
	}
	// 手动版仍在。
	if s, _ := scripts.CurrentScript(1); s != "export default { manual() {} }" {
		t.Fatalf("manual script clobbered: %q", s)
	}
}

func TestAgentBusyDuringInFlight(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	mock := &MockProvider{Delay: 50 * time.Millisecond}
	a := NewAgent(q, mock, nil)

	done := make(chan struct{})
	go func() { a.HandlePrompt(context.Background(), 3, "slow"); close(done) }()
	time.Sleep(10 * time.Millisecond)
	if _, err := a.HandlePrompt(context.Background(), 3, "again"); err != ErrBusy {
		t.Fatalf("err = %v, want ErrBusy", err)
	}
	<-done
	// 完成后可再次请求。
	if _, err := a.HandlePrompt(context.Background(), 3, "next"); err != nil {
		t.Fatal(err)
	}
}

func TestAgentManualCorpusInjected(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	mock := &MockProvider{}
	a := NewAgent(q, mock, nil)
	a.SetManual([]string{"## 手册", "正文语料"})
	if _, err := a.HandlePrompt(context.Background(), 2, "x"); err != nil {
		t.Fatal(err)
	}
	if sys := mock.LastSystemPrompt(); !contains(sys, "正文语料") || !contains(sys, "只输出完整新版脚本代码") {
		t.Fatalf("manual/instruction missing from system prompt:\n%s", sys)
	}
	if calls := mock.Calls(); calls[0].Manual[0] != "## 手册" {
		t.Fatalf("manual = %v", calls[0].Manual)
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// ---- 64 goroutine 混合压测（-race 目标）----

func TestAgentStress64Players(t *testing.T) {
	q := NewQuotaService(QuotaConfig{PlayerRounds: 3, PlayerTokens: 30_000, GlobalTokens: 1_000_000, MaxConcurrency: 20})
	mock := &MockProvider{Delay: 2 * time.Millisecond, Usage: Usage{TokensDelta: 111}}
	a := NewAgent(q, mock, newMemScripts())

	const workers = 64
	var wg sync.WaitGroup
	var ok, rejected atomic.Int64
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			player := uint64(id%32 + 1) // 32 玩家，2 轮并发竞争
			for r := 0; r < 2; r++ {
				out, err := a.HandlePrompt(context.Background(), player, fmt.Sprintf("w%d-r%d", id, r))
				switch {
				case err == nil:
					if !out.Accepted {
						t.Error("accepted=false without rev race in stress")
					}
					ok.Add(1)
				case err == ErrBusy || err == ErrRoundsExhausted || err == ErrTokensExhausted || err == ErrConcurrency:
					rejected.Add(1)
				default:
					t.Errorf("worker %d: %v", id, err)
				}
			}
		}(i)
	}
	wg.Wait()
	if ok.Load() == 0 {
		t.Fatal("no successful prompts in stress test")
	}
	// 32 玩家 × 3 轮 = 96 上限；串行约束下不可能超。
	if got := ok.Load(); got > 96 {
		t.Fatalf("ok = %d, want <= 96", got)
	}
	if r, _, _ := q.Snapshot(1); r > 1 { // 每人 3 轮，至少跑过 2 次才可能剩 1
		t.Fatalf("rounds accounting broken: %d", r)
	}
}
