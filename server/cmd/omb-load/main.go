// Command omb-load 是 oh-my-bot 的单进程压测驱动（批 2）：N 个真实 WS 连接
// 进同一房间（warmup 常驻对局），按比例提交脚本、持续上行输入，统计下行
// 快照速率 / 带宽 / base_tick 缺口（丢帧→重同步需求）与 /api/stats 快照。
//
// 用法示例（先以 OMB_MAX_PLAYERS=200 启动 omb）：
//
//	omb-load -addr 127.0.0.1:27990 -room LD -n 200 -scripts 0.5 -duration 60s
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

const (
	frameUp   byte = 2
	frameDown byte = 3
	framePing byte = 0x00
	framePong byte = 0x01
)

// 每连接的典型脚本（与 glue 性能门同型：scan→aim→fire→move）。
const typicalScript = `
let last = null
function tick(bot) {
  const enemies = bot.scan().robots.filter(function(r){ return r.id !== bot.self.id })
  if (enemies.length > 0) {
    const e = enemies[0]
    const dx = e.position.x - bot.self.position.x
    const dy = e.position.y - bot.self.position.y
    bot.aimAt(Math.atan2(dy, dx))
    bot.fire()
    bot.move(dx > 0 ? 1 : -1, 0)
  }
}`

type connStats struct {
	frames    atomic.Uint64
	bytes     atomic.Uint64
	lastTick  atomic.Int64
	gaps      atomic.Uint64 // base_tick 跳变 > 1：丢帧，客户端将请求重同步
	snapshots atomic.Uint64
}

func main() {
	addr := flag.String("addr", "127.0.0.1:27182", "omb HTTP 地址")
	url := flag.String("url", "", "完整 WS 基址（含 scheme，如 wss://omb.example.com）；留空则用 -addr 拼 ws://")
	dialAddr := flag.String("dialaddr", "", "覆盖 TCP 拨号目标 host:port；TLS SNI/HTTP Host 仍用 -url 域名。用于 v4/v6 路径对照")
	room := flag.String("room", "LOAD", "房间码")
	n := flag.Int("n", 64, "玩家连接数")
	scriptFrac := flag.Float64("scripts", 0, "提交脚本的玩家比例 [0,1]")
	duration := flag.Duration("duration", 30*time.Second, "持续时长")
	inputHz := flag.Float64("input", 30, "每连接上行输入频率 Hz")
	flag.Parse()

	// -url 用于经反代的公网入口：stats 接口与 WS 同域，scheme 换成 http(s) 即可。
	wsBase, statsBase := "ws://"+*addr, "http://"+*addr
	if *url != "" {
		wsBase = strings.TrimSuffix(*url, "/")
		if strings.HasPrefix(wsBase, "wss://") {
			statsBase = "https://" + strings.TrimPrefix(wsBase, "wss://")
		} else {
			statsBase = "http://" + strings.TrimPrefix(wsBase, "ws://")
		}
	}

	log.Printf("load: ws=%s room=%s n=%d scripts=%.0f%% duration=%s input=%.0fHz",
		wsBase, *room, *n, *scriptFrac*100, *duration, *inputHz)
	fetchStats(statsBase, "start")

	var stats []*connStats
	var wg sync.WaitGroup
	ctx, cancel := context.WithTimeout(context.Background(), *duration)
	defer cancel()

	start := time.Now()
	for i := 0; i < *n; i++ {
		st := &connStats{}
		stats = append(stats, st)
		wg.Add(1)
		withScript := i < int(*scriptFrac*float64(*n))
		go func(idx int, st *connStats, withScript bool) {
			defer wg.Done()
			runClient(ctx, wsBase, *dialAddr, *room, idx, withScript, *inputHz, st)
		}(i, st, withScript)
	}

	// 周期性进度输出。
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	for {
		select {
		case <-done:
			goto report
		case <-ticker.C:
			log.Printf("t+%.0fs: %s", time.Since(start).Seconds(), aggregate(stats, time.Since(start)))
			fetchStats(statsBase, "live")
		}
	}
report:
	elapsed := time.Since(start)
	log.Printf("done in %s: %s", elapsed, aggregate(stats, elapsed))
	fetchStats(statsBase, "end")
}

// connected 记录成功建立 WS 的连接数（公网入口下个别拨号可能失败）。
var connected atomic.Uint64

