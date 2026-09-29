package netws

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// 端到端：客户端 ping→pong 回显；0x02 上行帧触发 0x03 下行。
func TestPingPongAndDownlink(t *testing.T) {
	h := Handler(func(up []byte, send func([]byte)) {
		// 回显上行业务载荷作为下行业务帧（联调用）。
		send(append([]byte{0x03}, up...))
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
	if err := c.Write(ctx, websocket.MessageBinary, []byte{0x02, 0xAA, 0xBB}); err != nil {
		t.Fatal(err)
	}

	gotPong, gotDown := false, false
	for !gotPong || !gotDown {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (pong=%v down=%v)", err, gotPong, gotDown)
		}
		if len(data) == 0 {
			continue
		}
		switch data[0] {
		case 0x01:
			if !bytes.Equal(data[1:], []byte{1, 2, 3}) {
				t.Fatalf("pong echo: %v", data[1:])
			}
			gotPong = true
		case 0x03:
			if !bytes.Equal(data[1:], []byte{0xAA, 0xBB}) {
				t.Fatalf("downlink echo: %v", data[1:])
			}
			gotDown = true
		case 0x00: // 服务器心跳 ping，忽略
		default:
			t.Fatalf("unexpected frame kind %d", data[0])
		}
	}
}
