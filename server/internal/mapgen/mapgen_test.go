package mapgen

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ---- 测试种子集 ----

var testSeeds = []uint64{0, 1, 2, 3, 42, 0xDEADBEEF, 0xFFFFFFFFFFFFFFFF, 1234567890, 3731973273936997066}

// angleDeg 返回点 (x,y) 的方位角（度，[0,360)）。
func angleDeg(x, y float64) float64 {
	a := math.Atan2(y, x) * 180 / math.Pi
	if a < 0 {
		a += 360
	}
	return a
}

// mod45 返回角度对 45° 的余数（[0,45)）。
func mod45(deg float64) float64 {
	m := math.Mod(deg, 45)
	if m < 0 {
		m += 45
	}
	return m
}

// TestTopologyInvariants 校验固定骨架拓扑：扇区/Uplink 角度与半径/锁区/
// CoreRules/ID 全序/墙体 AABB 与边界。
func TestTopologyInvariants(t *testing.T) {
	for _, seed := range testSeeds {
		def, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: Generate: %v", seed, err)
		}
		// 元数据。
		if def.Version != 1 || def.GeneratorVer != GeneratorVer || GeneratorVer != 11 {
			t.Fatalf("seed %d: version fields wrong", seed)
		}
		if def.Seed != seed {
			t.Fatalf("seed %d: Seed mismatch %d", seed, def.Seed)
		}
		// 哈希可复算。
		h, err := hashDef(def)
		if err != nil || h != def.MapHash {
			t.Fatalf("seed %d: MapHash mismatch: %q vs %q (%v)", seed, h, def.MapHash, err)
		}
		// 扇区：8 个，中心角 k*45°，SpawnArea 在外环带内。
		if len(def.Sectors) != 8 {
			t.Fatalf("seed %d: sectors = %d, want 8", seed, len(def.Sectors))
		}
		for k, s := range def.Sectors {
			if s.ID != uint32(k) {
				t.Fatalf("seed %d: sector %d has ID %d", seed, k, s.ID)
			}
			wantAng := float64(k * 45)
			gotAng := angleDeg(s.Center.X, s.Center.Y)
			if math.Abs(gotAng-wantAng) > 0.01 {
				t.Fatalf("seed %d: sector %d angle %.4f, want %.1f", seed, k, gotAng, wantAng)
			}
			if r := s.Center.Len(); math.Abs(r-67.5) > 0.001 {
				t.Fatalf("seed %d: sector %d center radius %.4f", seed, k, r)
			}
			// 出生方块四角全部落在外环带 [55,80] 与本扇区楔内（1° 余量）。
			r := s.SpawnArea
			for _, c := range []sim.Vec2{
				{X: r.Min.X, Y: r.Min.Y}, {X: r.Max.X, Y: r.Min.Y},
				{X: r.Min.X, Y: r.Max.Y}, {X: r.Max.X, Y: r.Max.Y},
			} {
				if d := c.Len(); d < 55-1e-6 || d > 80+1e-6 {
					t.Fatalf("seed %d: sector %d spawn corner radius %.3f out of [55,80]", seed, k, d)
				}
				a := angleDeg(c.X, c.Y)
				lo, hi := wantAng-22.5+1, wantAng+22.5-1
				if wantAng == 0 && a > 180 { // 跨 0° 处理。
					a -= 360
				}
				if a < lo || a > hi {
					t.Fatalf("seed %d: sector %d spawn corner angle %.3f outside [%.1f,%.1f]", seed, k, a, lo, hi)
				}
			}
		}
		if len(def.HealthPacks) != 4 {
			t.Fatalf("seed %d: health packs = %d, want 4", seed, len(def.HealthPacks))
		}
		for i, pack := range def.HealthPacks {
			if pack.ID != uint32(i+1) {
				t.Fatalf("seed %d: health pack %d has ID %d", seed, i, pack.ID)
			}
			if d := pack.Pos.Len(); math.Abs(d-43) > 1e-9 {
				t.Fatalf("seed %d: health pack %d radius %.6f, want 43", seed, pack.ID, d)
			}
			for _, wall := range def.Walls {
				if nearestDist2(wallRect(wall), pack.Pos) < 1.2*1.2 {
					t.Fatalf("seed %d: health pack %d overlaps wall %+v", seed, pack.ID, wall)
				}
			}
		}
		// Uplink：6 普通 + 1 主。
		if len(def.Uplinks) != 7 {
			t.Fatalf("seed %d: uplinks = %d, want 7", seed, len(def.Uplinks))
		}
		mains, normals := 0, 0
		ids := map[uint32]bool{}
		for _, u := range def.Uplinks {
			if ids[u.ID] {
				t.Fatalf("seed %d: duplicate uplink ID %d", seed, u.ID)
			}
			ids[u.ID] = true
			if u.Main {
				mains++
				if u.Pos.X != 0 || u.Pos.Y != 0 {
					t.Fatalf("seed %d: main uplink not at origin: %v", seed, u.Pos)
				}
				if u.ActivePhase != sim.PhaseCoreOpen {
					t.Fatalf("seed %d: main uplink phase %d", seed, u.ActivePhase)
				}
				if u.InteractR != mainInteractR {
					t.Fatalf("seed %d: main uplink InteractR %v", seed, u.InteractR)
				}
			} else {
				normals++
				if d := u.Pos.Len(); d < 40-1e-9 || d > 45+1e-9 {
					t.Fatalf("seed %d: uplink %d radius %.3f outside [40,45]", seed, u.ID, d)
				}
				if m := mod45(angleDeg(u.Pos.X, u.Pos.Y)); math.Abs(m-22.5) > 0.6 {
					t.Fatalf("seed %d: uplink %d angle mod45 = %.4f, want 22.5", seed, u.ID, m)
				}
				if u.ActivePhase != sim.PhaseOuterRing {
					t.Fatalf("seed %d: uplink %d phase %d", seed, u.ID, u.ActivePhase)
				}
			}
		}
		if mains != 1 || normals != 6 {
			t.Fatalf("seed %d: uplink composition %d main / %d normal", seed, mains, normals)
		}
		// 锁区与 CoreRules。
		if def.CoreZone.Radius != 28.0 || def.CoreZone.Radius >= 30 {
			t.Fatalf("seed %d: core zone radius %v", seed, def.CoreZone.Radius)
		}
		if def.CoreZone.UnlockPhase != sim.PhaseCoreOpen {
			t.Fatalf("seed %d: core zone unlock phase %d", seed, def.CoreZone.UnlockPhase)
		}
		if def.CoreRules.PeriodTicks != 1200 || def.CoreRules.TargetAlive != 4 {
			t.Fatalf("seed %d: core supply period=%d target=%d", seed, def.CoreRules.PeriodTicks, def.CoreRules.TargetAlive)
		}
		wantW := map[sim.Phase][]float64{
			sim.PhaseOuterRing: {0.6, 0.4, 0.0},
			sim.PhaseCoreOpen:  {0.2, 0.4, 0.4},
		}
		if len(def.CoreRules.GroupWeights) != 2 {
			t.Fatalf("seed %d: group weight phases %d", seed, len(def.CoreRules.GroupWeights))
		}
		for ph, w := range wantW {
			got := def.CoreRules.GroupWeights[ph]
			if len(got) != 3 {
				t.Fatalf("seed %d: phase %d weights len %d", seed, ph, len(got))
			}
			for i := range w {
				if got[i] != w[i] {
					t.Fatalf("seed %d: phase %d weight[%d] = %v, want %v", seed, ph, i, got[i], w[i])
				}
			}
		}
		// CorePad：16/12/6，分组带内，值 10/25。
		if len(def.CorePads) != 16+12+6 {
			t.Fatalf("seed %d: pads = %d, want 34", seed, len(def.CorePads))
		}
		counts := [3]int{}
		mega := 0
		padIDs := map[uint32]bool{}
		for i, p := range def.CorePads {
			if p.ID != uint32(i+1) {
				t.Fatalf("seed %d: pad %d ID %d (want %d)", seed, i, p.ID, i+1)
			}
			padIDs[p.ID] = true
			if p.Group < 0 || p.Group > 2 {
				t.Fatalf("seed %d: pad %d group %d", seed, p.ID, p.Group)
			}
			counts[p.Group]++
			band := [3][2]float64{{57, 77}, {32, 53}, {6, 15}}[p.Group]
			if d := p.Pos.Len(); d < band[0]-1e-9 || d > band[1]+1e-9 {
				t.Fatalf("seed %d: pad %d (group %d) radius %.3f outside [%v,%v]", seed, p.ID, p.Group, d, band[0], band[1])
			}
			if p.Value == 25 {
				mega++
				if p.Group != 2 {
					t.Fatalf("seed %d: mega pad %d in group %d", seed, p.ID, p.Group)
				}
			} else if p.Value != 10 {
				t.Fatalf("seed %d: pad %d value %d", seed, p.ID, p.Value)
			}
		}
		if counts != [3]int{16, 12, 6} {
			t.Fatalf("seed %d: pad group counts %v, want [16 12 6]", seed, counts)
		}
		if mega != 2 {
			t.Fatalf("seed %d: mega pads = %d, want 2", seed, mega)
		}
		// Gen7 has eight complete batches: two long central strata, four other
		// single-AABB strata, and two mid-ring two-piece L strata.
		if len(def.Walls) != 80 {
			t.Fatalf("seed %d: walls = %d, want 80", seed, len(def.Walls))
		}
		for i, w := range def.Walls {
			if w.ID != uint32(i+1) {
				t.Fatalf("seed %d: wall %d has ID %d (want %d)", seed, i, w.ID, i+1)
			}
			if !(w.Min.X < w.Max.X && w.Min.Y < w.Max.Y) {
				t.Fatalf("seed %d: wall %d not a valid AABB: %v-%v", seed, w.ID, w.Min, w.Max)
			}
			for _, v := range []float64{w.Min.X, w.Min.Y, w.Max.X, w.Max.Y} {
				if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 80 {
					t.Fatalf("seed %d: wall %d coordinate %v out of bounds", seed, w.ID, v)
				}
			}
		}
	}
}

