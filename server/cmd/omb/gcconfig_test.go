package main

import (
	"strings"
	"testing"
)

func TestParseByteSize(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"512MiB", 512 << 20, true},
		{"512mib", 512 << 20, true},
		{"512M", 512 << 20, true},
		{"1GiB", 1 << 30, true},
		{"768KB", 768 << 10, true},
		{"64KiB", 64 << 10, true},
		{"1073741824", 1 << 30, true},
		{"2G", 2 << 30, true},
		{"", 0, false},
		{"MiB", 0, false},
		{"12XiB", 0, false},
	}
	for _, tc := range cases {
		got, err := parseByteSize(tc.in)
		if tc.ok && err != nil {
			t.Errorf("parseByteSize(%q): unexpected err %v", tc.in, err)
			continue
		}
		if !tc.ok {
			if err == nil {
				t.Errorf("parseByteSize(%q): expected error, got %d", tc.in, got)
			}
			continue
		}
		if got != tc.want {
			t.Errorf("parseByteSize(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestByteSizeHuman(t *testing.T) {
	if got := byteSizeHuman(512 << 20); !strings.Contains(got, "MiB") {
		t.Errorf("byteSizeHuman(512MiB) = %q", got)
	}
	if got := byteSizeHuman(-1); got != "off" {
		t.Errorf("byteSizeHuman(-1) = %q, want off", got)
	}
}
