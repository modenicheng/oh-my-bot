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
	"github.com/modenicheng/oh-my-bot/server/internal/snippet"
)

// ============ GojaRuntime：sim.Runtime 的 goja 实现 ============

// GojaRuntime 每 bot 一个实例。Tick 可被池 worker 调用、Load 可被房间
// goroutine 调用（Hot Swap），内部互斥串行化；VM 全局 = 模块状态，
// 跨 tick 存活；每次成功 Load 重建。
//
// Snippet 组合模型（v0.3 §9-2）：baseSource 是玩家源码（AI 读写视角），
// snips 是已启用的官方 Snippet 配置；装载时两者 Combine 成单一 VM。
// tick 分两阶段：玩家入口先行（玩家归因），再依序调各 snippetTick
// （受限 bot 视图，snippet 归因；玩家已操作轴丢弃）。Source()/AI 视角
// 只见 baseSource——官方 wrapper 不是玩家代码。
type GojaRuntime struct {
	cfg Config

	mu      sync.Mutex
	vm      *goja.Runtime
	tickFn  goja.Callable   // 玩家入口（无玩家源码时 nil）
	snipFns []goja.Callable // 官方 snippet 模块入口（Combine 注册顺序）
	rev     uint32
	source  string            // 玩家源码原文（AI CurrentScript / 客户端回显视角；未装载为空）
	snips   []snippet.Setting // 当前生效 snippet 配置（Combine 依据；空 = 无 snippet）

	interruptVal any // 配额中断哨兵载荷（闭包类型，脚本无法伪造）
	console      *consoleState
	bindings     *vmBindings // 装载期原生方法缓存（随候选 VM 重建）
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

// Load 编译装载玩家源码（保留当前 snippet 配置重新组合）。失败
// （TS 源码、语法错、运行时错、缺 tick 入口且无 snippet）返回 err 且
// 不替换旧版本——Hot Swap 语义：对局中提交坏脚本，旧脚本继续跑。
func (r *GojaRuntime) Load(source string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.loadLocked(source, r.snips)
}

// LoadSnippets 全量替换 snippet 配置并重新组合（配置保旧：组合失败
// 返回 err 且现役 VM 不动）。baseSource 不变；无玩家源码时仅 snippet 运行。
func (r *GojaRuntime) LoadSnippets(snips []snippet.Setting) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return ErrClosed
	}
	return r.loadLocked(r.source, snips)
}

// Snippets 返回当前生效 snippet 配置（快照）。
func (r *GojaRuntime) Snippets() []snippet.Setting {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]snippet.Setting{}, r.snips...)
}

// LoadIfRev 乐观并发装载（AI Agent 改码落地用）：仅当当前 rev == expected
// 时才装载新源码。expected 已被超越（玩家手动热更或另一 AI 结果先到）时
// 返回 (当前rev, false, nil)，现役脚本不动——迟到结果丢弃。
// 编译失败返回 (当前rev, false, err)，旧版本继续运行（Hot Swap 语义）。
// 新源码与当前 snippet 配置重新组合；AI 视角只见玩家源码。
func (r *GojaRuntime) LoadIfRev(expected uint32, source string) (uint32, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return r.rev, false, ErrClosed
	}
	if r.rev != expected {
		return r.rev, false, nil
	}
	if err := r.loadLocked(source, r.snips); err != nil {
		return r.rev, false, err
	}
	return r.rev, true, nil
}

// Source 返回当前生效玩家源码原文（玩家提交原文，未剥模块语法、不含
// 官方 Snippet wrapper；未装载返回空）。内部互斥，与 Load/Tick 串行。
func (r *GojaRuntime) Source() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.source
}