func TestCoreSupplyScalesWithParticipants(t *testing.T) {
	cases := []struct{ players, period, target int }{
		{1, 1200, 4}, {5, 900, 6}, {12, 720, 10}, {24, 600, 16}, {40, 480, 24}, {50, 480, 29},
	}
	for _, tc := range cases {
		padsOuter, padsMid := 16, 12
		if tc.players >= 50 {
			padsOuter = 18 // v9 TA 保底：n≥50 的外环配额被抬高（50 人档 16→18）
		}
		period, target := coreSupply(tc.players, padsOuter, padsMid)
		if period != tc.period || target != tc.target {
			t.Fatalf("players %d: period/target = %d/%d, want %d/%d", tc.players, period, target, tc.period, tc.target)
		}
		def, err := GenerateForPlayers(42, tc.players)
		if err != nil {
			t.Fatal(err)
		}
		if def.CoreRules.PeriodTicks != tc.period || def.CoreRules.TargetAlive != tc.target {
			t.Fatalf("players %d map rules = %+v", tc.players, def.CoreRules)
		}
	}
	// v9 TA 保底：n=49 仍是「只有供给规则随人数变」的几何冻结上界；
	// n=50 起 pad 配额被保底抬高（18+12=30），TA=29 不再被 pad 总数封顶。
	one, _ := GenerateForPlayers(42, 1)
	fortyNine, _ := GenerateForPlayers(42, 49)
	if one.MapHash == fortyNine.MapHash {
		t.Fatal("participant-scaled rules must be part of the authoritative map hash")
	}
	if !reflect.DeepEqual(one.Walls, fortyNine.Walls) || !reflect.DeepEqual(one.CorePads, fortyNine.CorePads) {
		t.Fatal("participant count changed deterministic geometry instead of only supply rules")
	}
	fifty, _ := GenerateForPlayers(42, 50)
	if len(fifty.CorePads) != 18+12+6 {
		t.Fatalf("n=50 pads = %d, want 36 (TA floor active)", len(fifty.CorePads))
	}
	ids := make([]uint32, 50)
	for i := range ids {
		ids[i] = uint32(i + 1)
	}
	world := sim.NewSim(42, ids, nil)
	if err := world.SetMap(fifty); err != nil {
		t.Fatal(err)
	}
	world.Tick()
	alive := 0
	for _, core := range world.WorldView().Cores {
		if core.Alive {
			alive++
		}
	}
	if alive != 29 {
		t.Fatalf("50-player first wave has %d live cores, want 29", alive)
	}
}

