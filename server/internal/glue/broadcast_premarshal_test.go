package glue

import (
	"bytes"
	"testing"

	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// 广播预编码（批 2）：broadcastFrame 的帧字节必须与 netws 逐连接编码逐位
// 一致（0x03 + protobuf），否则新旧路径混布时同一房间不同连接收到不同帧。
func TestBroadcastFrameMatchesPerConnectionEncoding(t *testing.T) {
	msg := &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Tick: 42,
		Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: 3, Text: "hello"}},
	}}}
	frame := broadcastFrame(msg)
	if frame == nil {
		t.Fatal("say broadcast not pre-marshallable")
	}
	body, err := proto.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	want := append([]byte{byte(ombv1.TransportTiming_FRAME_DOWN)}, body...)
	if !bytes.Equal(frame, want) {
		t.Fatalf("frame mismatch:\n got %x\nwant %x", frame, want)
	}
}

// 不适用预编码的消息必须回退：ScriptLog 走可丢队列、MapBootstrap 推进
// epoch、非事件消息无广播语义。
func TestBroadcastFrameExcludesSpecialRoutes(t *testing.T) {
	scriptLog := &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_ScriptLog{ScriptLog: &ombv1.EvScriptLog{RobotId: 1}},
	}}}
	bootstrap := &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_MapBootstrap{MapBootstrap: &ombv1.EvMapBootstrap{MapJson: "{}"}},
	}}}
	if broadcastFrame(scriptLog) != nil {
		t.Fatal("script log must not take the pre-marshaled path")
	}
	if broadcastFrame(bootstrap) != nil {
		t.Fatal("map bootstrap must not take the pre-marshaled path")
	}
	if broadcastFrame(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: &ombv1.SnapshotDelta{}}}) != nil {
		t.Fatal("non-event message must not take the pre-marshaled path")
	}
}

// 注入了帧通道的会话收到共享帧字节；未注入的会话回退 SendReliable 收到
// 等价消息——同一广播对两类连接产生相同的可见内容。
func TestBroadcastLockedUsesFramePathWhenAvailable(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("PREM")
	msg := say("广播内容")

	var gotFrame []byte
	framed := NewSession(func(m *ombv1.ServerMsg) { t.Fatal("framed session must not use per-connection path") },
		func(*ombv1.ServerMsg) {}, func(b []byte) { gotFrame = append(gotFrame[:0], b...) })
	plain := NewSession(func(m *ombv1.ServerMsg) {
		if m.GetEvent().GetSay().GetText() != msg.GetEvent().GetSay().GetText() {
			t.Fatalf("legacy session got %+v", m)
		}
	}, func(*ombv1.ServerMsg) {}, nil)
	h.Register(framed)
	h.Register(plain)
	if err := rc.Bind(framed, "framee", "#fff"); err != nil {
		t.Fatal(err)
	}
	if err := rc.Bind(plain, "plain", "#fff"); err != nil {
		t.Fatal(err)
	}

	rc.mu.Lock()
	rc.broadcastLocked(msg)
	rc.mu.Unlock()

	want := broadcastFrame(msg)
	if want == nil {
		t.Fatal("say must be pre-marshallable")
	}
	if !bytes.Equal(gotFrame, want) {
		t.Fatalf("framed session bytes %x, want %x", gotFrame, want)
	}
}
