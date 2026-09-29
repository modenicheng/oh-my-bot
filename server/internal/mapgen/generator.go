// Package mapgen 生成 oh-my-bot 的确定性八辐轮盘地图（sim.MapDef）。
//
// 骨架拓扑固定（v0.3 §3）：8 个 45° 出生扇区（轴角 k*45°，SpawnArea 为外环
// 55–80m 内的轴对齐方块）、三环（外 55–80 / 中 30–55 / 中央 <30m）、6 个普通
// Uplink 位于中环且角度 = k*45°+22.5°、1 个中央主 Uplink（CORE_OPEN 激活）、
// 外 16 + 中 12 + 中央 6 个 CorePad。骨架内的掩体布局按种子随机：中环密、
// 外环疏。全部墙体为 AABB。
//
// 墙体八分对称：骨架墙在每个 45° 楔内形状完全一致；每个掩体原型落在 0°楔
// 内，经 k·45° 旋转（k=0..7）同时盖 8 块——任何 45° 楔拥有相同的掩体数、
// 面积与朝向分布（八辐公平性）。掩体整批接受或整批丢弃（净空/连通检查），
// 保证对称性不被局部拒绝破坏。
//
// 确定性：生成路径只用整数与浮点乘加运算 + 字面量方向表（零三角函数、零
// map 遍历序依赖），同 seed 必产出同 MapHash = SHA256(canonical JSON)。
package mapgen

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ---- 环带与锁区常量（v0.3 §3；单位米）----

const (
	outerMinR = 55.0 // 外环内边界
	outerMaxR = 80.0 // 外环外边界（160×160m 参考的半宽）
	midMinR   = 30.0 // 中环内边界
	midMaxR   = 55.0 // 中环外边界（= outerMinR）
	coreZoneR = 28.0 // 中央锁区半径（<30m；CORE_OPEN 解锁）

	spawnRadius = 67.5 // 出生方块中心半径（外环带中段）
	spawnHalf   = 6.5  // 出生方块半边长（13×13m，四角半径 58.3–76.7 全在 [55,80]）

	uplinkRLo      = 40.0 // 普通 Uplink 半径抖动下界（中环带内）
	uplinkRHi      = 45.0 // 普通 Uplink 半径抖动上界
	normInteractR  = 2.5  // 普通 Uplink 交互半径（v0.3 §6）
	mainInteractR  = 3.0  // 主 Uplink 交互半径
	corePeriodTick = 1800 // Core 刷新周期：30s @ 60Hz
)

// CorePad 数量（Group 0=outer / 1=mid / 2=center）。
const (
	padOuterN  = 16
	padMidN    = 12
	padCenterN = 6
)

// GeneratorVer 是 mapgen 算法版本；布局算法任何变更必须递增。
const GeneratorVer = 1

// 分段盐：各生成阶段使用独立随机流，避免阶段间拒绝采样纠缠。
const (
	saltUplinks uint64 = 0xD1B54A327F6109C3
	saltPads    uint64 = 0x6A2E88C041D7B5A4
	saltWalls   uint64 = 0x9F03C2D15E47A8B0
)

// Generate 按 seed 生成确定性 MapDef：固定骨架（扇区/Uplink 角度/锁区/刷新
// 规则）+ seed 驱动的 Uplink 半径、CorePad 与掩体布局。产出前经双模式 BFS
// 连通性验证（1m 网格：OUTER_RING 锁区封闭、CORE_OPEN 全图连通）。
func Generate(seed uint64) (*sim.MapDef, error) {
	skeleton := skeletonWalls()
	uplinks := genUplinks(newRng(seed ^ saltUplinks))
	pads := genCorePads(newRng(seed^saltPads), skeleton, uplinks)
	walls, err := genWalls(newRng(seed^saltWalls), skeleton, uplinks, pads)
	if err != nil {
		return nil, fmt.Errorf("mapgen: walls: %w", err)
	}

	def := &sim.MapDef{
		Version:      1,
		GeneratorVer: GeneratorVer,
		Seed:         seed,
		Walls:        walls,
		Sectors:      genSectors(),
		Uplinks:      uplinks,
		CorePads:     pads,
		CoreZone: sim.CoreZoneDef{
			Radius:      coreZoneR,
			UnlockPhase: sim.PhaseCoreOpen,
		},
		CoreRules: sim.CoreRulesDef{
			PeriodTicks: corePeriodTick,
			GroupWeights: map[sim.Phase][]float64{
				sim.PhaseOuterRing: {0.6, 0.4, 0.0},
				sim.PhaseCoreOpen:  {0.2, 0.4, 0.4},
			},
		},
	}
	h, err := hashDef(def)
	if err != nil {
		return nil, fmt.Errorf("mapgen: hash: %w", err)
	}
	def.MapHash = h
	return def, nil
}

// hashDef 计算 MapDef 的内容哈希：MapHash 置空后 canonical JSON（结构体字段
// 声明序 + 生成序切片 + 数值键升序 map）的 SHA256 hex。它是"同 seed 同产出"
// 契约的断言凭据。
func hashDef(def *sim.MapDef) (string, error) {
	clone := *def
	clone.MapHash = ""
	b, err := json.Marshal(clone)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return fmt.Sprintf("%x", sum), nil
}

// sectorCenter 返回第 k 扇区轴线（k*45°）上 spawnRadius 处的中心点。
func sectorCenter(k int) sim.Vec2 { return dirAt(6 * k).Scale(spawnRadius) }

// spawnAreaOf 返回第 k 扇区的出生方块（轴对齐 13×13m，四角全部落在外环带
// 内且不越出相邻扇区界）。AABB 世界无法精确表达 45° 弧段；方块是"外环 +
// 扇区内 + 8 重旋转一致"的保守逼近。
func spawnAreaOf(k int) rect {
	c := sectorCenter(k)
	return rect{MinX: c.X - spawnHalf, MinY: c.Y - spawnHalf, MaxX: c.X + spawnHalf, MaxY: c.Y + spawnHalf}
}