// TestDeterminismHundredSeeds：100 个种子重复生成哈希稳定，且不同种子产出
// 不同哈希。
func TestDeterminismHundredSeeds(t *testing.T) {
	const n = 100
	hashes := make(map[string]uint64, n)
	for i := 0; i < n; i++ {
		seed := uint64(i)*0x9E3779B97F4A7C15 + 0x123456789ABCDEF
		a, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		b, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d (retry): %v", seed, err)
		}
		if a.MapHash != b.MapHash {
			t.Fatalf("seed %d: hash unstable: %s vs %s", seed, a.MapHash, b.MapHash)
		}
		ja, _ := json.Marshal(a)
		jb, _ := json.Marshal(b)
		if string(ja) != string(jb) {
			t.Fatalf("seed %d: JSON output differs between runs", seed)
		}
		if prev, dup := hashes[a.MapHash]; dup {
			t.Fatalf("seeds %d and %d collide on hash %s", prev, seed, a.MapHash)
		}
		hashes[a.MapHash] = seed
	}
	if len(hashes) != n {
		t.Fatalf("distinct hashes = %d, want %d", len(hashes), n)
	}
}

// TestConnectivityBFS：两种阶段模式（锁区封闭/开放）全图自由格 4-邻接连通，
// 且出生点/Uplink/CorePad 所在格为自由格。
func TestConnectivityBFS(t *testing.T) {
	l := layoutFor(1)
	for _, seed := range testSeeds {
		def, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		if !connectedGrid(l, def.Walls, false) {
			t.Fatalf("seed %d: OUTER_RING mode not connected", seed)
		}
		if !connectedGrid(l, def.Walls, true) {
			t.Fatalf("seed %d: CORE_OPEN mode not connected", seed)
		}
		// POI 格自由性。
		open, n := gridFor(l, def.Walls, true)
		ext := l.outerMaxR
		cellFree := func(p sim.Vec2) bool {
			gx, gy := gridIndex(p.X, ext), gridIndex(p.Y, ext)
			return gx >= 0 && gx < n && gy >= 0 && gy < n && !open[gy*n+gx]
		}
		for k := 0; k < 8; k++ {
			if !cellFree(l.sectorCenter(k)) {
				t.Fatalf("seed %d: spawn center %d blocked", seed, k)
			}
		}
		for _, u := range def.Uplinks {
			if !cellFree(u.Pos) {
				t.Fatalf("seed %d: uplink %d blocked", seed, u.ID)
			}
		}
		for _, p := range def.CorePads {
			if !cellFree(p.Pos) {
				t.Fatalf("seed %d: pad %d blocked", seed, p.ID)
			}
		}
	}
}

