package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// DeepSeek 配置常量。
const (
	DeepSeekDefaultEndpoint = "https://api.deepseek.com/chat/completions"
	DeepSeekDefaultModel    = "deepseek-chat"
	DeepSeekDefaultTimeout  = 30 * time.Second
	DeepSeekKeyEnv          = "DEEPSEEK_API_KEY"
)

// DeepSeekError 类别（ErrorCategory；玩家侧提示/重试策略按类别分流）。
const (
	// CatNetwork：超时、连接失败、5xx、非 JSON 响应——可提示玩家稍后重试。
	CatNetwork = "network"
	// CatRateLimited：429——并发/频率限制，稍后重试。
	CatRateLimited = "rate_limited"
	// CatClient：其余 4xx（key 无效、请求体非法等）——服务端配置问题。
	CatClient = "client"
	// CatProvider：2xx 但响应缺 usage / 缺内容——DeepSeek 契约异常。
	CatProvider = "provider"
)

// ProviderError 携带错误类别（Category 见 Cat* 常量）。
type ProviderError struct {
	Category  string
	Status    int    // HTTP 状态码（网络层错误为 0）
	Detail    string // 摘要（截断），不含 API key
	Retryable bool   // 网络类/限流类可重试
	err       error
}

func (e *ProviderError) Error() string {
	if e.err != nil {
		return fmt.Sprintf("deepseek: [%s] %v", e.Category, e.err)
	}
	return fmt.Sprintf("deepseek: [%s] %s", e.Category, e.Detail)
}

func (e *ProviderError) Unwrap() error { return e.err }

// DeepSeekProvider 实现 Provider，POST DeepSeek /chat/completions。
type DeepSeekProvider struct {
	// APIKey 取值顺序：显式字段 → 环境变量 DEEPSEEK_API_KEY。
	APIKey     string
	Model      string // 默认 deepseek-chat
	Endpoint   string // 默认 https://api.deepseek.com/chat/completions
	HTTPClient *http.Client
}

var _ Provider = (*DeepSeekProvider)(nil)

// NewDeepSeekProvider 构造默认配置的 DeepSeek 通道。
// key 显式传入优先；否则读 DEEPSEEK_API_KEY。
func NewDeepSeekProvider(key string) *DeepSeekProvider {
	return &DeepSeekProvider{
		APIKey:     key,
		Model:      DeepSeekDefaultModel,
		Endpoint:   DeepSeekDefaultEndpoint,
		HTTPClient: &http.Client{Timeout: DeepSeekDefaultTimeout},
	}
}

// apiKey 解析注入优先级。
func (p *DeepSeekProvider) apiKey() string {
	if p.APIKey != "" {
		return p.APIKey
	}
	return os.Getenv(DeepSeekKeyEnv)
}

func (p *DeepSeekProvider) model() string {
	if p.Model == "" {
		return DeepSeekDefaultModel
	}
	return p.Model
}

func (p *DeepSeekProvider) endpoint() string {
	if p.Endpoint == "" {
		return DeepSeekDefaultEndpoint
	}
	return p.Endpoint
}

