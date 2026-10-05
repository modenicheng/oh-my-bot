package script

import (
	"slices"
	"sync"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ============ RunPool：并行脚本执行池（ADR-0007 r2） ============
//
// 职责：把一帧内 N 个 bot 脚本的 Tick 分派到固定 worker 池并行执行，
// Collect(deadline) 收齐全部结果；超 deadline 未完成的标记 Deferred
//（超帧顺延：结果作废、计 idle 不计异常，脚本下一 tick 正常继续）。
//
// 帧时序（仲裁器视角）：Submit(id, frame)... × N → Collect(deadline)
// → 仲裁 → 物理。整帧预算 12ms 由仲裁器持有；脚本池只对传入的 deadline 负责。

// TickResult 单脚本单 tick 结果。
type TickResult struct {
	ID uint32
	// Rev 产生该结果的脚本版本（Hot Swap 对账）。
	Rev uint32
	// Commands 脚本命令。Err != nil 或 Deferred 时为零值（脚本轴全清）。
	Commands sim.ScriptCommands
	// Deferred 超 deadline 未完成，顺延下一 tick（计 idle 不计异常）。
	Deferred bool
	// Err 脚本错误（ErrQuotaExceeded / 运行时异常 / ErrNoModule）。
	Err error
}

// resultSink 单帧结果汇聚点。
type resultSink struct {
	mu      sync.Mutex
	pending map[uint32]struct{}
	out     []TickResult
	notify  chan struct{}
}

func newResultSink(ids []uint32) *resultSink {
	s := &resultSink{
		pending: make(map[uint32]struct{}, len(ids)),
		out:     make([]TickResult, 0, MaxPoolWorkers),
		notify:  make(chan struct{}, 1),
	}
	for _, id := range ids {
		s.pending[id] = struct{}{}
	}
	return s
}

// addPending 注册一个待收 id（Submit 调用，需持 sink.mu —— 由 pool.mu 串行化保护）。
func (s *resultSink) addPending(id uint32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending[id] = struct{}{}
}

func (s *resultSink) deliver(res TickResult) {
	s.mu.Lock()
	if _, ok := s.pending[res.ID]; !ok {
		s.mu.Unlock()
		return // 未知/重复投递，丢弃
	}
	delete(s.pending, res.ID)
	s.out = append(s.out, res)
	s.mu.Unlock()
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

// finish freezes completed and pending IDs in one critical section. Ownership
// of the result slice transfers to Collect; late workers find no pending ID.
func (s *resultSink) finish() ([]TickResult, []uint32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]uint32, 0, len(s.pending))
	for id := range s.pending {
		ids = append(ids, id)
	}
	results := s.out
	s.pending, s.out = nil, nil
	return results, ids
}

func (s *resultSink) isEmpty() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending) == 0
}

// RunPool 固定 worker 并行执行池。一次创建服务整个房间生命周期。
type RunPool struct {
	workers int

	mu       sync.Mutex
	runtimes map[uint32]*GojaRuntime
	batch    *resultSink // 当前帧汇聚点（Collect 后轮转）
	closed   bool

	jobs chan poolJob
	wg   sync.WaitGroup
}

type poolJob struct {
	id       uint32
	frame    sim.ScriptFrame
	rev      uint32
	runtime  *GojaRuntime
	sink     *resultSink
	deadline time.Time
}

// NewRunPool 创建执行池。cfg.PoolSize <= 0 时取 NumWorkers()
// = min(64, NumCPU)（ADR-0007 r2 压测阈值：64 脚本满配额并行）。
func NewRunPool(cfg Config) *RunPool {
	n := cfg.PoolSize
	if n <= 0 {
		n = NumWorkers()
	}
	p := &RunPool{
		workers:  n,
		runtimes: make(map[uint32]*GojaRuntime),
		jobs:     make(chan poolJob, MaxPoolWorkers*4),
	}
	for i := 0; i < n; i++ {
		p.wg.Add(1)
		go p.worker()
	}
	return p
}

// Register 注册/替换 id 对应的脚本运行时（座位 → 运行时绑定）。
// 运行时归池所有：池 Close 时统一回收。重复 Register 覆盖旧运行时。
func (p *RunPool) Register(id uint32, rt *GojaRuntime) {
	p.mu.Lock()
	old := p.runtimes[id]
	p.runtimes[id] = rt
	p.mu.Unlock()
	if old != nil && old != rt {
		old.Close()
	}
}

// Unregister 移除并关闭 id 的运行时（玩家离场）。
func (p *RunPool) Unregister(id uint32) {
	p.mu.Lock()
	rt := p.runtimes[id]
	delete(p.runtimes, id)
	p.mu.Unlock()
	if rt != nil {
		rt.Close()
	}
}