// TestSpawnLegality：出生方块与全部墙体净空 ≥ 2.2m（严格不重叠），方块
// 四角位于外环带与本扇区楔内。
func TestSpawnLegality(t *testing.T) {
	for _, seed := range testSeeds {
		def, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		l := layoutFor(1)
		for k := 0; k < 8; k++ {
			sq := l.spawnArea(k)
			for _, w := range def.Walls {
				g := gap2(wallRect(w), sq)
				if g < 0 {
					t.Fatalf("seed %d: wall %d overlaps spawn square %d", seed, w.ID, k)
				}
				if g < poiClearance*poiClearance-1e-9 {
					t.Fatalf("seed %d: wall %d only %.3fm from spawn square %d", seed, w.ID, math.Sqrt(g), k)
				}
			}
		}
	}
}

// rot90Wall 精确旋转墙（AABB→AABB）：[x0,x1]×[y0,y1] → [-y1,-y0]×[x0,x1]。
func rot90Wall(w sim.Wall) sim.Wall {
	return sim.Wall{
		Min: sim.Vec2{X: -w.Max.Y, Y: w.Min.X},
		Max: sim.Vec2{X: -w.Min.Y, Y: w.Max.X},
	}
}

func wallKey(w sim.Wall) string {
	return fmt.Sprintf("%.17g,%.17g,%.17g,%.17g", w.Min.X, w.Min.Y, w.Max.X, w.Max.Y)
}

