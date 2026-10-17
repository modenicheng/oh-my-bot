package glue

import (
	"math"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// 并行观察者路径的确定性对照（批 2）：同一 seed、同一 tick 序列下，强制
// 并行（阈值 1）与强制串行（阈值 MaxInt）跑出的每个会话消息流必须
// 逐字节一致——观察者任务的调度顺序不得影响任何单个连接看到的世界。
// 观察者数（24）超过并行阈值才触发 parallelFor 分支。
func TestParallelObserversByteIdenticalToSerial(t *testing.T) {
	t.Chdir(t.TempDir())
	run := func(threshold int) [][]sentMessage {
		prev := parallelObserverThreshold
		parallelObserverThreshold = threshold
		t.Cleanup(func() { parallelObserverThreshold = prev })

		h := NewHub()
		rc := h.EnsureRoom("PARDET")
		var logs []*messageLog
		players := map[uint64]SessionInfo{}
		for i := 0; i < 24; i++ {
			l := &messageLog{}
			s := NewSession(l.send(true), l.send(false), nil)
			h.Register(s)
			if err := rc.Bind(s, nickOf(i), "#ffffff"); err != nil {
				t.Fatal(err)
			}
			logs = append(logs, l)
			players[s.playerID] = SessionInfo{PlayerID: s.playerID, Nick: s.nick, Color: s.color}
		}
		m, err := NewMatch(rc, 4242, 1, players, true, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { stopTestMatch(t, m) })
		rc.mu.Lock()
		rc.match = m
		m.handle = nil
		for _, s := range rc.sessions {
			m.bootstrapLocked(s)
		}
		// 部分机器人持续输入 + 一半开 assist 跑 solo bot 源码，制造事件与
		// 仲裁流量；断言覆盖 reliable/lossy 两个通道的逐帧内容。
		// map 遍历序不确定：按 playerID 排序后装配，两次运行的输入/仲裁
		// 流量才严格一致（选人开火/assist 不随遍历序漂移）。
		pids := make([]uint64, 0, len(rc.sessions))
		for pid := range rc.sessions {
			pids = append(pids, pid)
		}
		sort.Slice(pids, func(i, j int) bool { return pids[i] < pids[j] })
		for i, pid := range pids {
			if i%2 == 0 {
				m.sim.AssistToggle(m.robotOf[pid])
			}
			m.sim.ApplyInput(m.robotOf[pid], &ombv1.ClientInput{
				Seq: 1, AxisMask: uint32(sim.AxisMove | sim.AxisFire), MoveX: 1000, Aim: 0.5, Fire: true})
		}
		rc.mu.Unlock()
		// step 自取 rc.mu：步进必须在锁外调用。
		for tick := 0; tick < 90; tick++ {
			m.step()
		}
		out := make([][]sentMessage, len(logs))
		for idx, l := range logs {
			out[idx] = l.take()
		}
		return out
	}
	serial := run(math.MaxInt32)
	parallel := run(1)
	if len(serial) != len(parallel) {
		t.Fatalf("session count mismatch %d vs %d", len(serial), len(parallel))
	}
	for i := range serial {
		if len(serial[i]) != len(parallel[i]) {
			t.Fatalf("session %d message count %d vs %d", i, len(serial[i]), len(parallel[i]))
		}
		for j := range serial[i] {
			if serial[i][j].reliable != parallel[i][j].reliable {
				t.Fatalf("session %d msg %d channel mismatch", i, j)
			}
			// Tick wall-clock telemetry is intentionally runtime-dependent, so it
			// cannot participate in the byte-identical world projection check.
			// The event cadence and projection shape are covered separately.
			if ev := serial[i][j].msg.GetEvent(); ev != nil && ev.GetTickTelemetry() != nil {
				if other := parallel[i][j].msg.GetEvent(); other == nil || other.GetTickTelemetry() == nil || ev.GetTick() != other.GetTick() {
					t.Fatalf("session %d msg %d telemetry event mismatch", i, j)
				}
				continue
			}
			a, b := serial[i][j].msg.String(), parallel[i][j].msg.String()
			if a != b {
				t.Fatalf("session %d msg %d differs:\nserial:   %s\nparallel: %s", i, j, a, b)
			}
		}
	}
}

// parallelFor 本身的行为门：未过阈值必须串行（fn 内并发计数会暴露），
// 过阈值必须真的并行（观察 concurrent 峰值 > 1）。
func TestParallelForThresholdAndConcurrency(t *testing.T) {
	prev := parallelObserverThreshold
	t.Cleanup(func() { parallelObserverThreshold = prev })

	m := &Match{obsWorkers: 4}
	parallelObserverThreshold = math.MaxInt32
	var inFlight, maxSerial atomic.Int32
	m.parallelFor(32, func(int) {
		cur := inFlight.Add(1)
		for {
			old := maxSerial.Load()
			if cur <= old || maxSerial.CompareAndSwap(old, cur) {
				break
			}
		}
		inFlight.Add(-1)
	})
	if maxSerial.Load() > 1 {
		t.Fatalf("below threshold ran concurrently: %d", maxSerial.Load())
	}

	parallelObserverThreshold = 1
	inFlight.Store(0)
	var observedMax atomic.Int32
	// 每项驻留 30ms：4 worker × 16 项必然产生重叠窗口；串行路径则总耗时
	// ~0.5s 且峰值恒为 1。
	m.parallelFor(16, func(int) {
		cur := inFlight.Add(1)
		for {
			old := observedMax.Load()
			if cur <= old || observedMax.CompareAndSwap(old, cur) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		inFlight.Add(-1)
	})
	if observedMax.Load() < 2 {
		t.Fatal("above threshold did not run concurrently")
	}
}

func TestParallelForReusesObserverWorkers(t *testing.T) {
	m := &Match{obsWorkers: 2}
	m.startObserverPool()
	t.Cleanup(m.closeObserverPool)
	jobs := m.obsJobs

	m.parallelFor(16, func(int) {})
	if jobs == nil || m.obsJobs != jobs {
		t.Fatal("parallelFor did not retain the match observer worker pool")
	}
}

func nickOf(i int) string { return "bot" + string(rune('a'+i%26)) + string(rune('a'+i/26%26)) }
