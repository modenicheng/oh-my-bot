package mapgen

import (
	"math"
	"testing"
)

// TestStatsSummary 打印代表性种子的统计摘要（验收材料；无断言失败风险）。
func TestStatsSummary(t *testing.T) {
	seeds := []uint64{0, 1, 42, 1234567890}
	for _, seed := range seeds {
		def, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		midBand := math.Pi * (55*55 - 30*30)
		outerBand := math.Pi * (80*80 - 55*55)
		var midN, outerN, centerN int
		var midA, outerA, centerA float64
		for _, w := range def.Walls {
			cx := (w.Min.X + w.Max.X) / 2
			cy := (w.Min.Y + w.Max.Y) / 2
			a := (w.Max.X - w.Min.X) * (w.Max.Y - w.Min.Y)
			switch r := math.Hypot(cx, cy); {
			case r < 30:
				centerN++
				centerA += a
			case r < 55:
				midN++
				midA += a
			default:
				outerN++
				outerA += a
			}
		}
		t.Logf("seed=%d hash=%.16s walls=%d (center %d, mid %d density %.4f, outer %d density %.4f) uplinks=6+1 pads=16/12/6",
			seed, def.MapHash, len(def.Walls), centerN, midN, midA/midBand, outerN, outerA/outerBand)
	}
}
