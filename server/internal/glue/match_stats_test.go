package glue

import (
	"encoding/json"
	"testing"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// Match 观测窗口（批 2）：step 计入墙钟，窗口随步进增长，p95 ≥ avg。
func TestMatchStatSnapshotRecordsTickWindow(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("MSTAT")
	players := map[uint64]SessionInfo{}
	for i := 0; i < 24; i++ {
		s, _ := bindLogged(t, h, rc, nickOf(i))
		players[s.playerID] = SessionInfo{PlayerID: s.playerID, Nick: s.nick, Color: s.color}
	}
	m, err := NewMatch(rc, 7, 1, players, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	m.handle = nil
	// 交火负载：保证 tick 有可测时长（部分机器的快 tick 时钟读数会整量化为 0）。
	for _, pid := range m.robotOf {
		m.sim.ApplyInput(pid, &ombv1.ClientInput{Seq: 1, AxisMask: uint32(sim.AxisMove | sim.AxisFire), MoveX: 1000, Aim: 0.5, Fire: true})
	}
	rc.mu.Unlock()

	if st := m.StatSnapshot(); st.Tick != 0 || st.TickAvgMs != 0 {
		t.Fatalf("fresh match stats = %+v", st)
	}
	for i := 0; i < 5; i++ {
		m.step()
	}
	st := m.StatSnapshot()
	if st.Tick != 5 {
		t.Fatalf("tick = %d, want 5", st.Tick)
	}
	if st.TickAvgMs <= 0 || st.TickP95Ms < st.TickAvgMs {
		t.Fatalf("window stats not recorded: %+v", st)
	}
	if st.WindowTicks != 5 {
		t.Fatalf("window ticks = %d, want 5", st.WindowTicks)
	}
	if !st.Warmup {
		t.Fatal("warmup flag lost")
	}
	raw, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Stages map[string]struct {
			Avg float64 `json:"avg_ms"`
			P95 float64 `json:"p95_ms"`
			Max float64 `json:"max_ms"`
		} `json:"stages"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	var accounted float64
	for _, name := range []string{"lock_wait", "simulation", "observation", "scripts", "snapshot"} {
		stage, ok := decoded.Stages[name]
		if !ok || stage.Avg < 0 || stage.P95 < 0 || stage.Max < stage.P95 {
			t.Fatalf("missing/invalid stage %s: %s", name, raw)
		}
		accounted += stage.Avg
	}
	if accounted <= 0 || accounted > st.TickAvgMs {
		t.Fatalf("stage accounting %.6f exceeds total %.6f", accounted, st.TickAvgMs)
	}
}

func TestDurationStatsNearestRank(t *testing.T) {
	samples := make([]time.Duration, 100)
	for i := range samples {
		samples[i] = time.Duration(100-i) * time.Microsecond
	}
	got := durationStats(samples)
	if got.AvgMs != 0.0505 || got.P95Ms != 0.095 || got.MaxMs != 0.1 {
		t.Fatalf("duration summary = %+v", got)
	}
	if got := durationStats(nil); got != (DurationStats{}) {
		t.Fatalf("empty summary = %+v", got)
	}
}

func TestTickStageWindowRotatesTogether(t *testing.T) {
	m := &Match{}
	for i := 0; i <= tickStatWindowLen; i++ {
		m.tick = uint32(i + 1)
		sample := tickSample{observation: time.Microsecond}
		if i == 0 {
			sample.observation = time.Second
		}
		m.recordTickStat(time.Now(), sample)
	}
	got := m.StatSnapshot()
	if got.Tick != tickStatWindowLen+1 || got.WindowTicks != tickStatWindowLen || got.Stages.Observation.MaxMs != 0.001 {
		t.Fatalf("stage window failed to evict oldest sample: %+v", got)
	}
}

func TestTickTelemetryEventOfProjectsMatchStats(t *testing.T) {
	st := MatchStats{
		Tick: 123, TickAvgMs: 3.25, TickP95Ms: 8.5, WindowTicks: 60,
		ScriptDeferrals: 4, Warmup: true,
	}

	ev := tickTelemetryEventOf(st)
	telemetry := ev.GetTickTelemetry()
	if telemetry == nil {
		t.Fatal("tick telemetry event payload is nil")
	}
	if ev.GetTick() != st.Tick || telemetry.GetTick() != st.Tick ||
		telemetry.GetTickAvgMs() != st.TickAvgMs || telemetry.GetTickP95Ms() != st.TickP95Ms ||
		telemetry.GetWindowTicks() != st.WindowTicks || telemetry.GetScriptDeferrals() != st.ScriptDeferrals ||
		telemetry.GetTickRate() != 60 || telemetry.GetFrameBudgetMs() != 12 || !telemetry.GetWarmup() {
		t.Fatalf("telemetry = %+v, event tick = %d", telemetry, ev.GetTick())
	}
}
