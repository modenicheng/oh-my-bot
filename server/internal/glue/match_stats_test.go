package glue

import (
	"testing"

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
	if !st.Warmup {
		t.Fatal("warmup flag lost")
	}
}
