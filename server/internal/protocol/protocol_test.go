package protocol

import (
	"encoding/hex"
	"testing"

	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// 跨语言契约黄金字节：与 packages/protocol/test/golden.test.ts 断言同一 hex。
// ClientMsg{input:{seq:42, move_x:500, move_y:-500, fire:true, aim:1.5}}
const goldenHex = "0a1b082a10f403188cfcffffffffffffff01200129000000000000f83f"

func TestGoldenBytes(t *testing.T) {
	msg := &ombv1.ClientMsg{
		Payload: &ombv1.ClientMsg_Input{
			Input: &ombv1.ClientInput{Seq: 42, MoveX: 500, MoveY: -500, Fire: true, Aim: 1.5},
		},
	}
	b, err := proto.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(b); got != goldenHex {
		t.Fatalf("golden mismatch:\n got %s\nwant %s", got, goldenHex)
	}
}

func TestServerMsgRoundTrip(t *testing.T) {
	msg := &ombv1.ServerMsg{
		Payload: &ombv1.ServerMsg_Snapshot{
			Snapshot: &ombv1.SnapshotDelta{
				Tick: 7200, AckSeq: 99, Phase: ombv1.Phase_CORE_OPEN,
				TimeLeftS: 240, Full: false, RobotGone: []uint32{7},
			},
		},
	}
	b, err := proto.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	back := &ombv1.ServerMsg{}
	if err := proto.Unmarshal(b, back); err != nil {
		t.Fatal(err)
	}
	snap := back.GetSnapshot()
	if snap == nil || snap.AckSeq != 99 || len(snap.RobotGone) != 1 || snap.RobotGone[0] != 7 {
		t.Fatalf("round-trip mismatch: %+v", snap)
	}
}

// 脚本版本链（AI 直填 + 版本回退）：枚举编号与消息往返与 TS 侧
// golden.test.ts 的 script versions describe 互钉；任一侧改 proto 编号都会双侧失败。
func TestScriptVersionMessagesRoundTrip(t *testing.T) {
	if ombv1.ScriptOrigin_SCRIPT_ORIGIN_UNSPECIFIED != 0 || ombv1.ScriptOrigin_ORIGIN_MANUAL != 1 ||
		ombv1.ScriptOrigin_ORIGIN_AI != 2 || ombv1.ScriptOrigin_ORIGIN_ROLLBACK != 3 {
		t.Fatal("ScriptOrigin enum values drifted from omb.proto")
	}
	if ombv1.ScriptLanguage_SCRIPT_LANGUAGE_UNSPECIFIED != 0 || ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS != 1 ||
		ombv1.ScriptLanguage_SCRIPT_LANGUAGE_TS != 2 {
		t.Fatal("ScriptLanguage enum values drifted from omb.proto")
	}
	msg := &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_ScriptVersions{ScriptVersions: &ombv1.EvScriptVersions{
			Versions: []*ombv1.EvScriptVersion{
				{Id: 1, ScriptRev: 3, Origin: ombv1.ScriptOrigin_ORIGIN_MANUAL, WallMs: 1000, Source: "manual"},
				{Id: 2, ScriptRev: 4, Origin: ombv1.ScriptOrigin_ORIGIN_AI, WallMs: 2000, Source: "ai"},
			},
			CurrentId: 2,
		}},
	}}}
	b, err := proto.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	back := &ombv1.ServerMsg{}
	if err := proto.Unmarshal(b, back); err != nil {
		t.Fatal(err)
	}
	vs := back.GetEvent().GetScriptVersions()
	if vs == nil || vs.CurrentId != 2 || len(vs.Versions) != 2 {
		t.Fatalf("versions round-trip mismatch: %+v", vs)
	}
	if vs.Versions[0].Origin != ombv1.ScriptOrigin_ORIGIN_MANUAL || vs.Versions[1].Source != "ai" {
		t.Fatalf("version fields drifted: %+v", vs.Versions)
	}

	up := &ombv1.ClientMsg{Payload: &ombv1.ClientMsg_ScriptRollback{ScriptRollback: &ombv1.ScriptRollback{VersionId: 7}}}
	ub, err := proto.Marshal(up)
	if err != nil {
		t.Fatal(err)
	}
	backUp := &ombv1.ClientMsg{}
	if err := proto.Unmarshal(ub, backUp); err != nil {
		t.Fatal(err)
	}
	if backUp.GetScriptRollback().GetVersionId() != 7 {
		t.Fatalf("rollback round-trip mismatch: %+v", backUp.GetScriptRollback())
	}

	res := &ombv1.EvScriptRollbackResult{Ok: true, VersionId: 7, ScriptRev: 9, Source: "rolled", Language: langPtr(ombv1.ScriptLanguage_SCRIPT_LANGUAGE_TS)}
	rb, err := proto.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	backRes := &ombv1.EvScriptRollbackResult{}
	if err := proto.Unmarshal(rb, backRes); err != nil {
		t.Fatal(err)
	}
	if !backRes.Ok || backRes.VersionId != 7 || backRes.Source != "rolled" {
		t.Fatalf("rollback result round-trip mismatch: %+v", backRes)
	}
	if backRes.GetLanguage() != ombv1.ScriptLanguage_SCRIPT_LANGUAGE_TS {
		t.Fatalf("rollback result language round-trip mismatch: %v", backRes.GetLanguage())
	}
	// 旧客户端/旧服务器兼容：language/editor_source 缺省可探测（nil → JS 兼容语义）。
	legacySubmit := &ombv1.ScriptSubmit{ClientScriptId: 5, Source: "js"}
	lb, err := proto.Marshal(legacySubmit)
	if err != nil {
		t.Fatal(err)
	}
	backLegacy := &ombv1.ScriptSubmit{}
	if err := proto.Unmarshal(lb, backLegacy); err != nil {
		t.Fatal(err)
	}
	if backLegacy.GetEditorSource() != "" || backLegacy.GetLanguage() != ombv1.ScriptLanguage_SCRIPT_LANGUAGE_UNSPECIFIED {
		t.Fatalf("legacy submit drifted: %+v", backLegacy)
	}
}

func langPtr(l ombv1.ScriptLanguage) *ombv1.ScriptLanguage { return &l }