// loadLocked 编译装载（调用方持 r.mu）。候选 VM 全链路成功才替换现役 VM。
// combined = Combine(baseSource, snips)：玩家源码与官方 snippet 模块同 VM。
func (r *GojaRuntime) loadLocked(baseSource string, snips []snippet.Setting) error {
	if r.closed {
		return ErrClosed
	}
	if detectTypeScript(baseSource) {
		return fmt.Errorf("%w: submit JavaScript instead", ErrTypeScript)
	}
	combined, err := snippet.Combine(baseSource, snips)
	if err != nil {
		return fmt.Errorf("combine snippets: %w", err)
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
	// snippet 注册表：全局绑定不可写/不可配置；组合脚本注册完成后会
	// Object.freeze 数组，玩家源码不能替换、删除或追加官方模块。
	if err := vm.GlobalObject().DefineDataProperty("__ombSnips", vm.NewArray(), goja.FLAG_FALSE, goja.FLAG_FALSE, goja.FLAG_FALSE); err != nil {
		return fmt.Errorf("install snippet registry: %w", err)
	}
	prog, err := goja.Compile("", stripModuleSyntax(combined), false)
	if err != nil {
		return fmt.Errorf("compile: %w", err)
	}
	// 初始化预算覆盖整个候选 VM 装载阶段，而不只是 RunProgram：
	// 玩家可以把死循环藏在 bot.tick getter 或注册表属性读取中。
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
		// 无玩家入口：纯 snippet 运行合法（无玩家源码时 Snippet 仍可单独跑）。
		if baseSource != "" {
			return fmt.Errorf("resolve entry: %w", classifyErr(err, r.interruptVal))
		}
		tickFn = nil
	}
	snipFns, err := collectSnippetFns(vm)
	if err != nil {
		return fmt.Errorf("resolve snippets: %w", classifyErr(err, r.interruptVal))
	}
	if tickFn == nil && len(snipFns) == 0 {
		return fmt.Errorf("no tick entry: %w", ErrNoModule)
	}

	r.vm = vm
	r.bindings = newVMBindings(vm)
	r.tickFn = tickFn
	r.snipFns = snipFns
	r.rev = nextRevision
	r.source = baseSource
	r.snips = append([]snippet.Setting{}, snips...)
	r.console = candidateConsole
	return nil
}

// collectSnippetFns 读出注册表中的官方模块入口（装载期一次）。
func collectSnippetFns(vm *goja.Runtime) ([]goja.Callable, error) {
	reg := vm.Get("__ombSnips")
	if reg == nil || goja.IsUndefined(reg) || goja.IsNull(reg) {
		return nil, nil
	}
	arr, ok := reg.(*goja.Object)
	if !ok {
		return nil, fmt.Errorf("registry is not an array")
	}
	n := arr.Get("length")
	if n == nil || goja.IsUndefined(n) {
		return nil, nil
	}
	count := int(n.ToInteger())
	if count < 0 || count > 16 {
		return nil, fmt.Errorf("registry size %d out of bounds", count)
	}
	fns := make([]goja.Callable, 0, count)
	for i := 0; i < count; i++ {
		v := arr.Get(fmt.Sprintf("%d", i))
		if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
			continue
		}
		fn, ok := goja.AssertFunction(v)
		if !ok {
			return nil, fmt.Errorf("registry entry %d not callable", i)
		}
		fns = append(fns, fn)
	}
	return fns, nil
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

// Tick 在默认配额内执行一次完整 tick（玩家阶段 → snippet 阶段）并
// 收集合并命令。任一阶段超时/异常：全部命令清零（idle）——现有语义。
// SnippetAxes 标记本 tick 由 snippet 阶段实际写入的轴（玩家已操作轴
// 已在受限视图中丢弃，不产生归因）。
func (r *GojaRuntime) Tick(frame sim.ScriptFrame) (sim.ScriptCommands, error) {
	return r.tickLocked(frame, r.cfg.TickTimeout)
}

// tickBeforeDeadline 串行取得 runtime 后重新计算剩余帧预算。排队或等待
// Hot Swap 导致截止已过时，任务必须直接 deferred，不能再推进模块状态。
func (r *GojaRuntime) tickBeforeDeadline(frame sim.ScriptFrame, deadline time.Time) (sim.ScriptCommands, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	quota := time.Until(deadline)
	if quota <= 0 {
		return sim.ScriptCommands{}, true, nil
	}
	if quota > r.cfg.TickTimeout {
		quota = r.cfg.TickTimeout
	}
	cmds, err := r.tickLockedHeld(frame, quota)
	return cmds, false, err
}

// tickLocked 互斥下执行（与 Load/Close 串行，保证 Hot Swap 原子性）。
func (r *GojaRuntime) tickLocked(frame sim.ScriptFrame, quota time.Duration) (sim.ScriptCommands, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tickLockedHeld(frame, quota)
}

