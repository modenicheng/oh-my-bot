// Package netws 实现 ADR-0012：WebSocket 传输端点。
// 帧协议（二进制）：首字节为帧类型。
//
//	0x00 ping（任一方向；载荷为 8B 时间戳）
//	0x01 pong（收到 ping 的一方回显载荷）
//	0x02 上行业务消息（protobuf，待 protocol schema 落地）
//	0x03 下行业务消息
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

// Handler 返回 /ws 端点。onConnect 在握手成功后回调：入参 send 用于下行推送，
// 返回值作为上行业务帧回调（可为 nil）。
func Handler(onConnect func(send func([]byte)) func([]byte)) http.Handler {
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

		onMsg := onConnect(send)
		if onMsg == nil {
			onMsg = func([]byte) {}
		}

		readerErr := make(chan error, 1)
		go func() {
			defer close(readerErr)
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
				default:
					onMsg(data)
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
				_ = err // 连接断开或读错误
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
