package main

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/room"
)

func TestEnvDefaultSoloBots(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		want        uint32
	}{
		{name: "unset", value: "", want: 0},
		{name: "full room", value: "63", want: room.MaxSoloBots},
		{name: "clamped", value: "999", want: room.MaxSoloBots},
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
