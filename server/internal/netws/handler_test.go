package netws

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func wsURL(s *testserverT) string { return "ws" + s.URL[4:] + "/ws" }

// TestFrameBytesPinned 钉住 ADR-0012 首字节帧协议：与客户端
// packages/protocol/src/messages.ts 的 frame 常量（由 golden.test.ts 互钉）
// 保持同一组值。任一侧改动都会在两侧测试同时失败。
func TestFrameBytesPinned(t *testing.T) {
	if framePing != 0x00 || framePong != 0x01 || frameUp != 0x02 || frameDown != 0x03 {
		t.Fatalf("frame bytes drifted: ping=%#02x pong=%#02x up=%#02x down=%#02x",
			framePing, framePong, frameUp, frameDown)
	}
}

// dialAndKick：拨号后发送一帧空 ClientMsg，触发 onUp（会话装配）。
func dialAndKick(t *testing.T, ctx context.Context, s *testserverT) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.Dial(ctx, wsURL(s), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	if err := c.Write(ctx, websocket.MessageBinary, []byte{frameUp}); err != nil {
		t.Fatal(err)
	}
	return c
}

// TestGracefulCloseDrainsQueuedFrames（审计 S-33）：closeConn 前入队的可靠帧
// 必须全部送达，随后连接关闭（同身份接管时旧连接的 takeover 通知依赖此
// 语义——不能像 reliableCh 满 kill 那样立即断连截断队列）。
func TestGracefulCloseDrainsQueuedFrames(t *testing.T) {
	var sendReliable func(*ombv1.ServerMsg)
	var closeConn func()
	ready := make(chan struct{})
	h := Handler(func(sr, sl func(*ombv1.ServerMsg), cc func()) func(up *ombv1.ClientMsg) {
		sendReliable, closeConn = sr, cc
		close(ready)
		return func(*ombv1.ClientMsg) {}
	})
	s := newTestServer(h)
	defer s.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	c := dialAndKick(t, ctx, s)
	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("onUp never fired")
	}

	sayMsg := func(text string) *ombv1.ServerMsg {
		return &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
			Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: 0, Text: text}}}}}
	}
	const frames = 8
	for i := 0; i < frames; i++ {
		sendReliable(sayMsg(fmt.Sprintf("takeover-%02d", i)))
	}
	closeConn()

	got := map[string]bool{}
	deadline := time.Now().Add(4 * time.Second)
	for len(got) < frames {
		rctx, rcancel := context.WithDeadline(ctx, deadline)
		msg := readServerMsg(t, c, rctx)
		rcancel()
		if text := msg.GetEvent().GetSay().GetText(); text != "" {
			got[text] = true
		}
	}
	for i := 0; i < frames; i++ {
		if !got[fmt.Sprintf("takeover-%02d", i)] {
			t.Fatalf("graceful close dropped a frame queued before closeConn: %v", got)
		}
	}
	// 全部送达后连接必须关闭（优雅关闭不是永生）。
	for {
		rc, rcancel := context.WithDeadline(ctx, deadline)
		_, _, err := c.Read(rc)
		rcancel()
		if err != nil {
			return // 连接已关闭 = 通过
		}
		if time.Now().After(deadline) {
			t.Fatal("graceful close never closed the connection")
		}
	}
}

// TestGracefulCloseWithEmptyQueues：空队列时 closeConn 立即关闭（无帧可等）。
func TestGracefulCloseWithEmptyQueues(t *testing.T) {
	var closeConn func()
	ready := make(chan struct{})
	h := Handler(func(sr, sl func(*ombv1.ServerMsg), cc func()) func(up *ombv1.ClientMsg) {
		closeConn = cc
		close(ready)
		return func(*ombv1.ClientMsg) {}
	})
	s := newTestServer(h)
	defer s.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	c := dialAndKick(t, ctx, s)
	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("onUp never fired")
	}
	closeConn()
	deadline := time.Now().Add(3 * time.Second)
	for {
		rc, rcancel := context.WithDeadline(ctx, deadline)
		_, _, err := c.Read(rc)
		rcancel()
		if err != nil {
			return // 连接已关闭 = 通过
		}
		if time.Now().After(deadline) {
			t.Fatal("graceful close never closed the connection")
		}
	}
}

// 双通道投递：reliable 不丢、lossy 可到；优先级（同时排队时 reliable 先出）
// 由两级 select 实现，跨入队时序不保证，故此处断言集合而非顺序。
func TestDualChannelDelivery(t *testing.T) {
	var sendReliable, sendLossy func(*ombv1.ServerMsg)
	ready := make(chan struct{})
	h := Handler(func(sr, sl func(*ombv1.ServerMsg), _ func()) func(up *ombv1.ClientMsg) {
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
	h := Handler(func(sr, sl func(*ombv1.ServerMsg), _ func()) func(up *ombv1.ClientMsg) {
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

// TestReadLimitAllows64KiBScriptSubmit 钉住读上限：默认 32768 装不下 TS 提交帧
// （编译 JS + TS 原文同帧可达 ~53 KiB），会被 coder/websocket 以
// StatusMessageTooBig 默默断连。上限与客户端预检同源 TransportTiming。
func TestReadLimitAllows64KiBScriptSubmit(t *testing.T) {
	var got atomic.Int32
	h := Handler(func(sr, sl func(*ombv1.ServerMsg), _ func()) func(up *ombv1.ClientMsg) {
		return func(up *ombv1.ClientMsg) {
			if sub := up.GetScriptSubmit(); sub != nil {
				got.Add(int32(len(sub.GetSource())))
			}
		}
	})
	s := newTestServer(h)
	defer s.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL(s), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })

	// 用真实 protobuf 组装 ~53 KB 的 TS 提交帧（与 oracle.ts 实测同量级），
	// 覆盖旧默认 32768 读上限会断连的区间。
	js := "function tick(bot) {} // " + strings.Repeat("a", 25484)
	ts := "function tick(bot: BotContext) {} // " + strings.Repeat("b", 27364)
	sub := &ombv1.ClientMsg{Payload: &ombv1.ClientMsg_ScriptSubmit{ScriptSubmit: &ombv1.ScriptSubmit{
		Source: js, EditorSource: &ts,
		Language: ombv1.ScriptLanguage_SCRIPT_LANGUAGE_TS.Enum(),
	}}}
	body, err := proto.Marshal(sub)
	if err != nil {
		t.Fatal(err)
	}
	frame := append([]byte{frameUp}, body...)
	if len(frame) <= 32768 || len(frame) > int(maxFrameBytes) {
		t.Fatalf("test frame %d bytes must be in (32768, %d]", len(frame), maxFrameBytes)
	}
	if err := c.Write(ctx, websocket.MessageBinary, frame); err != nil {
		t.Fatal(err)
	}

	// 连接必须存活且 onUp 必须收到（旧默认上限会直接断连）。
	deadline := time.Now().Add(3 * time.Second)
	for got.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := got.Load(); n != int32(len(js)) {
		t.Fatalf("server received %d source bytes, want %d (read limit regression?)", n, len(js))
	}
}

func TestReliableOverflowDisconnects(t *testing.T) {
	big := strings.Repeat("x", 4096)
	h := Handler(func(sr, sl func(*ombv1.ServerMsg), _ func()) func(up *ombv1.ClientMsg) {
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
