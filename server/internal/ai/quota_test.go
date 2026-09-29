package ai

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func acquireOK(t *testing.T, q QuotaService, player uint64) Lease {
	t.Helper()
	l, err := q.TryAcquire(context.Background(), player)
	if err != nil {
		t.Fatalf("TryAcquire(player=%d): %v", player, err)
	}
	return l
}

// --- 基本语义 ---

func TestQuotaTryAcquireCommitBasics(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	l := acquireOK(t, q, 1)
	if l.MatchSeq != 1 || l.RoundsLeft != 19 {
		t.Fatalf("lease = %+v, want MatchSeq=1 RoundsLeft=19", l)
	}
	if !q.Commit(l, Usage{TokensDelta: 1000}) {
		t.Fatal("Commit accepted = false, want true")
	}
	r, tokK, globK := q.Snapshot(1)
	if r != 19 || tokK != 299 || globK != 1999 {
		t.Fatalf("snapshot = (%d,%d,%d), want (19,299,1999)", r, tokK, globK)
	}
}

func TestQuotaRoundsExhausted(t *testing.T) {
	q := NewQuotaService(QuotaConfig{PlayerRounds: 3, PlayerTokens: 100_000, GlobalTokens: 1_000_000})
	for i := 0; i < 3; i++ {
		l := acquireOK(t, q, 7)
		q.Commit(l, Usage{})
	}
	_, err := q.TryAcquire(context.Background(), 7)
	if err != ErrRoundsExhausted {
		t.Fatalf("err = %v, want ErrRoundsExhausted", err)
	}
}

func TestQuotaTokensExhausted(t *testing.T) {
	q := NewQuotaService(QuotaConfig{PlayerRounds: 20, PlayerTokens: 1000, GlobalTokens: 1_000_000})
	l := acquireOK(t, q, 7)
	q.Commit(l, Usage{TokensDelta: 1000})
	_, err := q.TryAcquire(context.Background(), 7)
	if err != ErrTokensExhausted {
		t.Fatalf("err = %v, want ErrTokensExhausted", err)
	}
}

func TestQuotaBusySerialPerPlayer(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	acquireOK(t, q, 5)
	if _, err := q.TryAcquire(context.Background(), 5); err != ErrBusy {
		t.Fatalf("err = %v, want ErrBusy", err)
	}
	// 另一玩家不受影响。
	acquireOK(t, q, 6)
}

func TestQuotaFailedAcquireDoesNotConsume(t *testing.T) {
	q := NewQuotaService(QuotaConfig{PlayerRounds: 2, PlayerTokens: 100_000, GlobalTokens: 1_000_000})
	acquireOK(t, q, 1) // 在途，占 1 轮
	if _, err := q.TryAcquire(context.Background(), 1); err != ErrBusy {
		t.Fatalf("err = %v, want ErrBusy", err)
	}
	// Busy 拒绝不吞轮次：仍有 1 轮可用。
	l := acquireOK(t, q, 2)
	q.Commit(l, Usage{})
	if r, _, _ := q.Snapshot(2); r != 1 {
		t.Fatalf("player2 roundsLeft = %d, want 1", r)
	}
}

// --- Restart 语义 ---

func TestQuotaRestartResetsAndInvalidatesLease(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	l := acquireOK(t, q, 9)
	q.Commit(l, Usage{TokensDelta: 50_000})

	q.Restart()
	r, tokK, globK := q.Snapshot(9)
	if r != 20 || tokK != 300 || globK != 2000 {
		t.Fatalf("post-restart snapshot = (%d,%d,%d), want full reset", r, tokK, globK)
	}

	// 旧局在途 lease：Restart 后 Commit 必须静默丢弃。
	old := acquireOK(t, q, 8)
	q.Restart()
	if q.Commit(old, Usage{TokensDelta: 123}) {
		t.Fatal("stale lease Commit accepted = true, want false")
	}
	if _, tokK, globK := q.Snapshot(8); tokK != 300 || globK != 2000 {
		t.Fatalf("stale commit leaked: tokK=%d globK=%d", tokK, globK)
	}
	// 新局正常可用。
	l2 := acquireOK(t, q, 9)
	if l2.MatchSeq != 3 { // 初值 1 + 两次 Restart
		t.Fatalf("l2.MatchSeq = %d, want 3", l2.MatchSeq)
	}
	q.Commit(l2, Usage{TokensDelta: 10})
}