// TestRotationSymmetry：两层验证（审核裁决：墙对称即可）。
//
//  1. 绕原点旋转 90°：墙集合多重集严格不变（bit 级，精确算术断言）。
//  2. 统计特征逐楔一致：把墙按中心角归入 8 个 45° 楔（round 划界，对边界
//     浮点误差鲁棒），每个楔的墙数、总面积、总周长、尺寸多重集（半边排序
//     后的 width×height）必须完全相同——即对任意 k·45° 旋转墙集合统计特征
//     一致（AABB 旋转 45° 后不再是 AABB，故用楔统计而非几何双射）。
func TestRotationSymmetry(t *testing.T) {
	for _, seed := range testSeeds {
		def, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		// 90°：精确多重集相等。
		orig := map[string]int{}
		for _, w := range def.Walls {
			orig[wallKey(w)]++
		}
		rot := map[string]int{}
		for _, w := range def.Walls {
			rot[wallKey(rot90Wall(w))]++
		}
		if len(orig) != len(rot) {
			t.Fatalf("seed %d: rot90 multiset size %d != %d", seed, len(rot), len(orig))
		}
		for k, c := range orig {
			if rot[k] != c {
				t.Fatalf("seed %d: rot90 mismatch at %s: %d vs %d", seed, k, rot[k], c)
			}
		}
		// 逐楔统计。骨架墙恰落在楔边界（轴向 k·45°），跨越两侧；把边界墙
		//（中心角距 45° 倍数 < 0.1°）对半摊给相邻两楔，内部墙全量归一楔。
		// 这样每楔统计量精确可比：掩体每批 1 块/楔，径向墙 0.5+0.5=1/楔，
		// 环墙 1/楔。
		type wedgeStat struct {
			count, area, peri float64
		}
		stats := make([]wedgeStat, 8)
		addWall := func(ang, sx, sy float64) {
			sx, sy = min(sx, sy), max(sx, sy)
			area := 4 * sx * sy
			peri := 4 * (sx + sy)
			frac := math.Mod(ang, 45)
			if frac < 0 {
				frac += 45
			}
			if frac < 0.1 || frac > 44.9 { // 边界墙：对半摊给两侧。
				k := int(math.Round(ang/45.0)) % 8
				if k < 0 {
					k += 8
				}
				stats[k].count += 0.5
				stats[k].area += area / 2
				stats[k].peri += peri / 2
				k2 := (k + 7) % 8
				stats[k2].count += 0.5
				stats[k2].area += area / 2
				stats[k2].peri += peri / 2
				return
			}
			k := int(math.Floor(ang/45.0)) % 8
			stats[k].count++
			stats[k].area += area
			stats[k].peri += peri
		}
		for _, w := range def.Walls {
			cx := (w.Min.X + w.Max.X) / 2
			cy := (w.Min.Y + w.Max.Y) / 2
			addWall(angleDeg(cx, cy), (w.Max.X-w.Min.X)/2, (w.Max.Y-w.Min.Y)/2)
		}
		for k := 1; k < 8; k++ {
			if math.Abs(stats[k].count-stats[0].count) > 1e-9 {
				t.Fatalf("seed %d: wedge %d wall count %g != %g", seed, k, stats[k].count, stats[0].count)
			}
			if math.Abs(stats[k].area-stats[0].area) > 1e-6 {
				t.Fatalf("seed %d: wedge %d area %.6f != %.6f", seed, k, stats[k].area, stats[0].area)
			}
			if math.Abs(stats[k].peri-stats[0].peri) > 1e-6 {
				t.Fatalf("seed %d: wedge %d perimeter %.6f != %.6f", seed, k, stats[k].peri, stats[0].peri)
			}
		}
		// 尺寸类成套性：每类（排序半边相同）墙数必为 8 的倍数。Gen4 的 L 层
		// 采用偶/奇双定向框（同尺寸类内短杠角度残差按构造不同），逐类角度
		// 残差一致性不再成立，成套性由「每尺寸类 8 的倍数 + 逐楔统计一致 +
		// 90° 精确多重集」共同保证；L 装配自身的重叠剪影在
		// TestStrataClearanceAndSpawns 与 TestLASsemblySilhouette 中单独验证。
		classCount := map[string]int{}
		for _, w := range def.Walls {
			sx := (w.Max.X - w.Min.X) / 2
			sy := (w.Max.Y - w.Min.Y) / 2
			sx, sy = min(sx, sy), max(sx, sy)
			key := fmt.Sprintf("%.6fx%.6f", 2*sx, 2*sy)
			classCount[key]++
		}
		for key, n := range classCount {
			if n%8 != 0 {
				t.Fatalf("seed %d: dim class %s count %d not divisible by 8", seed, key, n)
			}
		}
	}
}

