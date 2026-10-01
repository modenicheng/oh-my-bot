package script

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/dop251/goja"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ============ GojaRuntime：sim.Runtime 的 goja 实现 ============

// GojaRuntime 每 bot 一个实例。Tick 可被池 worker 调用、Load 可被房间
// goroutine 调用（Hot Swap），内部互斥串行化；VM 全局 = 模块状态，
// 跨 tick 存活；每次成功 Load 重建。
type GojaRuntime struct {
	cfg Config

	mu     sync.Mutex
	vm     *goja.Runtime
	tickFn goja.Callable
	rev    uint32

	interruptVal any // 配额中断哨兵载荷（闭包类型，脚本无法伪造）
	console      *consoleState
	closed       bool
}

// quotaInterrupt 私有哨兵：只有配额超时以 ErrQuotaExceeded 上报，
// 与脚本自身 throw 的任意值区分。
type quotaInterrupt struct{}

// NewGojaRuntime 创建运行时。cfg 零值字段取默认（10ms / NumWorkers）。
func NewGojaRuntime(cfg Config) *GojaRuntime {
	if cfg.TickTimeout <= 0 {
		cfg.TickTimeout = DefaultTickTimeout
	}
	if cfg.PoolSize <= 0 {
		cfg.PoolSize = NumWorkers()
	}
	r := &GojaRuntime{
		cfg:          cfg,
		interruptVal: quotaInterrupt{},
	}
	r.console = &consoleState{}
	r.console.reset(0)
	return r
}

// ---- 手册入口兼容（§五行代码起步） ----
//
// 手册示例是 TS 书写、JS 语义：`import type {...}` + `export default bot`。
// goja 不支持 ES module，Load 前剥除这两类纯类型/导出语句；剥除后须为合法 JS。
var (
	reImportType    = regexp.MustCompile(`(?m)^[ \t]*import\s+type\s[^\n]*$`)
	reImportSide    = regexp.MustCompile(`(?m)^[ \t]*import\s*['"][^'"]*['"];?[ \t]*$`)
	reExportDefault = regexp.MustCompile(`(?m)^[ \t]*export\s+default\s[^\n]*$`)
	reExportNamed   = regexp.MustCompile(`(?m)^[ \t]*export[ \t]+(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*|function\s+[A-Za-z_$][\w$]*|class\s+[A-Za-z_$][\w$]*)`)
)

func stripModuleSyntax(src string) string {
	out := reImportType.ReplaceAllString(src, "")
	out = reImportSide.ReplaceAllString(out, "")
	out = reExportDefault.ReplaceAllString(out, "")
	// export const x = 1 → const x = 1（保留声明，只去 export 关键字）。
	out = reExportNamed.ReplaceAllStringFunc(out, trimLeadingExport)
	return out
}

// trimLeadingExport 去掉行内 export（保留前导空白与后续声明）。
func trimLeadingExport(line string) string {
	i := strings.Index(line, "export")
	if i < 0 {
		return line
	}
	return line[:i] + line[i+len("export"):]
}

// Load 编译装载玩家源码。失败（TS 源码、语法错、运行时错、缺 tick 入口）
// 返回 err 且不替换旧版本——Hot Swap 语义：对局中提交坏脚本，旧脚本继续跑。
func (r *GojaRuntime) Load(source string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return ErrClosed
	}
	if detectTypeScript(source) {
		return fmt.Errorf("%w: submit JavaScript instead", ErrTypeScript)
	}

	// 候选 VM 全链路成功才替换现役 VM——原子 Hot Swap。
	vm := goja.New()
	nextRevision := r.rev + 1
	candidateConsole := &consoleState{}
	candidateConsole.reset(nextRevision)
	candidateConsole.beginTick(0)
	if err := installConsole(vm, candidateConsole); err != nil {
		return fmt.Errorf("install console: %w", err)
	}
	prog, err := goja.Compile("", stripModuleSyntax(source), false)
	if err != nil {
		return fmt.Errorf("compile: %w", err)
	}
	timer := time.AfterFunc(r.cfg.TickTimeout, func() { vm.Interrupt(r.interruptVal) })
	defer func() {
		timer.Stop()
		vm.ClearInterrupt()
	}()
	_, runErr := vm.RunProgram(prog)
	if runErr != nil {
		return fmt.Errorf("evaluate: %w", classifyErr(runErr, r.interruptVal))
	}
	tickFn, err := resolveTickSafely(vm)
	if err != nil {
		return fmt.Errorf("resolve entry: %w", classifyErr(err, r.interruptVal))
	}

	r.vm = vm
	r.tickFn = tickFn
	r.rev = nextRevision
	r.console = candidateConsole
	return nil
}

