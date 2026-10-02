package script

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ---- RunPool：基本收齐 ----

func TestPoolCollectAll(t *testing.T) {
	p := NewRunPool(Config{PoolSize: 4})
	defer p.Close()

	const N = 16
	for i := 1; i <= N; i++ {
		rt := NewGojaRuntime(Config{})
		if err := rt.Load(`function tick(ctx){ ctx.api.fire(); }`); err != nil {
			t.Fatalf("load: %v", err)
		}
		p.Register(uint32(i), rt)
	}

	frame := testFrame()
	deadline := time.Now().Add(50 * time.Millisecond)
	for i := 1; i <= N; i++ {
		if err := p.Submit(uint32(i), frame, deadline); err != nil {
			t.Fatalf("submit %d: %v", i, err)
		}
	}
	results := p.Collect(deadline)
	if len(results) != N {
		t.Fatalf("want %d results, got %d", N, len(results))
	}
	for _, res := range results {
		if res.Err != nil || res.Deferred || res.Commands.Fire == nil {
			t.Errorf("id %d: bad result %+v", res.ID, res)
		}
	}
}

// ---- deferred 语义 ----

func TestPoolDeferredOnShortDeadline(t *testing.T) {
	// 每个脚本烧满配额（10ms 死循环），deadline 只给 20ms：后段必然 deferred。
	p := NewRunPool(Config{PoolSize: 2}) // 故意少量 worker 制造排队
	defer p.Close()

	const N = 8
	for i := 1; i <= N; i++ {
		rt := NewGojaRuntime(Config{})
		_ = rt.Load(`function tick(ctx){ var s=0; for(var i=0;;i++){ s+=i; } }`)
		p.Register(uint32(i), rt)
	}

	frame := testFrame()
	deadline := time.Now().Add(20 * time.Millisecond)
	for i := 1; i <= N; i++ {
		if err := p.Submit(uint32(i), frame, deadline); err != nil {
			var de *DeferredError
			if !errors.As(err, &de) {
				t.Fatalf("submit %d: %v", i, err)
			}
		}
	}
	results := p.Collect(deadline)

	var deferred, quota int
	for _, res := range results {
		switch {
		case res.Deferred:
			deferred++
			if res.Err != nil {
				t.Errorf("deferred must not carry error: %+v", res)
			}
			if !cmdsIsZero(res.Commands) {
				t.Errorf("deferred commands must be zero: %+v", res.Commands)
			}
		case errors.Is(res.Err, ErrQuotaExceeded):
			quota++
		default:
			t.Logf("id %d completed or errored: %+v", res.ID, res.Err)
		}
	}
	if deferred == 0 {
		t.Fatalf("expected some deferred results with 2 workers / 8 jobs / 20ms deadline")
	}
	t.Logf("deferred=%d quotaExceeded=%d total=%d", deferred, quota, len(results))
}

func TestPoolDeferredIsIdleNotCrash(t *testing.T) {
	// deferred 之后的 tick 正常继续（顺延不惩罚）。
	p := NewRunPool(Config{PoolSize: 1})
	defer p.Close()

	rt := NewGojaRuntime(Config{})
	_ = rt.Load(`var n = 0; function tick(ctx){ n++; ctx.api.say("n=" + n); }`)
	p.Register(7, rt)

	frame := testFrame()

	// 帧 1：deadline 已过 → Submit 立即 deferred。
	past := time.Now().Add(-time.Millisecond)
	err := p.Submit(7, frame, past)
	if err == nil {
		t.Fatal("past-deadline submit must defer")
	}
	var de *DeferredError
	if !errors.As(err, &de) {
		t.Fatalf("want DeferredError, got %v", err)
	}
	results := p.Collect(time.Now().Add(time.Millisecond))
	if len(results) != 1 || !results[0].Deferred {
		t.Fatalf("want 1 deferred, got %+v", results)
	}

	// 帧 2：正常执行，状态连续（n=1，说明帧 1 未执行但未毒化 VM）。
	dl := time.Now().Add(50 * time.Millisecond)
	if err := p.Submit(7, frame, dl); err != nil {
		t.Fatalf("submit: %v", err)
	}
	results = p.Collect(dl)
	if len(results) != 1 || results[0].Err != nil {
		t.Fatalf("frame 2: %+v", results)
	}
	if got := *results[0].Commands.Say; got != "n=1" {
		t.Fatalf("deferred tick must not execute script: got %q", got)
	}
}

// ---- 64 并行 -race ----

