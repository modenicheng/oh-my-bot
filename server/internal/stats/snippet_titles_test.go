package stats

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// snippetUsage 构造 sim 埋点的真实事件（最终输出轴为 N 时产生）。
func snippetUsage(tick, robot uint32, axes uint32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_SnippetUsage{SnippetUsage: &ombv1.EvSnippetUsage{Robot: robot, Axes: axes}}}
}

// OLD_SCHOOL：AI=0 但有 SnippetUsage → 不授予；AI=0 且无 SnippetUsage → 授予。
func TestTitleOldSchoolBlockedBySnippetUsage(t *testing.T) {
	p := NewProjector()
	p.OnEvent(10, snippetUsage(10, 2, 1)) // r2 真实用过 snippet（N 轴被最终采用）
	p.OnEvent(20, core(20, 2, 10))        // r2 干净分数
	p.OnEvent(30, kill(30, 3, 2, 0))      // r3 干净
	p.OnEvent(40, matchEnd(40))
	rows := feedFinal(p)
	if titlesOf(t, rows[2])[ombv1.Title_OLD_SCHOOL] {
		t.Errorf("robot 2 (snippet usage) wrongly awarded OLD_SCHOOL")
	}
	if !titlesOf(t, rows[3])[ombv1.Title_OLD_SCHOOL] {
		t.Errorf("robot 3 (clean) missing OLD_SCHOOL; titles=%v", rows[3].Titles)
	}
	// AI 使用同样阻断（双门之一）。
	p2 := NewProjector()
	p2.OnEvent(10, aiUsage(10, 5, 1))
	p2.OnEvent(20, matchEnd(20))
	if titlesOf(t, feedFinal(p2)[5])[ombv1.Title_OLD_SCHOOL] {
		t.Errorf("robot 5 (AI rounds) wrongly awarded OLD_SCHOOL")
	}
}

// 仅配置 snippet 但从未被最终采用（无 EvSnippetUsage）不阻断 OLD_SCHOOL——
// 埋点语义：配置本身不是使用。
func TestTitleOldSchoolIgnoresConfiguredButUnusedSnippets(t *testing.T) {
	p := NewProjector()
	// 无 snippetUsage 事件 = 配置了但从未产生 N 轴输出。
	p.OnEvent(10, core(10, 7, 10))
	p.OnEvent(20, matchEnd(20))
	if !titlesOf(t, feedFinal(p)[7])[ombv1.Title_OLD_SCHOOL] {
		t.Fatal("configured-but-unused snippet must not block OLD_SCHOOL")
	}
}

// projector 端到端：sim 事件流（含 SnippetUsage）驱动 OLD_SCHOOL 门。
func TestProjectorCountsSnippetUsageTelemetry(t *testing.T) {
	p := NewProjector()
	p.OnEvent(5, snippetUsage(5, 1, 2))
	p.OnEvent(6, snippetUsage(6, 1, 4))
	p.OnEvent(7, snippetUsage(7, 2, 1))
	p.OnEvent(9, matchEnd(9))
	rows := feedFinal(p)
	for _, id := range rows[1].Titles {
		if id == ombv1.Title_OLD_SCHOOL {
			t.Fatal("r1 with 2 usage events must not hold OLD_SCHOOL")
		}
	}
	for _, id := range rows[2].Titles {
		if id == ombv1.Title_OLD_SCHOOL {
			t.Fatal("r2 with usage must not hold OLD_SCHOOL")
		}
	}
}
