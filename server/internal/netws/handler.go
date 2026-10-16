// Package netws 实现 ADR-0012：WebSocket 传输端点。
// 帧协议（二进制）：首字节为帧类型。
//
//	0x00 ping（任一方向；载荷 8B 时间戳）
//	0x01 pong（收到 ping 的一方回显载荷）
//	0x02 上行 ClientMsg（protobuf）
//	0x03 下行 ServerMsg（protobuf）
//	0x04 negotiated compact snapshot (omb.binary.v1)
//	0x05 negotiated ordered batch (omb.binary.v1)
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
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/wire"
)

// 帧字节与心跳/写超时从生成协议 ombv1.TransportTiming 取值（审计 X-5：单一权威源，
// protocol/proto/omb.proto 定义，两侧测试互钉）。读超时同理；运行时数值与重构前逐位相同。
const (
	framePing byte = byte(ombv1.TransportTiming_FRAME_PING)
	framePong byte = byte(ombv1.TransportTiming_FRAME_PONG)
	frameUp   byte = byte(ombv1.TransportTiming_FRAME_UP)
	frameDown byte = byte(ombv1.TransportTiming_FRAME_DOWN)

	// 心跳与写超时（毫秒 → Duration，逐位对应生成枚举值）。
	pingInterval      = time.Duration(ombv1.TransportTiming_PING_INTERVAL_MS) * time.Millisecond
	writeTimeout      = time.Duration(ombv1.TransportTiming_SERVER_WRITE_TIMEOUT_MS) * time.Millisecond
	serverReadTimeout = time.Duration(ombv1.TransportTiming_SERVER_READ_TIMEOUT_MS) * time.Millisecond

	lossyQueueLen     = 4    // 丢帧通道小缓冲：只保留最新几帧
	scriptLogQueueLen = 32   // Console 独立低优先队列：满时只丢日志
	reliableQueueLn   = 1024 // 可靠通道大缓冲：满即断

	// maxFrameBytes 单条 WebSocket 消息（编码后的整帧）上限。coder/websocket
	// 默认 32768，TS 脚本提交（编译 JS + TS 原文同帧）可达 ~53 KiB 会被默默
	// 断连；显式提到 64 KiB，与客户端提交预检共用权威源 TransportTiming。
	maxFrameBytes = int64(ombv1.TransportTiming_MAX_FRAME_BYTES)
)

// transportStats（批 2 可观测性）：进程级累计计数，覆盖三类「过载可见」
// 信号——慢消费者丢 delta、可靠通道满而断连、script log 低优先丢弃。
// 仅原子自增，永不重置；/api/stats 聚合消费。
var transportStats struct {
	lossyDropped      atomic.Uint64
	reliableKilled    atomic.Uint64
	scriptLogsDropped atomic.Uint64
}

// TransportStats 返回（慢消费者丢 delta 数, 可靠通道满断连数, script log 丢弃数）。
func TransportStats() (lossyDropped, reliableKilled, scriptLogsDropped uint64) {
	return transportStats.lossyDropped.Load(), transportStats.reliableKilled.Load(), transportStats.scriptLogsDropped.Load()
}

// queuedFrame keeps superseded match snapshots and logs out of the new map's timeline.
// Epochs are transport-local; the protobuf contract remains unchanged.
type queuedFrame struct {
	data      []byte
	epoch     uint64
	bootstrap bool
	scriptLog *ombv1.EvScriptLog
	snapshot  *ombv1.SnapshotDelta
}

