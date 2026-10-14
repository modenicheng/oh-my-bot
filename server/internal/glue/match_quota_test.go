package glue

import (
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/script"
)

// 脚本配额分档（批 2）：随花名册规模单调收紧；≤64 与包默认一致。
func TestScriptTickQuotaTiers(t *testing.T) {
	cases := []struct {
		players int
		want    time.Duration
	}{
		{1, 0}, {64, 0}, {65, 6 * time.Millisecond}, {128, 6 * time.Millisecond},
		{129, 4 * time.Millisecond}, {200, 4 * time.Millisecond},
	}
	for _, tc := range cases {
		if got := scriptTickQuota(tc.players); got != tc.want {
			t.Fatalf("players %d: quota = %v, want %v", tc.players, got, tc.want)
		}
	}
	// 0 值语义：script 包按 DefaultTickTimeout（10ms）处理。
	if cfg := (script.Config{TickTimeout: scriptTickQuota(64)}); cfg.TickTimeout != 0 {
		t.Fatal("small roster must keep the package default")
	}
}
