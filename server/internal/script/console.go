package script

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/dop251/goja"
)

const (
	maxConsoleMessageBytes       = 1024
	maxConsoleArgs               = 32
	maxConsoleSnapshotDepth      = 4
	maxConsoleSnapshotProperties = 48
	maxConsolePropertyNameBytes  = 64
	structuredConsolePrefix      = "\x1eomb-console:v1:"
)

var gojaProxyType = reflect.TypeOf(goja.Proxy{})

// ScriptLog is a bounded, already-formatted console entry emitted by a script.
// Structured entries contain a versioned static snapshot, never a live object reference.
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
	entries  []ScriptLog
}

func (c *consoleState) reset(revision uint32) {
	*c = consoleState{revision: revision, entries: make([]ScriptLog, 0, 16)}
}

func (c *consoleState) beginTick(tick uint32) {
	c.tick = tick
}

func (c *consoleState) append(level, text string, truncated bool) {
	c.entries = append(c.entries, ScriptLog{
		Revision: c.revision, Tick: c.tick, Level: level, Text: text, Truncated: truncated,
	})
}

func (c *consoleState) drain() []ScriptLog {
	if len(c.entries) == 0 {
		return nil
	}
	out := c.entries
	c.entries = make([]ScriptLog, 0, 16)
	return out
}

type consoleInspector struct {
	vm      *goja.Runtime
	readOwn goja.Callable
}

type consoleProperty struct {
	name  string
	kind  int
	value goja.Value
}

func newConsoleInspector(vm *goja.Runtime) (*consoleInspector, error) {
	value, err := vm.RunString(`(() => {
  const ownNames = Object.getOwnPropertyNames;
  const ownDescriptor = Object.getOwnPropertyDescriptor;
  return value => {
    const names = ownNames(value);
    const rows = [];
    const limit = Math.min(names.length, 48);
    for (let i = 0; i < limit; i++) {
      const name = names[i];
      const descriptor = ownDescriptor(value, name);
      if (!descriptor || !descriptor.enumerable) continue;
      let kind = 0;
      if (!("writable" in descriptor)) kind = descriptor.get && descriptor.set ? 3 : descriptor.get ? 1 : 2;
      rows[rows.length] = [name, kind, kind === 0 ? descriptor.value : undefined];
    }
    return [rows, names.length > limit];
  };
})()`)
	if err != nil {
		return nil, err
	}
	readOwn, ok := goja.AssertFunction(value)
	if !ok {
		return nil, fmt.Errorf("console inspector is not callable")
	}
	return &consoleInspector{vm: vm, readOwn: readOwn}, nil
}

func (i *consoleInspector) properties(value goja.Value) (properties []consoleProperty, more bool, ok bool) {
	result, callErr := i.readOwn(goja.Undefined(), value)
	if callErr != nil {
		panic(callErr)
	}
	resultArray, ok := result.(*goja.Object)
	if !ok {
		return nil, false, false
	}
	rows, ok := resultArray.Get("0").(*goja.Object)
	if !ok {
		return nil, false, false
	}
	length := int(rows.Get("length").ToInteger())
	properties = make([]consoleProperty, 0, length)
	for index := 0; index < length; index++ {
		row, rowOK := rows.Get(strconv.Itoa(index)).(*goja.Object)
		if !rowOK {
			continue
		}
		properties = append(properties, consoleProperty{
			name:  row.Get("0").String(),
			kind:  int(row.Get("1").ToInteger()),
			value: row.Get("2"),
		})
	}
	return properties, resultArray.Get("1").ToBoolean(), true
}

func installConsole(vm *goja.Runtime, state *consoleState) error {
	inspector, err := newConsoleInspector(vm)
	if err != nil {
		return err
	}
	console := vm.NewObject()
	for _, level := range []string{"log", "info", "warn", "error", "debug"} {
		level := level
		if err := console.Set(level, func(call goja.FunctionCall) goja.Value {
			text, truncated := formatConsoleArgs(call.Arguments, inspector)
			state.append(level, text, truncated)
			return goja.Undefined()
		}); err != nil {
			return err
		}
	}
	return vm.Set("console", console)
}