func runClient(ctx context.Context, wsBase, dialAddr, room string, idx int, withScript bool, inputHz float64, st *connStats) {
	// 单连接握手限时：200 并发过公网时个别超时不该拖住整个进程的统计周期。
	dialCtx, cancelDial := context.WithTimeout(ctx, 15*time.Second)
	var opts *websocket.DialOptions
	if dialAddr != "" {
		// 只改写 TCP 拨号目标；TLS SNI 与 HTTP Host 仍取 URL 域名，证书校验不变。
		opts = &websocket.DialOptions{HTTPClient: &http.Client{Transport: &http.Transport{
			DialContext: func(c context.Context, network, addr string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(c, "tcp", dialAddr)
			},
		}}}
	}
	c, _, err := websocket.Dial(dialCtx, wsBase+"/ws", opts)
	cancelDial()
	if err != nil {
		log.Printf("client %d: dial: %v", idx, err)
		return
	}
	connected.Add(1)
	connStart := time.Now()
	// coder/websocket 的 Write 非并发安全：读循环回 pong 与输入/warmup 写并发，统一串行化。
	var wmu sync.Mutex
	defer func() { _ = c.CloseNow() }()
	c.SetReadLimit(1 << 20)

	send := func(msg *ombv1.ClientMsg) {
		body, err := proto.Marshal(msg)
		if err != nil {
			return
		}
		wmu.Lock()
		defer wmu.Unlock()
		wctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		_ = c.Write(wctx, websocket.MessageBinary, append([]byte{frameUp}, body...))
	}

	send(&ombv1.ClientMsg{Payload: &ombv1.ClientMsg_Join{Join: &ombv1.JoinRoom{
		RoomCode: room, Nick: fmt.Sprintf("load%03d", idx), Color: "#3af2e0"}}})
	// 200 并发拨号下首绑顺序不定、真正的房主未知：所有客户端都补发
	// WARMUP（非房主收到一条无害的 command failed say，房主的一次生效；
	// Warmup 态重复发同样无害）。对局出现即停止。
	go func() {
		for _, delay := range []time.Duration{500 * time.Millisecond, 2 * time.Second, 5 * time.Second} {
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			if st.snapshots.Load() > 0 {
				return
			}
			send(&ombv1.ClientMsg{Payload: &ombv1.ClientMsg_RoomAction{RoomAction: &ombv1.RoomAction{Kind: ombv1.RoomAction_WARMUP}}})
		}
	}()
	if withScript {
		send(&ombv1.ClientMsg{Payload: &ombv1.ClientMsg_ScriptSubmit{ScriptSubmit: &ombv1.ScriptSubmit{
			ClientScriptId: uint32(idx + 1), Source: typicalScript}}})
	}

	// 读循环：统计帧/字节/缺口。
	go func() {
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				// 退出原因：CloseError=对端优雅关闭（服务端主动），EOF/RST=路径或本机异常
				log.Printf("client %d: read end (age %s): %v", idx, time.Since(connStart).Round(time.Second), err)
				return
			}
			st.frames.Add(1)
			st.bytes.Add(uint64(len(data)))
			if len(data) > 0 && data[0] == framePing {
				// 按协议回 pong（载荷回显时间戳）；服务端虽不强制，保持客户端语义完整。
				wmu.Lock()
				wctx, cancel := context.WithTimeout(ctx, 3*time.Second)
				_ = c.Write(wctx, websocket.MessageBinary, append([]byte{framePong}, data[1:]...))
				cancel()
				wmu.Unlock()
			}
			if len(data) == 0 || data[0] != frameDown {
				continue
			}
			msg := &ombv1.ServerMsg{}
			if err := proto.Unmarshal(data[1:], msg); err != nil {
				continue
			}
			if snap := msg.GetSnapshot(); snap != nil {
				st.snapshots.Add(1)
				tick := int64(snap.BaseTick)
				if tick == 0 {
					tick = int64(snap.Tick)
				}
				if prev := st.lastTick.Swap(tick); prev > 0 && tick-prev > 1 {
					st.gaps.Add(1)
				}
			}
		}
	}()

	// 输入循环：往返移动 + 间歇开火。
	interval := time.Second / time.Duration(inputHz)
	seq := uint32(0)
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			seq++
			move := int32(1000)
			if (seq/30)%2 == 1 {
				move = -1000
			}
			send(&ombv1.ClientMsg{Payload: &ombv1.ClientMsg_Input{Input: &ombv1.ClientInput{
				Seq: seq, AxisMask: uint32(1), MoveX: move, MoveY: 0,
				Aim: float64(seq%360) * 0.01745, Fire: seq%8 == 0}}})
		}
	}
}

func aggregate(stats []*connStats, elapsed time.Duration) string {
	var frames, bytes, gaps, snaps uint64
	for _, s := range stats {
		frames += s.frames.Load()
		bytes += s.bytes.Load()
		gaps += s.gaps.Load()
		snaps += s.snapshots.Load()
	}
	mbps := float64(bytes) / elapsed.Seconds() / 1e6
	return fmt.Sprintf("dialed=%d connected=%d frames=%d snapshots=%d gaps=%d down=%.1f Mbps",
		len(stats), connected.Load(), frames, snaps, gaps, mbps)
}

func fetchStats(base, phase string) {
	resp, err := http.Get(base + "/api/stats")
	if err != nil {
		log.Printf("stats[%s]: %v", phase, err)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	log.Printf("stats[%s]: %s", phase, body)
}
