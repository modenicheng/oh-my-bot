package glue

import (
	"context"
	"strings"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/ai"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestAIStreamTargetsCurrentOwnerSession(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("AI-STREAM")
	owner, ownerLog := bindLogged(t, h, rc, "owner")
	_, peerLog := bindLogged(t, h, rc, "peer")
	quota := ai.NewQuotaService(ai.DefaultQuotaConfig())
	svc := &AIService{quota: quota}
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{
		owner.playerID: {PlayerID: owner.playerID, Nick: owner.nick},
	}, true, svc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()
	ownerLog.take()
	peerLog.take()

	m.sendAIStream(owner.playerID, svc, quota.CurrentMatchSeq(), ai.StreamDelta{Kind: ai.StreamReasoning, Text: "first"})
	ownerMsgs := ownerLog.take()
	if len(ownerMsgs) != 1 || ownerMsgs[0].msg.GetEvent().GetAiStream().GetDelta() != "first" || ownerMsgs[0].msg.GetEvent().GetAiStream().GetKind() != ombv1.EvAiStream_REASONING || !ownerMsgs[0].reliable {
		t.Fatalf("owner stream messages = %+v", ownerMsgs)
	}
	if got := peerLog.take(); len(got) != 0 {
		t.Fatalf("peer received private AI stream: %+v", got)
	}

	replacement, replacementLog := bindLogged(t, h, rc, "owner")
	replacementLog.take() // takeover bootstrap
	m.sendAIStream(replacement.playerID, svc, quota.CurrentMatchSeq(), ai.StreamDelta{Kind: ai.StreamAnswer, Text: "second"})
	if got := ownerLog.take(); len(got) != 0 {
		t.Fatalf("superseded session received AI stream: %+v", got)
	}
	replacementMsgs := replacementLog.take()
	if len(replacementMsgs) != 1 || replacementMsgs[0].msg.GetEvent().GetAiStream().GetDelta() != "second" || replacementMsgs[0].msg.GetEvent().GetAiStream().GetKind() != ombv1.EvAiStream_ANSWER {
		t.Fatalf("replacement stream messages = %+v", replacementMsgs)
	}
}

func TestNormalizeAIPrompt(t *testing.T) {
	if got, ok := normalizeAIPrompt("  改成巡逻  "); !ok || got != "改成巡逻" {
		t.Fatalf("normalize = %q,%v", got, ok)
	}
	if _, ok := normalizeAIPrompt(" \n\t "); ok {
		t.Fatal("blank prompt accepted")
	}
	long := strings.Repeat("血", 20_000)
	if got, ok := normalizeAIPrompt(long); !ok || got != long {
		t.Fatal("long prompt should be accepted unchanged")
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