func TestQuotaDoubleCommitRejected(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	l := acquireOK(t, q, 3)
	if !q.Commit(l, Usage{TokensDelta: 100}) {
		t.Fatal("first Commit = false")
	}
	if q.Commit(l, Usage{TokensDelta: 100}) {
		t.Fatal("double Commit = true, want false")
	}
	if _, tokK, _ := q.Snapshot(3); tokK != 299 {
		t.Fatalf("double commit leaked tokens: tokK=%d", tokK)
	}
}

// --- 全局并发 20 ---

func TestQuotaGlobalConcurrencyCap(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	const workers = 64
	var wg sync.WaitGroup
	var inflight, peak atomic.Int64
	var rejectedBusyOrConc atomic.Int64

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(id uint64) {
			defer wg.Done()
			l, err := q.TryAcquire(context.Background(), id)
			if err != nil {
				if err == ErrBusy || err == ErrConcurrency {
					rejectedBusyOrConc.Add(1)
				} else {
					t.Errorf("player %d: unexpected err %v", id, err)
				}
				return
			}
			cur := inflight.Add(1)
			for {
				p := peak.Load()
				if cur <= p || peak.CompareAndSwap(p, cur) {
					break
				}
			}
			time.Sleep(5 * time.Millisecond)
			inflight.Add(-1)
			q.Commit(l, Usage{})
		}(uint64(i + 1))
	}
	wg.Wait()

	if got := peak.Load(); got > int64(DefaultMaxConcurrency) {
		t.Fatalf("peak in-flight = %d, want <= %d", got, DefaultMaxConcurrency)
	}
	if _, _, globK := q.Snapshot(1); globK != 2000 {
		t.Fatalf("guardrail moved without usage: globK=%d", globK)
	}
	// 并发位全部归还后仍可继续获取。
	acquireOK(t, q, 100)
}

// --- 串行语义（同玩家顺序链）---

func TestQuotaPlayerSerialChained(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	const rounds = 10
	for i := 0; i < rounds; i++ {
		l := acquireOK(t, q, 42)
		// 在途期间同玩家必 Busy。
		if _, err := q.TryAcquire(context.Background(), 42); err != ErrBusy {
			t.Fatalf("round %d: err = %v, want ErrBusy", i, err)
		}
		q.Commit(l, Usage{TokensDelta: 100})
	}
	r, tokK, _ := q.Snapshot(42)
	if r != 10 || tokK != 299 {
		t.Fatalf("snapshot = (%d,%d), want (10,299)", r, tokK)
	}
}

// --- 全局护栏 2M ---

func TestQuotaGlobalGuardrailBlocksAll(t *testing.T) {
	q := NewQuotaService(QuotaConfig{PlayerRounds: 1000, PlayerTokens: 1_000_000, GlobalTokens: 5000})
	// 三名玩家合计烧 5000：1 号 3000、2 号 2000。
	l := acquireOK(t, q, 1)
	q.Commit(l, Usage{TokensDelta: 3000})
	l = acquireOK(t, q, 2)
	q.Commit(l, Usage{TokensDelta: 2000})
	// 触顶：任何玩家（含零消耗的 3 号）都被全员禁。
	for _, p := range []uint64{1, 2, 3} {
		if _, err := q.TryAcquire(context.Background(), p); err != ErrGlobalGuardrail {
			t.Fatalf("player %d: err = %v, want ErrGlobalGuardrail", p, err)
		}
	}
	if _, _, globK := q.Snapshot(3); globK != 0 {
		t.Fatalf("globK = %d, want 0", globK)
	}
	// Restart 后恢复。
	q.Restart()
	acquireOK(t, q, 3)
}

// --- 并发压测：64 goroutine 抢占 + 提交（-race 目标）---

