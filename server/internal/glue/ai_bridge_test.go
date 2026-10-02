package glue

import (
	"context"
	"strings"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/ai"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestNormalizeAIPrompt(t *testing.T) {
	if got, ok := normalizeAIPrompt("  改成巡逻  "); !ok || got != "改成巡逻" {
		t.Fatalf("normalize = %q,%v", got, ok)
	}
	if _, ok := normalizeAIPrompt(" \n\t "); ok {
		t.Fatal("blank prompt accepted")
	}
	if _, ok := normalizeAIPrompt(strings.Repeat("血", aiMaxPromptRunes+1)); ok {
		t.Fatal("oversize prompt accepted")
	}
}

func TestSnapshotCarriesAuthoritativeAIQuota(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("AI-QUOTA")
	p, log := bindLogged(t, h, rc, "pilot")
	quota := ai.NewQuotaService(ai.DefaultQuotaConfig())
	svc := &AIService{quota: quota, playerTokensK: ai.DefaultPlayerTokens / 1000}
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{p.playerID: {PlayerID: p.playerID, Nick: p.nick}}, true, svc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	m.bootstrapLocked(p)
	rc.mu.Unlock()
	log.take()

	lease, err := quota.TryAcquire(context.Background(), p.playerID)
	if err != nil {
		t.Fatal(err)
	}
	if !quota.Commit(lease, ai.Usage{TokensDelta: 1000}) {
		t.Fatal("quota commit rejected")
	}
	m.step()
	self := lastSnapshot(t, log.take()).Self
	if self.AiRoundsLeft != ai.DefaultPlayerRounds-1 || self.AiTokensLeftK != ai.DefaultPlayerTokens/1000-1 {
		t.Fatalf("snapshot quota = rounds %d tokens %dk", self.AiRoundsLeft, self.AiTokensLeftK)
	}
}

func TestMarshalAIPerceptionStripsPrivateFields(t *testing.T) {
	self := sim.RobotView{ID: 1, Pos: sim.Vec2{X: 1, Y: 2}, Vel: sim.Vec2{X: 3, Y: 4}, HpX10: 850, EnergyX10: 420, Nick: "private-self", Color: "#secret"}
	obs := sim.Observation{
		Frame:       sim.FrameView{Tick: 99, Phase: sim.PhaseCoreOpen, TimeLeftS: 123, Map: &sim.MapDef{Walls: []sim.Wall{{ID: 7, Min: sim.Vec2{X: -1, Y: -2}, Max: sim.Vec2{X: 1, Y: 2}}}}},
		Robots:      []sim.RobotView{self, {ID: 2, Pos: sim.Vec2{X: 5, Y: 6}, HpX10: 500, Nick: "private-enemy", Color: "#leak"}},
		Cores:       []sim.CoreView{{ID: 3, Pos: sim.Vec2{X: 8, Y: 9}, Value: 10, Alive: true}},
		HealthPacks: []sim.HealthPackView{{ID: 4, Pos: sim.Vec2{X: 2, Y: 3}, Available: true}},
		Uplinks:     []sim.UplinkView{{ID: 5, Pos: sim.Vec2{X: 4, Y: 5}, Active: true, PersonalCDs: map[uint32]uint32{1: 12, 2: 99}}},
		Projectiles: []sim.ProjView{{ID: 6, Owner: 2, Pos: sim.Vec2{X: 7, Y: 8}}},
	}
	raw := marshalAIPerception(self, obs)
	for _, leak := range []string{"private-self", "private-enemy", "#secret", "#leak", "\"2\":99"} {
		if strings.Contains(raw, leak) {
			t.Fatalf("private field leaked: %q in %s", leak, raw)
		}
	}
	for _, want := range []string{"CORE_OPEN", "\"my_cooldown_s\":12", "\"walls\"", "\"projectiles\""} {
		if !strings.Contains(raw, want) {
			t.Fatalf("perception missing %q: %s", want, raw)
		}
	}
}
