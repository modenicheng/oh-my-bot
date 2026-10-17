package main

import (
	"strings"
	"testing"
	"time"
)

func TestAggregateReportsBitsAndWireMessages(t *testing.T) {
	s := &connStats{}
	s.bytes.Store(1_000_000)
	s.frames.Store(120)
	got := aggregate([]*connStats{s}, time.Second)
	if !strings.Contains(got, "down=8.0 Mbps") || !strings.Contains(got, "ws_msg_s=120") {
		t.Fatalf("wrong bandwidth/message units: %s", got)
	}
}
