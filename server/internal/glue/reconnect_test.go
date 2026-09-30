package glue

import (
	"sync"
	"testing"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func joinTestSession(t *testing.T, h *Hub, rc *RoomConn, nick string, send func(*ombv1.ServerMsg)) *Session {
	t.Helper()
	s := NewSession(send, send)
	h.Register(s)
	if err := rc.Bind(s, nick, "red"); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestNicknameTakeoverPreservesIdentity(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("restore")
	discard := func(*ombv1.ServerMsg) {}
	old := joinTestSession(t, h, rc, "host", discard)
	pid := old.playerID
	replacement := joinTestSession(t, h, rc, "host", discard)
	if replacement.playerID != pid || rc.Room.MemberCount() != 1 || rc.Room.HostID() != pid {
		t.Fatalf("takeover changed identity/seats: old=%d new=%d seats=%d", pid, replacement.playerID, rc.Room.MemberCount())
	}
	old.LeaveRoom()
	h.Unregister(old)
	if rc.sessionOf(pid) != replacement || rc.Room.MemberCount() != 1 {
		t.Fatal("stale close/leave removed replacement")
	}
	h.Unregister(replacement)
	if rc.sessionOf(pid) != nil {
		t.Fatal("disconnect retained active connection")
	}
	again := joinTestSession(t, h, rc, "host", discard)
	if again.playerID != pid || rc.Room.MemberCount() != 1 {
		t.Fatal("disconnect lost recovery identity")
	}
}

func TestNewMatchWaitsForPublication(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("ordering")
	var mu sync.Mutex
	count := 0
	s := joinTestSession(t, h, rc, "host", func(*ombv1.ServerMsg) { mu.Lock(); count++; mu.Unlock() })
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{s.playerID: {PlayerID: s.playerID, Nick: "host"}}, true)
	if err != nil {
		t.Fatal(err)
	}
	defer stopTestMatch(t, m)
	if !m.warmup {
		t.Error("warmup flag was dropped")
	}
	time.Sleep(40 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if count != 0 {
		t.Fatalf("unpublished match sent %d messages before bootstrap", count)
	}
}
