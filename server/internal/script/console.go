package script

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/dop251/goja"
)

const (
	maxConsoleMessageBytes = 1024
	maxConsoleArgs         = 32
	maxConsoleMessagesTick = 12
	maxConsoleBytesTick    = 4 * 1024
	maxConsoleMessagesSec  = 40
	maxConsoleBytesSec     = 16 * 1024
	maxConsoleBuffered     = 128
)

// ScriptLog is a bounded, already-formatted console entry emitted by a script.
// Object properties are never inspected while formatting, so getters, proxies,
// cycles, and user-defined toString implementations cannot escape the tick quota.
type ScriptLog struct {
	Revision  uint32
	Tick      uint32
	Level     string
	Text      string
	Truncated bool
}

type consoleState struct {
	revision uint32
	tick     uint32

	tickMessages int
	tickBytes    int
	secStartTick uint32
	secMessages  int
	secBytes     int

	droppedMessages int
	droppedBytes    int
	noticeTick      uint32
	noticeSent      bool
	entries         []ScriptLog
}

func (c *consoleState) reset(revision uint32) {
	*c = consoleState{revision: revision, entries: make([]ScriptLog, 0, 16)}
}

func (c *consoleState) beginTick(tick uint32) {
	c.tick = tick
	c.tickMessages = 0
	c.tickBytes = 0
	if tick < c.secStartTick || tick-c.secStartTick >= 60 {
		c.secStartTick = tick
		c.secMessages = 0
		c.secBytes = 0
	}
}

func (c *consoleState) append(level, text string, truncated bool) {
	bytes := len(text)
	if c.tickMessages >= maxConsoleMessagesTick || c.tickBytes+bytes > maxConsoleBytesTick ||
		c.secMessages >= maxConsoleMessagesSec || c.secBytes+bytes > maxConsoleBytesSec ||
		len(c.entries) >= maxConsoleBuffered {
		c.droppedMessages++
		c.droppedBytes += bytes
		return
	}
	c.tickMessages++
	c.tickBytes += bytes
	c.secMessages++
	c.secBytes += bytes
	c.entries = append(c.entries, ScriptLog{
		Revision: c.revision, Tick: c.tick, Level: level, Text: text, Truncated: truncated,
	})
}

func (c *consoleState) drain() []ScriptLog {
	emitNotice := c.droppedMessages > 0 && (!c.noticeSent || c.tick < c.noticeTick || c.tick-c.noticeTick >= 60)
	n := len(c.entries)
	if emitNotice {
		n++
	}
	if n == 0 {
		return nil
	}
	out := make([]ScriptLog, 0, n)
	out = append(out, c.entries...)
	if emitNotice {
		out = append(out, ScriptLog{
			Revision:  c.revision,
			Tick:      c.tick,
			Level:     "warn",
			Text:      fmt.Sprintf("console limit reached: dropped %d message(s), %d byte(s)", c.droppedMessages, c.droppedBytes),
			Truncated: true,
		})
		c.droppedMessages = 0
		c.droppedBytes = 0
		c.noticeTick = c.tick
		c.noticeSent = true
	}
	c.entries = c.entries[:0]
	return out
}

func installConsole(vm *goja.Runtime, state *consoleState) error {
	console := vm.NewObject()
	for _, level := range []string{"log", "info", "warn", "error", "debug"} {
		level := level
		if err := console.Set(level, func(call goja.FunctionCall) goja.Value {
			text, truncated := formatConsoleArgs(call.Arguments)
			state.append(level, text, truncated)
			return goja.Undefined()
		}); err != nil {
			return err
		}
	}
	return vm.Set("console", console)
}

func formatConsoleArgs(args []goja.Value) (string, bool) {
	limit := len(args)
	omitted := 0
	if limit > maxConsoleArgs {
		omitted = limit - maxConsoleArgs
		limit = maxConsoleArgs
	}
	var out strings.Builder
	out.Grow(maxConsoleMessageBytes)
	truncated := omitted > 0
	for i := 0; i < limit; i++ {
		part := safeConsoleValue(args[i])
		if i > 0 {
			part = " " + part
		}
		remaining := maxConsoleMessageBytes - out.Len()
		if remaining <= 0 {
			truncated = true
			break
		}
		bounded, cut := truncateUTF8(part, remaining)
		out.WriteString(bounded)
		if cut {
			truncated = true
			break
		}
	}
	if omitted > 0 && out.Len() < maxConsoleMessageBytes {
		suffix := fmt.Sprintf(" … [+%d args]", omitted)
		bounded, _ := truncateUTF8(suffix, maxConsoleMessageBytes-out.Len())
		out.WriteString(bounded)
	}
	return out.String(), truncated
}

func safeConsoleValue(value goja.Value) string {
	if value == nil || goja.IsUndefined(value) {
		return "undefined"
	}
	if goja.IsNull(value) {
		return "null"
	}
	if _, ok := value.(*goja.Object); ok {
		// Do not inspect class names or properties: proxies, getters, cycles, and
		// user-defined coercion hooks must never execute during logging.
		return "[object]"
	}
	exported := value.Export()
	if exported == nil {
		return "null"
	}
	return fmt.Sprint(exported)
}

func truncateUTF8(text string, maxBytes int) (string, bool) {
	if len(text) <= maxBytes {
		return text, false
	}
	suffix := "…"
	cut := maxBytes - len(suffix)
	if cut < 0 {
		cut = 0
	}
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + suffix, true
}
