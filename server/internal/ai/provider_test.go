package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ---- MockProvider ----

func TestMockProviderRecordsAndProgrammable(t *testing.T) {
	m := &MockProvider{
		Delay:  5 * time.Millisecond,
		Result: Result{NewScript: "function tick(bot) {}", Explain: "no-op"},
		Usage:  Usage{TokensDelta: 4321},
	}
	res, usage, err := m.Complete(context.Background(), PromptContext{Instruction: "改一下"})
	if err != nil || res.NewScript != "function tick(bot) {}" || usage.TokensDelta != 4321 {
		t.Fatalf("res=%+v usage=%+v err=%v", res, usage, err)
	}
	calls := m.Calls()
	if len(calls) != 1 || calls[0].Instruction != "改一下" {
		t.Fatalf("calls = %+v", calls)
	}
	if m.CompleteCount() != 1 {
		t.Fatalf("complete count = %d", m.CompleteCount())
	}
	if !strings.Contains(m.LastSystemPrompt(), "Bot Script") {
		t.Fatal("system prompt missing API summary")
	}
}

func TestMockProviderFail(t *testing.T) {
	boom := errors.New("upstream down")
	m := &MockProvider{Fail: boom}
	_, _, err := m.Complete(context.Background(), PromptContext{})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}

func TestMockProviderCtxCancelDuringDelay(t *testing.T) {
	m := &MockProvider{Delay: 5 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _, err := m.Complete(ctx, PromptContext{})
	if err == nil || time.Since(start) > time.Second {
		t.Fatalf("err = %v, elapsed = %v", err, time.Since(start))
	}
}

// ---- system prompt 组装 ----

func TestBuildSystemPromptIncludesCorpus(t *testing.T) {
	sys := buildSystemPrompt([]string{"## Bot Script 编程指南\n正文A", "## AI Agent\n正文B"})
	for _, want := range []string{"只输出完整新版 JavaScript", "function tick(bot)", "禁止类型注解", "Bot Script", "正文A", "正文B", "pulseScan(): Observation", "navigateTo", "bot.scan()", "bot.self.position"} {
		if !strings.Contains(sys, want) {
			t.Errorf("system prompt missing %q", want)
		}
	}
	if strings.Contains(sys, "DEEPSEEK") {
		t.Error("system prompt must not leak provider details")
	}
	if strings.Contains(sys, "pulseScan(): Observation | null") {
		t.Error("system prompt must describe pulseScan as non-nullable")
	}
}

func TestBuildUserPrompt(t *testing.T) {
	pc := PromptContext{ScriptRev: 7, CurrentScript: "const x = 1", Perception: `{"tick":42,"robots":[]}`, Instruction: "加开火"}
	u := buildUserPrompt(pc)
	for _, want := range []string{"rev 7", "```js", "const x = 1", "当前玩家感知快照", `"tick":42`, "加开火"} {
		if !strings.Contains(u, want) {
			t.Errorf("user prompt missing %q", want)
		}
	}
}

// ---- extractScript ----

func TestExtractScript(t *testing.T) {
	cases := []struct {
		name, in, wantScript, wantExplain string
		wantOK                            bool
	}{
		{"fenced", "改动说明：\n```js\nfunction tick(bot) {}\n```", "function tick(bot) {}", "改动说明：", true},
		{"plain", "const botModule = { tick(bot) {} }; export default botModule", "const botModule = { tick(bot) {} }; export default botModule", "", true},
		{"multi-block-last-wins", "示例：\n```js\nfunction demo() {}\n```\n正式：\n```js\nconst botModule = { tick(bot) {} }; export default botModule\n```", "const botModule = { tick(bot) {} }; export default botModule", "示例：", true},
		{"unclosed", "```js\nfunction tick(bot) {}", "function tick(bot) {}", "", true}, {"empty", "", "", "", false},
	}
	for _, c := range cases {
		s, e, ok := extractScript(c.in)
		if ok != c.wantOK || (ok && (s != c.wantScript || e != c.wantExplain)) {
			t.Errorf("%s: got (%q,%q,%v), want (%q,%q,%v)", c.name, s, e, ok, c.wantScript, c.wantExplain, c.wantOK)
		}
	}
}

// ---- DeepSeek HTTP 行为（httptest 注入，不测真 API）----

func newTestServer(t *testing.T, status int, resp any) (*httptest.Server, *DeepSeekProvider) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("auth = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		switch v := resp.(type) {
		case string:
			_, _ = w.Write([]byte(v))
		default:
			_ = json.NewEncoder(w).Encode(v)
		}
	}))
	t.Cleanup(srv.Close)
	p := NewDeepSeekProvider("test-key")
	p.Endpoint = srv.URL
	return srv, p
}

func okBody(content string, ptok, ctok int) map[string]any {
	return map[string]any{
		"choices": []any{map[string]any{"message": map[string]any{"content": content}}},
		"usage":   map[string]any{"prompt_tokens": ptok, "completion_tokens": ctok},
	}
}

func TestDeepSeekCompleteSuccess(t *testing.T) {
	_, p := newTestServer(t, 200, okBody("说明X\n```js\nfunction tick(bot) { bot.fire() }\n```", 1000, 200))
	res, usage, err := p.Complete(context.Background(), PromptContext{
		Instruction:   "加开火",
		Manual:        []string{"手册"},
		CurrentScript: "function tick(bot) {}",
		ScriptRev:     3,
	})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if res.NewScript != "function tick(bot) { bot.fire() }" {
		t.Fatalf("script = %q", res.NewScript)
	}
	if usage.TokensDelta != 1200 {
		t.Fatalf("tokens = %d, want 1200", usage.TokensDelta)
	}
}

