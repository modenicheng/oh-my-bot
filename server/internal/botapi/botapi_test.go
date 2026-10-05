package botapi

import (
	"os"
	"strings"
	"testing"
)

// botApiPath 指向仓库内 bot-api 单源。测试工作目录为 server/internal/botapi。
const botApiPath = "../../../packages/bot-api/src/index.ts"

// TestGeneratedSourceIsFresh 对拍嵌入副本与权威源：index.ts 改动后必须
// 重新运行 `pnpm --filter @omb/bot-api gen`（否则 AI prompt 语料、
// 契约测试与补全表都会消费过期 API 描述）。
func TestGeneratedSourceIsFresh(t *testing.T) {
	raw, err := os.ReadFile(botApiPath)
	if err != nil {
		t.Skipf("bot-api source not readable: %v", err)
	}
	if got := string(raw); got != Source {
		firstDiff := firstDifference(got, Source)
		t.Fatalf("server/internal/botapi/bot_api.gen.ts 与权威源漂移（首个差异在 %d 字节附近）。\n修改 packages/bot-api/src/index.ts 后运行: pnpm --filter @omb/bot-api gen", firstDiff)
	}
}

// TestSourceDeclaresCoreInterfaces 防生成器/权威源结构性退化：
// AI prompt 与补全表依赖这些 interface 面存在。
func TestSourceDeclaresCoreInterfaces(t *testing.T) {
	for _, name := range []string{
		"interface Vec2", "interface RobotRef", "interface WallRef", "interface HealthPackRef",
		"interface ProjectileRef", "interface Observation", "interface Self", "interface GameInfo",
		"interface L0", "interface L1", "interface ScriptConsole", "interface BotContext", "interface BotModule",
	} {
		if !strings.Contains(Source, "export "+name) {
			t.Errorf("bot-api source missing %q", name)
		}
	}
}

func firstDifference(a, b string) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	if len(a) != len(b) {
		return n
	}
	return -1
}