func TestQuotaStressMixedPlayers(t *testing.T) {
	q := NewQuotaService(QuotaConfig{
		PlayerRounds:   5,
		PlayerTokens:   50_000,
		GlobalTokens:   1_000_000,
		MaxConcurrency: 8,
	})
	const workers = 64
	var wg sync.WaitGroup
	var acq, done atomic.Int64
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			player := uint64(id%16 + 1) // 16 名玩家 × 4 轮尝试
			for r := 0; r < 4; r++ {
				l, err := q.TryAcquire(context.Background(), player)
				if err != nil {
					if err == ErrBusy || err == ErrRoundsExhausted || err == ErrConcurrency {
						continue
					}
					t.Errorf("worker %d: %v", id, err)
					return
				}
				acq.Add(1)
				time.Sleep(time.Millisecond)
				if q.Commit(l, Usage{TokensDelta: 777}) {
					done.Add(1)
				}
			}
		}(i)
	}
	wg.Wait()
	// 16 玩家 × 5 轮上限 = 80 次签发上限。
	if got := acq.Load(); got > 80 {
		t.Fatalf("acquired = %d, want <= 80", got)
	}
	if acq.Load() != done.Load() {
		t.Fatalf("acquired=%d committed=%d, must match", acq.Load(), done.Load())
	}
	_, _, globK := q.Snapshot(1)
	if globK != uint32((1_000_000-777*int(done.Load()))/1000) {
		t.Fatalf("globK = %d, inconsistent with commits", globK)
	}
}

// --- ctx 取消时并发等待退出 ---

func TestQuotaContextCancelDuringWait(t *testing.T) {
	q := NewQuotaService(QuotaConfig{PlayerRounds: 100, PlayerTokens: 1_000_000, GlobalTokens: 10_000_000, MaxConcurrency: 2})
	// 占满 2 个并发位。
	l1 := acquireOK(t, q, 1)
	l2 := acquireOK(t, q, 2)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	_, err := q.TryAcquire(ctx, 3)
	if err == nil || err == ErrBusy {
		t.Fatalf("err = %v, want ctx-cancelled ErrConcurrency wrap", err)
	}
	if ctx.Err() == nil {
		t.Fatal("ctx should be cancelled")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("cancel took %v, want prompt return", elapsed)
	}
	// 释放后恢复。
	q.Commit(l1, Usage{})
	q.Commit(l2, Usage{})
	acquireOK(t, q, 3)
}

func TestQuotaSnapshotUnknownPlayer(t *testing.T) {
	q := NewQuotaService(DefaultQuotaConfig())
	r, tokK, globK := q.Snapshot(999)
	if r != 20 || tokK != 300 || globK != 2000 {
		t.Fatalf("snapshot = (%d,%d,%d), want defaults", r, tokK, globK)
	}
}

// 并发位归还回归：同玩家在途→快速 ErrBusy（不排信号量）；拒因路径不占位。
func TestQuotaSlotReleasedOnReject(t *testing.T) {
	q := NewQuotaService(QuotaConfig{PlayerRounds: 1, PlayerTokens: 100_000, GlobalTokens: 1_000_000, MaxConcurrency: 1})
	l := acquireOK(t, q, 1) // 占位：轮次 1/1 用掉、在途
	// 在途重请求必须立即 ErrBusy（即使并发位也被自己占满）。
	if _, err := q.TryAcquire(context.Background(), 1); err != ErrBusy {
		t.Fatalf("err = %v, want ErrBusy", err)
	}
	// 玩家 2 仍可用唯一并发位。
	l2 := acquireOK(t, q, 2)
	q.Commit(l, Usage{})
	q.Commit(l2, Usage{})
	// 位全部归还；玩家 1 轮次已尽拒因不变，玩家 3 可用。
	if _, err := q.TryAcquire(context.Background(), 1); err != ErrRoundsExhausted {
		t.Fatalf("err = %v, want ErrRoundsExhausted", err)
	}
	l3 := acquireOK(t, q, 3)
	q.Commit(l3, Usage{})
}
