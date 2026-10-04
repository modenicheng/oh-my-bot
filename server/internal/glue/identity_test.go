package glue

import (
	"encoding/binary"
	"hash/fnv"
	"testing"
)

// stableRobotID 是线上身份算法（playerID→robotID 持久化在房间状态与回放
// 身份表里）：golden 向量锁定输出，任何改动词必须逐位一致。
func TestStableRobotIDGoldenVectors(t *testing.T) {
	golden := map[uint64]uint32{
		0:                     2615243109,
		1:                     1048580676,
		42:                    3990555855,
		12345678901234567890:  1867441261,
		0xffff_ffff_ffff_f000: 127361063,
		0xffff_ffff_ffff_f005: 2854740578,
		0xffff_ffff_ffff_ffff: 1823345245,
	}
	for pid, want := range golden {
		if got := stableRobotID(pid); got != want {
			t.Errorf("stableRobotID(%d) = %d, want %d", pid, got, want)
		}
	}
}

// 与 stdlib hash/fnv·小端 8 字节逐位对照：手写循环换成标准库后语义不得漂移。
func TestStableRobotIDMatchesStdFNV(t *testing.T) {
	for pid := uint64(0); pid < 100_000; pid++ {
		var buf [8]byte
		binary.LittleEndian.PutUint64(buf[:], pid)
		h := fnv.New32a()
		_, _ = h.Write(buf[:])
		if got := stableRobotID(pid); got != h.Sum32() {
			t.Fatalf("stableRobotID(%d) = %d, stdlib = %d", pid, got, h.Sum32())
		}
	}
}
