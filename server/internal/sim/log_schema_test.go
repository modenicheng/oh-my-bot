package sim

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// 回放 schema 权威源互钉（审计 X-6）：本文件与 packages/protocol/test/golden.test.ts
// 断言同一组值。权威源是 protocol/proto/omb.proto 的 ReplaySchemaVersion /
// ReplayRecordType / ReplayVisualVersion；改 .proto 忘跑 buf generate 时，
// 生成代码与 .proto 文本互拍在这里失败。

func TestReplaySchemaPinnedToProto(t *testing.T) {
	// 1. 运行时常量逐位钉住（重构前后运行时行为逐位相同）。
	if SchemaVersion != 1 {
		t.Fatalf("SchemaVersion = %d, want 1", SchemaVersion)
	}
	// 2. 生成枚举与期望盘上名互钉：枚举值名去 REPLAY_ 前缀小写 = 盘上 type。
	for _, tc := range []struct {
		enum RecordType
		disk string
	}{
		{RecordEvent, "event"},
		{RecordMatchStart, "match_start"},
		{RecordInput, "input"},
		{RecordControl, "control"},
		{RecordCheckpoint, "checkpoint"},
		{RecordVisual, "visual"},
	} {
		if got := RecordTypeDiskName(tc.enum); got != tc.disk {
			t.Errorf("RecordTypeDiskName(%v) = %q, want %q", tc.enum, got, tc.disk)
		}
		if back, ok := RecordTypeFromDisk(tc.disk); !ok || back != tc.enum {
			t.Errorf("RecordTypeFromDisk(%q) = %v,%v; want %v,true", tc.disk, back, ok, tc.enum)
		}
	}
	// 3. 未知类型字符串必须拒绝（未来版本记录不静默丢弃）。
	if _, ok := RecordTypeFromDisk("future_record"); ok {
		t.Fatal("unknown record type accepted")
	}
	// 4. visual 行形态版本：v1 = 历史位置数组（只读），v2 = 命名字段（写出）。
	if ombv1.ReplayVisualVersion_REPLAY_VISUAL_V1 != 1 || ombv1.ReplayVisualVersion_REPLAY_VISUAL_V2 != 2 {
		t.Fatal("ReplayVisualVersion values drifted from proto authority")
	}
}

// 与 packages/protocol/test/golden.test.ts 的 TransportTiming 同步检查同族：
// 改 proto 忘跑 buf generate 时，生成代码缺失新枚举即失败。
func TestReplayEnumsPresentInGeneratedCode(t *testing.T) {
	for _, name := range []string{"REPLAY_SCHEMA_V1", "REPLAY_MATCH_START", "REPLAY_VISUAL_V2"} {
		if _, ok := ombv1.ReplayRecordType_value[name]; !ok {
			// ReplaySchemaVersion/ReplayVisualVersion 有各自 value map。
			if _, ok := ombv1.ReplaySchemaVersion_value[name]; ok {
				continue
			}
			if _, ok := ombv1.ReplayVisualVersion_value[name]; ok {
				continue
			}
			t.Errorf("generated enums missing %q (run pnpm --filter @omb/protocol gen)", name)
		}
	}
}

// TestInputRecordProtoJSONGolden 钉住 input 记录载荷的 protojson 形态：
// 字段名与旧 sim.Input JSON tag 逐字相同（seq/axis_mask/move_x/move_y/fire/
// aim/dash/shield/interact），旧录像与旧读取器无感互通。
func TestInputRecordProtoJSONGolden(t *testing.T) {
	input := Input{Seq: 42, AxisMask: AxisMove | AxisFire, MoveX: 500, MoveY: -500, Fire: true, Aim: 1.5, Dash: true, Shield: true, Interact: true}
	data, err := encodeInputJSON(input)
	if err != nil {
		t.Fatal(err)
	}
	// JSON 空白与对象键序没有协议语义；只钉住字段集合、字段名和值。
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"seq": float64(42), "move_x": float64(500), "move_y": float64(-500),
		"fire": true, "aim": 1.5, "dash": true, "shield": true,
		"interact": true, "axis_mask": float64(5),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("input protojson shape:\n got %#v\nwant %#v", got, want)
	}
	back, err := decodeInputJSON(data)
	if err != nil || *back != input {
		t.Fatalf("input roundtrip: %+v err=%v", back, err)
	}
}

// TestInputRecordLegacyShapeCompat 证明「旧写入器产出的行」仍可读：
// 载荷是历史 sim.Input JSON（同样字段名），补上信封即整个 LogRecord 等价。
func TestInputRecordLegacyShapeCompat(t *testing.T) {
	legacy := `{"type":"input","tick":7,"robot_id":3,"input":{"axis_mask":1,"seq":9,"move_x":-1000,"move_y":0,"fire":false,"aim":0,"dash":false,"shield":false,"interact":false}}`
	records, err := ReadMatchEventLog(strings.NewReader("{\"schema_version\":1}\n" + legacy + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0].Type != RecordInput || records[0].RobotID != 3 {
		t.Fatalf("legacy input record not decoded: %+v", records)
	}
	in := records[0].Input
	if in == nil || in.Seq != 9 || in.MoveX != -1000 || in.AxisMask != AxisMove {
		t.Fatalf("legacy input payload wrong: %+v", in)
	}
}

// TestVisualRecordNotInEventLog 证明权威事件日志本身不写 visual 行：
// visual 是浏览器导出（cmd/omb ?visual=1）的追加层，主日志保持最小。
func TestVisualRecordNotInEventLog(t *testing.T) {
	line := `{"type":"visual","v":2,"tick":1,"robots":[]}`
	if _, err := ReadMatchEventLog(strings.NewReader("{\"schema_version\":1}\n" + line + "\n")); err == nil {
		t.Fatal("event log reader accepted visual record")
	}
}

// TestSchemaVersionRejectsFuture 证明未知更高版本显式拒绝（不静默错读）。
func TestSchemaVersionRejectsFuture(t *testing.T) {
	for _, header := range []string{"{\"schema_version\":2}\n", "{\"schema_version\":99}\n", "{\"schema_version\":-1}\n"} {
		if _, err := NewMatchEventLogReader(strings.NewReader(header)); err == nil {
			t.Fatalf("future schema accepted: %s", header)
		}
	}
	// 服务器自写头仍是权威版本号。
	var buf bytes.Buffer
	log, err := NewMatchEventLogWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	var header logHeader
	if err := json.Unmarshal(bytes.SplitN(buf.Bytes(), []byte("\n"), 2)[0], &header); err != nil {
		t.Fatal(err)
	}
	if header.SchemaVersion != SchemaVersion {
		t.Fatalf("writer header = %d, want %d", header.SchemaVersion, SchemaVersion)
	}
}

// TestSimInputRecordJSONShapeFreeze 防止有人把 sim.Input 的 JSON tag 改名后
// 「新写入器写出的行旧读取器读不懂」：新旧行靠字段名兼容，这里冻结字段名集合。
func TestSimInputRecordJSONShapeFreeze(t *testing.T) {
	data, err := json.Marshal(Input{})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"axis_mask":0,"seq":0,"move_x":0,"move_y":0,"fire":false,"aim":0,"dash":false,"shield":false,"interact":false}`
	if string(data) != want {
		t.Fatalf("sim.Input JSON shape drifted:\n got %s\nwant %s", data, want)
	}
}
