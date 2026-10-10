package main

import (
	"strings"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/glue"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// joinCase 组装一次上行 Join 并经 handleUpstream 路由（与生产同路径）。
func joinCase(roomCode, nick string) *ombv1.ClientMsg {
	return &ombv1.ClientMsg{Payload: &ombv1.ClientMsg_Join{Join: &ombv1.JoinRoom{
		RoomCode: roomCode, Nick: nick, Color: "red",
	}}}
}

// TestJoinRejectsInvalidParams（审计 S-31）：空房码/非法字符房码/空昵称一律
// 走 sendJoinFailedReliable 双形态拒绝（结构化 CN_JOIN_FAILED notice 在前、
// 兼容 "join failed:" say 在后），且不创建会话。
func TestJoinRejectsInvalidParams(t *testing.T) {
	cases := []struct {
		name     string
		roomCode string
		nick     string
	}{
		{"empty room code", "", "alice"},
		{"lowercase room code", "spec", "alice"},
		{"confusable digit", "AB12", "alice"},
		{"confusable letter", "TAKEOVER", "alice"},
		{"path hostile", "../etc", "alice"},
		{"blank nick", "SPEC", "   "},
		{"tabs-only nick", "SPEC", "\t\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := glue.NewHub()
			var session *glue.Session
			var received []*ombv1.ServerMsg
			send := func(msg *ombv1.ServerMsg) { received = append(received, msg) }
			handleUpstream(h, joinCase(tc.roomCode, tc.nick), send, send, nil, &session)
			if session != nil {
				t.Fatalf("invalid join (%q,%q) bound a session", tc.roomCode, tc.nick)
			}
			if len(received) != 2 {
				t.Fatalf("got %d messages, want notice+say pair: %+v", len(received), received)
			}
			notice := received[0].GetEvent().GetControlNotice()
			if notice == nil || notice.GetCode() != ombv1.EvControlNotice_CN_JOIN_FAILED || notice.GetText() == "" {
				t.Fatalf("first message is not a CN_JOIN_FAILED notice: %+v", received[0])
			}
			if got := received[1].GetEvent().GetSay().GetText(); !strings.HasPrefix(got, joinFailedPrefix) {
				t.Fatalf("second message lost join-failed prefix: %q", got)
			}
		})
	}
}

// spectateCase 组装一次上行 Spectate 并经 handleUpstream 路由（与生产同路径）。
func spectateCase(roomCode string) *ombv1.ClientMsg {
	return &ombv1.ClientMsg{Payload: &ombv1.ClientMsg_Spectate{Spectate: &ombv1.SpectateRoom{
		RoomCode: roomCode,
	}}}
}

// TestSpectateRejectsInvalidRoomCode（审计 S-31）：观战路径与 join 同一房码门，
// 空房码/非法字符不再创建共享 "" 观战房，拒绝走同一 join-failed 双形态。
func TestSpectateRejectsInvalidRoomCode(t *testing.T) {
	for name, code := range map[string]string{"empty": "", "confusable": "LIVEBOT"} {
		t.Run(name, func(t *testing.T) {
			h := glue.NewHub()
			var session *glue.Session
			var received []*ombv1.ServerMsg
			send := func(msg *ombv1.ServerMsg) { received = append(received, msg) }
			handleUpstream(h, spectateCase(code), send, send, nil, &session)
			if session != nil {
				t.Fatalf("invalid spectate (%q) bound a session", code)
			}
			if len(received) != 2 {
				t.Fatalf("got %d messages, want notice+say pair: %+v", len(received), received)
			}
			notice := received[0].GetEvent().GetControlNotice()
			if notice == nil || notice.GetCode() != ombv1.EvControlNotice_CN_JOIN_FAILED || notice.GetText() == "" {
				t.Fatalf("first message is not a CN_JOIN_FAILED notice: %+v", received[0])
			}
			if got := received[1].GetEvent().GetSay().GetText(); !strings.HasPrefix(got, joinFailedPrefix) {
				t.Fatalf("second message lost join-failed prefix: %q", got)
			}
		})
	}
}

// TestJoinAcceptsValidParams：合法房码 + 带空白昵称照常进房，昵称以 trim 后
// 的值绑定（与客户端表单行为一致），并回房态广播。
func TestJoinAcceptsValidParams(t *testing.T) {
	h := glue.NewHub()
	var session *glue.Session
	var received []*ombv1.ServerMsg
	send := func(msg *ombv1.ServerMsg) { received = append(received, msg) }
	handleUpstream(h, joinCase("HEALTH", "  alice  "), send, send, nil, &session)
	if session == nil {
		t.Fatal("valid join did not bind a session")
	}
	rc := h.EnsureRoom("HEALTH")
	if rc.Room.MemberCount() != 1 {
		t.Fatalf("room members = %d, want 1", rc.Room.MemberCount())
	}
	if state := rc.Room.StateBroadcast(); state.GetHostNick() != "alice" {
		t.Fatalf("bound nick = %q, want trimmed %q", state.GetHostNick(), "alice")
	}
	sawState := false
	for _, msg := range received {
		if msg.GetEvent().GetRoomState() != nil {
			sawState = true
		}
	}
	if !sawState {
		t.Fatal("join did not broadcast room state")
	}
}
