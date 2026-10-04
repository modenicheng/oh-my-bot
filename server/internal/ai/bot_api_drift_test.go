package ai

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Bot Script API 漂移对拍（审计 X-1/D1）：AI system prompt 的类型摘要
// （provider_prompt.go botAPITypes 手抄镜像）必须覆盖 @omb/bot-api 声明的
// 全部可调用方法，防止 AI 助手建议不存在的 API 或漏掉新增 API。
// 与 script/bot_api_drift_test.go（goja 绑定对拍）、
// client/src/workbench/bot-api-drift.test.ts（补全表对拍）三侧互钉。

const botApiPath = "../../../packages/bot-api/src/index.ts"

var botApiMethodPat = regexp.MustCompile(`(?m)^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\(`)

func botApiCallables(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(botApiPath)
	if err != nil {
		t.Skipf("bot-api source not readable: %v", err)
	}
	src := string(raw)
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

func TestSystemPromptCoversBotApiMethods(t *testing.T) {
	prompt := systemInstruction() + botAPITypes()
	var missing []string
	for _, name := range botApiCallables(t) {
		if !strings.Contains(prompt, name+"(") {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("AI system prompt missing bot-api methods %v — update provider_prompt.go botAPITypes mirror", missing)
	}
}
