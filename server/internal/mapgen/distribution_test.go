package mapgen

import (
	"math"
	"sort"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestResourceAngularCoverage(t *testing.T) {
	for seed := uint64(0); seed < 256; seed++ {
		def, err := Generate(seed)
		if err != nil {
			t.Fatal(err)
		}
		for group, count := range []int{16, 12, 6} {
			angles := []float64{}
			for _, p := range def.CorePads {
				if p.Group == group {
					angles = append(angles, angleDeg(p.Pos.X, p.Pos.Y))
				}
			}
			sort.Float64s(angles)
			if len(angles) != count {
				t.Fatalf("seed %d group %d count %d", seed, group, len(angles))
			}
			for i, a := range angles {
				next := angles[(i+1)%count]
				if i == count-1 {
					next += 360
				}
				if next-a > 1.3*360/float64(count) {
					t.Errorf("seed %d group %d empty arc %.2f degrees exceeds %.2f", seed, group, next-a, 1.3*360/float64(count))
				}
			}
			if group == 0 {
				wedges := [8]int{}
				for _, a := range angles {
					wedges[int(a/45)]++
				}
				for k, n := range wedges {
					if n != 2 {
						t.Errorf("seed %d outer wedge %d pads %d, want 2", seed, k, n)
					}
				}
			}
		}
	}
}

func TestStrataClearanceAndSpawns(t *testing.T) {
	for seed := uint64(0); seed < 256; seed++ {
		def, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		counts := [8][3]int{}
		for i, w := range def.Walls {
			center := w.Min.Add(w.Max).Scale(0.5)
			band := 0
			if center.Len() >= 55 {
				band = 2
			} else if center.Len() >= coreZoneR {
				band = 1
			}
			counts[int(angleDeg(center.X, center.Y)/45)][band]++
			width, height := w.Max.X-w.Min.X, w.Max.Y-w.Min.Y
			long, short := math.Max(width, height), math.Min(width, height)
			if math.Abs(short-0.7) > 1e-9 || (math.Abs(long-4) > 1e-9 && math.Abs(long-3) > 1e-9 && math.Abs(long-2) > 1e-9) {
				t.Fatalf("seed %d invalid grid cover size %.2fx%.2f", seed, width, height)
			}
			for _, p := range []sim.Vec2{w.Min, w.Max, {X: w.Min.X, Y: w.Max.Y}, {X: w.Max.X, Y: w.Min.Y}} {
				if p.Len() > 79.4 {
					t.Fatalf("seed %d wall outside arena", seed)
				}
			}
			for _, other := range def.Walls[:i] {
				// Gen4 L assemblies deliberately overlap their own two pieces
				// (grouped base+stub pair); the 2.2m clearance is waived only for
				// that grouped pair, never for independent walls.
				if isLPair(other, w) {
					continue
				}
				if gap2(wallRect(w), wallRect(other)) < 2.2*2.2-1e-9 {
					t.Fatalf("seed %d insufficient wall gap", seed)
				}
			}
			for _, p := range def.CorePads {
				if nearestDist2(wallRect(w), p.Pos) < 2.5*2.5-1e-9 {
					t.Fatalf("seed %d pad blocked", seed)
				}
			}
			for _, u := range def.Uplinks {
				if nearestDist2(wallRect(w), u.Pos) < 2.2*2.2-1e-9 {
					t.Fatalf("seed %d uplink blocked", seed)
				}
			}
		}
		for k, c := range counts {
			if c != [3]int{1, 5, 2} {
				t.Fatalf("seed %d wedge %d cover counts %v", seed, k, c)
			}
		}
		for i, p := range def.CorePads {
			for _, q := range def.CorePads[:i] {
				gap := 5.0
				if p.Group == 2 {
					gap = 3.5
				}
				if p.Group == q.Group && p.Pos.Sub(q.Pos).Len() < gap {
					t.Fatalf("seed %d pads too close", seed)
				}
			}
			for _, u := range def.Uplinks {
				if p.Pos.Sub(u.Pos).Len() < 3 {
					t.Fatalf("seed %d pad/uplink too close", seed)
				}
			}
		}
		s := sim.NewSim(seed, []uint32{1, 2, 3, 4, 5, 6, 7, 8}, nil)
		if err := s.SetMap(def); err != nil {
			t.Fatalf("seed %d SetMap: %v", seed, err)
		}
		for _, r := range s.Snapshot().Robots {
			if r.Position.Len() > 79.4 {
				t.Fatalf("seed %d initial spawn outside", seed)
			}
		}
		for id := uint32(1); id <= 8; id++ {
			s.Respawn(id)
		}
		s.Tick()
		for _, r := range s.Snapshot().Robots {
			if r.Position.Len() > 79.4 {
				t.Fatalf("seed %d respawn outside", seed)
			}
		}
	}
}

// isLPair 判断 w 与 other 是否为同一 L 装配的两件：基座（4×0.7 或 0.7×4）
// 与垂直短杠（0.7×2 或 2×0.7），正面积相交约 0.7×0.7。只豁免这对组合
// 自身的重叠；任何其他独立墙对仍受 2.2m 间距约束。
func isLPair(other, w sim.Wall) bool {
	// The fourth stratum owns IDs 25..40, base then stub per wedge.
	if other.ID < 25 || other.ID > 39 || (other.ID-25)%2 != 0 || w.ID != other.ID+1 {
		return false
	}
	ow, oh := overlapDims(wallRect(other), wallRect(w))
	if !(ow > 0 && oh > 0) {
		return false
	}
	ro, rw := wallRect(other), wallRect(w)
	oW, oH := ro.MaxX-ro.MinX, ro.MaxY-ro.MinY
	wW, wH := rw.MaxX-rw.MinX, rw.MaxY-rw.MinY
	// 两种合法组合（短杠长轴与基座长轴垂直）；平行组合不算 L。
	comboA := math.Abs(oW-4) < 1e-9 && math.Abs(oH-0.7) < 1e-9 && math.Abs(wW-0.7) < 1e-9 && math.Abs(wH-2) < 1e-9
	comboB := math.Abs(oW-0.7) < 1e-9 && math.Abs(oH-4) < 1e-9 && math.Abs(wW-2) < 1e-9 && math.Abs(wH-0.7) < 1e-9
	if !comboA && !comboB {
		return false
	}
	// 两件中心距固定为 sqrt(1.65²+0.65²)（短杠偏移的旋转像长度不变）。
	co := other.Min.Add(other.Max).Scale(0.5)
	cw := w.Min.Add(w.Max).Scale(0.5)
	return math.Abs(co.Sub(cw).Len()-math.Hypot(1.65, 0.65)) < 1e-6
}

func TestLClearanceChecksOtherGroups(t *testing.T) {
	pieces := stampCell(coverCell{lShape: true}, sim.Vec2{}, 0)
	base, stub := pieces[0], pieces[1]
	if !pieceHasClearance(stub, []stampedPiece{base}) {
		t.Fatal("same-assembly overlap rejected")
	}
	other := stampedPiece{r: stub.r, group: 1}
	if pieceHasClearance(stub, []stampedPiece{other, base}) {
		t.Fatal("stub skipped another assembly after sibling overlap")
	}
	other.group = -1
	if pieceHasClearance(stub, []stampedPiece{other, base}) {
		t.Fatal("stub skipped independent wall")
	}
}

func TestPlayableGridIsCircular(t *testing.T) {
	blocked, n := gridFor(nil, true)
	for _, p := range [][2]float64{{79.9, 0}, {70, 70}, {-70, -70}} {
		if !blocked[gridIndex(p[1])*n+gridIndex(p[0])] {
			t.Errorf("outside arena grid cell %v is free", p)
		}
	}
	if blocked[gridIndex(0)*n+gridIndex(0)] {
		t.Fatal("open center blocked")
	}
	if math.Abs(agentR-0.6) > 1e-12 {
		t.Fatal("radius drift")
	}
}

// TestLASsemblySilhouette：Gen4 L 层的形状契约。每楔恰有一个两件套装配：
// 4×0.7 基座与垂直 2×0.7 短杠正面积相交 0.7×0.7（并集连通为真实 L 剪影，
// 而非仅相接/分离）；基座定向遵循 coverXLong 约定（k0/3/4/7 横向，其余
// 纵向）；同批楔 k 与 k+2 的装配互为精确 90° 旋转像。装配外的任何墙对
// 仍需 ≥2.2m 间距（由 TestStrataClearanceAndSpawns 保证）。
func TestLASsemblySilhouette(t *testing.T) {
	for seed := uint64(0); seed < 256; seed++ {
		def, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		assemblies := 0
		for i := 0; i+1 < len(def.Walls); i++ {
			a, b := def.Walls[i], def.Walls[i+1]
			if !isLPair(a, b) {
				continue
			}
			assemblies++
			ow, oh := overlapDims(wallRect(a), wallRect(b))
			if math.Abs(ow-0.7) > 1e-9 || math.Abs(oh-0.7) > 1e-9 {
				t.Fatalf("seed %d: L pair %d/%d overlap %.3fx%.3f, want 0.7x0.7", seed, a.ID, b.ID, ow, oh)
			}
			if b.ID != a.ID+1 {
				t.Fatalf("seed %d: L pair IDs %d/%d not adjacent", seed, a.ID, b.ID)
			}
			// 基座/短杠识别：基座长边 4（横或纵），短杠长边 2 且与基座垂直。
			ra, rb := wallRect(a), wallRect(b)
			wa, ha := ra.MaxX-ra.MinX, ra.MaxY-ra.MinY
			wb, hb := rb.MaxX-rb.MinX, rb.MaxY-rb.MinY
			if !(math.Abs(math.Max(wa, ha)-4) < 1e-9 && math.Abs(math.Min(wa, ha)-0.7) < 1e-9) &&
				!(math.Abs(math.Max(wa, ha)-2) < 1e-9 && math.Abs(math.Min(wa, ha)-0.7) < 1e-9) {
				t.Fatalf("seed %d: L piece %d unexpected size %.1fx%.1f", seed, a.ID, wa, ha)
			}
			if !(math.Abs(math.Max(wb, hb)-4) < 1e-9 && math.Abs(math.Min(wb, hb)-0.7) < 1e-9) &&
				!(math.Abs(math.Max(wb, hb)-2) < 1e-9 && math.Abs(math.Min(wb, hb)-0.7) < 1e-9) {
				t.Fatalf("seed %d: L piece %d unexpected size %.1fx%.1f", seed, b.ID, wb, hb)
			}
			// 长边 4 者为基座，长边 2 者为短杠；一楔内必各一件且短杠长轴
			// 与基座长轴垂直。
			var baseW, stubH float64
			if math.Abs(math.Max(wa, ha)-4) < 1e-9 {
				baseW, stubH = wa, hb
			} else {
				baseW, stubH = wb, ha
			}
			baseXLong := math.Abs(baseW-4) < 1e-9
			stubYLong := math.Abs(stubH-2) < 1e-9
			if baseXLong != stubYLong {
				t.Fatalf("seed %d: stub axis not perpendicular to base axis", seed)
			}
			ca := a.Min.Add(a.Max).Scale(0.5)
			k := int(angleDeg(ca.X, ca.Y)/45) % 8
			if baseXLong != coverXLong(k) {
				t.Fatalf("seed %d: wedge %d base orientation %v violates convention", seed, k, baseXLong)
			}
		}
		if assemblies != 8 {
			t.Fatalf("seed %d: L assemblies = %d, want 8", seed, assemblies)
		}
	}
}