func TestDeepSeekRequestShape(t *testing.T) {
	var gotBody chatRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode: %v", err)
		}
		resp := "{\"choices\":[{\"message\":{\"content\":\"" + fence + "js\\nfunction tick(bot) {}\\n" + fence + "\"}}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}"
		_, _ = w.Write([]byte(resp))
	}))
	defer srv.Close()
	p := NewDeepSeekProvider("test-key")
	p.Endpoint = srv.URL
	_, _, err := p.Complete(context.Background(), PromptContext{Instruction: "指令", CurrentScript: "旧脚本", Perception: `{"tick":1}`})
	if err != nil {
		t.Fatal(err)
	}
	if gotBody.Model != "deepseek-chat" || gotBody.Stream {
		t.Fatalf("model=%s stream=%v", gotBody.Model, gotBody.Stream)
	}
	if len(gotBody.Messages) != 2 || gotBody.Messages[0].Role != "system" || gotBody.Messages[1].Role != "user" {
		t.Fatalf("messages = %+v", gotBody.Messages)
	}
	if !strings.Contains(gotBody.Messages[0].Content, "只输出完整新版 JavaScript") {
		t.Error("system prompt missing instruction")
	}
	if !strings.Contains(gotBody.Messages[1].Content, "旧脚本") || !strings.Contains(gotBody.Messages[1].Content, "指令") || !strings.Contains(gotBody.Messages[1].Content, `"tick":1`) {
		t.Error("user prompt missing script/perception/instruction")
	}
}

func TestDeepSeekErrorClassification(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		cat    string
		retry  bool
	}{
		{"429", 429, `{"error":"rate"}`, CatRateLimited, true},
		{"401", 401, `{"error":"key"}`, CatClient, false},
		{"400", 400, `{"error":"bad"}`, CatClient, false},
		{"500", 500, "boom", CatNetwork, false},
		{"200-no-usage", 200, `{"choices":[{"message":{"content":"` + fence + `ts\\nx\\n` + fence + `"}}]}`, CatProvider, false},
		{"200-no-choices", 200, `{"usage":{}}`, CatProvider, false},
		{"200-garbage", 200, `not-json`, CatNetwork, true},
	}
	for _, c := range cases {
		_, p := newTestServer(t, c.status, c.body)
		_, _, err := p.Complete(context.Background(), PromptContext{})
		var pe *ProviderError
		if !errors.As(err, &pe) {
			t.Errorf("%s: err %v not ProviderError", c.name, err)
			continue
		}
		if pe.Category != c.cat || pe.Retryable != c.retry {
			t.Errorf("%s: cat=%s retry=%v, want %s/%v", c.name, pe.Category, pe.Retryable, c.cat, c.retry)
		}
	}
}

func TestDeepSeekNetworkError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // 立即关闭 → 连接拒绝
	p := NewDeepSeekProvider("k")
	p.Endpoint = url
	_, _, err := p.Complete(context.Background(), PromptContext{})
	var pe *ProviderError
	if !errors.As(err, &pe) || pe.Category != CatNetwork || !pe.Retryable {
		t.Fatalf("err = %v, want retryable network ProviderError", err)
	}
}

func TestDeepSeekMissingKey(t *testing.T) {
	p := NewDeepSeekProvider("")
	p.Endpoint = "http://unused"
	t.Setenv("DEEPSEEK_API_KEY", "")
	_, _, err := p.Complete(context.Background(), PromptContext{})
	var pe *ProviderError
	if !errors.As(err, &pe) || pe.Category != CatClient {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), "DEEPSEEK_API_KEY=k") || strings.Contains(err.Error(), "Bearer") {
		t.Error("error leaks key material")
	}
}

func TestDeepSeekKeyFromEnv(t *testing.T) {
	t.Setenv("DEEPSEEK_API_KEY", "env-key")
	var auth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth.Store(r.Header.Get("Authorization"))
		body := `{"choices":[{"message":{"content":"` + fence + `js\\nfunction tick(bot) {}\\n` + fence + `"}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}`
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	p := NewDeepSeekProvider("") // 未显式传 key → 环境变量
	p.Endpoint = srv.URL
	if _, _, err := p.Complete(context.Background(), PromptContext{}); err != nil {
		t.Fatal(err)
	}
	if got, _ := auth.Load().(string); got != "Bearer env-key" {
		t.Fatalf("auth = %q", got)
	}
}

func TestDeepSeekTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	p := NewDeepSeekProvider("k")
	p.Endpoint = srv.URL
	p.HTTPClient = &http.Client{Timeout: 50 * time.Millisecond}
	_, _, err := p.Complete(context.Background(), PromptContext{})
	var pe *ProviderError
	if !errors.As(err, &pe) || pe.Category != CatNetwork {
		t.Fatalf("err = %v, want network ProviderError", err)
	}
}

func TestDeepSeekCtxCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	p := NewDeepSeekProvider("k")
	p.Endpoint = srv.URL
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	_, _, err := p.Complete(ctx, PromptContext{})
	var pe *ProviderError
	if !errors.As(err, &pe) || pe.Category != CatNetwork {
		t.Fatalf("err = %v, want network ProviderError on ctx cancel", err)
	}
}
