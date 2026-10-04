package script

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/dop251/goja"

	"github.com/modenicheng/oh-my-bot/server/internal/botapi"
)

// Bot Script API 漂移对拍（审计 X-1）：goja 运行时绑定（context.go 的
// vmToFns 表）必须与 @omb/bot-api 声明的可调用面一致。四处平行定义
//（bot-api ↔ provider_prompt.go ↔ bot-completions.ts ↔ context.go）中，
// 前三处已单源化（botapi embed + 生成补全表）；本测试钉死最后一处：
// 真实现 context.go 的方法名与运行时签名必须与权威源一致。
//
// 本测试对拍「成员名集合」+「运行时签名探针」（重载/参数在两侧语言
// 天然异构，故签名以权威源声明为期望、运行时 JS 可调用性为实测）。

var botApiMethodPat = regexp.MustCompile(`(?m)^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\(`)

// botApiCallables 返回 L0 ∪ L1 ∪ BotContext 声明的全部可调用成员名
// （期望面来自 server/internal/botapi 内嵌的权威源副本）。
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

// botApiMethodParamCounts 从权威源提取各方法的最小参数个数（重载取最小：
// BotContext.aimAt 两个单参重载记 1；move(vx, vy) 记 2）。运行时探针用
// 最小参数数逐方法调用（goja 侧多余实参被忽略，不足则 undefined）。
func botApiMethodParamCounts(t *testing.T) map[string]int {
	t.Helper()
	src := botapi.Source
	linePat := regexp.MustCompile(`^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*:`)
	out := map[string]int{}
	for _, name := range []string{"L0", "L1", "BotContext"} {
		body := interfaceBody(src, name)
		if body == "" {
			t.Fatalf("interface %s not found in bot-api source", name)
		}
		for _, line := range strings.Split(body, "\n") {
			m := linePat.FindStringSubmatch(strings.TrimSpace(line))
			if m == nil || m[1] == "api" {
				continue
			}
			inner := strings.TrimSpace(m[2])
			n := 0
			if inner != "" {
				n = 1
				depth := 0
				for _, ch := range inner {
					switch ch {
					case '(', '<', '{', '[':
						depth++
					case ')', '>', '}', ']':
						depth--
					case ',':
						if depth == 0 {
							n++
						}
					}
				}
			}
			if cur, ok := out[m[1]]; !ok || n < cur {
				out[m[1]] = n
			}
		}
	}
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

// botApiPath 指向仓库内 bot-api 单源（新鲜度测试在 internal/botapi 对拍；
// 此路径仅用于 skip 语义保持一致）。
const botApiPath = "../../../packages/bot-api/src/index.ts"

func TestBotApiBindingsMatchIDL(t *testing.T) {
	if _, err := os.Stat(botApiPath); err != nil {
		t.Skipf("bot-api source not readable: %v", err)
	}
	want := botApiCallables(t)
	got := runtimeBotMethods()
	if strings.Join(want, ",") != strings.Join(got, ",") {
		t.Fatalf("bot method surface drifted from @omb/bot-api:\n  bindings: %v\n  bot-api: %v\n（context.go 与 packages/bot-api/src/index.ts 需同步维护）", got, want)
	}
}

// TestBotApiRuntimeSignaturesCallable 运行时签名探针：权威源声明的每个
// 方法在 goja bot 对象上必须以声明参数个数可调用（无参方法 0 参、单参
// 方法 1 参）。这防住「名字对上了但绑定吃错参数个数」的漂移。
func TestBotApiRuntimeSignaturesCallable(t *testing.T) {
	if _, err := os.Stat(botApiPath); err != nil {
		t.Skipf("bot-api source not readable: %v", err)
	}
	params := botApiMethodParamCounts(t)
	if len(params) == 0 {
		t.Fatal("no methods parsed from bot-api source")
	}

	vm := goja.New()
	bindings := newVMBindings(vm)
	frame := testFrame()
	cmd := newCommandCollector()
	bot := bindings.buildTickContext(frame, cmd)

	// 每个方法以「声明参数个数」调用一次：参数全用安全值（0/false/{x:0,y:0}）。
	// 只验证 Function.call 返回不抛异常，不验证副作用（各轴语义另有单测）。
	for name, arity := range params {
		fn, ok := goja.AssertFunction(bot.Get(name))
		if !ok {
			t.Errorf("bot.%s is not callable at runtime", name)
			continue
		}
		args := make([]goja.Value, arity)
		for i := range args {
			switch name {
			case "shield":
				args[i] = vm.ToValue(false)
			case "moveTo", "navigateTo", "aimAt", "move":
				args[i] = vm.ToValue(map[string]float64{"x": 0, "y": 0})
			default:
				args[i] = vm.ToValue(0)
			}
		}
		// aimAt(RobotRef) 重载走 {id} 对象分支；aimAt(0) 走角度分支。两者都
		// 是合法调用面，这里用数值探针（角度分支）。
		if _, err := fn(goja.Undefined(), args...); err != nil {
			t.Errorf("bot.%s(%d args) runtime call failed: %v", name, arity, err)
		}
	}
}

// TestBotContextReadonlySurfaces bot 壳的只读属性面（self/game/api）在
// 运行时存在——IDL 的属性声明与 buildTickContext 的 defineReadonly 面对拍。
func TestBotContextReadonlySurfaces(t *testing.T) {
	vm := goja.New()
	bindings := newVMBindings(vm)
	bot := bindings.buildTickContext(testFrame(), newCommandCollector())
	for _, prop := range []string{"self", "game", "api"} {
		v := bot.Get(prop)
		if v == nil || goja.IsUndefined(v) {
			t.Errorf("bot.%s missing at runtime", prop)
			continue
		}
		o, ok := v.(*goja.Object)
		if !ok {
			t.Errorf("bot.%s is not an object", prop)
			continue
		}
		if prop == "self" {
			for _, f := range []string{"id", "hp", "energy", "position", "velocity"} {
				if goja.IsUndefined(o.Get(f)) {
					t.Errorf("bot.self.%s missing at runtime", f)
				}
			}
		}
		if prop == "game" {
			for _, f := range []string{"time", "timeLeft", "phase", "mapSeed"} {
				if goja.IsUndefined(o.Get(f)) {
					t.Errorf("bot.game.%s missing at runtime", f)
				}
			}
		}
	}
}
