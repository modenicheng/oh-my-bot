package netws

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// 端到端：客户端 ping → 服务器 pong 回显；服务器主动下行消息。
func TestPingPongAndDownlink(t *testing.T) {
	h := Handler(func(send func([]byte)) func([]byte) {
		go send(append([]byte{0x03}, []byte("hello")...))
		return nil
	})

	s := httptest_server(h)
	defer s.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, s.URL+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()

	if err := c.Write(ctx, websocket.MessageBinary, []byte{0x00, 1, 2, 3}); err != nil {
		t.Fatal(err)
	}

	gotDown, gotPong := false, false
	for !gotDown || !gotPong {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (down=%v pong=%v)", err, gotDown, gotPong)
		}
		if len(data) == 0 {
			continue
		}
		switch data[0] {
		case 0x03: // 下行
			if !bytes.Equal(data[1:], []byte("hello")) {
				t.Fatalf("downlink payload: %q", data[1:])
			}
			gotDown = true
		case 0x01: // pong 回显
			if !bytes.Equal(data[1:], []byte{1, 2, 3}) {
				t.Fatalf("pong echo: %v", data[1:])
			}
			gotPong = true
		case 0x00: // 服务器心跳 ping，忽略
		default:
			t.Fatalf("unexpected frame kind %d", data[0])
		}
	}
}
