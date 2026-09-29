package sim

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"google.golang.org/protobuf/encoding/protojson"
)

const (
	SchemaVersion = 1
	maxLogLine    = 16 * 1024 * 1024
)

// LogRecord is the full log stream, not merely the online ServerEvent subset.
// Type is event, match_start (initial state), input, or checkpoint. Exactly one
// payload is populated. Record order within a tick is significant.
type LogRecord struct {
	Type    string
	Tick    uint32
	Event   *ombv1.ServerEvent
	State   *Checkpoint
	RobotID uint32
	Input   *Input
}

type logHeader struct {
	SchemaVersion int `json:"schema_version"`
}

type diskRecord struct {
	Type    string          `json:"type"`
	Tick    uint32          `json:"tick"`
	Event   json.RawMessage `json:"event,omitempty"`
	State   *Checkpoint     `json:"state,omitempty"`
	RobotID uint32          `json:"robot_id,omitempty"`
	Input   *Input          `json:"input,omitempty"`
}

// MatchEventLog is single-owner like Sim. It flushes its buffer at construction,
// match initialization, every checkpoint, match end, explicit Flush, and Close.
// Flush reaches the underlying writer (not an fsync durability guarantee).
// The owner MUST check Err/Flush/Close: EventSink cannot return failures. Errors
// are sticky; a failed record is never silently skipped in a continuing stream.
type MatchEventLog struct {
	buffer   *bufio.Writer
	file     *os.File
	err      error
	closed   bool
	lastTick uint32
}

var (
	_ EventSink      = (*MatchEventLog)(nil)
	_ CheckpointSink = (*MatchEventLog)(nil)
	_ ReplaySink     = (*MatchEventLog)(nil)
)

// NewMatchEventLog creates data/matches/<matchID>.jsonl relative to the process
// working directory. Existing logs are never overwritten or appended blindly.
func NewMatchEventLog(matchID string) (*MatchEventLog, error) {
	return NewMatchEventLogIn(filepath.Join("data", "matches"), matchID)
}

// NewMatchEventLogIn accepts a log directory for deployment and isolated tests.
func NewMatchEventLogIn(dir, matchID string) (*MatchEventLog, error) {
	if len(matchID) == 0 || len(matchID) > 128 || strings.IndexFunc(matchID, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_')
	}) >= 0 {
		return nil, fmt.Errorf("sim: invalid match ID %q", matchID)
	}
	if err := os.MkdirAll(dir, 0750); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(dir, matchID+".jsonl"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	log, err := NewMatchEventLogWriter(file)
	if err != nil {
		return nil, errors.Join(err, file.Close())
	}
	log.file = file
	return log, nil
}

// NewMatchEventLogWriter writes a new stream and does not own/close w.
func NewMatchEventLogWriter(w io.Writer) (*MatchEventLog, error) {
	if w == nil {
		return nil, errors.New("sim: nil log writer")
	}
	l := &MatchEventLog{buffer: bufio.NewWriterSize(w, 64*1024)}
	l.err = json.NewEncoder(l.buffer).Encode(logHeader{SchemaVersion: SchemaVersion})
	if err := l.Flush(); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *MatchEventLog) Err() error { return l.err }

func (l *MatchEventLog) writable() bool {
	if l.closed && l.err == nil {
		l.err = os.ErrClosed
	}
	return l.err == nil
}

func (l *MatchEventLog) OnEvent(tick uint32, ev *ombv1.ServerEvent) {
	if !l.writable() {
		return
	}
	if ev == nil || ev.Kind == nil || ev.Tick != tick {
		l.err = errors.New("sim: nil event/kind or inconsistent event tick")
		return
	}
	data, err := (protojson.MarshalOptions{UseProtoNames: true}).Marshal(ev)
	if err != nil {
		l.err = err
		return
	}
	l.append(diskRecord{Type: "event", Tick: tick, Event: data})
	if ev.GetMatchEnd() != nil {
		_ = l.Flush()
	}
}

func (l *MatchEventLog) OnMatchInit(state Checkpoint) {
	l.append(diskRecord{Type: "match_start", Tick: state.Tick, State: &state})
	_ = l.Flush()
}

func (l *MatchEventLog) OnInput(tick uint32, robotID uint32, input Input) {
	l.append(diskRecord{Type: "input", Tick: tick, RobotID: robotID, Input: &input})
}

func (l *MatchEventLog) OnCheckpoint(state Checkpoint) {
	l.append(diskRecord{Type: "checkpoint", Tick: state.Tick, State: &state})
	_ = l.Flush()
}

func (l *MatchEventLog) append(record diskRecord) {
	if !l.writable() {
		return
	}
	if record.Tick < l.lastTick {
		l.err = errors.New("sim: log ticks moved backwards")
		return
	}
	if err := validateRecord(record); err != nil {
		l.err = err
		return
	}
	// Encode before writing so serialization errors cannot leave a partial line.
	data, err := json.Marshal(record)
	if err != nil {
		l.err = err
		return
	}
	if len(data)+1 > maxLogLine {
		l.err = errors.New("sim: log record exceeds size limit")
		return
	}
	_, l.err = l.buffer.Write(append(data, '\n'))
	if l.err == nil {
		l.lastTick = record.Tick
	}
}

