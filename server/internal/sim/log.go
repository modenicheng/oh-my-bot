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
	"sort"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// 回放 JSONL 记录 schema 的唯一权威源是 protocol/proto/omb.proto（审计 X-6）：
// 版本号（ReplaySchemaVersion）、记录类型（ReplayRecordType）与 visual 采样行
// 形态（ReplayVisualVersion/ReplayVisualFrame）均从生成枚举/消息取值，两侧
// 测试互钉（sim/log_schema_test.go ↔ packages/protocol/test/golden.test.ts）。
// 磁盘形态保持 NDJSON 信封不变：头行 {"schema_version":1} + 每行
// {"type":"<record_type>","tick":N,...}，旧录像文件继续可读。

// SchemaVersion is the replay JSONL schema version this build writes and the
// maximum it can read. Higher versions are rejected explicitly.
const SchemaVersion = int(ombv1.ReplaySchemaVersion_REPLAY_SCHEMA_V1)

// MaxLogLine 是单条 JSONL 记录的字节上限（写入前校验与读取侧 scanner
// 缓冲共用；cmd/omb/replay_visual.go 等消费者必须引用本常量而非复制字面量）。
const MaxLogLine = 16 * 1024 * 1024

// RecordType 是 LogRecord.Type 的枚举形态；盘上 "type" 字符串由
// RecordTypeDiskName 从权威枚举名推导（REPLAY_MATCH_START → "match_start"）。
type RecordType = ombv1.ReplayRecordType

// 记录类型常量：名字来自生成枚举，避免多处手抄字符串。
const (
	RecordEvent      = ombv1.ReplayRecordType_REPLAY_EVENT
	RecordMatchStart = ombv1.ReplayRecordType_REPLAY_MATCH_START
	RecordInput      = ombv1.ReplayRecordType_REPLAY_INPUT
	RecordControl    = ombv1.ReplayRecordType_REPLAY_CONTROL
	RecordCheckpoint = ombv1.ReplayRecordType_REPLAY_CHECKPOINT
	RecordVisual     = ombv1.ReplayRecordType_REPLAY_VISUAL
)

// replayTypePrefix 是权威枚举值名的公共前缀；盘上名 = 去前缀后小写。
const replayTypePrefix = "REPLAY_"

// RecordTypeDiskName 返回记录类型的盘上 "type" 字符串。与客户端
// replayRecordDiskName 同一规则，golden 测试互钉。
func RecordTypeDiskName(t RecordType) string {
	name := t.String()
	if rest, ok := strings.CutPrefix(name, replayTypePrefix); ok {
		return strings.ToLower(rest)
	}
	return strings.ToLower(name)
}

// RecordTypeFromDisk 解析盘上 "type" 字符串；未知字符串返回 false。
func RecordTypeFromDisk(name string) (RecordType, bool) {
	t, ok := ombv1.ReplayRecordType_value[replayTypePrefix+strings.ToUpper(name)]
	if !ok || t == int32(ombv1.ReplayRecordType_REPLAY_UNSPECIFIED) {
		return 0, false
	}
	return ombv1.ReplayRecordType(t), true
}

// MatchPlayer records the stable identity and pairing used by the live projector.
// Older logs may omit Players and still be read with externally supplied tables.
type MatchPlayer struct {
	RobotID  uint32 `json:"robot_id"`
	PlayerID uint64 `json:"player_id"`
	Nick     string `json:"nick"`
	Partner  uint32 `json:"partner,omitempty"`
	Bot      bool   `json:"bot,omitempty"`
}

// LogRecord is the full log stream, not merely the online ServerEvent subset.
// Type is event, match_start (initial state), input, control, or checkpoint.
// Record order within a tick is significant.
type LogRecord struct {
	Type    RecordType
	Tick    uint32
	Event   *ombv1.ServerEvent
	State   *Checkpoint
	Players []MatchPlayer
	RobotID uint32
	Input   *Input
	Control *ControlRecord
}

type logHeader struct {
	SchemaVersion int `json:"schema_version"`
}

