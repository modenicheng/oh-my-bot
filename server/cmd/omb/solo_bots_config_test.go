package main

import (
	"strconv"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/room"
)

func TestEnvDefaultSoloBots(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		want        uint32
	}{
		{name: "unset", value: "", want: 0},
		// 满房值随席位上限（默认 200 → 199）推导，不硬编码。
		{name: "full room", value: strconv.Itoa(room.MaxSoloBots), want: uint32(room.MaxSoloBots)},
		{name: "clamped", value: "999", want: uint32(room.MaxSoloBots)},
		{name: "invalid", value: "many", want: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OMB_DEFAULT_SOLO_BOTS", tc.value)
			if got := envDefaultSoloBots(); got != tc.want {
				t.Fatalf("envDefaultSoloBots() = %d, want %d", got, tc.want)
			}
		})
	}
}
