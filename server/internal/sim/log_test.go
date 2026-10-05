package sim

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func startEvent(tick uint32) *ombv1.ServerEvent {
	return &ombv1.ServerEvent{Tick: tick, Kind: &ombv1.ServerEvent_MatchStart{MatchStart: &ombv1.EvMatchStart{MapSeed: 1<<63 + 1, Players: 2}}}
}

func TestMatchEventLogRoundTrip(t *testing.T) {
	dir := t.TempDir()
	log, err := NewMatchEventLogIn(dir, "match_01-ab")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := log.Close(); err != nil {
			t.Error(err)
		}
	})
	path := filepath.Join(dir, "match_01-ab.jsonl")
	header, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(header) != "{\"schema_version\":1}\n" {
		t.Fatalf("wrong header: %s", header)
	}
	events := []*ombv1.ServerEvent{
		startEvent(1),
		{Tick: 8, Kind: &ombv1.ServerEvent_WallHit{WallHit: &ombv1.EvWallHit{Robot: 7, At: &ombv1.Vec2{X: -.25, Y: 4.5}, Impact: 8}}},
		{Tick: 9, Kind: &ombv1.ServerEvent_Respawn{Respawn: &ombv1.EvRespawn{Robot: 7, Sector: 5}}},
		{Tick: CoreOpenTick, Kind: &ombv1.ServerEvent_PhaseChange{PhaseChange: &ombv1.EvPhaseChange{From: ombv1.Phase_OUTER_RING, To: ombv1.Phase_CORE_OPEN}}},
		{Tick: MatchTicks, Kind: &ombv1.ServerEvent_MatchEnd{MatchEnd: &ombv1.EvMatchEnd{}}},
	}
	events[0].Wall = &timestamppb.Timestamp{Seconds: 1234, Nanos: 987654321}
	before := proto.Clone(events[0])
	for _, ev := range events {
		log.OnEvent(ev.Tick, ev)
	}
	if !proto.Equal(events[0], before) {
		t.Fatal("logger mutated event")
	}
	// Match end flushes without requiring Close.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	records, err := ReadMatchEventLog(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != len(events) {
		t.Fatalf("got %d records, want %d", len(records), len(events))
	}
	for i, record := range records {
		if record.Type != RecordEvent || record.Tick != events[i].Tick || !proto.Equal(record.Event, events[i]) {
			t.Fatalf("event %d differs: %+v", i, record)
		}
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	if err := log.Close(); err != nil {
		t.Fatal("close not idempotent:", err)
	}
	if _, err := NewMatchEventLogIn(dir, "match_01-ab"); !errors.Is(err, os.ErrExist) {
		t.Fatalf("existing log not protected: %v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(data, after) {
		t.Fatal("existing log modified")
	}
}

func TestMatchEventLogPersistsIdentityAndRejectsCorruption(t *testing.T) {
	var buffer bytes.Buffer
	log, err := NewMatchEventLogWriter(&buffer)
	if err != nil {
		t.Fatal(err)
	}
	players := []MatchPlayer{
		{RobotID: 9, PlayerID: 1<<60 + 1, Nick: "host", Partner: 2},
		{RobotID: 2, PlayerID: 1<<60 + 2, Nick: "test bot", Partner: 9, Bot: true},
	}
	if err := log.SetPlayers(players); err != nil {
		t.Fatal(err)
	}
	players[0].Nick = "modified"
	log.OnMatchInit(Checkpoint{Robots: []Robot{{ID: 2}, {ID: 9}}, Walls: []Wall{}})
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	records, err := ReadMatchEventLog(bytes.NewReader(buffer.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || !reflect.DeepEqual(records[0].Players, []MatchPlayer{
		{RobotID: 2, PlayerID: 1<<60 + 2, Nick: "test bot", Partner: 9, Bot: true},
		{RobotID: 9, PlayerID: 1<<60 + 1, Nick: "host", Partner: 2},
	}) {
		t.Fatalf("match identity roundtrip: %+v", records)
	}
	if err := log.SetPlayers(players); err == nil {
		t.Fatal("identity changed after match start")
	}
	for name, players := range map[string]string{
		"unknown robot":   `[ {"robot_id":3,"player_id":1} ]`,
		"duplicate":       `[ {"robot_id":2,"player_id":1}, {"robot_id":2,"player_id":2} ]`,
		"missing player":  `[ {"robot_id":2,"player_id":1} ]`,
		"unknown partner": `[ {"robot_id":2,"player_id":1,"partner":3}, {"robot_id":9,"player_id":2} ]`,
	} {
		t.Run(name, func(t *testing.T) {
			record := fmt.Sprintf(`{"type":"match_start","tick":0,"state":{"tick":0,"robots":[{"id":2},{"id":9}],"walls":[]},"players":%s}`, players)
			if _, err := ReadMatchEventLog(strings.NewReader("{\"schema_version\":1}\n" + record + "\n")); err == nil {
				t.Fatal("corrupt identity accepted")
			}
		})
	}
}

func TestMatchEventLogCheckpointAndReplay(t *testing.T) {
	var buffer bytes.Buffer
	log, err := NewMatchEventLogWriter(&buffer)
	if err != nil {
		t.Fatal(err)
	}
	s := NewSim(^uint64(0), []uint32{7, 1}, log)
	if err := s.SetWalls([]Wall{{ID: 1, Min: Vec2{1, -1}, Max: Vec2{2, 1}}}); err != nil {
		t.Fatal(err)
	}
	for tick := uint32(1); tick <= CheckpointInterval*2; tick++ {
		if tick == 1 {
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 1, MoveX: 1000, Aim: 1.25, Fire: true})
			s.ApplyInput(7, &ombv1.ClientInput{Seq: 3, MoveY: -500})
		}
		if tick == 101 {
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 2, MoveX: -1000})
		}
		if tick == 201 {
			s.ApplyInput(1, &ombv1.ClientInput{Seq: 4})
		}
		if tick == 401 {
			s.Respawn(1)
		}
		s.Tick()
	}
	if err := log.Err(); err != nil {
		t.Fatal(err)
	}
	// Checkpoints must already be flushed at 3600 and 7200, with no Close.
	records, err := ReadMatchEventLog(bytes.NewReader(buffer.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	var initial *Checkpoint
	var checkpoints []Checkpoint
	var events []*ombv1.ServerEvent
	inputs := make(map[uint32][]LogRecord)
	respawns := make(map[uint32][]uint32)
	for _, record := range records {
		switch record.Type {
		case RecordMatchStart:
			initial = record.State
		case RecordCheckpoint:
			checkpoints = append(checkpoints, *record.State)
		case RecordInput:
			inputs[record.Tick] = append(inputs[record.Tick], record)
		case RecordEvent:
			events = append(events, record.Event)
			if ev := record.Event.GetRespawn(); ev != nil {
				respawns[record.Tick] = append(respawns[record.Tick], ev.Robot)
			}
		}
	}
	if initial == nil || initial.Seed != ^uint64(0) || initial.Tick != 0 || len(initial.Robots) != 2 || initial.Robots[0].ID != 1 {
		t.Fatal("initial player table/seed lost")
	}
	if len(checkpoints) != 2 || checkpoints[0].Tick != 3600 || checkpoints[1].Tick != 7200 {
		t.Fatal("checkpoint interval wrong")
	}
	if !reflect.DeepEqual(s.Snapshot(), checkpoints[1]) {
		t.Fatal("checkpoint JSON roundtrip not exact")
	}
	// Prove the logged inputs and respawn events form a replay basis, not just
	// readable telemetry. Rebuild initial configuration through public APIs.
	sink := &recordingSink{}
	ids := make([]uint32, len(initial.Robots))
	for i, r := range initial.Robots {
		ids[i] = r.ID
	}
	replay := NewSim(initial.Seed, ids, sink)
	for _, r := range initial.Robots {
		if err := replay.SetSpawn(r.ID, r.SpawnPosition, r.Sector); err != nil {
			t.Fatal(err)
		}
	}
	if err := replay.SetWalls(initial.Walls); err != nil {
		t.Fatal(err)
	}
	for tick := uint32(1); tick <= s.CurrentTick(); tick++ {
		for _, record := range inputs[tick] {
			in := record.Input
			if !replay.ApplyInput(record.RobotID, &ombv1.ClientInput{Seq: in.Seq, MoveX: in.MoveX, MoveY: in.MoveY, Aim: in.Aim, Fire: in.Fire, Dash: in.Dash, Shield: in.Shield, Interact: in.Interact}) {
				t.Fatal("replay rejected logged input")
			}
		}
		for _, robotID := range respawns[tick] {
			replay.Respawn(robotID)
		}
		replay.Tick()
	}
	if !reflect.DeepEqual(s.Snapshot(), replay.Snapshot()) {
		t.Fatal("replay final state differs")
	}
	if len(events) != len(sink.events) {
		t.Fatal("replay event count differs")
	}
	for i, ev := range events {
		if !proto.Equal(ev, sink.events[i]) {
			t.Fatalf("replay event %d differs", i)
		}
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestMatchEventLogDefaultPathAndIDs(t *testing.T) {
	t.Chdir(t.TempDir())
	for _, id := range []string{"", "../escape", "/absolute", "a/b", "a\\b", "..", "a:b", strings.Repeat("a", 129)} {
		if _, err := NewMatchEventLog(id); err == nil {
			t.Fatalf("unsafe ID accepted: %q", id)
		}
	}
	log, err := NewMatchEventLog("safe-42")
	if err != nil {
		t.Fatal(err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join("data", "matches", "safe-42.jsonl")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("not-directory", []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewMatchEventLogIn("not-directory", "safe"); err == nil {
		t.Fatal("file accepted as directory")
	}
}

func TestMatchEventLogRejectsInvalidSchema(t *testing.T) {
	for _, header := range []string{"", "{}\n", "null\n", "{\"schema_version\":0}\n", "{\"schema_version\":2}\n", "{\"schema_version\":1,\"unknown\":true}\n", "{\"schema_version\":1} {}\n", "{\"schema_version\":\"1\"}\n", "[1]\n"} {
		t.Run(fmt.Sprintf("header_%q", header), func(t *testing.T) {
			if _, err := NewMatchEventLogReader(strings.NewReader(header)); err == nil {
				t.Fatal("bad header accepted")
			}
		})
	}
	if _, err := NewMatchEventLogReader(nil); err == nil {
		t.Fatal("nil reader accepted")
	}
	if _, err := NewMatchEventLogWriter(nil); err == nil {
		t.Fatal("nil writer accepted")
	}
}

func TestMatchEventLogRejectsCorruptRecords(t *testing.T) {
	tests := map[string]string{
		"invalid_json":          "{",
		"blank":                 "\n",
		"null":                  "null",
		"missing_type":          `{"tick":1}`,
		"unknown_type":          `{"type":"future","tick":1}`,
		"unknown_field":         `{"type":"event","tick":1,"future":1,"event":{"tick":1,"matchStart":{}}}`,
		"empty_event":           `{"type":"event","tick":1,"event":{"tick":1}}`,
		"null_event":            `{"type":"event","tick":1,"event":null}`,
		"missing_event":         `{"type":"event","tick":1}`,
		"tick_mismatch":         `{"type":"event","tick":1,"event":{"tick":2,"matchStart":{}}}`,
		"beyond_end":            `{"type":"event","tick":28801,"event":{"tick":28801,"matchStart":{}}}`,
		"unknown_proto_field":   `{"type":"event","tick":1,"event":{"tick":1,"future":{}}}`,
		"two_json_values":       `{"type":"event","tick":1,"event":{"tick":1,"matchStart":{}}} {}`,
		"missing_state":         `{"type":"checkpoint","tick":3600}`,
		"incomplete_state":      `{"type":"checkpoint","tick":3600,"state":{"tick":3600}}`,
		"wrong_checkpoint_tick": `{"type":"checkpoint","tick":3601,"state":{"tick":3601,"robots":[],"walls":[]}}`,
		"initial_tick_nonzero":  `{"type":"match_start","tick":1,"state":{"tick":1,"robots":[],"walls":[]}}`,
		"invalid_input":         `{"type":"input","tick":1,"robot_id":1,"input":{"move_x":1001}}`,
		"no_robot_id":           `{"type":"input","tick":1,"input":{}}`,
		"multiple_payloads":     `{"type":"event","tick":1,"event":{"tick":1,"matchStart":{}},"input":{}}`,
		"backward_ticks":        "{\"type\":\"event\",\"tick\":2,\"event\":{\"tick\":2,\"matchStart\":{}}}\n{\"type\":\"event\",\"tick\":1,\"event\":{\"tick\":1,\"matchStart\":{}}}",
	}
	for name, line := range tests {
		t.Run(name, func(t *testing.T) {
			text := "{\"schema_version\":1}\n" + line + "\n"
			if _, err := ReadMatchEventLog(strings.NewReader(text)); err == nil {
				t.Fatal("corrupt record accepted")
			}
		})
	}
	r, err := NewMatchEventLogReader(strings.NewReader("{\"schema_version\":1}\n{}\n"))
	if err != nil {
		t.Fatal(err)
	}
	_, first := r.Read()
	_, again := r.Read()
	if first == nil || first != again {
		t.Fatal("reader failure must be sticky")
	}
}

type failingWriter struct {
	fail  bool
	calls int
}

var errStorage = errors.New("storage unavailable")

func (w *failingWriter) Write(p []byte) (int, error) {
	w.calls++
	if w.fail {
		return 0, errStorage
	}
	return len(p), nil
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errStorage }

func TestMatchEventLogIOFailures(t *testing.T) {
	if _, err := NewMatchEventLogWriter(&failingWriter{fail: true}); !errors.Is(err, errStorage) {
		t.Fatalf("header write failure lost: %v", err)
	}
	w := &failingWriter{}
	log, err := NewMatchEventLogWriter(w)
	if err != nil {
		t.Fatal(err)
	}
	w.fail = true
	log.OnEvent(1, startEvent(1))
	if err := log.Flush(); !errors.Is(err, errStorage) {
		t.Fatalf("flush failure lost: %v", err)
	}
	calls := w.calls
	log.OnEvent(2, startEvent(2))
	if !errors.Is(log.Err(), errStorage) || !errors.Is(log.Close(), errStorage) || calls != w.calls {
		t.Fatal("writer failure was not sticky")
	}
	if _, err := NewMatchEventLogReader(failingReader{}); !errors.Is(err, errStorage) {
		t.Fatal("header read failure lost")
	}
	r, err := NewMatchEventLogReader(io.MultiReader(strings.NewReader("{\"schema_version\":1}\n"), failingReader{}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Read(); !errors.Is(err, errStorage) {
		t.Fatal("record read failure lost")
	}
	var buffer bytes.Buffer
	closed, err := NewMatchEventLogWriter(&buffer)
	if err != nil {
		t.Fatal(err)
	}
	if err := closed.Close(); err != nil {
		t.Fatal(err)
	}
	closed.OnEvent(1, startEvent(1))
	if !errors.Is(closed.Err(), os.ErrClosed) {
		t.Fatal("write after close not reported")
	}
}

func TestMatchEventLogWriterValidation(t *testing.T) {
	tests := map[string]func(*MatchEventLog){
		"nil_event":             func(l *MatchEventLog) { l.OnEvent(1, nil) },
		"missing_kind":          func(l *MatchEventLog) { l.OnEvent(1, &ombv1.ServerEvent{Tick: 1}) },
		"tick_mismatch":         func(l *MatchEventLog) { l.OnEvent(2, startEvent(1)) },
		"backwards":             func(l *MatchEventLog) { l.OnEvent(2, startEvent(2)); l.OnEvent(1, startEvent(1)) },
		"incomplete_checkpoint": func(l *MatchEventLog) { l.OnCheckpoint(Checkpoint{Tick: CheckpointInterval}) },
		"invalid_input":         func(l *MatchEventLog) { l.OnInput(1, 0, Input{}) },
	}
	for name, invalid := range tests {
		t.Run(name, func(t *testing.T) {
			var buffer bytes.Buffer
			l, err := NewMatchEventLogWriter(&buffer)
			if err != nil {
				t.Fatal(err)
			}
			invalid(l)
			if l.Err() == nil {
				t.Fatal("invalid record accepted")
			}
			if err := l.Close(); err == nil {
				t.Fatal("failure not propagated by Close")
			}
		})
	}
}

func TestMatchEventLogLargeCheckpoint(t *testing.T) {
	ids := make([]uint32, 64)
	for i := range ids {
		ids[i] = uint32(i + 1)
	}
	s := NewSim(1, ids, nil)
	walls := make([]Wall, 700)
	for i := range walls {
		x := 100 + float64(i)*2
		walls[i] = Wall{ID: uint32(i + 1), Min: Vec2{x, 100}, Max: Vec2{x + 1, 101}}
	}
	if err := s.SetWalls(walls); err != nil {
		t.Fatal(err)
	}
	advance(s, CheckpointInterval)
	cp := s.Snapshot()
	var buffer bytes.Buffer
	l, err := NewMatchEventLogWriter(&buffer)
	if err != nil {
		t.Fatal(err)
	}
	l.OnCheckpoint(cp)
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	if buffer.Len() <= 64*1024 {
		t.Fatal("test must exceed Scanner's default 64KiB limit")
	}
	records, err := ReadMatchEventLog(bytes.NewReader(buffer.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || !reflect.DeepEqual(*records[0].State, cp) {
		t.Fatal("large checkpoint not preserved")
	}
}