// diskRecord 的 input 载荷是 ombv1.ClientInput 的 protojson（字段名与旧
// sim.Input JSON tag 逐字相同：seq/axis_mask/move_x/move_y/fire/aim/dash/
// shield/interact），历史文件与旧读取器继续互通。
type diskRecord struct {
	Type    string          `json:"type"`
	Tick    uint32          `json:"tick"`
	Event   json.RawMessage `json:"event,omitempty"`
	State   *Checkpoint     `json:"state,omitempty"`
	Players []MatchPlayer   `json:"players,omitempty"`
	RobotID uint32          `json:"robot_id,omitempty"`
	Input   json.RawMessage `json:"input,omitempty"`
	Control *ControlRecord  `json:"control,omitempty"`
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
	players  []MatchPlayer
	started  bool
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

// isValidMatchIDRune 报告 r 是否为合法 match ID 字符（字母数字下划线连字符）。
func isValidMatchIDRune(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_'
}

// NewMatchEventLogIn accepts a log directory for deployment and isolated tests.
func NewMatchEventLogIn(dir, matchID string) (*MatchEventLog, error) {
	if len(matchID) == 0 || len(matchID) > 128 || strings.IndexFunc(matchID, func(r rune) bool {
		return !isValidMatchIDRune(r)
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

// SetPlayers attaches the assembly-time identity to the next match_start.
// Call before the first simulation tick; a nil slice preserves legacy logs.
func (l *MatchEventLog) SetPlayers(players []MatchPlayer) error {
	if !l.writable() {
		return l.err
	}
	if l.players != nil || l.started {
		return ErrIdentityFrozen
	}
	seen := make(map[uint32]bool, len(players))
	for _, player := range players {
		if player.RobotID == 0 || player.PlayerID == 0 || seen[player.RobotID] {
			return errors.New("sim: invalid or duplicate match player")
		}
		seen[player.RobotID] = true
	}
	for _, player := range players {
		if player.Partner != 0 && !seen[player.Partner] {
			return errors.New("sim: unknown match partner")
		}
	}
	l.players = append([]MatchPlayer{}, players...)
	sort.Slice(l.players, func(i, j int) bool { return l.players[i].RobotID < l.players[j].RobotID })
	return nil
}

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
	l.append(diskRecord{Type: RecordTypeDiskName(RecordEvent), Tick: tick, Event: data})
	if ev.GetMatchEnd() != nil {
		_ = l.Flush()
	}
}

func (l *MatchEventLog) OnMatchInit(state Checkpoint) {
	l.append(diskRecord{Type: RecordTypeDiskName(RecordMatchStart), Tick: state.Tick, State: &state, Players: l.players})
	l.started = true
	_ = l.Flush()
}

func (l *MatchEventLog) OnInput(tick uint32, robotID uint32, input Input) {
	data, err := encodeInputJSON(input)
	if err != nil {
		if l.writable() {
			l.err = err
		}
		return
	}
	l.append(diskRecord{Type: RecordTypeDiskName(RecordInput), Tick: tick, RobotID: robotID, Input: data})
}

func (l *MatchEventLog) OnControl(tick, robotID uint32, control ControlRecord) {
	l.append(diskRecord{Type: RecordTypeDiskName(RecordControl), Tick: tick, RobotID: robotID, Control: &control})
}

func (l *MatchEventLog) OnCheckpoint(state Checkpoint) {
	l.append(diskRecord{Type: RecordTypeDiskName(RecordCheckpoint), Tick: state.Tick, State: &state})
	_ = l.Flush()
}

// encodeInputJSON 序列化 input 记录载荷：ombv1.ClientInput 的 protojson
// （UseProtoNames，与 event 载荷同一编码器）。字段名与旧 sim.Input 的 JSON
// tag 完全一致，旧文件/旧读取器无感互通。
func encodeInputJSON(input Input) ([]byte, error) {
	return (protojson.MarshalOptions{UseProtoNames: true}).Marshal(&ombv1.ClientInput{
		Seq: input.Seq, AxisMask: uint32(input.AxisMask), MoveX: input.MoveX, MoveY: input.MoveY,
		Fire: input.Fire, Aim: input.Aim, Dash: input.Dash, Shield: input.Shield, Interact: input.Interact,
	})
}

// decodeInputJSON 解码 input 载荷。容错历史文件的宽松数值形态：JSON 数字
// 一律经 float64 中转（encoding/json 对 interface{} 的默认形态），再按目标
// 位宽收窄；NaN/Inf 不是合法 JSON，protojson 也不会产出。
func decodeInputJSON(data []byte) (*Input, error) {
	var wire ombv1.ClientInput
	if err := (protojson.UnmarshalOptions{DiscardUnknown: false}).Unmarshal(data, &wire); err != nil {
		return nil, err
	}
	input := Input{Seq: wire.Seq, AxisMask: AxisMask(wire.AxisMask), MoveX: wire.MoveX, MoveY: wire.MoveY,
		Fire: wire.Fire, Aim: wire.Aim, Dash: wire.Dash, Shield: wire.Shield, Interact: wire.Interact}
	return &input, nil
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
	if len(data)+1 > MaxLogLine {
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
	scanner.Buffer(make([]byte, 4096), MaxLogLine)
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
	if header.SchemaVersion <= 0 || header.SchemaVersion > SchemaVersion {
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
	recordType, ok := RecordTypeFromDisk(disk.Type)
	if !ok {
		return fail(fmt.Errorf("unknown log record type %q", disk.Type))
	}
	// 写读两侧共用同一路径校验：先把盘上名规范成权威枚举的推导名。
	disk.Type = RecordTypeDiskName(recordType)
	if err := validateRecord(disk); err != nil {
		return fail(err)
	}
	if disk.Tick < r.lastTick {
		return fail(errors.New("ticks moved backwards"))
	}
	record := &LogRecord{Type: recordType, Tick: disk.Tick, State: disk.State, Players: disk.Players, RobotID: disk.RobotID, Control: disk.Control}
	switch recordType {
	case ombv1.ReplayRecordType_REPLAY_EVENT:
		record.Event = &ombv1.ServerEvent{}
		if err := protojson.Unmarshal(disk.Event, record.Event); err != nil {
			return fail(err)
		}
		if record.Event.Kind == nil || record.Event.Tick != disk.Tick {
			return fail(errors.New("missing event kind or inconsistent tick"))
		}
	case ombv1.ReplayRecordType_REPLAY_INPUT:
		input, err := decodeInputJSON(disk.Input)
		if err != nil {
			return fail(fmt.Errorf("input payload: %w", err))
		}
		record.Input = input
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
	if r.Type != RecordTypeDiskName(RecordControl) && r.Control != nil {
		return errors.New("sim: unexpected control payload")
	}
	if r.Type != RecordTypeDiskName(RecordMatchStart) && len(r.Players) != 0 {
		return errors.New("sim: unexpected match identity")
	}
	switch r.Type {
	case RecordTypeDiskName(RecordControl):
		if r.Control == nil || r.RobotID == 0 || r.Tick == 0 || r.State != nil || len(r.Event) != 0 || len(r.Input) != 0 {
			return errors.New("sim: invalid control record")
		}
		// Toggles 是回放消费循环的迭代次数（纯算力字段，S-29）：不封顶的话
		// 一条篡改记录即可把回放卡在 ~4.3e9 次空转。上界依据见 MaxControlToggles。
		if r.Control.Toggles > MaxControlToggles {
			return fmt.Errorf("sim: control toggles %d exceed %d", r.Control.Toggles, MaxControlToggles)
		}
	case RecordTypeDiskName(RecordEvent):
		if len(r.Event) == 0 || r.State != nil || len(r.Input) != 0 || r.RobotID != 0 || r.Tick == 0 {
			return errors.New("sim: invalid event record")
		}
	case RecordTypeDiskName(RecordMatchStart), RecordTypeDiskName(RecordCheckpoint):
		if r.State == nil || r.State.Tick != r.Tick || len(r.Event) != 0 || len(r.Input) != 0 || r.RobotID != 0 {
			return errors.New("sim: invalid state record")
		}
		if (r.Type == RecordTypeDiskName(RecordMatchStart) && r.Tick != 0) || (r.Type == RecordTypeDiskName(RecordCheckpoint) && (r.Tick == 0 || r.Tick%CheckpointInterval != 0)) {
			return errors.New("sim: invalid state record tick")
		}
		if r.State.Robots == nil || r.State.Walls == nil {
			return errors.New("sim: state must include robot and wall arrays")
		}
		if r.State.SimulationVersion < 0 || r.State.SimulationVersion > SimulationVersion {
			return fmt.Errorf("sim: unsupported simulation_version %d", r.State.SimulationVersion)
		}
		if r.Type == RecordTypeDiskName(RecordMatchStart) && len(r.Players) != 0 {
			known := make(map[uint32]bool, len(r.State.Robots))
			for _, robot := range r.State.Robots {
				known[robot.ID] = true
			}
			seen := make(map[uint32]bool, len(r.Players))
			for _, player := range r.Players {
				if player.RobotID == 0 || player.PlayerID == 0 || !known[player.RobotID] || seen[player.RobotID] {
					return errors.New("sim: invalid match player identity")
				}
				seen[player.RobotID] = true
			}
			if len(seen) != len(known) {
				return errors.New("sim: incomplete match player identity")
			}
			for _, player := range r.Players {
				if player.Partner != 0 && !seen[player.Partner] {
					return errors.New("sim: unknown match partner")
				}
			}
		}
	case RecordTypeDiskName(RecordInput):
		if len(r.Input) == 0 || r.RobotID == 0 || r.Tick == 0 || r.State != nil || len(r.Event) != 0 {
			return errors.New("sim: invalid input record")
		}
		var wire ombv1.ClientInput
		if err := (protojson.UnmarshalOptions{}).Unmarshal(r.Input, &wire); err != nil {
			return fmt.Errorf("sim: invalid input payload: %w", err)
		}
		if wire.MoveX < -1000 || wire.MoveX > 1000 || wire.MoveY < -1000 || wire.MoveY > 1000 ||
			wire.AxisMask&^uint32(allAxes) != 0 || !finite(wire.Aim) {
			return errors.New("sim: invalid input record")
		}
	default:
		return fmt.Errorf("sim: unknown log record type %q", r.Type)
	}
	return nil
}
