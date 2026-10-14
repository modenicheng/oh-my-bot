package room

import "testing"

func TestDurationConfigCreationWindowOnly(t *testing.T) {
	// 真实建房时序：NewRoom → SetDurationConfig（创建窗口）→ Join。
	fresh := NewRoom("DURABL", 1)
	if !fresh.SetDurationConfig(7200, 3600) {
		t.Fatal("creation-window config rejected on fresh room")
	}
	if mt, ct := fresh.DurationConfig(); mt != 7200 || ct != 3600 {
		t.Fatalf("config = %d/%d, want 7200/3600", mt, ct)
	}
	if err := fresh.Join(2, "p2", "red"); err != nil {
		t.Fatal(err)
	}
	if fresh.SetDurationConfig(100, 50) {
		t.Fatal("config accepted after a member seated")
	}
	if mt, _ := fresh.DurationConfig(); mt != 7200 {
		t.Fatal("rejected write mutated stored config")
	}
	r, _ := newTestRoom(t)
	mustAction(t, r, 1, ActionWarmup)
	if r.SetDurationConfig(100, 50) {
		t.Fatal("config accepted outside Idle")
	}
}
