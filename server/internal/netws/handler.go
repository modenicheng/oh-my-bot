// Package netws 实现 ADR-0012：WebSocket 传输端点。
// 帧协议（二进制）：首字节为帧类型。
//
//	0x00 ping（任一方向；载荷 8B 时间戳）
//	0x01 pong（收到 ping 的一方回显载荷）
//	0x02 上行 ClientMsg（protobuf）
//	0x03 下行 ServerMsg（protobuf）
//
// 双通道语义（Round 2 计划 A2）：
//   - reliable：事件/tombstone 混合帧/MapBootstrap/ScriptResult/AiUsage——
//     队列满 = 断开连接（丢任何一条都破坏状态一致性）
//   - lossy：delta 快照——可丢，客户端靠 base_tick 检测缺口后 ResyncRequest
//
// 会话用帧首字节区分：发送侧 sendReliable/sendLossy；接收侧对下行业务帧
// 解析 ServerMsg.payload：snapshot → lossy 队列，其余 → reliable 队列。
package netws

import (
	"context"
	"encoding/binary"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

const (
	framePing byte = 0x00
	framePong byte = 0x01
	frameUp   byte = 0x02
	frameDown byte = 0x03

	lossyQueueLen   = 4    // 丢帧通道小缓冲：只保留最新几帧
	reliableQueueLn = 1024 // 可靠通道大缓冲：满即断
)

// Handler 返回 /ws 端点。sessionFactory 在每次握手成功后调用一次，返回该连接
// 专属的 onUp（闭包可捕获每连接状态）；sendReliable/sendLossy 为该连接的下行通道。
// 后续上行 ClientMsg 帧路由到返回的 onUp。
func Handler(sessionFactory func(sendReliable, sendLossy func(*ombv1.ServerMsg)) (onUp func(up *ombv1.ClientMsg))) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{})
		if err != nil {
			return
		}
		defer c.CloseNow()

		ctx := r.Context()

		// 下行队列：reliable 优先投递（事件先于快照，避免旧快照覆盖新事件后的状态）。
		reliableCh := make(chan []byte, reliableQueueLn)
		lossyCh := make(chan []byte, lossyQueueLen)
		dead := make(chan struct{})
		var deadOnce sync.Once
		kill := func() { deadOnce.Do(func() { close(dead) }) }

		encode := func(msg *ombv1.ServerMsg) []byte {
			body, err := proto.Marshal(msg)
			if err != nil {
				return nil
			}
			return append([]byte{frameDown}, body...)
		}

		sendReliable := func(msg *ombv1.ServerMsg) {
			b := encode(msg)
			if b == nil {
				return
			}
			select {
			case reliableCh <- b:
			default:
				kill() // 可靠通道满 = 一致性已破坏，断开由客户端重连+Resync 恢复
			}
		}
		sendLossy := func(msg *ombv1.ServerMsg) {
			b := encode(msg)
			if b == nil {
				return
			}
			select {
			case lossyCh <- b:
			default: // 慢消费者：丢 delta，客户端 base_tick 检测后重同步
			}
		}

		connOnUp := sessionFactory(sendReliable, sendLossy)

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
					sendLossyRaw(reliableCh, append([]byte{framePong}, data[1:]...))
				case frameUp:
					msg := &ombv1.ClientMsg{}
					if err := proto.Unmarshal(data[1:], msg); err != nil {
						continue // 畸形上行丢弃
					}
					if connOnUp != nil {
						connOnUp(msg)
					}
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
			// 优先级：reliable > lossy。先非阻塞排空 reliable，再阻塞等待任意通道。
			// 注意：阻塞分支必须再含 reliableCh（排空与新帧间的竞态窗口）。
			select {
			case b := <-reliableCh:
				if err := write(b); err != nil {
					return
				}
				continue
			default:
			}
			select {
			case <-ctx.Done():
				return
			case <-dead:
				return
			case err := <-readerErr:
				_ = err
				return
			case b := <-reliableCh:
				if err := write(b); err != nil {
					return
				}
			case b := <-lossyCh:
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

// sendLossyRaw 以可靠通道回 pong（ping/pong 属控制帧，不参与 lossy 丢弃）。
func sendLossyRaw(ch chan []byte, b []byte) {
	select {
	case ch <- b:
	default:
	}
}
