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
//   - script log：owner-only Console 低优先队列——可丢，不影响游戏可靠消息
//
// 会话用帧首字节区分：发送侧 sendReliable/sendLossy；接收侧对下行业务帧
// 解析 ServerMsg.payload：snapshot → lossy 队列，其余 → reliable 队列。
package netws

import (
	"context"
	"encoding/binary"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
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

	lossyQueueLen     = 4    // 丢帧通道小缓冲：只保留最新几帧
	scriptLogQueueLen = 32   // Console 独立低优先队列：满时只丢日志
	reliableQueueLn   = 1024 // 可靠通道大缓冲：满即断
)

// queuedFrame keeps superseded match snapshots and logs out of the new map's timeline.
// Epochs are transport-local; the protobuf contract remains unchanged.
type queuedFrame struct {
	data      []byte
	epoch     uint64
	bootstrap bool
	scriptLog *ombv1.EvScriptLog
}

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

		// 下行队列：游戏可靠消息优先；Console 有独立小队列且可丢。
		reliableCh := make(chan queuedFrame, reliableQueueLn)
		lossyCh := make(chan queuedFrame, lossyQueueLen)
		scriptLogCh := make(chan queuedFrame, scriptLogQueueLen)
		var epoch atomic.Uint64
		var droppedScriptLogs atomic.Uint64
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
			if log := msg.GetEvent().GetScriptLog(); log != nil {
				b := encode(msg)
				if b == nil {
					return
				}
				select {
				case scriptLogCh <- queuedFrame{data: b, epoch: epoch.Load(), scriptLog: log}:
				default:
					droppedScriptLogs.Add(1)
				}
				return
			}

			b := encode(msg)
			if b == nil {
				return
			}
			frame := queuedFrame{data: b}
			if msg.GetEvent().GetMapBootstrap() != nil {
				frame.bootstrap = true
				frame.epoch = epoch.Add(1)
			}
			select {
			case reliableCh <- frame:
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
			case lossyCh <- queuedFrame{data: b, epoch: epoch.Load()}:
			default: // 慢消费者：丢 delta，客户端 base_tick 检测后重同步
			}
		}

		connOnUp := sessionFactory(sendReliable, sendLossy)

		readerErr := make(chan error, 1)
		go func() {
			for {
				// A half-open connection must eventually unregister and release held input.
				readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
				_, data, err := c.Read(readCtx)
				cancel()
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

		var deliveredEpoch uint64
		var lastScriptLog *ombv1.EvScriptLog
		var lastDropNotice time.Time
		writeReliable := func(frame queuedFrame) error {
			if frame.bootstrap {
				deliveredEpoch = frame.epoch
				droppedScriptLogs.Store(0)
				lastScriptLog = nil
			}
			return write(frame.data)
		}
		writeDropNotice := func(now time.Time) error {
			if lastScriptLog == nil || now.Sub(lastDropNotice) < time.Second {
				return nil
			}
			dropped := droppedScriptLogs.Swap(0)
			if dropped == 0 {
				return nil
			}
			b := encode(scriptLogDropNotice(lastScriptLog, dropped))
			if b == nil {
				return nil
			}
			if err := write(b); err != nil {
				return err
			}
			lastDropNotice = now
			return nil
		}
		writeScriptLog := func(frame queuedFrame) error {
			if frame.epoch != deliveredEpoch {
				return nil
			}
			lastScriptLog = frame.scriptLog
			if err := writeDropNotice(time.Now()); err != nil {
				return err
			}
			return write(frame.data)
		}

		for {
			// 优先级：reliable > lossy > script log。先排空高优先通道。
			select {
			case frame := <-reliableCh:
				if err := writeReliable(frame); err != nil {
					return
				}
				continue
			default:
			}
			select {
			case frame := <-lossyCh:
				if frame.epoch == deliveredEpoch {
					if err := write(frame.data); err != nil {
						return
					}
				}
				continue
			default:
			}
			select {
			case frame := <-scriptLogCh:
				if err := writeScriptLog(frame); err != nil {
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
			case frame := <-reliableCh:
				if err := writeReliable(frame); err != nil {
					return
				}
			case frame := <-lossyCh:
				if frame.epoch != deliveredEpoch {
					continue
				}
				if err := write(frame.data); err != nil {
					return
				}
			case frame := <-scriptLogCh:
				if err := writeScriptLog(frame); err != nil {
					return
				}
			case now := <-pingTicker.C:
				if err := writeDropNotice(now); err != nil {
					return
				}
				var ts [9]byte
				ts[0] = framePing
				binary.LittleEndian.PutUint64(ts[1:], uint64(now.UnixNano()))
				if err := write(ts[:]); err != nil {
					return
				}
			}
		}
	})
}

func scriptLogDropNotice(log *ombv1.EvScriptLog, dropped uint64) *ombv1.ServerMsg {
	return &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Tick: log.GetTick(),
		Kind: &ombv1.ServerEvent_ScriptLog{ScriptLog: &ombv1.EvScriptLog{
			RobotId: log.GetRobotId(), ScriptRev: log.GetScriptRev(), Tick: log.GetTick(),
			Level: "warn", Text: fmt.Sprintf("transport backlog: dropped %d console message(s)", dropped), Truncated: true,
		}},
	}}}
}

// sendLossyRaw 以可靠通道回 pong（ping/pong 属控制帧，不参与 lossy 丢弃）。
func sendLossyRaw(ch chan queuedFrame, b []byte) {
	select {
	case ch <- queuedFrame{data: b}:
	default:
	}
}
