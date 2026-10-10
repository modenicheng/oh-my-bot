package glue

import (
	"sync"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/ai"
)

// AI 流式增量聚合 flush（审计 S-32）。
//
// 此前每个上游 SSE delta 各走一次 SendReliable：deepseek 长回答数千条
// delta × ~100B 直灌可靠通道，弱网下 reliableCh（容量 1024）填满即 kill
// 断连——玩家掉线重连、AI pending 作废、已生成的回答不可恢复。
//
// 聚合语义（冻结，见 ai_stream_test.go）：
//   - 同 kind 增量连续合并；kind 切换（reasoning → answer）先 flush 已聚
//     合段，两轨永不在一帧里混淆；
//   - flush 触发：聚合字节数达到 aiStreamFlushBytes，或首条待发增量入队
//     后经过 aiStreamFlushInterval（定时器在首字节时锚定，先到先发）；
//   - 下发走既有 sendAIStream（可靠通道、持 rc.mu 定向当前 owner、按局
//     序号失配丢弃），聚合只减少帧数，不改变顺序与通道语义；
//   - 结束语义：请求返回（成功/失败/上游取消）一律 close()——已收到的
//     增量尾 flush 全部下发，之后新 push 丢弃。部分回答文本不因请求
//     失败而丢失，错误 notice 仍随后按既有路径到达。
const (
	aiStreamFlushInterval = 50 * time.Millisecond
	aiStreamFlushBytes    = 512
)

// aiStreamAggregator 单次 AI 请求作用域的增量聚合器。push 由 provider 流
// 回调（请求 goroutine）与 close（同 goroutine，HandlePromptStream 返回后）
// 调用；定时器回调在独立 goroutine——三者在 a.mu 下互斥。flush 在持 a.mu
// 时调用 send（其内部再取 rc.mu；锁序 a.mu → rc.mu，无反向路径）。
type aiStreamAggregator struct {
	send     func(ai.StreamDelta)
	interval time.Duration
	limit    int

	mu     sync.Mutex
	kind   ai.StreamKind
	buf    []byte
	timer  *time.Timer
	closed bool
}

func newAIStreamAggregator(send func(ai.StreamDelta)) *aiStreamAggregator {
	return &aiStreamAggregator{
		send:     send,
		interval: aiStreamFlushInterval,
		limit:    aiStreamFlushBytes,
	}
}

// push 追加一条增量；按字节阈值/kind 切换即时 flush，否则武装定时器。
// close 之后的 push 丢弃（结束语义见上）。
func (a *aiStreamAggregator) push(delta ai.StreamDelta) {
	if delta.Text == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return
	}
	if len(a.buf) > 0 && delta.Kind != a.kind {
		a.flushLocked()
	}
	a.kind = delta.Kind
	a.buf = append(a.buf, delta.Text...)
	if len(a.buf) >= a.limit {
		a.flushLocked()
		return
	}
	if a.timer == nil {
		a.timer = time.AfterFunc(a.interval, a.drain)
	}
}

// close 请求结束（成功/失败/取消一致）：尾 flush 已收到的全部增量，丢弃
// 之后的新 push。幂等。
func (a *aiStreamAggregator) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return
	}
	a.closed = true
	a.flushLocked()
}

// drain 定时器到点：发走当前聚合段（无待发则空转）。
func (a *aiStreamAggregator) drain() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.timer = nil
	if a.closed {
		return
	}
	a.flushLocked()
}

// flushLocked 发送并清空聚合段；同时解除定时器（下次首字节重新锚定）。
func (a *aiStreamAggregator) flushLocked() {
	if a.timer != nil {
		a.timer.Stop()
		a.timer = nil
	}
	if len(a.buf) == 0 {
		return
	}
	text := string(a.buf)
	a.buf = a.buf[:0]
	a.send(ai.StreamDelta{Kind: a.kind, Text: text})
}