// TestWallRingDensity：中环墙体面积密度显著高于外环（设计要求：中环密、
// 外环疏），并输出统计摘要。
func TestWallRingDensity(t *testing.T) {
	const midBandArea = math.Pi * (55*55 - 30*30)
	const outerBandArea = math.Pi * (80*80 - 55*55)
	for _, seed := range testSeeds {
		def, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		midArea, outerArea, midN, outerN := 0.0, 0.0, 0, 0
		for _, w := range def.Walls {
			cx := (w.Min.X + w.Max.X) / 2
			cy := (w.Min.Y + w.Max.Y) / 2
			area := (w.Max.X - w.Min.X) * (w.Max.Y - w.Min.Y)
			switch r := math.Hypot(cx, cy); {
			case r >= 30 && r < 55:
				midArea += area
				midN++
			case r >= 55:
				outerArea += area
				outerN++
			}
		}
		midD, outerD := midArea/midBandArea, outerArea/outerBandArea
		t.Logf("seed %d: walls=%d (mid %d/%.1fm², outer %d/%.1fm²), density mid=%.4f outer=%.4f ratio=%.2f",
			seed, len(def.Walls), midN, midArea, outerN, outerArea, midD, outerD, midD/outerD)
		if midD <= outerD {
			t.Fatalf("seed %d: mid density %.4f not greater than outer %.4f", seed, midD, outerD)
		}
	}
}

