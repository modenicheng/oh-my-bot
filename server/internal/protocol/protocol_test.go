package protocol

import (
	"encoding/hex"
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

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

// 升级玩法（ADR-0016）：字段编号与消息往返与 TS 侧 golden.test.ts 的
// upgrade system describe 互钉；任一侧改 omb.proto 编号都会双侧失败。
func TestUpgradeSystemFieldNumbers(t *testing.T) {
	num := func(m proto.Message, name protoreflect.Name) protoreflect.FieldNumber {
		f := m.ProtoReflect().Descriptor().Fields().ByName(name)
		if f == nil {
			t.Fatalf("field %s missing on %s", name, m.ProtoReflect().Descriptor().FullName())
		}
		return f.Number()
	}
	if n := num(&ombv1.ClientMsg{}, "upgrade_request"); n != 14 {
		t.Fatalf("ClientMsg.upgrade_request = %d, want 14", n)
	}
	if n := num(&ombv1.ServerEvent{}, "point_drop_spawn"); n != 37 {
		t.Fatalf("ServerEvent.point_drop_spawn = %d, want 37", n)
	}
	if n := num(&ombv1.ServerEvent{}, "point_drop_pickup"); n != 38 {
		t.Fatalf("ServerEvent.point_drop_pickup = %d, want 38", n)
	}
	if n := num(&ombv1.SnapshotDelta{}, "point_drops"); n != 16 {
		t.Fatalf("SnapshotDelta.point_drops = %d, want 16", n)
	}
	if n := num(&ombv1.SnapshotDelta{}, "point_drop_gone"); n != 17 {
		t.Fatalf("SnapshotDelta.point_drop_gone = %d, want 17", n)
	}
	if n := num(&ombv1.SelfState{}, "upgrade"); n != 12 {
		t.Fatalf("SelfState.upgrade = %d, want 12", n)
	}
	if n := num(&ombv1.RobotState{}, "max_hp_x10"); n != 12 {
		t.Fatalf("RobotState.max_hp_x10 = %d, want 12", n)
	}
	if n := num(&ombv1.RobotState{}, "max_energy_x10"); n != 13 {
		t.Fatalf("RobotState.max_energy_x10 = %d, want 13", n)
	}
	if n := num(&ombv1.SimTuning{}, "upgrade"); n != 8 {
		t.Fatalf("SimTuning.upgrade = %d, want 8", n)
	}
}

// 跨语言黄金字节：ClientMsg{upgrade_request:{track:3}}（与 TS 侧同一 hex）。
const upgradeRequestGoldenHex = "72020803"

func TestUpgradeSystemMessagesRoundTrip(t *testing.T) {
	up := &ombv1.ClientMsg{Payload: &ombv1.ClientMsg_UpgradeRequest{UpgradeRequest: &ombv1.UpgradeRequest{Track: 3}}}
	b, err := proto.Marshal(up)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(b); got != upgradeRequestGoldenHex {
		t.Fatalf("upgrade request golden mismatch:\n got %s\nwant %s", got, upgradeRequestGoldenHex)
	}
	back := &ombv1.ClientMsg{}
	if err := proto.Unmarshal(b, back); err != nil {
		t.Fatal(err)
	}
	if back.GetUpgradeRequest().GetTrack() != 3 {
		t.Fatalf("upgrade request round-trip mismatch: %+v", back.GetUpgradeRequest())
	}

	snap := &ombv1.SnapshotDelta{
		PointDrops: []*ombv1.PointDropState{
			{Base: &ombv1.EntityBase{Id: 9, Pos: &ombv1.Vec2{X: 1, Y: -2}, Heading: 0.5}, Points: 7},
		},
		PointDropGone: []uint32{9},
	}
	sb, err := proto.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	backSnap := &ombv1.SnapshotDelta{}
	if err := proto.Unmarshal(sb, backSnap); err != nil {
		t.Fatal(err)
	}
	if len(backSnap.PointDrops) != 1 || backSnap.PointDrops[0].GetPoints() != 7 ||
		backSnap.PointDrops[0].GetBase().GetPos().GetY() != -2 {
		t.Fatalf("point drop round-trip mismatch: %+v", backSnap.PointDrops)
	}
	if len(backSnap.PointDropGone) != 1 || backSnap.PointDropGone[0] != 9 {
		t.Fatalf("point drop gone round-trip mismatch: %+v", backSnap.PointDropGone)
	}

	ev := &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_PointDropSpawn{PointDropSpawn: &ombv1.EvPointDropSpawn{
		FromRobot: 4, At: &ombv1.Vec2{X: 3, Y: 4}, TotalPoints: 19, LevelLost: true,
	}}}
	eb, err := proto.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	backEv := &ombv1.ServerEvent{}
	if err := proto.Unmarshal(eb, backEv); err != nil {
		t.Fatal(err)
	}
	sp := backEv.GetPointDropSpawn()
	if sp == nil || sp.FromRobot != 4 || sp.TotalPoints != 19 || !sp.LevelLost || sp.At.GetX() != 3 {
		t.Fatalf("point drop spawn round-trip mismatch: %+v", sp)
	}

	pk := &ombv1.ServerEvent{Kind: &ombv1.ServerEvent_PointDropPickup{PointDropPickup: &ombv1.EvPointDropPickup{
		By: 5, DropId: 9, Points: 7,
	}}}
	pb, err := proto.Marshal(pk)
	if err != nil {
		t.Fatal(err)
	}
	backPk := &ombv1.ServerEvent{}
	if err := proto.Unmarshal(pb, backPk); err != nil {
		t.Fatal(err)
	}
	if backPk.GetPointDropPickup().GetPoints() != 7 || backPk.GetPointDropPickup().GetBy() != 5 {
		t.Fatalf("point drop pickup round-trip mismatch: %+v", backPk.GetPointDropPickup())
	}

	self := &ombv1.SelfState{Upgrade: &ombv1.UpgradeSelf{Points: 12, Levels: []uint32{4, 2, 0, 0, 0}}}
	slb, err := proto.Marshal(self)
	if err != nil {
		t.Fatal(err)
	}
	backSelf := &ombv1.SelfState{}
	if err := proto.Unmarshal(slb, backSelf); err != nil {
		t.Fatal(err)
	}
	if backSelf.GetUpgrade().GetPoints() != 12 || len(backSelf.GetUpgrade().GetLevels()) != 5 || backSelf.GetUpgrade().GetLevels()[0] != 4 {
		t.Fatalf("upgrade self round-trip mismatch: %+v", backSelf.GetUpgrade())
	}
	// 旧服务器兼容：upgrade 缺失可探测（nil → 0 点全零级）。
	legacy := &ombv1.SelfState{}
	lb, err := proto.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	backLegacy := &ombv1.SelfState{}
	if err := proto.Unmarshal(lb, backLegacy); err != nil {
		t.Fatal(err)
	}
	if backLegacy.GetUpgrade() != nil {
		t.Fatalf("legacy self upgrade should be nil: %+v", backLegacy.GetUpgrade())
	}

	tuning := &ombv1.SimTuning{Upgrade: &ombv1.UpgradeTuning{
		Costs:    []int32{2, 3, 5, 8, 12, 18, 27, 40, 60, 90},
		StepsX10: []int32{200, 200, 200, 200, 200, 100, 100, 100, 100, 100},
	}}
	tb, err := proto.Marshal(tuning)
	if err != nil {
		t.Fatal(err)
	}
	backTuning := &ombv1.SimTuning{}
	if err := proto.Unmarshal(tb, backTuning); err != nil {
		t.Fatal(err)
	}
	if len(backTuning.GetUpgrade().GetCosts()) != 10 || backTuning.GetUpgrade().GetCosts()[9] != 90 {
		t.Fatalf("upgrade tuning round-trip mismatch: %+v", backTuning.GetUpgrade())
	}
	legacyTuning := &ombv1.SimTuning{}
	if lb2, err := proto.Marshal(legacyTuning); err != nil {
		t.Fatal(err)
	} else {
		bl := &ombv1.SimTuning{}
		if err := proto.Unmarshal(lb2, bl); err != nil {
			t.Fatal(err)
		}
		if bl.GetUpgrade() != nil {
			t.Fatalf("legacy tuning upgrade should be nil: %+v", bl.GetUpgrade())
		}
	}
}

func langPtr(l ombv1.ScriptLanguage) *ombv1.ScriptLanguage { return &l }
