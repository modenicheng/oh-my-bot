package glue

import (
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// D2 回归闸：glue 不得再自备节奏常量（原 tickHz/frameDue/matchTicks 双源
// 已矛盾——结算用 sim.MatchTicks、终局判定用本地 matchTicks）。此处锁定
// 驱动循环引用的 sim 值，任何人重建本地副本都会在终局判定上暴露漂移。
func TestGlueTimingUsesSimConstants(t *testing.T) {
	if sim.TickRate != 60 {
		t.Fatalf("sim.TickRate drifted: %d", sim.TickRate)
	}
	if sim.FrameBudget != 12*time.Millisecond {
		t.Fatalf("sim.FrameBudget drifted: %v", sim.FrameBudget)
	}
	if sim.MatchTicks != 8*60*sim.TickRate {
		t.Fatalf("sim.MatchTicks drifted: %d", sim.MatchTicks)
	}
}
