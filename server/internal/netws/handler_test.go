package netws

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func wsURL(s *testserverT) string { return "ws" + s.URL[4:] + "/ws" }

// dialAndKick：拨号后发送一帧空 ClientMsg，触发 onUp（会话装配）。
func dialAndKick(t *testing.T, ctx context.Context, s *testserverT) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.Dial(ctx, wsURL(s), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	if err := c.Write(ctx, websocket.MessageBinary, []byte{frameUp}); err != nil {
		t.Fatal(err)
	}
	return c
}

// 双通道投递：reliable 不丢、lossy 可到；优先级（同时排队时 reliable 先出）
// 由两级 select 实现，跨入队时序不保证，故此处断言集合而非顺序。
func TestDualChannelDelivery(t *testing.T) {
	var sendReliable, sendLossy func(*ombv1.ServerMsg)
	ready := make(chan struct{})
	h := Handler(func(sr, sl func(*ombv1.ServerMsg)) func(up *ombv1.ClientMsg) {
		sendReliable, sendLossy = sr, sl
		close(ready)
		return func(*ombv1.ClientMsg) {}
	})
	s := newTestServer(h)
	defer s.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c := dialAndKick(t, ctx, s)

	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("onUp never fired")
	}

	sayMsg := func(text string) *ombv1.ServerMsg {
		return &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
			Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: 1, Text: text}}}}}
	}
	sendLossy(sayMsg("snap"))
	sendReliable(sayMsg("evt"))

	got := map[string]bool{}
	for i := 0; i < 2; i++ {
		msg := readServerMsg(t, c, ctx)
		got[msg.GetEvent().GetSay().GetText()] = true
	}
	if !got["snap"] || !got["evt"] {
		t.Fatalf("missing frames: %v", got)
	}
}

// reliable 队列满 → 断开（一致性破坏保护）。
// 大帧（4KB）灌满 socket 缓冲 → writer 阻塞 → 队列真实填满 → kill。
func TestScriptLogFloodDoesNotDisconnectOrBlockReliable(t *testing.T) {
	var sendReliable func(*ombv1.ServerMsg)
	ready := make(chan struct{})
	h := Handler(func(sr, sl func(*ombv1.ServerMsg)) func(up *ombv1.ClientMsg) {
		sendReliable = sr
		close(ready)
		return func(*ombv1.ClientMsg) {}
	})
	s := newTestServer(h)
	defer s.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	c := dialAndKick(t, ctx, s)
	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("onUp never fired")
	}

	big := strings.Repeat("l", 4096)
	logMsg := func(i int) *ombv1.ServerMsg {
		return &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
			Tick: uint32(i), Kind: &ombv1.ServerEvent_ScriptLog{ScriptLog: &ombv1.EvScriptLog{
				RobotId: 1, ScriptRev: 9, Tick: uint32(i), Level: "debug", Text: big,
			}},
		}}}
	}
	// Do not read while flooding: the writer eventually blocks on the socket, but
	// ScriptLog must only fill its own 32-slot queue and never kill the connection.
	for i := 0; i < 10_000; i++ {
		sendReliable(logMsg(i))
	}
	sendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: 1, Text: "reliable-marker"}},
	}}})

	markerSeen := false
	notices := 0
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) && (!markerSeen || notices == 0) {
		rctx, rcancel := context.WithDeadline(ctx, deadline)
		msg := readServerMsg(t, c, rctx)
		rcancel()
		if msg.GetEvent().GetSay().GetText() == "reliable-marker" {
			markerSeen = true
		}
		if strings.HasPrefix(msg.GetEvent().GetScriptLog().GetText(), "transport backlog: dropped ") {
			notices++
		}
	}
	if !markerSeen {
		t.Fatal("reliable marker was blocked or connection closed by console flood")
	}
	if notices != 1 {
		t.Fatalf("want one bounded drop notice, got %d", notices)
	}
}

func TestReliableOverflowDisconnects(t *testing.T) {
	big := strings.Repeat("x", 4096)
	h := Handler(func(sr, sl func(*ombv1.ServerMsg)) func(up *ombv1.ClientMsg) {
		ev := &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
			Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: 1, Text: big}}}}}
		go func() {
			for i := 0; i < reliableQueueLn*4; i++ {
				sr(ev) // 持续灌满：触发 kill
			}
		}()
		return func(*ombv1.ClientMsg) {}
	})
	s := newTestServer(h)
	defer s.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	c := dialAndKick(t, ctx, s)

	// 服务器应主动断开：循环读直到连接关闭（灌入帧会被先读到，最终 EOF）。
	deadline := time.Now().Add(5 * time.Second)
	for {
		rc, cancel := context.WithDeadline(ctx, deadline)
		_, _, err := c.Read(rc)
		cancel()
		if err != nil {
			return // 连接断开 = 通过
		}
		if time.Now().After(deadline) {
			t.Fatal("expected disconnect after reliable overflow, still open")
		}
	}
}

func readServerMsg(t *testing.T, c *websocket.Conn, ctx context.Context) *ombv1.ServerMsg {
	t.Helper()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if len(data) < 2 || data[0] != frameDown {
			continue // ping/pong 跳过
		}
		msg := &ombv1.ServerMsg{}
		if err := proto.Unmarshal(data[1:], msg); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		return msg
	}
}