func (r *GojaRuntime) tickLockedHeld(frame sim.ScriptFrame, quota time.Duration) (sim.ScriptCommands, error) {
	if r.closed || r.vm == nil || (r.tickFn == nil && len(r.snipFns) == 0) {
		return sim.ScriptCommands{}, ErrNoModule
	}
	vm := r.vm
	r.console.beginTick(frame.Obs.Frame.Tick)

	// 配额中断：AfterFunc 到点 Interrupt。执行后 ClearInterrupt 复位
	//（goja 中断标记 VM 级粘滞，不复位会污染下一 tick）。
	timer := time.AfterFunc(quota, func() { vm.Interrupt(r.interruptVal) })
	defer func() {
		timer.Stop()
		vm.ClearInterrupt()
	}()

	// tick 结束（含异常路径）清空 hooks 的帧引用，避免 64 个 runtime
	// 各自持有最后一帧的 Observation 副本延迟回收（每次 tick 都会重设）。
	defer r.bindings.hooks.release()

	// —— 阶段1：玩家源码（完整权限；归因 = 玩家 Script）——
	playerCmd := newCommandCollector()
	if r.tickFn != nil {
		ctxObj := r.bindings.buildTickContext(frame, playerCmd)
		if _, err := r.tickFn(goja.Undefined(), ctxObj); err != nil {
			return sim.ScriptCommands{}, classifyErr(err, r.interruptVal)
		}
	}
	playerAxes := playerCmd.axes()

	// —— 阶段2：官方 snippet（受限视图；玩家已操作轴丢弃；归因 = N）——
	snipCmd := newSnippetCollector(playerAxes)
	if len(r.snipFns) > 0 {
		ctxObj := r.bindings.buildTickContext(frame, snipCmd)
		for _, fn := range r.snipFns {
			if _, err := fn(goja.Undefined(), ctxObj); err != nil {
				// 官方模块异常不应拖垮玩家源码：丢弃本 tick snippet 产出，
				// 玩家命令保留（组合规则：模块异常仅影响自身产出）。
				if isQuotaErr(classifyErr(err, r.interruptVal)) {
					return sim.ScriptCommands{}, ErrQuotaExceeded // 配额耗尽仍全清
				}
				break
			}
		}
	}

	merged := playerCmd.commands()
	snipOut := snipCmd.commands()
	snipAxes := snipCmd.snippetAxes()
	mergeSnippetInto(&merged, snipOut, snipAxes)
	return merged, nil
}

// isQuotaErr 判断分类后的错误是否配额中断。
func isQuotaErr(err error) bool { return errors.Is(err, ErrQuotaExceeded) }

// mergeSnippetInto 把 snippet 阶段产出合并进玩家命令（玩家优先：
// snippet 收集器已丢弃玩家轴，此处只填空轴；Say/PulseScan 同规则）。
func mergeSnippetInto(dst *sim.ScriptCommands, snip sim.ScriptCommands, snipAxes sim.AxisMask) {
	if dst.Move == nil && snip.Move != nil {
		dst.Move = snip.Move
	}
	if dst.Aim == nil && snip.Aim != nil {
		dst.Aim = snip.Aim
	}
	if dst.Fire == nil && snip.Fire != nil {
		dst.Fire = snip.Fire
	}
	if dst.Dash == nil && snip.Dash != nil {
		dst.Dash = snip.Dash
	}
	if dst.Shield == nil && snip.Shield != nil {
		dst.Shield = snip.Shield
	}
	if dst.Interact == nil && snip.Interact != nil {
		dst.Interact = snip.Interact
	}
	if dst.Say == nil && snip.Say != nil {
		dst.Say = snip.Say
	}
	if !dst.PulseScan && snip.PulseScan {
		dst.PulseScan = true
	}
	dst.SnippetAxes = snipAxes & effectiveAxes(*dst)
}

// effectiveAxes 命令实际操作的轴位图。
func effectiveAxes(c sim.ScriptCommands) sim.AxisMask {
	var m sim.AxisMask
	if c.Move != nil {
		m |= sim.AxisMove
	}
	if c.Aim != nil {
		m |= sim.AxisAim
	}
	if c.Fire != nil {
		m |= sim.AxisFire
	}
	if c.Dash != nil || c.Shield != nil || c.Interact != nil {
		m |= sim.AxisAbility
	}
	return m
}

// classifyErr 区分配额中断与脚本运行时异常。
func classifyErr(err error, sentinel any) error {
	var ie *goja.InterruptedError
	if errors.As(err, &ie) && ie.Value() == sentinel {
		return ErrQuotaExceeded
	}
	return fmt.Errorf("script: tick error: %w", err)
}
