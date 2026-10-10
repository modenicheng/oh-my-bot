package main

import (
	"strings"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/glue"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// SystemSay 是 cmd/omb 上行路由唯一的系统 Say 构造点。机器人 0 + 事件
// 封装 + “join failed:” 前缀是客户端契约（RoomSession 视其为终态停止重试）。
func TestSystemSayWireContract(t *testing.T) {
	msg := glue.SystemSay("join failed: readonly spectator connection")
	ev := msg.GetEvent()
	if ev == nil {
		t.Fatal("SystemSay is not an event message")
	}
	say := ev.GetSay()
	if say == nil {
		t.Fatal("SystemSay is not a Say event")
	}
	if say.GetRobot() != 0 {
		t.Fatalf("system Say robot = %d, want 0", say.GetRobot())
	}
	if !strings.HasPrefix(say.GetText(), "join failed:") {
		t.Fatalf("system Say lost join-failed prefix: %q", say.GetText())
	}
}

// 上行拒绝路径仍输出同构消息（原三处内联构造的回归闸）。X-4：结构化
// notice 先到，兼容 join-failed say 紧随，两者文本同源。
func TestUpstreamRejectionsUseSystemSay(t *testing.T) {
	h := glue.NewHub()
	var session *glue.Session
	var received []*ombv1.ServerMsg
	send := func(msg *ombv1.ServerMsg) { received = append(received, msg) }
	handleUpstream(h, &ombv1.ClientMsg{Payload: &ombv1.ClientMsg_Spectate{Spectate: &ombv1.SpectateRoom{RoomCode: "SYSAY"}}}, send, send, nil, &session)
	if session == nil || !session.IsSpectator() {
		t.Fatal("spectator not bound")
	}
	for _, cmd := range []*ombv1.ClientMsg{
		{Payload: &ombv1.ClientMsg_Join{Join: &ombv1.JoinRoom{RoomCode: "SYSAY", Nick: "intruder"}}},
		{Payload: &ombv1.ClientMsg_Say{Say: &ombv1.Say{Text: "hello"}}},
		{Payload: &ombv1.ClientMsg_AiPrompt{AiPrompt: &ombv1.AiPrompt{Text: "prompt"}}},
	} {
		received = nil
		handleUpstream(h, cmd, send, send, nil, &session)
		if len(received) != 2 {
			t.Fatalf("command %T: got %d messages, want 2", cmd.Payload, len(received))
		}
		notice := received[0].GetEvent().GetControlNotice()
		if notice == nil || notice.GetCode() != ombv1.EvControlNotice_CN_READONLY_SPECTATOR {
			t.Fatalf("command %T: first message is not a readonly-spectator notice: %+v", cmd.Payload, received[0])
		}
		say := received[1].GetEvent().GetSay()
		if say == nil || say.GetRobot() != 0 || !strings.HasPrefix(say.GetText(), "join failed:") {
			t.Fatalf("command %T: second message is not a robot-0 join-failed Say: %+v", cmd.Payload, received[1])
		}
	}
}
