package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestReplayExportsOnlyCompleteRecords(t *testing.T) {
	for _, tc := range []struct{ name, input, want string }{
		{"active tail", "{\"tick\":0}\n{\"tick\":120}\n{\"tick\":", "{\"tick\":0}\n{\"tick\":120}\n"},
		{"complete", "{\"tick\":0}\n{\"tick\":120}\n", "{\"tick\":0}\n{\"tick\":120}\n"},
		{"empty", "", ""},
		{"bad complete record stays visible", "not json\n", "not json\n"},
		{"record larger than read buffer", strings.Repeat("x", 65536) + "\npartial", strings.Repeat("x", 65536) + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			if err := copyCompleteRecords(&out, strings.NewReader(tc.input)); err != nil {
				t.Fatal(err)
			}
			if out.String() != tc.want {
				t.Fatalf("output differs: got %d bytes, want %d", out.Len(), len(tc.want))
			}
		})
	}
}
