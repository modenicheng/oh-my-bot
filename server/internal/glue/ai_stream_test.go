package glue

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/ai"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// recordedSends 收集聚合器 flush 的段（线程安全：定时器回调在独立 goroutine）。
type recordedSends struct {
	mu     sync.Mutex
	deltas []ai.StreamDelta
}

func (r *recordedSends) record(d ai.StreamDelta) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deltas = append(r.deltas, d)
}

func (r *recordedSends) take() []ai.StreamDelta {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.deltas
	r.deltas = nil
	return out
}

// count 非破坏性计数（轮询用，不消费）。
func (r *recordedSends) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.deltas)
}

// smallAgg 测试用聚合器：小阈值/小间隔，避免依赖生产 50ms/512B 时序。
func smallAgg(rec *recordedSends, interval time.Duration, limit int) *aiStreamAggregator {
	a := newAIStreamAggregator(rec.record)
	a.interval = interval
	a.limit = limit
	return a
}

// TestAIStreamAggregatorMergesUntilClose：小于阈值的小增量不逐条下发，
// close() 尾 flush 合并为一段（顺序保持）。
func TestAIStreamAggregatorMergesUntilClose(t *testing.T) {
	rec := &recordedSends{}
	a := smallAgg(rec, time.Hour, 1<<20) // 不会到期的定时器/不可能的阈值
	for _, s := range []string{"Hel", "lo ", "wor", "ld"} {
		a.push(ai.StreamDelta{Kind: ai.StreamAnswer, Text: s})
	}
	if got := rec.take(); len(got) != 0 {
		t.Fatalf("premature flush: %+v", got)
	}
	a.close()
	got := rec.take()
	if len(got) != 1 || got[0].Text != "Hello world" || got[0].Kind != ai.StreamAnswer {
		t.Fatalf("merged flush = %+v", got)
	}
	// close 幂等：不重复下发。
	a.close()
	if got := rec.take(); len(got) != 0 {
		t.Fatalf("close flushed twice: %+v", got)
	}
}

// TestAIStreamFlushOnByteThreshold：聚合字节数达到阈值立即 flush（不等定时器）。
func TestAIStreamFlushOnByteThreshold(t *testing.T) {
	rec := &recordedSends{}
	a := smallAgg(rec, time.Hour, 8)
	a.push(ai.StreamDelta{Kind: ai.StreamAnswer, Text: "abc"})  // 3B，未达阈值
	a.push(ai.StreamDelta{Kind: ai.StreamAnswer, Text: "defg"}) // +4B=7B，仍未达
	if got := rec.take(); len(got) != 0 {
		t.Fatalf("premature flush: %+v", got)
	}
	a.push(ai.StreamDelta{Kind: ai.StreamAnswer, Text: "h"}) // 8B = 阈值，立即发
	got := rec.take()
	if len(got) != 1 || got[0].Text != "abcdefgh" {
		t.Fatalf("threshold flush = %+v", got)
	}
	a.close()
	if got := rec.take(); len(got) != 0 {
		t.Fatalf("close should have nothing pending: %+v", got)
	}
}

// TestAIStreamKindSwitchFlushes：reasoning → answer 切换先 flush 已聚合段，
// 两轨永不同帧。
func TestAIStreamKindSwitchFlushes(t *testing.T) {
	rec := &recordedSends{}
	a := smallAgg(rec, time.Hour, 1<<20)
	a.push(ai.StreamDelta{Kind: ai.StreamReasoning, Text: "think "})
	a.push(ai.StreamDelta{Kind: ai.StreamReasoning, Text: "hard"})
	a.push(ai.StreamDelta{Kind: ai.StreamAnswer, Text: "answer"})
	got := rec.take()
	if len(got) != 1 || got[0].Kind != ai.StreamReasoning || got[0].Text != "think hard" {
		t.Fatalf("kind switch must flush the pending reasoning segment: %+v", got)
	}
	a.close()
	got = rec.take()
	if len(got) != 1 || got[0].Kind != ai.StreamAnswer || got[0].Text != "answer" {
		t.Fatalf("tail flush = %+v", got)
	}
}