// genSectors 生成 8 个出生扇区：中心角 = k*45°，SpawnArea 为外环内方块。
func genSectors() [8]sim.Sector {
	var out [8]sim.Sector
	for k := 0; k < 8; k++ {
		c := sectorCenter(k)
		out[k] = sim.Sector{
			ID: uint32(k),
			SpawnArea: sim.Rect{
				Min: sim.Vec2{X: c.X - spawnHalf, Y: c.Y - spawnHalf},
				Max: sim.Vec2{X: c.X + spawnHalf, Y: c.Y + spawnHalf},
			},
			Center: c,
		}
	}
	return out
}

// uplinkSteps 为 6 个普通 Uplink 的方向表步进（7.5°/步）：22.5°、67.5°、
// 112.5°、202.5°、247.5°、292.5°——全部错位扇区轴 22.5°，且三对直径对
// （22.5↔202.5、67.5↔247.5、112.5↔292.5）构成中心对称集合。
var uplinkSteps = [6]int{3, 9, 15, 27, 33, 39}

// genUplinks 生成 6 个普通 Uplink（中环 40–45m；同一直径对共享半径，使
// 集合保持中心对称）与 1 个中央主 Uplink（原点，CORE_OPEN 激活）。
// ID：普通桩按角度升序 1–6，主桩 7。
func genUplinks(r *rng) []sim.UplinkDef {
	radii := [3]float64{r.rangeF(uplinkRLo, uplinkRHi), r.rangeF(uplinkRLo, uplinkRHi), r.rangeF(uplinkRLo, uplinkRHi)}
	out := make([]sim.UplinkDef, 0, len(uplinkSteps)+1)
	for i, step := range uplinkSteps {
		out = append(out, sim.UplinkDef{
			ID:          uint32(i + 1),
			Pos:         dirAt(step).Scale(radii[i%3]),
			InteractR:   normInteractR,
			ActivePhase: sim.PhaseOuterRing,
		})
	}
	out = append(out, sim.UplinkDef{
		ID:          uint32(len(uplinkSteps) + 1),
		Pos:         sim.Vec2{},
		Main:        true,
		InteractR:   mainInteractR,
		ActivePhase: sim.PhaseCoreOpen,
	})
	return out
}

// genCorePads 生成外 16 + 中 12 + 中央 6 个刷新点（seed 驱动）。外/中环组
// 用中心对称对采样（8 楔均衡），与骨架墙保持 ≥2.5m、与 Uplink 保持 ≥3m
// 净空；组内按 (x,y) 字典序排序后顺序分配 ID（canonical 顺序）。中央组
// 坐标序前两个为 Mega Core（+25）。
func genCorePads(r *rng, skeleton []sim.Wall, uplinks []sim.UplinkDef) []sim.CorePadDef {
	pads := make([]sim.CorePadDef, 0, padOuterN+padMidN+padCenterN)
	id := uint32(1)
	place := func(group, count int, lo, hi, gap float64) {
		placed := make([]sim.Vec2, 0, count)
		for tries := 0; len(placed) < count && tries < 5000; tries++ {
			x, y := r.rangeF(-hi, hi), r.rangeF(-hi, hi)
			if d2 := x*x + y*y; d2 < lo*lo || d2 > hi*hi {
				continue
			}
			p := sim.Vec2{X: x, Y: y}
			mirror := sim.Vec2{X: -x, Y: -y}
			if !padOK(p, gap, placed, skeleton, uplinks) ||
				!padOK(mirror, gap, append(placed, p), skeleton, uplinks) {
				continue
			}
			placed = append(placed, p, mirror)
		}
		sortVec2(placed)
		for _, p := range placed {
			pads = append(pads, sim.CorePadDef{ID: id, Pos: p, Group: group, Value: 10})
			id++
		}
	}
	place(0, padOuterN, 57, 77, 5.0)
	place(1, padMidN, 32, 53, 5.0)
	place(2, padCenterN, 6, 15, 3.5)
	pads[len(pads)-padCenterN].Value = 25
	pads[len(pads)-padCenterN+1].Value = 25
	return pads
}

// padOK 校验候选刷新点：距同组已放点 ≥ gap，距骨架墙 ≥ 2.5m，距任意
// Uplink ≥ 3m（含原点主桩）。
func padOK(p sim.Vec2, gap float64, placed []sim.Vec2, skeleton []sim.Wall, uplinks []sim.UplinkDef) bool {
	for _, q := range placed {
		dx, dy := p.X-q.X, p.Y-q.Y
		if dx*dx+dy*dy < gap*gap {
			return false
		}
	}
	for _, w := range skeleton {
		if nearestDist2(wallRect(w), p) < 2.5*2.5 {
			return false
		}
	}
	for _, u := range uplinks {
		dx, dy := p.X-u.Pos.X, p.Y-u.Pos.Y
		if dx*dx+dy*dy < 3.0*3.0 {
			return false
		}
	}
	return true
}

// sortVec2 按 (x,y) 字典序原址排序（插入排序，n ≤ 34）。
func sortVec2(v []sim.Vec2) {
	for i := 1; i < len(v); i++ {
		for j := i; j > 0 && vecLess(v[j], v[j-1]); j-- {
			v[j], v[j-1] = v[j-1], v[j]
		}
	}
}

// vecLess 按 (x,y) 字典序比较（canonical 排序用）。
func vecLess(a, b sim.Vec2) bool {
	if a.X != b.X {
		return a.X < b.X
	}
	return a.Y < b.Y
}
