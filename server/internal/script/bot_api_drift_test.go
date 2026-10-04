package script

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/dop251/goja"
)

// Bot Script API 漂移对拍（审计 X-1/D1）：goja 运行时绑定（context.go 的
// vmToFns 表）必须与 @omb/bot-api 声明的可调用面一致。四处平行定义
// （bot-api ↔ provider_prompt.go ↔ bot-completions.ts ↔ context.go）任一
// 漂移都会在这里或对应 TS 测试失败。
//
// 真实现是本包的 context.go；bot-api 是玩家手册/AI 语料的单源 IDL。
// 本测试只对拍「成员名集合」，不比对签名细节（重载/参数在两侧语言天然异构）。

// botApiPath 指向仓库内 bot-api 单源。测试在 package script 下运行，
// 工作目录为 server/internal/script。
const botApiPath = "../../../packages/bot-api/src/index.ts"

var botApiMethodPat = regexp.MustCompile(`(?m)^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\(`)

// botApiCallables 返回 L0 ∪ L1 ∪ BotContext 声明的全部可调用成员名。
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
	// L0/L1 的 aimAt 在 BotContext 上重载合并； BotContext 自身声明的
	// scan/aimAt 已由正则覆盖。deprecated 的 api 属性不是方法绑定。
	delete(seen, "api")
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// interfaceBody 提取 `interface <name> ... { ... }` 块（首个闭合大括号止，
// 容忍成员行内注释与 JSDoc）。
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

// runtimeBotMethods 返回 goja 侧 bot 对象实际绑定的方法名（buildTickContext
// 把 vmBindings.fns 全量挂到 bot 壳上）。取自 context.go 的 vmToFns 注册表。
func runtimeBotMethods() []string {
	// newVMBindings 不依赖运行中的 tick；只需一个空 VM 构造绑定表。
	bindings := newVMBindings(goja.New())
	out := make([]string, 0, len(bindings.fns))
	for name := range bindings.fns {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func TestBotApiBindingsMatchIDL(t *testing.T) {
	want := botApiCallables(t)
	got := runtimeBotMethods()
	if strings.Join(want, ",") != strings.Join(got, ",") {
		t.Fatalf("bot method surface drifted from @omb/bot-api:\n  bindings: %v\n  bot-api: %v\n（context.go 与 packages/bot-api/src/index.ts 需同步维护）", got, want)
	}
}
