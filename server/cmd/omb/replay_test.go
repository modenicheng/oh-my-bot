package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestVisualReplayExportsContinuousAuthoritativeFrames(t *testing.T) {
	var source bytes.Buffer
	log, err := sim.NewMatchEventLogWriter(&source)
	if err != nil {
		t.Fatal(err)
	}
	s := sim.NewSim(9, []uint32{1}, log)
	for tick := uint32(1); tick <= 60; tick++ {
		if tick == 1 || tick == 60 {
			s.ApplyInput(1, &ombv1.ClientInput{Seq: tick, AxisMask: 1, MoveX: 1000})
		}
		s.Tick()
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := writeVisualReplay(&out, bytes.NewReader(source.Bytes())); err != nil {
		t.Fatal(err)
	}
	var visual []replayVisualRecord
	scanner := bufio.NewScanner(bytes.NewReader(out.Bytes()))
	for scanner.Scan() {
		var record struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "input" || record.Type == "control" || record.Type == "checkpoint" {
			t.Fatalf("visual export leaked %s record", record.Type)
		}
		if record.Type == "visual" {
			var frame replayVisualRecord
			if err := json.Unmarshal(scanner.Bytes(), &frame); err != nil {
				t.Fatal(err)
			}
			visual = append(visual, frame)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(visual) != 11 || visual[0].Tick != 0 || visual[len(visual)-1].Tick != 60 {
		t.Fatalf("unexpected visual frames: %+v", visual)
	}
	if visual[1].Robots[0][1] == visual[len(visual)-1].Robots[0][1] {
		t.Fatal("visual export froze robot position")
	}
}

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