// TestDirTable：方向表单位长度、相邻夹角 7.5°、周期与负步进回绕。
func TestDirTable(t *testing.T) {
	const sq2 = math.Sqrt2 / 2
	cos75 := math.Cos(7.5 * math.Pi / 180)
	for i, d := range dirTable {
		if l := math.Hypot(d.x, d.y); math.Abs(l-1) > 1e-5 {
			t.Fatalf("dirTable[%d] length %.8f", i, l)
		}
		n := dirTable[(i+1)%dirCount]
		dot := d.x*n.x + d.y*n.y
		if math.Abs(dot-cos75) > 1e-5 {
			t.Fatalf("dirTable[%d] adjacent dot %.8f, want %.8f", i, dot, cos75)
		}
	}
	if d := dirAt(0); d.X != 1 || d.Y != 0 {
		t.Fatalf("dirAt(0) = %v", d)
	}
	if d := dirAt(6); math.Abs(d.X-sq2) > 1e-5 || math.Abs(d.Y-sq2) > 1e-5 {
		t.Fatalf("dirAt(6) = %v", d)
	}
	for step := -100; step < 100; step++ {
		a, b := dirAt(step), dirAt(step+dirCount)
		if a != b {
			t.Fatalf("dirAt(%d) != dirAt(%d): %v vs %v", step, step+dirCount, a, b)
		}
	}
}

// TestSortedOutputStability：Walls/Uplinks/CorePads 输出已按 ID 升序（canonical
// 顺序，供 SetMap 直接消费）。
func TestSortedOutputStability(t *testing.T) {
	for _, seed := range testSeeds {
		def, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		for i := 1; i < len(def.Walls); i++ {
			if def.Walls[i-1].ID >= def.Walls[i].ID {
				t.Fatalf("seed %d: walls not sorted by ID at %d", seed, i)
			}
		}
		for i := 1; i < len(def.Uplinks); i++ {
			if def.Uplinks[i-1].ID >= def.Uplinks[i].ID {
				t.Fatalf("seed %d: uplinks not sorted by ID at %d", seed, i)
			}
		}
		for i := 1; i < len(def.CorePads); i++ {
			if def.CorePads[i-1].ID >= def.CorePads[i].ID {
				t.Fatalf("seed %d: pads not sorted by ID at %d", seed, i)
			}
		}
	}
}

// TestUplinkCenterSymmetry：普通 Uplink 集合中心对称（三对直径对），直径对
// 共享半径——8 楔可达性均衡。
func TestUplinkCenterSymmetry(t *testing.T) {
	for _, seed := range testSeeds {
		def, err := Generate(seed)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		normals := make([]sim.UplinkDef, 0, 6)
		for _, u := range def.Uplinks {
			if !u.Main {
				normals = append(normals, u)
			}
		}
		matched := make([]bool, len(normals))
		for i := range normals {
			if matched[i] {
				continue
			}
			found := false
			for j := i + 1; j < len(normals); j++ {
				if matched[j] {
					continue
				}
				dx := normals[i].Pos.X + normals[j].Pos.X
				dy := normals[i].Pos.Y + normals[j].Pos.Y
				if math.Hypot(dx, dy) < 1e-6 {
					matched[i], matched[j], found = true, true, true
					break
				}
			}
			if !found {
				t.Fatalf("seed %d: uplink %d has no antipodal partner", seed, normals[i].ID)
			}
		}
	}
}

