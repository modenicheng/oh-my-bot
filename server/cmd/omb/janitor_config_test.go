package main

import (
	"testing"
	"time"
)

// 空房间清道夫阈值 env（OMB_WARMUP_IDLE_STOP / OMB_ROOM_EVICT_AFTER）解析：
// 空/未设置=未应用（Hub 保留默认）；合法 duration 生效（含 0s——非正值由 Hub
// setter 拒绝）；解析失败回退默认（ok=false）。
func TestEnvDuration(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		want        time.Duration
		wantOK      bool
	}{
		{name: "unset", value: "", wantOK: false},
		{name: "blank", value: "   ", wantOK: false},
		{name: "seconds", value: "15s", want: 15 * time.Second, wantOK: true},
		{name: "minutes", value: "5m", want: 5 * time.Minute, wantOK: true},
		{name: "padded", value: " 3s ", want: 3 * time.Second, wantOK: true},
		{name: "zero passes parsing", value: "0s", want: 0, wantOK: true},
		{name: "invalid unit", value: "soon", wantOK: false},
		{name: "unitless number", value: "15", wantOK: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OMB_WARMUP_IDLE_STOP", tc.value)
			got, ok := envDuration("OMB_WARMUP_IDLE_STOP")
			if ok != tc.wantOK || got != tc.want {
				t.Fatalf("envDuration() = (%s, %v), want (%s, %v)", got, ok, tc.want, tc.wantOK)
			}
		})
	}
}