func formatConsoleArgs(args []goja.Value, inspectors ...*consoleInspector) (string, bool) {
	var inspector *consoleInspector
	if len(inspectors) > 0 {
		inspector = inspectors[0]
	}
	limit := len(args)
	if limit > maxConsoleArgs {
		limit = maxConsoleArgs
	}
	hasObject := false
	for _, value := range args[:limit] {
		if _, ok := value.(*goja.Object); ok {
			hasObject = true
			break
		}
	}
	if hasObject && inspector != nil {
		if text, truncated, ok := formatStructuredConsoleArgs(args, inspector); ok {
			return text, truncated
		}
	}
	return formatPlainConsoleArgs(args)
}

func formatPlainConsoleArgs(args []goja.Value) (string, bool) {
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

type consoleValueEncoder struct {
	inspector *consoleInspector
	seen      map[*goja.Object]bool
}

func formatStructuredConsoleArgs(args []goja.Value, inspector *consoleInspector) (string, bool, bool) {
	var out bytes.Buffer
	out.Grow(maxConsoleMessageBytes)
	out.WriteString(structuredConsolePrefix)
	out.WriteString(`{"a":[`)
	encoder := consoleValueEncoder{inspector: inspector, seen: make(map[*goja.Object]bool)}
	included := 0
	truncated := false
	limit := len(args)
	if limit > maxConsoleArgs {
		limit = maxConsoleArgs
		truncated = true
	}
	for index := 0; index < limit; index++ {
		separator := 0
		if included > 0 {
			separator = 1
		}
		remaining := maxConsoleMessageBytes - out.Len() - separator - len(`],"m":4294967295}`)
		encoded, cut := encoder.encode(args[index], remaining, 0)
		if len(encoded) == 0 {
			truncated = true
			break
		}
		if separator > 0 {
			out.WriteByte(',')
		}
		out.Write(encoded)
		included++
		truncated = truncated || cut
	}
	omitted := len(args) - included
	if omitted > 0 {
		truncated = true
	}
	fmt.Fprintf(&out, `],"m":%d}`, omitted)
	if out.Len() > maxConsoleMessageBytes {
		return "", false, false
	}
	return out.String(), truncated, true
}

func (e *consoleValueEncoder) encode(value goja.Value, maxBytes, depth int) ([]byte, bool) {
	if maxBytes < len(`{"k":"x"}`) {
		return nil, true
	}
	if value == nil || goja.IsUndefined(value) {
		return []byte(`{"k":"u"}`), false
	}
	if goja.IsNull(value) {
		return []byte(`{"k":"z"}`), false
	}
	if object, ok := value.(*goja.Object); ok {
		return e.encodeObject(object, maxBytes, depth)
	}
	exported := value.Export()
	switch typed := exported.(type) {
	case string:
		return encodeConsoleLeaf("s", typed, maxBytes)
	case bool:
		return encodeConsoleLeaf("b", strconv.FormatBool(typed), maxBytes)
	case int64:
		return encodeConsoleLeaf("n", strconv.FormatInt(typed, 10), maxBytes)
	case float64:
		return encodeConsoleLeaf("n", strconv.FormatFloat(typed, 'g', -1, 64), maxBytes)
	default:
		return encodeConsoleLeaf("g", fmt.Sprint(exported), maxBytes)
	}
}

func (e *consoleValueEncoder) encodeObject(object *goja.Object, maxBytes, depth int) ([]byte, bool) {
	if object.ExportType() == gojaProxyType {
		return encodeConsoleLeaf("x", "Proxy", maxBytes)
	}
	if _, callable := goja.AssertFunction(object); callable {
		return encodeConsoleLeaf("x", "Function", maxBytes)
	}
	if e.seen[object] {
		return encodeConsoleLeaf("x", "Circular", maxBytes)
	}
	kind := "o"
	label := "Object"
	if object.ClassName() == "Array" {
		kind = "a"
		label = "Array"
	}
	if depth >= maxConsoleSnapshotDepth {
		return encodeConsoleLeaf("x", label+"(…)", maxBytes)
	}
	properties, more, ok := e.inspector.properties(object)
	if !ok {
		return encodeConsoleLeaf("x", label+"(unavailable)", maxBytes)
	}
	e.seen[object] = true
	defer delete(e.seen, object)

	var out bytes.Buffer
	out.WriteString(`{"k":"`)
	out.WriteString(kind)
	out.WriteString(`","p":[`)
	included := 0
	truncated := more
	for index, property := range properties {
		name, nameCut := truncateUTF8(property.name, maxConsolePropertyNameBytes)
		nameJSON, _ := json.Marshal(name)
		propertyPrefix := len(nameJSON) + 2
		separator := 0
		if included > 0 {
			separator = 1
		}
		remaining := maxBytes - out.Len() - separator - propertyPrefix - 1 - len(`],"m":4294967295}`)
		var encoded []byte
		var cut bool
		switch property.kind {
		case 1:
			encoded, cut = encodeConsoleLeaf("x", "Getter", remaining)
		case 2:
			encoded, cut = encodeConsoleLeaf("x", "Setter", remaining)
		case 3:
			encoded, cut = encodeConsoleLeaf("x", "Getter/Setter", remaining)
		default:
			encoded, cut = e.encode(property.value, remaining, depth+1)
		}
		if len(encoded) == 0 {
			truncated = true
			break
		}
		if separator > 0 {
			out.WriteByte(',')
		}
		out.WriteByte('[')
		out.Write(nameJSON)
		out.WriteByte(',')
		out.Write(encoded)
		out.WriteByte(']')
		included++
		truncated = truncated || nameCut || cut
		if index == maxConsoleSnapshotProperties-1 {
			truncated = truncated || len(properties) > included
			break
		}
	}
	omitted := len(properties) - included
	if more && omitted == 0 {
		omitted = 1
	}
	fmt.Fprintf(&out, `],"m":%d}`, omitted)
	if out.Len() > maxBytes {
		return encodeConsoleLeaf("x", label+"(…)", maxBytes)
	}
	return out.Bytes(), truncated
}

func encodeConsoleLeaf(kind, value string, maxBytes int) ([]byte, bool) {
	build := func(text string) []byte {
		encoded, _ := json.Marshal(text)
		out := make([]byte, 0, len(encoded)+16)
		out = append(out, `{"k":"`...)
		out = append(out, kind...)
		out = append(out, `","v":`...)
		out = append(out, encoded...)
		out = append(out, '}')
		return out
	}
	if encoded := build(value); len(encoded) <= maxBytes {
		return encoded, false
	}
	low, high := 0, len(value)
	var best []byte
	for low <= high {
		middle := low + (high-low)/2
		bounded, _ := truncateUTF8(value, middle)
		encoded := build(bounded)
		if len(encoded) <= maxBytes {
			best = encoded
			low = middle + 1
		} else {
			high = middle - 1
		}
	}
	if len(best) > 0 {
		return best, true
	}
	fallback := []byte(`{"k":"x"}`)
	if len(fallback) <= maxBytes {
		return fallback, true
	}
	return nil, true
}

func safeConsoleValue(value goja.Value) string {
	if value == nil || goja.IsUndefined(value) {
		return "undefined"
	}
	if goja.IsNull(value) {
		return "null"
	}
	if _, ok := value.(*goja.Object); ok {
		return "[object]"
	}
	exported := value.Export()
	if exported == nil {
		return "null"
	}
	return fmt.Sprint(exported)
}

func truncateUTF8(text string, maxBytes int) (string, bool) {
	if maxBytes < 0 {
		maxBytes = 0
	}
	valid := strings.ToValidUTF8(text, "")
	changed := valid != text
	text = valid
	if len(text) <= maxBytes {
		return text, changed
	}
	if maxBytes == 0 {
		return "", true
	}

	suffix := "…"
	if maxBytes < len(suffix) {
		cut := maxBytes
		for cut > 0 && !utf8.ValidString(text[:cut]) {
			cut--
		}
		return text[:cut], true
	}

	cut := maxBytes - len(suffix)
	for cut > 0 && !utf8.ValidString(text[:cut]) {
		cut--
	}
	return text[:cut] + suffix, true
}
