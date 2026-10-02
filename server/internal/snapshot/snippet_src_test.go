package snapshot

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ctrlSrc 字节 → 协议 ControlSource 映射（含 CS_SNIPPET = 'N'）。

func TestControlSourceMappingIncludesSnippet(t *testing.T) {
	if got := ctrlSrc('N'); got != ombv1.ControlSource_CS_SNIPPET {
		t.Fatalf("'N' must map to CS_SNIPPET, got %v", got)
	}
	if got := ctrlSrc('S'); got != ombv1.ControlSource_CS_SCRIPT {
		t.Fatalf("'S' must map to CS_SCRIPT, got %v", got)
	}
	if got := ctrlSrc('H'); got != ombv1.ControlSource_CS_HUMAN {
		t.Fatalf("'H' must map to CS_HUMAN, got %v", got)
	}
	if got := ctrlSrc('-'); got != ombv1.ControlSource_CS_UNSPECIFIED {
		t.Fatalf("'-' must map to CS_UNSPECIFIED, got %v", got)
	}
}

// encodeSelf 携带 N 归因下发：分轴来源齐全（H/S/N 混合场景）。
func TestEncodeSelfCarriesPerAxisSnippetSources(t *testing.T) {
	enc := NewEncoder()
	w := mkWorld(nil, []sim.RobotView{mkRobot(1, 0, 0)})
	self := &SelfInput{
		Robot: mkRobot(1, 0, 0),
		// 人工接管 move，snippet 驱动其余三轴。
		MoveSrc:    'H',
		TurretSrc:  'N',
		FireSrc:    'N',
		AbilitySrc: 'N',
		ManualAxes: uint32(sim.AxisMove),
	}
	d := enc.Encode(10, 1, sim.PhaseOuterRing, 480, obsOf(w, 1, 0, nil), self)
	if d.Self == nil {
		t.Fatal("self state missing")
	}
	if d.Self.MoveSrc != ombv1.ControlSource_CS_HUMAN ||
		d.Self.TurretSrc != ombv1.ControlSource_CS_SNIPPET {
		t.Fatalf("move/turret sources: %v %v", d.Self.MoveSrc, d.Self.TurretSrc)
	}
	if d.Self.FireSrc == nil || *d.Self.FireSrc != ombv1.ControlSource_CS_SNIPPET {
		t.Fatalf("fire source: %v", d.Self.FireSrc)
	}
	if d.Self.AbilitySrc == nil || *d.Self.AbilitySrc != ombv1.ControlSource_CS_SNIPPET {
		t.Fatalf("ability source: %v", d.Self.AbilitySrc)
	}
}