// TestAIStreamTimerFlushesWithoutClose：间隔到点自动 flush（不依赖后续增量或
// close——上游停顿半分钟也不该让首段滞留）。
func TestAIStreamTimerFlushesWithoutClose(t *testing.T) {
	rec := &recordedSends{}
	a := smallAgg(rec, 15*time.Millisecond, 1<<20)
	a.push(ai.StreamDelta{Kind: ai.StreamAnswer, Text: "stalled-start"})
	deadline := time.Now().Add(2 * time.Second)
	for rec.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	got := rec.take()
	if len(got) != 1 || got[0].Text != "stalled-start" {
		t.Fatalf("timer flush = %+v", got)
	}
	a.close()
	if got := rec.take(); len(got) != 0 {
		t.Fatalf("close should have nothing pending: %+v", got)
	}
}

// TestAIStreamPushAfterCloseDropped：结束语义——close 后新到的增量丢弃。
func TestAIStreamPushAfterCloseDropped(t *testing.T) {
	rec := &recordedSends{}
	a := smallAgg(rec, time.Hour, 1<<20)
	a.push(ai.StreamDelta{Kind: ai.StreamAnswer, Text: "final"})
	a.close()
	a.push(ai.StreamDelta{Kind: ai.StreamAnswer, Text: "late"})
	if got := rec.take(); len(got) != 1 || got[0].Text != "final" {
		t.Fatalf("post-close push must be dropped: %+v", got)
	}
}

// scriptedStreamProvider glue 测试用流式 provider：按脚本回调增量后返回固定
// 结果或错误（实现 ai.StreamingProvider，模拟 deepseek SSE 节奏）。
type scriptedStreamProvider struct {
	deltas []ai.StreamDelta
	err    error
	delay  time.Duration
}

func (p *scriptedStreamProvider) Complete(ctx context.Context, pc ai.PromptContext) (ai.Result, ai.Usage, error) {
	return p.CompleteStream(ctx, pc, nil)
}

func (p *scriptedStreamProvider) CompleteStream(ctx context.Context, pc ai.PromptContext, onDelta func(ai.StreamDelta)) (ai.Result, ai.Usage, error) {
	for _, d := range p.deltas {
		if p.delay > 0 {
			select {
			case <-time.After(p.delay):
			case <-ctx.Done():
				return ai.Result{}, ai.Usage{}, ctx.Err()
			}
		}
		if onDelta != nil {
			onDelta(d)
		}
	}
	if p.err != nil {
		return ai.Result{}, ai.Usage{}, p.err
	}
	return ai.Result{NewScript: "function tick(bot) { bot.navigateTo({x: 0, y: 0}) }"}, ai.Usage{TokensDelta: 42}, nil
}

// collectUntil 轮询 log 直至谓词命中，返回累计的全部消息（不丢弃中间帧）。
func collectUntil(t *testing.T, log *messageLog, what string, done func([]sentMessage) bool) []sentMessage {
	t.Helper()
	var all []sentMessage
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		all = append(all, log.take()...)
		if done(all) {
			return all
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s (got %d messages)", what, len(all))
	return nil
}

// aiStreamRoom 装配一个带流式 provider 的 warmup 对局（AI 集成测试夹具）。
func aiStreamRoom(t *testing.T, provider ai.Provider) (*Hub, *RoomConn, *Session, *messageLog, *Match, *ai.QuotaServiceImpl) {
	t.Helper()
	h := NewHub()
	rc := h.EnsureRoom("AISTRM")
	owner, log := bindLogged(t, h, rc, "owner")
	quota := ai.NewQuotaService(ai.DefaultQuotaConfig())
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{
		owner.playerID: {PlayerID: owner.playerID, Nick: owner.nick},
	}, true, &AIService{quota: quota, provider: provider})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()
	log.take()
	return h, rc, owner, log, m, quota
}