// Complete 执行一次改码请求：
//
//	system prompt = 指令段（只输出完整新版脚本）+ bot-api 类型摘要 +
//		Manual 语料（PromptContext.Manual，audience=both 章节）；
//	user prompt = 当前脚本 + 玩家自然语言指令。
//
//	token 计量读响应 usage 字段（prompt_tokens + completion_tokens 累加）。
//	结果 NewScript 剥离 markdown 围栏；Explain 取 choices[0].message.content
//	（deepseek-chat 单轮即最终答案，按代码块/文本分段约定取正文）。
func (p *DeepSeekProvider) Complete(ctx context.Context, pc PromptContext) (Result, Usage, error) {
	key := p.apiKey()
	if key == "" {
		return Result{}, Usage{}, &ProviderError{
			Category: CatClient,
			Detail:   "missing API key (set DEEPSEEK_API_KEY)",
		}
	}

	body, err := p.requestBody(pc, false)
	if err != nil {
		return Result{}, Usage{}, &ProviderError{Category: CatClient, Detail: "encode request: " + err.Error(), err: err}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint(), bytes.NewReader(body))
	if err != nil {
		return Result{}, Usage{}, &ProviderError{Category: CatClient, Detail: "build request: " + err.Error(), err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)

	client := p.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: DeepSeekDefaultTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return Result{}, Usage{}, &ProviderError{
			Category:  CatNetwork,
			Detail:    truncate(err.Error(), 200),
			Retryable: true,
			err:       err,
		}
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return Result{}, Usage{}, &ProviderError{Category: CatNetwork, Detail: "read body: " + err.Error(), Retryable: true, err: err}
	}

	if resp.StatusCode == http.StatusTooManyRequests {
		return Result{}, Usage{}, &ProviderError{
			Category:  CatRateLimited,
			Status:    resp.StatusCode,
			Detail:    truncate(string(raw), 200),
			Retryable: true,
		}
	}
	if resp.StatusCode >= 400 {
		cat := CatClient
		if resp.StatusCode >= 500 {
			cat = CatNetwork
		}
		return Result{}, Usage{}, &ProviderError{
			Category: cat,
			Status:   resp.StatusCode,
			Detail:   truncate(string(raw), 200),
		}
	}

	var cr chatResponse
	if err := json.Unmarshal(raw, &cr); err != nil {
		return Result{}, Usage{}, &ProviderError{Category: CatNetwork, Detail: "decode body: " + err.Error(), Retryable: true, err: err}
	}
	if len(cr.Choices) == 0 {
		return Result{}, Usage{}, &ProviderError{Category: CatProvider, Detail: "no choices in response"}
	}

	if cr.Usage.PromptTokens <= 0 && cr.Usage.CompletionTokens <= 0 {
		// 计量是硬需求：无 usage 字段无法记账，视为 provider 契约异常。
		return Result{}, Usage{}, &ProviderError{Category: CatProvider, Detail: "response missing usage fields"}
	}
	content := cr.Choices[0].Message.Content
	script, explain, ok := extractScript(content)
	if !ok {
		return Result{}, Usage{}, &ProviderError{Category: CatProvider, Detail: "response contains no script code block"}
	}

	usage := Usage{TokensDelta: uint32(cr.Usage.PromptTokens + cr.Usage.CompletionTokens)}
	return Result{NewScript: script, Explain: explain}, usage, nil
}