// RuntimeOf 取 id 的运行时（Load/Rev 热替换入口）。不存在返回 nil。
func (p *RunPool) RuntimeOf(id uint32) *GojaRuntime {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.runtimes[id]
}

// Ensure 取 id 的已注册运行时；不存在则创建并注册后返回（尚未装载任何
// 模块）。首次装载失败的调用方应立即 Unregister(id)，避免空 VM 常驻
// 池内逐帧产出 ErrNoModule。池已关闭时返回 nil。
func (p *RunPool) Ensure(id uint32) *GojaRuntime {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	if rt := p.runtimes[id]; rt != nil {
		return rt
	}
	rt := NewGojaRuntime(Config{})
	p.runtimes[id] = rt
	return rt
}

// IDs 返回全部已注册运行时 id 的升序快照（帧内 Submit 顺序确定化）。
func (p *RunPool) IDs() []uint32 {
	p.mu.Lock()
	ids := make([]uint32, 0, len(p.runtimes))
	for id := range p.runtimes {
		ids = append(ids, id)
	}
	p.mu.Unlock()
	slices.Sort(ids)
	return ids
}

// Submit 异步提交一个脚本 tick（当前帧）。不阻塞；返回 nil 表示已入队。
// 错误：ErrPoolClosed / ErrNoSuchScript / *DeferredError（已超 deadline
// 或池满背压——按 deferred 处理，绝不阻塞 sim 帧）。
//
// deadline 为本帧 Collect 的绝对时限；单 job 配额 = min(TickTimeout, 剩余预算)。
func (p *RunPool) Submit(id uint32, frame sim.ScriptFrame, deadline time.Time) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return ErrPoolClosed
	}
	rt := p.runtimes[id]
	if rt == nil {
		p.mu.Unlock()
		return ErrNoSuchScript
	}
	if p.batch == nil {
		p.batch = newResultSink(nil)
	}
	sink := p.batch
	sink.addPending(id) // 注册本帧待收 id（deliver 只接受注册过的 id）
	p.mu.Unlock()

	rev := rt.Rev()
	if !time.Now().Before(deadline) {
		sink.deliver(TickResult{ID: id, Rev: rev, Deferred: true})
		return &DeferredError{ID: id}
	}

	job := poolJob{id: id, frame: frame, rev: rev, runtime: rt, sink: sink, deadline: deadline}
	select {
	case p.jobs <- job:
		return nil
	default:
		// 池满背压：deferred，不阻塞。
		sink.deliver(TickResult{ID: id, Rev: job.rev, Deferred: true})
		return &DeferredError{ID: id}
	}
}

// DeferredError Submit 即判定顺延（超 deadline / 池满）。
type DeferredError struct {
	ID uint32
}

func (e *DeferredError) Error() string { return "script: deferred to next tick" }

// worker 池内 goroutine。同一 id 的运行时在同一时刻至多被一个 worker
// 执行（一帧内同 id 只 Submit 一次；GojaRuntime 内部互斥再兜底 Hot Swap）。
func (p *RunPool) worker() {
	defer p.wg.Done()
	for job := range p.jobs {
		res := p.runJob(job)
		job.sink.deliver(res)
	}
}

func (p *RunPool) runJob(job poolJob) TickResult {
	if !time.Now().Before(job.deadline) {
		return TickResult{ID: job.id, Rev: job.rev, Deferred: true}
	}
	cmds, deferred, err := job.runtime.tickBeforeDeadline(job.frame, job.deadline)
	return TickResult{ID: job.id, Rev: job.runtime.Rev(), Commands: cmds, Deferred: deferred, Err: err}
}

// Collect 收齐当前帧全部结果：阻塞至全部完成或 deadline。
// 超时未完成的 id 以 Deferred=true 返回（命令零值 = idle，不计异常）。
// 返回后帧内 Sink 轮转：后续 Submit 进入下一帧。
func (p *RunPool) Collect(deadline time.Time) []TickResult {
	p.mu.Lock()
	sink := p.batch
	p.batch = nil // 轮转：Collect 之后的 Submit 归下一帧
	p.mu.Unlock()
	if sink == nil {
		return nil
	}

	for !sink.isEmpty() {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		timer := time.NewTimer(remaining)
		select {
		case <-sink.notify:
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
		}
	}

	results, pending := sink.finish()
	for _, id := range pending {
		rev := uint32(0)
		if rt := p.RuntimeOf(id); rt != nil {
			rev = rt.Rev()
		}
		results = append(results, TickResult{ID: id, Rev: rev, Deferred: true})
	}
	return results
}

// Close 关闭池：停止接收、排空 worker、关闭全部运行时。
func (p *RunPool) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	rts := p.runtimes
	p.runtimes = make(map[uint32]*GojaRuntime)
	p.mu.Unlock()

	close(p.jobs)
	p.wg.Wait()
	for _, rt := range rts {
		rt.Close()
	}
}
