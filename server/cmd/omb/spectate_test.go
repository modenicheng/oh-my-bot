package main

import (
	"strings"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/glue"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func TestSpectatorUpstreamRoleCannotPromoteOrControl(t *testing.T) {
	h := glue.NewHub()
	var session *glue.Session
	var received []*ombv1.ServerMsg
	send := func(msg *ombv1.ServerMsg) { received = append(received, msg) }
	handleUpstream(h, &ombv1.ClientMsg{Payload: &ombv1.ClientMsg_Spectate{Spectate: &ombv1.SpectateRoom{RoomCode: "SPEC"}}}, send, send, nil, &session)
	if session == nil || !session.IsSpectator() {
		t.Fatal("spectator not bound")
	}
	original := session
	rc := h.EnsureRoom("SPEC")
	commands := []*ombv1.ClientMsg{
		{Payload: &ombv1.ClientMsg_Join{Join: &ombv1.JoinRoom{RoomCode: "SPEC", Nick: "intruder"}}},
		{Payload: &ombv1.ClientMsg_Spectate{Spectate: &ombv1.SpectateRoom{RoomCode: "ELSE"}}},
		{Payload: &ombv1.ClientMsg_Input{Input: &ombv1.ClientInput{Seq: 1, MoveX: 1000}}},
		{Payload: &ombv1.ClientMsg_WarmupInput{WarmupInput: &ombv1.ClientInput{Seq: 2, Fire: true}}},
		{Payload: &ombv1.ClientMsg_RoomAction{RoomAction: &ombv1.RoomAction{Kind: ombv1.RoomAction_START}}},
		{Payload: &ombv1.ClientMsg_RoomAction{RoomAction: &ombv1.RoomAction{Kind: ombv1.RoomAction_ABORT}}},
		{Payload: &ombv1.ClientMsg_ScriptSubmit{ScriptSubmit: &ombv1.ScriptSubmit{Source: "function tick() {}"}}},
		{Payload: &ombv1.ClientMsg_AssistToggle{AssistToggle: &ombv1.AssistToggle{}}},
		{Payload: &ombv1.ClientMsg_AiPrompt{AiPrompt: &ombv1.AiPrompt{Text: "prompt"}}},
		{Payload: &ombv1.ClientMsg_ScriptRollback{ScriptRollback: &ombv1.ScriptRollback{VersionId: 1}}},
		{Payload: &ombv1.ClientMsg_Say{Say: &ombv1.Say{Text: "hello"}}},
	}
	for _, cmd := range commands {
		received = nil
		handleUpstream(h, cmd, send, send, nil, &session)
		if session != original || !session.IsSpectator() || rc.Room.MemberCount() != 0 || rc.Room.HostID() != 0 {
			t.Fatalf("command %T changed spectator identity or room", cmd.Payload)
		}
		// X-4：拒绝 = 结构化 notice + 兼容 join-failed say（顺序固定：notice 在前）。
		if len(received) != 2 {
			t.Fatalf("command %T: got %d messages, want 2", cmd.Payload, len(received))
		}
		notice := received[0].GetEvent().GetControlNotice()
		if notice == nil || notice.GetCode() != ombv1.EvControlNotice_CN_READONLY_SPECTATOR {
			t.Fatalf("command %T: first message is not a readonly-spectator notice: %+v", cmd.Payload, received[0])
		}
		if !strings.HasPrefix(received[1].GetEvent().GetSay().GetText(), "join failed:") {
			t.Fatalf("command %T: second message lost join-failed prefix", cmd.Payload)
		}
	}
	received = nil
	handleUpstream(h, &ombv1.ClientMsg{Payload: &ombv1.ClientMsg_ResyncRequest{ResyncRequest: &ombv1.ResyncRequest{}}}, send, send, nil, &session)
	if session != original || len(received) != 0 {
		t.Fatal("idle spectator resync changed role")
	}
	handleUpstream(h, &ombv1.ClientMsg{Payload: &ombv1.ClientMsg_Leave{Leave: &ombv1.LeaveRoom{}}}, send, send, nil, &session)
	if session != nil || rc.Room.MemberCount() != 0 {
		t.Fatal("leave did not detach spectator")
	}
}
