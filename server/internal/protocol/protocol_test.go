package protocol

import (
	"encoding/hex"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"google.golang.org/protobuf/proto"
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