func (l *MatchEventLog) Flush() error {
	if !l.writable() {
		return l.err
	}
	l.err = l.buffer.Flush()
	return l.err
}

func (l *MatchEventLog) Close() error {
	if l.closed {
		return l.err
	}
	_ = l.Flush()
	l.closed = true
	if l.file != nil {
		l.err = errors.Join(l.err, l.file.Close())
	}
	return l.err
}

// MatchEventLogReader decodes one bounded JSONL record at a time. Unknown schema
// versions, malformed payloads, backward ticks and scanner errors are fatal.
// io.EOF means a clean stream end, not proof that a match_end was recorded.
// It does not own/close the source reader.
type MatchEventLogReader struct {
	scanner  *bufio.Scanner
	line     int
	lastTick uint32
	err      error
}

func NewMatchEventLogReader(r io.Reader) (*MatchEventLogReader, error) {
	if r == nil {
		return nil, errors.New("sim: nil log reader")
	}
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), maxLogLine)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return nil, err
		}
		return nil, errors.New("sim: missing log schema header")
	}
	var header logHeader
	if err := decodeJSON(scanner.Bytes(), &header); err != nil {
		return nil, fmt.Errorf("sim: header: %w", err)
	}
	if header.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("sim: unsupported schema_version %d", header.SchemaVersion)
	}
	return &MatchEventLogReader{scanner: scanner, line: 1}, nil
}

func (r *MatchEventLogReader) Read() (*LogRecord, error) {
	if r.err != nil {
		return nil, r.err
	}
	if !r.scanner.Scan() {
		r.err = r.scanner.Err()
		if r.err == nil {
			r.err = io.EOF
		}
		return nil, r.err
	}
	r.line++
	fail := func(err error) (*LogRecord, error) {
		r.err = fmt.Errorf("sim: log line %d: %w", r.line, err)
		return nil, r.err
	}
	var disk diskRecord
	if err := decodeJSON(r.scanner.Bytes(), &disk); err != nil {
		return fail(err)
	}
	if err := validateRecord(disk); err != nil {
		return fail(err)
	}
	if disk.Tick < r.lastTick {
		return fail(errors.New("ticks moved backwards"))
	}
	record := &LogRecord{Type: disk.Type, Tick: disk.Tick, State: disk.State, RobotID: disk.RobotID, Input: disk.Input}
	if disk.Type == "event" {
		record.Event = &ombv1.ServerEvent{}
		if err := protojson.Unmarshal(disk.Event, record.Event); err != nil {
			return fail(err)
		}
		if record.Event.Kind == nil || record.Event.Tick != disk.Tick {
			return fail(errors.New("missing event kind or inconsistent tick"))
		}
	}
	r.lastTick = disk.Tick
	return record, nil
}

// ReadMatchEventLog collects a validated log stream. Prefer the streaming reader
// for long logs. A failure returns no partial stream to accidentally trust.
func ReadMatchEventLog(r io.Reader) ([]LogRecord, error) {
	reader, err := NewMatchEventLogReader(r)
	if err != nil {
		return nil, err
	}
	records := make([]LogRecord, 0)
	for {
		record, err := reader.Read()
		if err == io.EOF {
			return records, nil
		}
		if err != nil {
			return nil, err
		}
		records = append(records, *record)
	}
}

func decodeJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			return io.ErrUnexpectedEOF
		}
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("expected one JSON value per line")
	}
	return nil
}

func validateRecord(r diskRecord) error {
	if r.Tick > MatchTicks {
		return errors.New("sim: log tick beyond match end")
	}
	switch r.Type {
	case "event":
		if len(r.Event) == 0 || r.State != nil || r.Input != nil || r.RobotID != 0 || r.Tick == 0 {
			return errors.New("sim: invalid event record")
		}
	case "match_start", "checkpoint":
		if r.State == nil || r.State.Tick != r.Tick || len(r.Event) != 0 || r.Input != nil || r.RobotID != 0 {
			return errors.New("sim: invalid state record")
		}
		if (r.Type == "match_start" && r.Tick != 0) || (r.Type == "checkpoint" && (r.Tick == 0 || r.Tick%CheckpointInterval != 0)) {
			return errors.New("sim: invalid state record tick")
		}
		if r.State.Robots == nil || r.State.Walls == nil {
			return errors.New("sim: state must include robot and wall arrays")
		}
	case "input":
		if r.Input == nil || r.RobotID == 0 || r.Tick == 0 || r.State != nil || len(r.Event) != 0 ||
			r.Input.MoveX < -1000 || r.Input.MoveX > 1000 || r.Input.MoveY < -1000 || r.Input.MoveY > 1000 {
			return errors.New("sim: invalid input record")
		}
	default:
		return fmt.Errorf("sim: unknown log record type %q", r.Type)
	}
	return nil
}
