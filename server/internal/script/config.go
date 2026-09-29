package script

import (
	"errors"
	"runtime"
	"time"
)

// ============ 配置 ============

// Config 运行时与执行池配置（NewGojaRuntime / NewRunPool 注入）。
type Config struct {
	// TickTimeout 单 tick wall-clock 配额（<=0 取 DefaultTickTimeout）。
	TickTimeout time.Duration
	// PoolSize 并行 worker 数（<=0 取 NumWorkers()）。
	PoolSize int
}

// DefaultTickTimeout 单 tick 配额 10ms（ADR-0007 r2 / 手册 §tick 模型）。
const DefaultTickTimeout = 10 * time.Millisecond

// MaxPoolWorkers ADR-0007 r2 压测目标：64 脚本满配额并行仍需在整帧 12ms 内。
const MaxPoolWorkers = 64

// NumWorkers 默认 worker 数 = min(64, NumCPU)，至少 1。
func NumWorkers() int {
	n := runtime.NumCPU()
	if n > MaxPoolWorkers {
		n = MaxPoolWorkers
	}
	if n < 1 {
		return 1
	}
	return n
}

// ============ 错误 ============

var (
	// ErrQuotaExceeded 单 tick 配额超时。该 tick 脚本轴全清、计 idle（仲裁器语义）。
	ErrQuotaExceeded = errors.New("script: tick quota exceeded")
	// ErrNoModule 未 Load 任何脚本（或已 Close）时调用 Tick。
	ErrNoModule = errors.New("script: no module loaded")
	// ErrTypeScript v1 不支持 TypeScript 源码（仅 JS；编译器引入延后）。
	ErrTypeScript = errors.New("script: TypeScript not supported in v1 (JavaScript only)")
	// ErrClosed 运行时已 Close。
	ErrClosed = errors.New("script: runtime closed")
	// ErrPoolClosed 执行池已关闭后 Submit。
	ErrPoolClosed = errors.New("script: pool closed")
	// ErrNoSuchScript Submit 了未注册的 id。
	ErrNoSuchScript = errors.New("script: no such script registered")
)