// CompleteStream 使用 DeepSeek/OpenAI 兼容 SSE：每个 choices[].delta.content
// 到达即回调；最后一个 include_usage chunk 提供精确 token 计量。
func (p *DeepSeekProvider) CompleteStream(ctx context.Context, pc PromptContext, onDelta func(StreamDelta)) (Result, Usage, error) {
	key := p.apiKey()
	if key == "" {
		return Result{}, Usage{}, &ProviderError{Category: CatClient, Detail: "missing API key (set DEEPSEEK_API_KEY)"}
	}
	body, err := p.requestBody(pc, true)
	if err != nil {
		return Result{}, Usage{}, &ProviderError{Category: CatClient, Detail: "encode request: " + err.Error(), err: err}
	}
	streamCtx, cancelStream := context.WithCancel(ctx)
	defer cancelStream()
	req, err := http.NewRequestWithContext(streamCtx, http.MethodPost, p.endpoint(), bytes.NewReader(body))
	if err != nil {
		return Result{}, Usage{}, &ProviderError{Category: CatClient, Detail: "build request: " + err.Error(), err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer "+key)
	client, idleTimeout := p.streamHTTPClient()
	var headerTimer *time.Timer
	if idleTimeout > 0 {
		headerTimer = time.AfterFunc(idleTimeout, cancelStream)
	}
	resp, err := client.Do(req)
	if headerTimer != nil {
		headerTimer.Stop()
	}
	if err != nil {
		return Result{}, Usage{}, &ProviderError{Category: CatNetwork, Detail: truncate(err.Error(), 200), Retryable: true, err: err}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
		cat, retryable := CatClient, false
		if resp.StatusCode == http.StatusTooManyRequests {
			cat, retryable = CatRateLimited, true
		} else if resp.StatusCode >= 500 {
			cat, retryable = CatNetwork, true
		}
		return Result{}, Usage{}, &ProviderError{Category: cat, Status: resp.StatusCode, Detail: truncate(string(raw), 200), Retryable: retryable}
	}

	var content strings.Builder
	var promptTokens, completionTokens int
	var idleTimer *time.Timer
	if idleTimeout > 0 {
		idleTimer = time.AfterFunc(idleTimeout, cancelStream)
		defer idleTimer.Stop()
	}
	refreshIdleDeadline := func() {
		if idleTimer != nil {
			idleTimer.Reset(idleTimeout)
		}
	}
	reader := bufio.NewReader(resp.Body)
	streamDone := false
	for !streamDone {
		line, readErr := reader.ReadString('\n')
		if len(line) > 0 {
			refreshIdleDeadline()
			line = strings.TrimSpace(line)
			if line != "" && !strings.HasPrefix(line, ":") && strings.HasPrefix(line, "data:") {
				data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				if data == "[DONE]" {
					streamDone = true
				} else {
					var chunk chatStreamChunk
					if err := json.Unmarshal([]byte(data), &chunk); err != nil {
						return Result{}, Usage{}, &ProviderError{Category: CatNetwork, Detail: "decode stream chunk: " + err.Error(), Retryable: true, err: err}
					}
					for _, choice := range chunk.Choices {
						if choice.Delta.ReasoningContent != "" && onDelta != nil {
							onDelta(StreamDelta{Kind: StreamReasoning, Text: choice.Delta.ReasoningContent})
						}
						if choice.Delta.Content != "" {
							content.WriteString(choice.Delta.Content)
							if onDelta != nil {
								onDelta(StreamDelta{Kind: StreamAnswer, Text: choice.Delta.Content})
							}
						}
					}
					if chunk.Usage != nil {
						promptTokens = chunk.Usage.PromptTokens
						completionTokens = chunk.Usage.CompletionTokens
					}
				}
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return Result{}, Usage{}, &ProviderError{Category: CatNetwork, Detail: "read stream: " + readErr.Error(), Retryable: true, err: readErr}
		}
	}
	if promptTokens <= 0 && completionTokens <= 0 {
		return Result{}, Usage{}, &ProviderError{Category: CatProvider, Detail: "stream missing usage fields"}
	}
	script, explain, ok := extractScript(content.String())
	if !ok {
		return Result{}, Usage{}, &ProviderError{Category: CatProvider, Detail: "stream contains no script code block"}
	}
	return Result{NewScript: script, Explain: explain}, Usage{TokensDelta: uint32(promptTokens + completionTokens)}, nil
}

// streamHTTPClient 去掉 http.Client.Timeout 对整个 SSE 响应的总时长限制。
// 配置的 timeout 由 CompleteStream 改作“等待响应头”和“相邻流数据之间”
// 的空闲超时：只要上游持续输出，长生成不会被误报成网络异常。
func (p *DeepSeekProvider) streamHTTPClient() (*http.Client, time.Duration) {
	base := p.HTTPClient
	if base == nil {
		base = &http.Client{Timeout: DeepSeekDefaultTimeout}
	}
	clone := *base
	timeout := clone.Timeout
	clone.Timeout = 0
	return &clone, timeout
}

func (p *DeepSeekProvider) requestBody(pc PromptContext, stream bool) ([]byte, error) {
	request := chatRequest{
		Model: p.model(),
		Messages: []chatMessage{
			{Role: "system", Content: buildSystemPrompt(pc.Manual)},
			{Role: "user", Content: buildUserPrompt(pc)},
		},
		Stream: stream,
	}
	if stream {
		request.StreamOptions = &chatStreamOptions{IncludeUsage: true}
		request.Thinking = &chatThinking{Type: "enabled"}
		request.ReasoningEffort = "high"
	}
	return json.Marshal(request)
}

const maxResponseBytes = 4 << 20 // 4 MiB：防异常超大响应占内存

// buildSystemPrompt 组装 system prompt：指令 + bot-api 类型摘要 + 手册语料。
func buildSystemPrompt(manual []string) string {
	var b strings.Builder
	b.WriteString(systemInstruction())
	if len(manual) > 0 {
		b.WriteString("\n\n## 参考手册\n\n以下为玩家手册相关章节，写作时遵守其中的 API 语义与规则：\n\n")
		b.WriteString(strings.Join(manual, "\n\n---\n\n"))
	}
	return b.String()
}

// buildUserPrompt 组装 user prompt：当前脚本 + 当前玩家合法感知 + 指令。
func buildUserPrompt(pc PromptContext) string {
	var b strings.Builder
	b.WriteString("## 当前脚本（rev " + fmt.Sprint(pc.ScriptRev) + "）\n\n```js\n")
	b.WriteString(pc.CurrentScript)
	b.WriteString("\n```\n")
	if pc.Perception != "" {
		b.WriteString("\n## 当前玩家感知快照（只读 JSON）\n\n```json\n")
		b.WriteString(pc.Perception)
		b.WriteString("\n```\n")
	}
	b.WriteString("\n## 玩家指令\n\n")
	b.WriteString(pc.Instruction)
	return b.String()
}

// extractScript 从模型输出提取代码与说明：
// 优先取 ``` 围栏代码块（最后一个代码块视为新版脚本，前文为改动说明）；
// 无围栏时整个输出视为脚本（指令已要求只输出代码）。
func extractScript(content string) (script, explain string, ok bool) {
	fenceStart := strings.Index(content, "```")
	if fenceStart < 0 {
		s := strings.TrimSpace(content)
		return s, "", s != ""
	}
	explain = strings.TrimSpace(content[:fenceStart])

	// 收集所有围栏代码块，取最后一个为脚本（说明文字若写成代码块会被跳过）。
	var blocks []string
	rest := content[fenceStart:]
	for {
		open := strings.Index(rest, "```")
		if open < 0 {
			break
		}
		after := rest[open+3:]
		// 跳过语言标注行（```ts / ```typescript / ```js）。
		if nl := strings.IndexByte(after, '\n'); nl >= 0 {
			lang := strings.TrimSpace(after[:nl])
			if lang != "" && !strings.ContainsAny(lang, "`") {
				after = after[nl+1:]
			}
		}
		close := strings.Index(after, "```")
		if close < 0 {
			// 未闭合：取到末尾。
			blocks = append(blocks, strings.TrimSpace(after))
			break
		}
		blocks = append(blocks, strings.TrimSpace(after[:close]))
		rest = after[close+3:]
	}
	if len(blocks) == 0 {
		return "", "", false
	}
	return blocks[len(blocks)-1], explain, true
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…(truncated)"
}

// ---- DeepSeek chat/completions wire types（仅取所需字段）----

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model           string             `json:"model"`
	Messages        []chatMessage      `json:"messages"`
	Stream          bool               `json:"stream"`
	StreamOptions   *chatStreamOptions `json:"stream_options,omitempty"`
	Thinking        *chatThinking      `json:"thinking,omitempty"`
	ReasoningEffort string             `json:"reasoning_effort,omitempty"`
}

type chatThinking struct {
	Type string `json:"type"`
}

type chatStreamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

type chatStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
		} `json:"delta"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}
