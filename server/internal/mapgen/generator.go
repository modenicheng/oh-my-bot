// Package mapgen 生成 oh-my-bot 的确定性八辐轮盘地图（sim.MapDef）。
//
// 骨架拓扑固定（v0.3 §3）：8 个 45° 出生扇区（轴角 k*45°，SpawnArea 为外环
// 55–80m 内的轴对齐方块）、三环（外 55–80 / 中 30–55 / 中央 <30m）、6 个普通
// Uplink 位于中环且角度错位扇区轴 22.5°、1 个中央主 Uplink（CORE_OPEN 激活）、
// 外 16 + 中 12 + 中央 6 个 CorePad。骨架内的掩体布局按种子随机：中环密、
// 外环疏。全部墙体为 AABB，集合在绕原点旋转 90° 下严格不变（4 次旋转封
// 闭），因此对任意 k*45° 旋转各 45° 楔的墙体统计特征一致（八辐骨架公平性）。
//
// 确定性：生成路径只用整数/IEEE754 基本运算与字面量方向表（无 math 三角
// 调用、无 map 遍历序依赖），同 seed 必产出同 MapHash = SHA256(canonical JSON)。
package mapgen

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ---- 环带与锁区常量（v0.3 §3；单位米）----

const (
	outerMinR = 55.0 // 外环内边界
	outerMaxR = 80.0 // 外环外边界（方形地图 160×160m 的半宽）
	midMinR   = 30.0 // 中环内边界
	midMaxR   = 55.0 // 中环外边界（= outerMinR）
	coreZoneR = 28.0 // 中央锁区半径（<30m，CORE_OPEN 解锁）

	spawnRadius = 67.5 // 出生方块中心所在半径（外环中段）
	spawnHalf   = 8.5  // 出生方块半边长（17×17m，全部落在 [55,80] 环带内）

	uplinkRLo       = 40.0 // 普通 Uplink 半径抖动下界（中环内）
	uplinkRHi       = 45.0 // 普通 Uplink 半径抖动上界
	normInteractR   = 2.5  // 普通 Uplink 交互半径（v0.3 §6）
	mainInteractR   = 3.0  // 主 Uplink 交互半径
	corePeriodTicks = 1800 // Core 刷新周期：30s @ 60Hz
)

// ---- CorePad 数量（Group 0=outer / 1=mid / 2=center）----

const (
	padOuterN  = 16
	padMidN    = 12
	padCenterN = 6
)

// GeneratorVer 是 mapgen 算法版本；布局算法任何变更必须递增。
const GeneratorVer = 1

// 分段盐：各生成阶段使用独立随机流，避免阶段间重试纠缠。
const (
	saltUplinks uint64 = 0xD1B54A327F6109C3
	saltPads    uint64 = 0x6A2E88C041D7B5A4
	saltWalls   uint64 = 0x9F03C2D15E47A8B0
)

