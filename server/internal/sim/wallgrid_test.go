package sim

import (
	"math/rand"
	"testing"
)

// 墙体空间索引的语义等价门（批 2）：对随机墙布局与随机查询线段，
// wallsNear 候选集按 ID 升序、且与全墙遍历在三个查询点
// （sweepContact / pushRobot / traceSolid）的逐步覆盖式 tie-breaking 下
// 结果一致。实测以 sweepContact/traceSolid 的完整返回值为准。
func TestWallGridMatchesFullScan(t *testing.T) {
	rng := rand.New(rand.NewSource(20261014))
	for iter := 0; iter < 300; iter++ {
		walls := make([]Wall, 1+rng.Intn(40))
		for i := range walls {
			x, y := rng.Float64()*120-60, rng.Float64()*120-60
			w, h := 0.5+rng.Float64()*6, 0.5+rng.Float64()*6
			walls[i] = Wall{ID: uint32(i + 1), Min: Vec2{X: x, Y: y}, Max: Vec2{X: x + w, Y: y + h}}
		}
		p := Vec2{X: rng.Float64()*140 - 70, Y: rng.Float64()*140 - 70}
		d := Vec2{X: rng.Float64()*8 - 4, Y: rng.Float64()*8 - 4}

		full := &Sim{walls: walls}
		indexed := &Sim{walls: walls, mapDef: &MapDef{GeneratorVer: 8, ArenaRadius: 100}}
		indexed.rebuildWallIndex()

		// sweepContact（含法线与平局处理）。
		a, b := full.sweepContact(p, d), indexed.sweepContact(p, d)
		if a.t != b.t || a.hit != b.hit || a.normal != b.normal {
			t.Fatalf("iter %d sweepContact: full=%+v indexed=%+v", iter, a, b)
		}
		// traceSolid。
		fa, ha := full.traceSolid(p, d)
		fb, hb := indexed.traceSolid(p, d)
		if fa != fb || ha != hb {
			t.Fatalf("iter %d traceSolid: full=%v/%v indexed=%v/%v", iter, fa, ha, fb, hb)
		}
	}
}

// 覆盖完整性：故意构造远端墙 + 近端墙，索引不得漏掉任何与扫掠 AABB 相交的墙。
func TestWallGridFindsFarWall(t *testing.T) {
	walls := []Wall{
		{ID: 1, Min: Vec2{X: 50, Y: -1}, Max: Vec2{X: 51, Y: 1}},
		{ID: 2, Min: Vec2{X: -52, Y: -1}, Max: Vec2{X: -51, Y: 1}},
	}
	s := &Sim{walls: walls, mapDef: &MapDef{GeneratorVer: 8, ArenaRadius: 80}}
	s.rebuildWallIndex()
	// 从左侧出发：先命中近侧墙（x=-52 → fraction=8/120）。
	if f, hit := s.traceSolid(Vec2{X: -60}, Vec2{X: 120, Y: 0}); !hit || f < 0.06 || f > 0.07 {
		t.Fatalf("near wall missed: fraction=%v hit=%v", f, hit)
	}
	// 从原点出发：跨全场命中远侧墙（x=50 → fraction=50/120）。
	if f, hit := s.traceSolid(Vec2{}, Vec2{X: 120, Y: 0}); !hit || f < 0.41 || f > 0.42 {
		t.Fatalf("far wall missed: fraction=%v hit=%v", f, hit)
	}
}