// TestRunAiPromptAggregatesStreamThroughRealWiring：真实 runAiPrompt 链路——
// 数十条小增量经聚合 flush 到达 owner（帧数远小于增量条数），且完整流文本
// 先于 ScriptResult 回执（客户端面板顺序依赖）。
func TestRunAiPromptAggregatesStreamThroughRealWiring(t *testing.T) {
	provider := &scriptedStreamProvider{}
	const chunks = 40
	for i := 0; i < chunks; i++ {
		provider.deltas = append(provider.deltas, ai.StreamDelta{Kind: ai.StreamAnswer, Text: "chunk-" + strings.Repeat("x", 8) + ";"})
	}
	_, rc, owner, log, m, quota := aiStreamRoom(t, provider)

	rc.mu.Lock()
	m.handleAiPromptLocked(owner.playerID, "改稳一点")
	rc.mu.Unlock()

	all := collectUntil(t, log, "script result receipt", func(all []sentMessage) bool {
		for _, sm := range all {
			if sm.msg.GetEvent().GetScriptResult() != nil {
				return true
			}
		}
		return false
	})
	var streams []*ombv1.EvAiStream
	var resultIndex, lastStreamIndex = -1, -1
	for i, sm := range all {
		if s := sm.msg.GetEvent().GetAiStream(); s != nil {
			streams = append(streams, s)
			lastStreamIndex = i
			if !sm.reliable {
				t.Fatal("aggregated stream frame must stay on the reliable channel")
			}
		}
		if sm.msg.GetEvent().GetScriptResult() != nil {
			resultIndex = i
		}
	}
	if len(streams) == 0 || len(streams) >= chunks {
		t.Fatalf("aggregation ineffective: %d deltas -> %d frames (want 1..few)", chunks, len(streams))
	}
	var textLen int
	for _, s := range streams {
		textLen += len(s.GetDelta())
	}
	if want := chunks * len("chunk-xxxxxxxx;"); textLen != want {
		t.Fatalf("stream text bytes = %d, want %d (lossy aggregation?)", textLen, want)
	}
	if resultIndex < 0 || lastStreamIndex > resultIndex {
		t.Fatalf("stream text must precede the result receipt: lastStream=%d result=%d", lastStreamIndex, resultIndex)
	}
	if quota.CurrentMatchSeq() == 0 {
		t.Fatal("quota not exercised")
	}
}

// TestRunAiPromptErrorTailFlush：请求失败（上游错误/取消语义）时已到达的增量
// 仍经尾 flush 完整下发（部分回答不丢失），错误 notice 随后到达。
func TestRunAiPromptErrorTailFlush(t *testing.T) {
	provider := &scriptedStreamProvider{
		deltas: []ai.StreamDelta{
			{Kind: ai.StreamReasoning, Text: "part-1 "},
			{Kind: ai.StreamReasoning, Text: "part-2"},
		},
		err: errors.New("upstream boom"),
	}
	_, rc, owner, log, m, _ := aiStreamRoom(t, provider)

	rc.mu.Lock()
	m.handleAiPromptLocked(owner.playerID, "再改")
	rc.mu.Unlock()

	all := collectUntil(t, log, "AI request-failed notice", func(all []sentMessage) bool {
		for _, sm := range all {
			if n := sm.msg.GetEvent().GetControlNotice(); n != nil && n.GetCode() == ombv1.EvControlNotice_CN_AI_REQUEST_FAILED {
				return true
			}
		}
		return false
	})
	var streamText string
	var streamIndex, noticeIndex = -1, -1
	for i, sm := range all {
		if s := sm.msg.GetEvent().GetAiStream(); s != nil {
			if streamIndex >= 0 {
				t.Fatalf("error tail must be a single merged flush, got extra frame %q", s.GetDelta())
			}
			streamIndex = i
			streamText = s.GetDelta()
			if s.GetKind() != ombv1.EvAiStream_REASONING {
				t.Fatalf("tail flush kind = %v, want REASONING", s.GetKind())
			}
		}
		if n := sm.msg.GetEvent().GetControlNotice(); n != nil && n.GetCode() == ombv1.EvControlNotice_CN_AI_REQUEST_FAILED {
			noticeIndex = i
		}
	}
	if streamText != "part-1 part-2" {
		t.Fatalf("tail flush = %q, want merged reasoning segments", streamText)
	}
	if streamIndex < 0 || noticeIndex < 0 || streamIndex > noticeIndex {
		t.Fatalf("tail flush must precede the error notice: stream=%d notice=%d", streamIndex, noticeIndex)
	}
}