// Generate 按 seed 生成确定性 MapDef。骨架（扇区/Uplink 角度/锁区/规则）固定，
// 墙体掩体与 CorePad 布局由 seed 驱动；产出前经 BFS 连通性验证（1m 网格，
// OUTER_RING 锁区封闭与 CORE_OPEN 开放两种模式）。
func Generate(seed uint64) (*sim.MapDef, error) {
	skeleton := skeletonWalls()
	uplinks := genUplinks(newRng(seed ^ saltUplinks))
	pads, err := genCorePads(newRng(seed ^ saltPads), skeleton, uplinks)
	if err != nil {
		return nil, fmt.Errorf("mapgen: pads: %w", err)
	}
	walls, err := genWalls(newRng(seed ^ saltWalls), skeleton, uplinks, pads)
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
			PeriodTicks: corePeriodTicks,
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
// 序 + 有序切片 + 排序 map 键）的 SHA256 hex。它是"同 seed 同产出"的断言凭据。
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
func sectorCenter(k int) sim.Vec2 { return dirAt(2 * k).Scale(spawnRadius) }

// spawnAreaOf 返回第 k 扇区的出生方块（轴对齐 17×17m，含于外环带）。
func spawnAreaOf(k int) sim.Rect {
	c := sectorCenter(k)
	return rectOf(c.X, c.Y, spawnHalf, spawnHalf)
}

// genSectors 生成 8 个出生扇区：中心角 = k*45°，SpawnArea 为外环内的轴对齐
// 方块（AABB 世界无法精确表达 45° 弧段，方块为兼顾"外环 + 扇区内 + 严格
// 45° 旋转对称"的保守逼近，且比弧段外接矩形更小更安全）。
func genSectors() [8]sim.Sector {
	var out [8]sim.Sector
	for k := 0; k < 8; k++ {
		c := sectorCenter(k)
		out[k] = sim.Sector{
			ID:        uint32(k),
			SpawnArea: rectOf(c.X, c.Y, spawnHalf, spawnHalf),
			Center:    c,
		}
	}
	return out
}

// uplinkSteps 为 6 个普通 Uplink 的方向表步进（22.5°·step）。
// 取 {22.5°+k·90°} 四个加 {157.5°, 337.5°} 对径对：全部错位扇区轴 22.5°，
// 且集合整体中心对称。Uplink 集合按审核裁决不要求旋转对称。
var uplinkSteps = [6]int{1, 5, 7, 9, 13, 15}

// genUplinks 生成 6 个普通 Uplink（中环 40–45m，角度 = k*45°+22.5°，半径由
// seed 抖动）与 1 个中央主 Uplink（原点，CORE_OPEN 激活）。
func genUplinks(r *rng) []sim.UplinkDef {
	out := make([]sim.UplinkDef, 0, 7)
	for i, step := range uplinkSteps {
		d := dirAt(step)
		rad := uplinkRLo + (uplinkRHi-uplinkRLo)*r.float()
		out = append(out, sim.UplinkDef{
			ID:          uint32(i + 1),
			Pos:         d.Scale(rad),
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

// genCorePads 生成外 16 + 中 12 + 中央 6 个刷新点（seed 驱动，笛卡尔拒绝采样
// 保证全部落在目标环带内），与骨架墙、Uplink 保持净空；组内按 (x,y) 排序后
// 顺序分配 ID（canonical 顺序）。中央组坐标序前两个为 Mega Core（+25）。
func genCorePads(r *rng, skeleton []sim.Wall, uplinks []sim.UplinkDef) ([]sim.CorePadDef, error) {
	pads := make([]sim.CorePadDef, 0, padOuterN+padMidN+padCenterN)
	id := uint32(1)
	place := func(group int, lo, hi, minGap float64, want int) error {
		placed := make([]sim.Vec2, 0, want)
		for tries := 0; len(placed) < want; tries++ {
			if tries > 1000 {
				return fmt.Errorf("group %d: exhausted placement tries", group)
			}
			x, y := r.rangeF(-hi, hi), r.rangeF(-hi, hi)
			if r2 := x*x + y*y; r2 < lo*lo || r2 > hi*hi {
				continue
			}
			p := sim.Vec2{X: x, Y: y}
			if !padClear(p, minGap, placed, skeleton, uplinks) {
				continue
			}
			placed = append(placed, p)
		}
		sort.Slice(placed, func(i, j int) bool {
			if placed[i].X != placed[j].X {
				return placed[i].X < placed[j].X
			}
			return placed[i].Y < placed[j].Y
		})
		for _, p := range placed {
			pads = append(pads, sim.CorePadDef{ID: id, Pos: p, Group: group, Value: 10})
			id++
		}
		return nil
	}
	if err := place(0, 58, 76, 4.0, padOuterN); err != nil {
		return nil, err
	}
	if err := place(1, 33, 52, 4.0, padMidN); err != nil {
		return nil, err
	}
	if err := place(2, 4.5, 14, 3.0, padCenterN); err != nil {
		return nil, err
	}
	// 中央组前两个（坐标序）为 Mega Core。
	n := len(pads)
	pads[n-padCenterN].Value = 25
	pads[n-padCenterN+1].Value = 25
	return pads, nil
}

// padClear 校验候选刷新点：距已放置同组点 ≥ minGap、距骨架墙 ≥ 2.5m、
// 距 Uplink ≥ 3m。
func padClear(p sim.Vec2, minGap float64, placed []sim.Vec2, skeleton []sim.Wall, uplinks []sim.UplinkDef) bool {
	for _, q := range placed {
		if p.Sub(q).Len() < minGap {
			return false
		}
	}
	for _, w := range skeleton {
		if pointRectDist2(p, wallRect(w)) < 2.5*2.5 {
			return false
		}
	}
	for _, u := range uplinks {
		if p.Sub(u.Pos).Len() < 3.0 {
			return false
		}
	}
	return true
}
