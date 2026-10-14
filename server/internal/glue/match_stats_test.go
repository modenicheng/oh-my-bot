package glue

import (
	"testing"
)

// Match 观测窗口（批 2）：step 计入墙钟，窗口随步进增长，p95 ≥ avg。
func TestMatchStatSnapshotRecordsTickWindow(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("MSTAT")
	pilot, _ := bindLogged(t, h, rc, "pilot")
	m, err := NewMatch(rc, 7, 1, map[uint64]SessionInfo{
		pilot.playerID: {PlayerID: pilot.playerID, Nick: pilot.nick, Color: pilot.color},
	}, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	m.handle = nil
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
