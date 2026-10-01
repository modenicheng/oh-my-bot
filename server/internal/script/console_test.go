package script

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/dop251/goja"
)

func TestTruncateUTF8StrictBudgets(t *testing.T) {
	tests := []struct {
		name   string
		text   string
		budget int
	}{
		{name: "zero", text: "abcdef", budget: 0},
		{name: "one ascii", text: "abcdef", budget: 1},
		{name: "two ascii", text: "abcdef", budget: 2},
		{name: "one multibyte", text: "界abcdef", budget: 1},
		{name: "two multibyte", text: "界abcdef", budget: 2},
		{name: "ellipsis fits", text: "abcdef", budget: 3},
		{name: "prefix plus ellipsis", text: "abcdef", budget: 4},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, truncated := truncateUTF8(tt.text, tt.budget)
			if !truncated {
				t.Fatal("expected truncation")
			}
			if len(got) > tt.budget {
				t.Fatalf("len=%d exceeds budget=%d: %q", len(got), tt.budget, got)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("invalid UTF-8: %x", []byte(got))
			}
		})
	}
}

func TestFormatConsoleArgsNeverExceedsMessageBudget(t *testing.T) {
	vm := goja.New()
	for _, prefixLen := range []int{maxConsoleMessageBytes - 1, maxConsoleMessageBytes - 2, maxConsoleMessageBytes - 3} {
		args := []goja.Value{vm.ToValue(strings.Repeat("x", prefixLen)), vm.ToValue("界"), vm.ToValue("tail")}
		got, truncated := formatConsoleArgs(args)
		if !truncated {
			t.Fatalf("prefix=%d: expected truncation", prefixLen)
		}
		if len(got) > maxConsoleMessageBytes {
			t.Fatalf("prefix=%d: len=%d exceeds %d", prefixLen, len(got), maxConsoleMessageBytes)
		}
		if !utf8.ValidString(got) {
			t.Fatalf("prefix=%d: invalid UTF-8", prefixLen)
		}
	}
}
