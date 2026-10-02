package netws

import (
	"context"
	"testing"
	"time"

	"github.com/coder/websocket"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// Fill both queues before the writer starts. An old delta must not follow the
// new bootstrap/full even when its tick is greater than every new-match tick.
func TestBootstrapDiscardsQueuedPreviousMatchScriptLog(t *testing.T) {
	h := Handler(func(reliable, lossy func(*ombv1.ServerMsg)) func(*ombv1.ClientMsg) {
		reliable(scriptLogMessage(900, "old-epoch"))
		reliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_MapBootstrap{MapBootstrap: &ombv1.EvMapBootstrap{MapJson: "{}"}}}}})
		reliable(scriptLogMessage(1, "new-epoch"))
		return func(*ombv1.ClientMsg) {}
	})
	s := newTestServer(h)
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL(s), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if readServerMsg(t, c, ctx).GetEvent().GetMapBootstrap() == nil {
		t.Fatal("bootstrap must precede new-epoch script logs")
	}
	if log := readServerMsg(t, c, ctx).GetEvent().GetScriptLog(); log.GetText() != "new-epoch" {
		t.Fatalf("previous-match script log leaked across bootstrap: %v", log)
	}
}

func scriptLogMessage(tick uint32, text string) *ombv1.ServerMsg {
	return &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Tick: tick, Kind: &ombv1.ServerEvent_ScriptLog{ScriptLog: &ombv1.EvScriptLog{
			RobotId: 1, ScriptRev: 1, Tick: tick, Level: "log", Text: text,
		}},
	}}}
}

func TestBootstrapDiscardsQueuedPreviousMatchDelta(t *testing.T) {
	h := Handler(func(reliable, lossy func(*ombv1.ServerMsg)) func(*ombv1.ClientMsg) {
		lossy(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: &ombv1.SnapshotDelta{Tick: 900, BaseTick: 899}}})
		reliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_MapBootstrap{MapBootstrap: &ombv1.EvMapBootstrap{MapJson: "{}"}}}}})
		reliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: &ombv1.SnapshotDelta{Tick: 1, Full: true}}})
		lossy(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: &ombv1.SnapshotDelta{Tick: 2, BaseTick: 1}}})
		return func(*ombv1.ClientMsg) {}
	})
	s := newTestServer(h)
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL(s), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if readServerMsg(t, c, ctx).GetEvent().GetMapBootstrap() == nil {
		t.Fatal("bootstrap must precede the new snapshots")
	}
	if snap := readServerMsg(t, c, ctx).GetSnapshot(); snap.GetTick() != 1 || !snap.GetFull() {
		t.Fatalf("expected new full snapshot, got %v", snap)
	}
	if snap := readServerMsg(t, c, ctx).GetSnapshot(); snap.GetTick() != 2 {
		t.Fatalf("previous-match delta leaked across bootstrap: %v", snap)
	}
}