// resolveTick 解析入口：顶层 `function tick(ctx)` 或 `bot.tick`（手册示例
// `const bot = { tick(ctx) {} }` 剥除 export 后的全局 bot）。
func resolveTickSafely(vm *goja.Runtime) (fn goja.Callable, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			if recoveredErr, ok := recovered.(error); ok {
				err = recoveredErr
				return
			}
			err = fmt.Errorf("entry resolution panic: %v", recovered)
		}
	}()
	return resolveTick(vm)
}

func resolveTick(vm *goja.Runtime) (goja.Callable, error) {
	if bot := vm.Get("bot"); bot != nil && !goja.IsUndefined(bot) && !goja.IsNull(bot) {
		if obj, ok := bot.(*goja.Object); ok {
			if t := obj.Get("tick"); callableValue(t) {
				fn, _ := goja.AssertFunction(t)
				return fn, nil
			}
		}
	}
	if t := vm.Get("tick"); callableValue(t) {
		fn, _ := goja.AssertFunction(t)
		return fn, nil
	}
	return nil, fmt.Errorf("no tick entry: expected top-level tick(ctx) function or bot object with .tick")
}

func callableValue(v goja.Value) bool {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return false
	}
	_, ok := goja.AssertFunction(v)
	return ok
}

// Rev 当前版本号（Load 成功单调 +1；0 = 未装载）。
func (r *GojaRuntime) Rev() uint32 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.rev
}

// DrainLogs returns bounded console output since the previous drain.
func (r *GojaRuntime) DrainLogs() []ScriptLog {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.console.drain()
}

// Close 关闭运行时。后续 Load/Tick 返回 ErrClosed / ErrNoModule。
func (r *GojaRuntime) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	r.closed = true
	if r.vm != nil {
		r.vm.Interrupt(r.interruptVal)
		r.vm = nil
	}
	r.tickFn = nil
}

// Tick 在默认配额内执行一次 tick(ctx) 并收集命令。
// 超时 → ErrQuotaExceeded；脚本异常 → 包装 err。两者命令全清（idle）。
func (r *GojaRuntime) Tick(frame sim.ScriptFrame) (sim.ScriptCommands, error) {
	return r.tickLocked(frame, r.cfg.TickTimeout)
}

// tickWithQuota 池 worker 入口：配额可收紧为帧剩余预算。
func (r *GojaRuntime) tickWithQuota(frame sim.ScriptFrame, quota time.Duration) (sim.ScriptCommands, error) {
	if quota <= 0 {
		return sim.ScriptCommands{}, ErrQuotaExceeded
	}
	return r.tickLocked(frame, quota)
}

// tickLocked 互斥下执行（与 Load/Close 串行，保证 Hot Swap 原子性）。
func (r *GojaRuntime) tickLocked(frame sim.ScriptFrame, quota time.Duration) (sim.ScriptCommands, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.tickFn == nil || r.vm == nil {
		return sim.ScriptCommands{}, ErrNoModule
	}
	vm := r.vm
	r.console.beginTick(frame.Obs.Frame.Tick)

	cmd := newCommandCollector()
	ctxObj := buildTickContext(vm, frame, cmd)

	// 配额中断：AfterFunc 到点 Interrupt。执行后 ClearInterrupt 复位
	//（goja 中断标记 VM 级粘滞，不复位会污染下一 tick）。
	timer := time.AfterFunc(quota, func() { vm.Interrupt(r.interruptVal) })
	defer func() {
		timer.Stop()
		vm.ClearInterrupt()
	}()

	_, err := r.tickFn(goja.Undefined(), ctxObj)
	if err != nil {
		return sim.ScriptCommands{}, classifyErr(err, r.interruptVal)
	}
	return cmd.commands(), nil
}

// classifyErr 区分配额中断与脚本运行时异常。
func classifyErr(err error, sentinel any) error {
	var ie *goja.InterruptedError
	if errors.As(err, &ie) && ie.Value() == sentinel {
		return ErrQuotaExceeded
	}
	return fmt.Errorf("script: tick error: %w", err)
}