// TestLargeRoomLayoutBreakpoints（GeneratorVer 8 人数自适应骨架的断点 golden）：
// 1 / 64 / 65 / 96 / 100 / 150 / 200 / 256 人各生成一张图，断言：
//   - 生成成功（含 genWalls 候选搜索与双模式 BFS 连通验证）；
//   - ArenaRadius / Uplink / Pad / 血包数量符合 layout 档位表；
//   - sim.SetMap 以满员机器人装配成功（初始出生全部合法）；
//   - MapBootstrap JSON 体积在 48KiB 传输帧预算内（含余量，netws 上限 64KiB）。
//
// 档位表任何调整都会在此暴露，是"人数 → 全部参数"自动化的验收门。
func TestLargeRoomLayoutBreakpoints(t *testing.T) {
	for _, tc := range []struct {
		n, uplinks, pads, packs int
	}{
		{1, 6, 34, 4},
		{64, 6, 42, 4},    // v9：TA=36 → 外24+中12+心6（差额全补外环）
		{65, 6, 42, 4},    // 同 64：TA 仍是 36
		{96, 8, 62, 8},    // TA=52 → 外34+中18+心10
		{100, 8, 64, 8},   // TA=54 → 外34+中20+心10
		{150, 8, 94, 8},   // TA=79 → 外52+中28+心14
		{200, 8, 124, 12}, // TA=104 → 外66+中38+心20
		{256, 8, 156, 12}, // TA=132 → 外84+中48+心24
	} {
		t.Run(fmt.Sprintf("n=%d", tc.n), func(t *testing.T) {
			def, err := GenerateForPlayers(42, tc.n)
			if err != nil {
				t.Fatalf("generate: %v", err)
			}
			l := layoutFor(tc.n)
			if math.Abs(def.ArenaRadius-l.outerMaxR) > 1e-9 {
				t.Fatalf("arena radius %.3f, want %.3f", def.ArenaRadius, l.outerMaxR)
			}
			if got := len(def.Uplinks); got != tc.uplinks+1 {
				t.Fatalf("uplinks = %d, want %d+main", got, tc.uplinks)
			}
			if got := len(def.CorePads); got != tc.pads {
				t.Fatalf("pads = %d, want %d", got, tc.pads)
			}
			if got := len(def.HealthPacks); got != tc.packs {
				t.Fatalf("health packs = %d, want %d", got, tc.packs)
			}
			// 满员装配：全部机器人落位其扇区出生块（重叠兜底允许，硬错误拒绝）。
			ids := make([]uint32, tc.n)
			for i := range ids {
				ids[i] = uint32(i + 1)
			}
			s := sim.NewSim(42, ids, nil)
			if err := s.SetMap(def); err != nil {
				t.Fatalf("SetMap with %d robots: %v", tc.n, err)
			}
			// bootstrap 传输体积（glue 会把整图 JSON 塞进单帧可靠消息）。
			b, err := json.Marshal(def)
			if err != nil {
				t.Fatal(err)
			}
			if len(b) > 48*1024 {
				t.Fatalf("map JSON %d bytes exceeds 48KiB transport budget", len(b))
			}
			t.Logf("n=%d: walls=%d pads=%d packs=%d json=%dB", tc.n, len(def.Walls), tc.pads, tc.packs, len(b))
		})
	}
}

// TestGeometryStableBelowCapacityFloor：n≤49 骨架冻结——同 seed 下 1 人与
// 49 人产出除 CoreRules（供给曲线）外完全一致的几何。这是"小房不变"的
// 回归锚：任何波及小图布局的改动都会在此失败。（v8 时代上界是 64；v9 起
// pad 配额 TA 保底从 n=50 生效，冻结上界前移到 49。）
func TestGeometryStableBelowCapacityFloor(t *testing.T) {
	one, err := GenerateForPlayers(42, 1)
	if err != nil {
		t.Fatal(err)
	}
	full, err := GenerateForPlayers(42, 49)
	if err != nil {
		t.Fatal(err)
	}
	one.CoreRules, full.CoreRules = sim.CoreRulesDef{}, sim.CoreRulesDef{}
	one.MapHash, full.MapHash = "", ""
	if !reflect.DeepEqual(one, full) {
		t.Fatal("n=1 and n=49 maps diverge outside CoreRules; capacity-floor geometry is not frozen")
	}
}

// TestScaledLayoutsGenerateAcrossSeeds：缩放档位对随机种子的健壮性门。
// 候选格点加宽（7×7→11×7×11）前，n=96 有 ~5% 种子整层掩体放置失败、
// 对局装配报错——大房开图是随机种子，这是必须为零的失败率。
func TestScaledLayoutsGenerateAcrossSeeds(t *testing.T) {
	for _, n := range []int{96, 150, 200, 256} {
		for seed := uint64(0); seed < 20; seed++ {
			if _, err := GenerateForPlayers(seed, n); err != nil {
				t.Fatalf("n=%d seed=%d: %v", n, seed, err)
			}
		}
	}
}
