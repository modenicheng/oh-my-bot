package ai

import (
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/botapi"
)

// Bot Script API 漂移对拍（审计 X-1）：AI system prompt 的类型摘要不再
// 手抄，而是内嵌 internal/botapi 的权威源副本。本测试双保险：
//   1. prompt 必须逐段包含权威源全文（防摘要被截断/手改）；
//   2. 权威源声明的全部可调用方法必须在 prompt 文本中出现。
//
// 与 script/bot_api_drift_test.go（goja 绑定对拍）、
// client/src/workbench/bot-api-drift.test.ts（补全表对拍）三侧互钉。

var botApiMethodPat = regexp.MustCompile(`(?m)^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\(`)

func botApiCallables(t *testing.T) []string {
	t.Helper()
	src := botapi.Source
	seen := map[string]bool{}
	for _, name := range []string{"L0", "L1", "BotContext"} {
		body := interfaceBody(src, name)
		if body == "" {
			t.Fatalf("interface %s not found in bot-api source", name)
		}
		for _, m := range botApiMethodPat.FindAllStringSubmatch(body, -1) {
			seen[m[1]] = true
		}
	}
	delete(seen, "api") // deprecated 兼容属性，AI 指令段已明确禁止生成 ctx.api
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func interfaceBody(src, name string) string {
	header := "interface " + name
	start := strings.Index(src, header)
	if start < 0 {
		return ""
	}
	open := strings.Index(src[start:], "{")
	if open < 0 {
		return ""
	}
	depth := 0
	for i := start + open; i < len(src); i++ {
		switch src[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return src[start+open : i+1]
			}
		}
	}
	return ""
}

// TestSystemPromptCoversBotApiMethods 权威源每个可调用方法都在 prompt 中。
func TestSystemPromptCoversBotApiMethods(t *testing.T) {
	prompt := systemInstruction()
	var missing []string
	for _, name := range botApiCallables(t) {
		if !strings.Contains(prompt, name+"(") {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("AI system prompt missing bot-api methods %v", missing)
	}
}

// TestSystemPromptEmbedsAuthoritativeSource prompt 的 API 段必须包含
// 权威源全文（注释剥离后）。手抄摘要回归（如重新引入镜像表）在此失败。
func TestSystemPromptEmbedsAuthoritativeSource(t *testing.T) {
	prompt := systemInstruction()
	for _, line := range strings.Split(botapi.Source, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "//") {
			continue
		}
		if i := strings.Index(line, " //"); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		trimmed = strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !strings.Contains(prompt, trimmed) {
			t.Fatalf("system prompt API 段缺权威源行: %q\n（prompt 应内嵌 botapi.Source；勿手抄镜像）", trimmed)
		}
	}
}