// Handler 返回 /ws 端点。sessionFactory 在每次握手成功后调用一次，返回该连接
// 专属的 onUp（闭包可捕获每连接状态）；sendReliable/sendLossy 为该连接的下行通道，
// sendReliableFrame 是广播预编码通道：入参为「0x03 帧类型 + ServerMsg protobuf」
// 的完整帧字节，跳过逐连接 marshal（广播方 marshal 一次、全部连接共享同一切片，
// 本 handler 只读不写）。该通道不区分消息类型——MapBootstrap/ScriptLog 等需要
// epoch/scriptlog 分流的帧不得走此路径，由调用方（glue broadcastFrame）保证。
// closeConn 请求优雅关闭：已排队帧（reliable/lossy/script log）全部写完后连接
// 才关闭——closeConn 调用前入队的可靠帧保证送达（审计 S-33：同身份接管时旧连接
// 的接管通知先入队、再 closeConn，不能被直接 kill 截断）。后续上行 ClientMsg 帧
// 路由到返回的 onUp。
func Handler(sessionFactory func(sendReliable, sendLossy func(*ombv1.ServerMsg), sendReliableFrame func([]byte), closeConn func()) (onUp func(up *ombv1.ClientMsg))) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{wire.Subprotocol}})
		if err != nil {
			return
		}
		// 默认读上限 32 KiB 装不下 TS 脚本提交帧；超限帧会被库直接断连。
		c.SetReadLimit(maxFrameBytes)
		defer func() { _ = c.CloseNow() }() // 强制关闭属正常路径，close 错误无信息量

		ctx := r.Context()
		compact := c.Subprotocol() == wire.Subprotocol

		// 下行队列：游戏可靠消息优先；Console 有独立小队列且可丢。
		reliableCh := make(chan queuedFrame, reliableQueueLn)
		lossyCh := make(chan queuedFrame, lossyQueueLen)
		scriptLogCh := make(chan queuedFrame, scriptLogQueueLen)
		var epoch atomic.Uint64
		var droppedScriptLogs atomic.Uint64
		dead := make(chan struct{})
		var deadOnce sync.Once
		kill := func() { deadOnce.Do(func() { close(dead) }) }
		// graceful（审计 S-33）：排空后关闭。与 kill 的区别：kill 是一致性
		// 破坏时的立即断连，graceful 等待三条队列清空——写入循环顶部的
		// 优先级 select 每轮各取一帧，直到阻塞 select 里观察到三队皆空。
		graceful := make(chan struct{})
		var gracefulOnce sync.Once
		closeGracefully := func() { gracefulOnce.Do(func() { close(graceful) }) }

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
					transportStats.scriptLogsDropped.Add(1)
				}
				return
			}

			frame := queuedFrame{epoch: epoch.Load()}
			if compact && msg.GetSnapshot() != nil {
				// Compact baselines belong to delivery order, never enqueue order.
				frame.snapshot = msg.GetSnapshot()
			} else {
				frame.data = encode(msg)
				if frame.data == nil {
					return
				}
			}
			if msg.GetEvent().GetMapBootstrap() != nil {
				frame.bootstrap = true
				frame.epoch = epoch.Add(1)
			}
			select {
			case reliableCh <- frame:
			default:
				kill() // 可靠通道满 = 一致性已破坏，断开由客户端重连+Resync 恢复
				transportStats.reliableKilled.Add(1)
			}
		}
		sendLossy := func(msg *ombv1.ServerMsg) {
			frame := queuedFrame{epoch: epoch.Load()}
			if compact && msg.GetSnapshot() != nil {
				frame.snapshot = msg.GetSnapshot()
			} else {
				frame.data = encode(msg)
				if frame.data == nil {
					return
				}
			}
			select {
			case lossyCh <- frame:
			default: // 慢消费者：丢 delta，客户端 base_tick 检测后重同步

				transportStats.lossyDropped.Add(1)
			}
		}
		sendReliableFrame := func(b []byte) {
			if len(b) == 0 {
				return
			}
			frame := queuedFrame{data: b}
			select {
			case reliableCh <- frame:
			default:
				kill() // 与 sendReliable 同语义：可靠通道满 = 一致性已破坏
				transportStats.reliableKilled.Add(1)
			}
		}

		connOnUp := sessionFactory(sendReliable, sendLossy, sendReliableFrame, closeGracefully)

		readerErr := make(chan error, 1)
		go func() {
			for {
				// A half-open connection must eventually unregister and release held input.
				readCtx, cancel := context.WithTimeout(ctx, serverReadTimeout)
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

		pingTicker := time.NewTicker(pingInterval)
		defer pingTicker.Stop()

		write := func(b []byte) error {
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			defer cancel()
			return c.Write(wctx, websocket.MessageBinary, b)
		}

		var deliveredEpoch uint64
		compactEncoder := wire.NewEncoder()
		var lastSnapshotTick uint32
		var hasSnapshot bool
		writeSnapshot := func(frame queuedFrame) error {
			if frame.epoch != deliveredEpoch || (hasSnapshot && (frame.snapshot.Tick < lastSnapshotTick || (!frame.snapshot.Full && frame.snapshot.Tick == lastSnapshotTick))) {
				return nil
			}
			b, err := compactEncoder.EncodeSnapshot(frame.snapshot)
			if err != nil {
				log.Printf("compact snapshot encoding failed (tick=%d): %v", frame.snapshot.Tick, err)
				return err // Invalid authoritative state must not corrupt the stream.
			}
			if err := write(b); err != nil {
				return err
			}
			lastSnapshotTick, hasSnapshot = frame.snapshot.Tick, true
			return nil
		}
		var lastScriptLog *ombv1.EvScriptLog
		var lastDropNotice time.Time
		var pendingReliable *queuedFrame
		writeReliable := func(frame queuedFrame) error {
			if frame.bootstrap {
				deliveredEpoch = frame.epoch
				droppedScriptLogs.Store(0)
				lastScriptLog = nil
				compactEncoder.Reset()
				hasSnapshot = false
			}
			if frame.snapshot != nil {
				return writeSnapshot(frame)
			}
			if compact && batchable(frame) {
				b, pending := collectReliableBatch(frame, reliableCh, graceful)
				pendingReliable = pending
				return write(b)
			}
			return write(frame.data)
		}
		writeLossy := func(frame queuedFrame) error {
			if frame.epoch != deliveredEpoch {
				return nil
			}
			if frame.snapshot != nil {
				return writeSnapshot(frame)
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
			if pendingReliable != nil {
				frame := *pendingReliable
				pendingReliable = nil
				if err := writeReliable(frame); err != nil {
					return
				}
				continue
			}
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
				if err := writeLossy(frame); err != nil {
					return
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
			case <-graceful:
				// 优雅关闭：三队皆空才返回；否则回到循环顶部按既有优先级排空。
				// closeConn 之后新入队的帧不保证送达（调用方语义：先发完、
				// 后 close，不再发新帧）。
				if len(reliableCh) == 0 && len(lossyCh) == 0 && len(scriptLogCh) == 0 {
					return
				}
			case err := <-readerErr:
				_ = err
				return
			case frame := <-reliableCh:
				if err := writeReliable(frame); err != nil {
					return
				}
			case frame := <-lossyCh:
				if err := writeLossy(frame); err != nil {
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
