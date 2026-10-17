package glue

import (
	"os"
	"strings"
	"testing"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/room"
)

func TestFailedLaunchCanRetry(t *testing.T) {
	for _, warmup := range []bool{false, true} {
		t.Run(map[bool]string{false: "idle", true: "warmup"}[warmup], func(t *testing.T) {
			t.Chdir(t.TempDir())
			h := NewHub()
			rc := h.EnsureRoom("FAILTEST")
			host, messages := bindLogged(t, h, rc, "host")
			rc.EnsureLauncher()
			if warmup {
				host.HostCommand(ombv1.RoomAction_WARMUP)
				m := waitPublished(t, rc, nil)
				t.Cleanup(func() { stopTestMatch(t, m) })
			}
			// Force a real assembly error without depending on CPU scheduling.
			if err := os.MkdirAll("data", 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile("data/matches", []byte("blocked"), 0o600); err != nil {
				t.Fatal(err)
			}
			messages.take()
			host.HostCommand(ombv1.RoomAction_START)
			failed := false
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) && !failed {
				for _, sent := range messages.take() {
					if say := sent.msg.GetEvent().GetSay(); say != nil && strings.HasPrefix(say.Text, "match launch failed:") {
						failed = true
					}
				}
				if !failed {
					time.Sleep(time.Millisecond)
				}
			}
			if !failed {
				t.Fatal("assembly failure was not reported")
			}
			if got := rc.Room.State(); got != room.Ended {
				t.Fatalf("failed assembly left room %s; host cannot retry", got)
			}
			if rc.currentMatch() != nil {
				t.Fatal("failed assembly retained the previous match")
			}
			if rc.Room.MemberCount() != 1 || rc.Room.HostID() != host.playerID {
				t.Fatal("failure lost the room identity or host")
			}
			if err := os.Remove("data/matches"); err != nil {
				t.Fatal(err)
			}
			host.HostCommand(ombv1.RoomAction_START)
			m := waitPublished(t, rc, nil)
			t.Cleanup(func() { stopTestMatch(t, m) })
			if m.warmup || m.robotOf[host.playerID] == 0 {
				t.Fatal("retry did not start a scored match for the host")
			}
		})
	}
}
