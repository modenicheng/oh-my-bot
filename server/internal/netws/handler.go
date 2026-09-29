// Package netws 实现 ADR-0012：WebSocket 传输端点。
// 帧协议（二进制）：首字节为帧类型。
//
//	0x00 ping（任一方向；载荷 8B 时间戳）
//	0x01 pong（收到 ping 的一方回显载荷）
//	0x02 上行 ClientMsg（protobuf）
//	0x03 下行 ServerMsg（protobuf）
package netws

import (
	"context"
	"encoding/binary"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

const (
	framePing byte = 0x00
	framePong byte = 0x01
	frameUp   byte = 0x02
	frameDown byte = 0x03
)

// Handler 返回 /ws 端点。onUp 在收到上行 ClientMsg 帧时回调（解析失败静默丢弃）；
// 返回的 send 用于异步下行 ServerMsg。会话内置心跳与慢消费者丢帧（快照冗余）。
func Handler(onUp func(up []byte, send func([]byte))) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{})
		if err != nil {
			return
		}
		defer c.CloseNow()

		ctx := r.Context()

		sendCh := make(chan []byte, 64)
		send := func(b []byte) {
			select {
			case sendCh <- b:
			default: // 慢消费者丢帧：60Hz 快照天然冗余
			}
		}

		readerErr := make(chan error, 1)
		go func() {
			for {
				_, data, err := c.Read(ctx)
				if err != nil {
					readerErr <- err
					return
				}
				if len(data) == 0 {
					continue
				}
				switch data[0] {
				case framePing:
					send(append([]byte{framePong}, data[1:]...))
				case frameUp:
					onUp(data[1:], send)
				}
			}
		}()

		pingTicker := time.NewTicker(2 * time.Second)
		defer pingTicker.Stop()

		write := func(b []byte) error {
			wctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			return c.Write(wctx, websocket.MessageBinary, b)
		}

		for {
			select {
			case <-ctx.Done():
				return
			case err := <-readerErr:
				_ = err
				return
			case b := <-sendCh:
				if err := write(b); err != nil {
					return
				}
			case <-pingTicker.C:
				var ts [9]byte
				ts[0] = framePing
				binary.LittleEndian.PutUint64(ts[1:], uint64(time.Now().UnixNano()))
				if err := write(ts[:]); err != nil {
					return
				}
			}
		}
	})
}