func TestPool64ParallelRace(t *testing.T) {
	cfg := Config{PoolSize: NumWorkers(), TickTimeout: time.Second}
	p := NewRunPool(cfg)
	defer p.Close()

	const N = 64
	src := `var hits = 0;
function tick(ctx){
	hits++;
	var o = ctx.scan();
	if (o.robots.length > 0) { ctx.api.aimAt(o.robots[0]); }
	if (hits % 2 === 0) { ctx.api.fire(); }
	ctx.api.moveTo(ctx.api.nearestCore());
}`
	for i := 1; i <= N; i++ {
		rt := NewGojaRuntime(cfg)
		if err := rt.Load(src); err != nil {
			t.Fatalf("load %d: %v", i, err)
		}
		p.Register(uint32(i), rt)
	}

	frame := testFrame()
	// 连续 3 帧：每帧 Submit × 64 → Collect。
	for f := 0; f < 3; f++ {
		dl := time.Now().Add(200 * time.Millisecond)
		for i := 1; i <= N; i++ {
			if err := p.Submit(uint32(i), frame, dl); err != nil {
				t.Fatalf("frame %d submit %d: %v", f, i, err)
			}
		}
		results := p.Collect(dl)
		if len(results) != N {
			t.Fatalf("frame %d: want %d results, got %d", f, N, len(results))
		}
		for _, res := range results {
			if res.Err != nil || res.Deferred {
				t.Fatalf("frame %d id %d: %+v", f, res.ID, res)
			}
		}
	}
}

// ---- Hot Swap 与池并发（-race） ----

func TestHotSwapDuringPool(t *testing.T) {
	// worker 正在跑长脚本时并发 Load 新版本：Hot Swap 原子、无 race。
	p := NewRunPool(Config{PoolSize: 4})
	defer p.Close()

	const ID = 1
	rt := NewGojaRuntime(Config{})
	_ = rt.Load(`function tick(ctx){ var s=0; for(var i=0;i<2e7;i++){ s+=i; } ctx.api.dash(); }`)
	p.Register(ID, rt)

	frame := testFrame()
	dl := time.Now().Add(2 * time.Second)
	if err := p.Submit(ID, frame, dl); err != nil {
		t.Fatalf("submit: %v", err)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_ = rt.Load(`function tick(ctx){ ctx.api.fire(); }`) // 热替换
	}()
	wg.Wait()

	results := p.Collect(dl)
	if len(results) != 1 {
		t.Fatalf("want 1 result, got %d", len(results))
	}
	// 旧 tick 在跑完前被替换不打断其结果归属（Rev 对账见结果）。
	if results[0].Err != nil && !errors.Is(results[0].Err, ErrQuotaExceeded) {
		t.Fatalf("unexpected err: %v", results[0].Err)
	}
}

// ---- Unregister / Close ----

func TestPoolUnregisterAndNoSuchScript(t *testing.T) {
	p := NewRunPool(Config{})
	rt := NewGojaRuntime(Config{})
	_ = rt.Load(`function tick(ctx){}`)
	p.Register(9, rt)
	p.Unregister(9)

	if err := p.Submit(9, testFrame(), time.Now().Add(time.Second)); !errors.Is(err, ErrNoSuchScript) {
		t.Fatalf("want ErrNoSuchScript, got %v", err)
	}
	if p.RuntimeOf(9) != nil {
		t.Fatal("runtime should be removed")
	}
	p.Close()

	if err := p.Submit(9, testFrame(), time.Now().Add(time.Second)); !errors.Is(err, ErrPoolClosed) {
		t.Fatalf("want ErrPoolClosed, got %v", err)
	}
	// Close 幂等。
	p.Close()
}

// ---- sim.Runtime 接口适配（契约断言运行时行为） ----

func TestGojaRuntimeImplementsSimRuntime(t *testing.T) {
	var r interface{} = NewGojaRuntime(Config{})
	if _, ok := r.(sim.Runtime); !ok {
		t.Fatal("GojaRuntime must implement sim.Runtime")
	}
}

// ---- NumWorkers 边界 ----

func TestNumWorkersBounds(t *testing.T) {
	n := NumWorkers()
	if n < 1 || n > MaxPoolWorkers {
		t.Fatalf("NumWorkers out of bounds: %d", n)
	}
}

func TestCollectTimeoutFreezesResultSet(t *testing.T) {
	sink := newResultSink([]uint32{1, 2})
	sink.out = make([]TickResult, 0, 4)
	sink.deliver(TickResult{ID: 1, Rev: 7})
	p := &RunPool{batch: sink}
	results := p.Collect(time.Now().Add(-time.Second))
	if len(results) != 2 || results[1].ID != 2 || !results[1].Deferred {
		t.Fatalf("missing deferred result: %+v", results)
	}
	sink.deliver(TickResult{ID: 2, Rev: 99})
	if !results[1].Deferred || results[1].Rev != 0 {
		t.Fatalf("late worker rewrote returned frame: %+v", results)
	}
}

func TestCollectConcurrentDeadlineKeepsEveryID(t *testing.T) {
	const n = 64
	ids := make([]uint32, n)
	for i := range ids {
		ids[i] = uint32(i + 1)
	}
	for i := 0; i < 100; i++ {
		sink := newResultSink(ids)
		p := &RunPool{batch: sink}
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, id := range ids {
				sink.deliver(TickResult{ID: id})
			}
		}()
		results := p.Collect(time.Now().Add(-time.Second))
		seen := make(map[uint32]bool, n)
		for _, r := range results {
			if seen[r.ID] {
				t.Fatalf("duplicate result %d", r.ID)
			}
			seen[r.ID] = true
		}
		wg.Wait()
		if len(seen) != n {
			t.Fatalf("deadline lost results: %d/%d", len(seen), n)
		}
	}
}
