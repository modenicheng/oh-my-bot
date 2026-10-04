package glue

import (
	"os"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/ai"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// emitNonSimEvent 必须经 NewMatch 装配的有效 sink 链（multiSink：日志+glue）
// 而非双路由：正式局事件落盘且事件携带 tick；观战者同样收到广播。
func TestEmitNonSimEventUsesEffectiveSink(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("EMIT9")
	p, log := bindLogged(t, h, rc, "pilot")
	spec, specLog := bindSpectatorLogged(t, h, rc)
	players := map[uint64]SessionInfo{p.playerID: {PlayerID: p.playerID, Nick: p.nick, Color: p.color}}
	m, err := NewMatch(rc, 42, 1, players, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	log.take()
	specLog.take()
	m.tick = 7
	m.emitNonSimEvent(&ombv1.ServerEvent{Kind: &ombv1.ServerEvent_AiUsage{AiUsage: &ombv1.EvAiUsage{
		Robot: stableRobotID(p.playerID), RoundsDelta: 2,
	}}})
	rc.mu.Unlock()
	stopTestMatch(t, m)

	for name, msgs := range map[string][]sentMessage{"player": log.take(), "spectator": specLog.take()} {
		var usage []*ombv1.EvAiUsage
		for _, sm := range msgs {
			if u := sm.msg.GetEvent().GetAiUsage(); u != nil && !sm.reliable {
				t.Fatalf("%s received AiUsage on lossy channel", name)
			} else if u != nil {
				usage = append(usage, u)
			}
		}
		if len(usage) != 1 || usage[0].GetRoundsDelta() != 2 || usage[0].GetRobot() != stableRobotID(p.playerID) {
			t.Fatalf("%s AiUsage events = %+v", name, usage)
		}
	}

	f, err := os.Open("data/matches/EMIT9-1.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	records, err := sim.ReadMatchEventLog(f)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	persisted := 0
	for _, rec := range records {
		if u := rec.Event.GetAiUsage(); u != nil {
			persisted++
			if rec.Tick != 7 || rec.Event.GetTick() != 7 {
				t.Fatalf("persisted AiUsage tick = record %d / event %d, want 7", rec.Tick, rec.Event.GetTick())
			}
			if u.GetRoundsDelta() != 2 {
				t.Fatalf("persisted AiUsage = %+v", u)
			}
		}
	}
	if persisted != 1 {
		t.Fatalf("persisted AiUsage records = %d, want 1", persisted)
	}
	_ = spec
}

// 热身局无日志：事件仅广播，不落盘；glue sink 仍可见。
func TestEmitNonSimEventWarmupSkipsLog(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("EMIT9W")
	p, log := bindLogged(t, h, rc, "pilot")
	players := map[uint64]SessionInfo{p.playerID: {PlayerID: p.playerID, Nick: p.nick, Color: p.color}}
	m, err := NewMatch(rc, 42, 1, players, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	log.take()
	m.tick = 3
	m.emitNonSimEvent(&ombv1.ServerEvent{Kind: &ombv1.ServerEvent_AiUsage{AiUsage: &ombv1.EvAiUsage{
		Robot: stableRobotID(p.playerID), RoundsDelta: 1,
	}}})
	rc.mu.Unlock()
	count := 0
	for _, sm := range log.take() {
		if sm.msg.GetEvent().GetAiUsage() != nil {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("warmup broadcast AiUsage = %d, want 1", count)
	}
}

// sendAIUsageLocked 的完整链路（quota → 定向 AiQuota + 广播 AiUsage）复核
// emitNonSimEvent 改造后投影计数正确：aiRounds 累计触发 AI_REGULAR 称号。
func TestEmitNonSimEventProjectorCountsUsage(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("EMIT9P")
	p, log := bindLogged(t, h, rc, "pilot")
	quota := ai.NewQuotaService(ai.DefaultQuotaConfig())
	svc := &AIService{quota: quota}
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{p.playerID: {PlayerID: p.playerID, Nick: p.nick}}, false, svc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	log.take()
	m.tick = 2
	m.sendAIUsageLocked(p, p.playerID, svc, ai.Usage{RoundsDelta: 3, TokensDelta: 5, GlobalLeftK: 100}, true)
	rc.mu.Unlock()
	stopTestMatch(t, m)
	// Final() 在 matchEnded 后可用：以 AI_REGULAR 称号验证投影收到了事件。
	m.rc.mu.Lock()
	settled := settledMatchEnd(m.tick, m.proj.Final())
	m.rc.mu.Unlock()
	found := false
	for _, row := range settled.GetMatchEnd().GetScores() {
		if row.Robot == stableRobotID(p.playerID) {
			for _, title := range row.Titles {
				if title == ombv1.Title_AI_REGULAR {
					found = true
				}
			}
		}
	}
	if !found {
		t.Fatalf("projector did not count AiUsage (AI_REGULAR missing): %+v", settled.GetMatchEnd().GetScores())
	}
}
