// Package mapgen 生成 oh-my-bot 的确定性八辐轮盘地图（MapDef）。
//
// 骨架拓扑永不变化（v0.3 §3）：8 个 45° 出生扇区、三环（外 55–80m /
// 中 30–55m / 中央 <30m）、6 个普通 Uplink 错位扇区轴 22.5°、中央主 Uplink、
// 外 16 + 中 12 + 中央 6 个 CorePad。骨架内的墙段、掩体、刷新点布局按种子
// 随机生成。墙全部为 AABB，按 45° 旋转对称（绕原点旋转 90° 后集合不变），
// 保证八辐骨架的拓扑公平性；同 seed 必产出同 MapHash（SHA256 canonical JSON）。
package mapgen

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// 环半径边界（米）——与设计基准 v0.3 §3 对齐。
const (
	outerMinR = 55.0 // 外环内边界
	outerMaxR = 80.0 // 外环外边界
	midMinR   = 30.0 // 中环内边界
	midMaxR   = 55.0 // 中环外边界（= outerMinR）
	coreMaxR  = 30.0 // 中央核心区边界（锁区半径）
)

// 锁区与主桩常量。
const (
	coreZoneR = 28.0 // 中央锁区半径（<30m）
	mainUplinkR = 6.0 // 主 Uplink 距原点（<10m）
	uplinkMidR  = 42.5 // 普通 Uplink 距原点（中环带 40–45m）
	uplinkRBase = 40.0 // 普通 Uplink 半径随机下界
	uplinkRSpan = 5.0  // 普通 Uplink 半径随机跨度（40–45m）
	mainInteractR = 3.0 // 主 Uplink 交互半径
	normInteractR = 2.5 // 普通 Uplink 交互半径（v0.3 §6）
)

// 墙体常量（米）。
const (
	gateLen        = 14.0 // 环向闸门墙半长（总长 28m）
	gateThick      = 1.5  // 闸门墙厚
	coverLen       = 2.0  // 掩体半长（4m）
	coverThick     = 0.8  // 掩体厚
	clearance      = 3.0  // 刷墙最小净空半径（出生点/桩/pad 周围）
	ringRoadHalf   = 10.0 // 外环道路保留半宽（无墙带，保证出生区到中环畅通）
)

// CoreRules 数值（任务规格）。
const (
	corePeriodTicks = 1800 // 30s @ 60Hz
)

// GeneratorVer 是 mapgen 算法版本；布局算法变更时必须递增。
const GeneratorVer = 1

// Generate 按 seed 生成确定性地图。骨架（扇区/Uplink 角度/锁区/规则）固定，
// 墙与 CorePad 布局由 seed 驱动。返回的 MapDef 已含 MapHash。
func Generate(seed uint64) (*sim.MapDef, error) {
	r := newRng(seed)

	walls, err := genWalls(r)
	if err != nil {
		return nil, fmt.Errorf("mapgen: walls: %w", err)
	}

	sectors := genSectors()
	uplinks := genUplinks(r)
	pads := genCorePads(r)

	def := &sim.MapDef{
		Version:      1,
		GeneratorVer: GeneratorVer,
		Seed:         seed,
		Walls:        walls,
		Sectors:      sectors,
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

// hashDef 计算 MapDef 的内容哈希：MapHash 字段置空后 canonical JSON
// （定长字段有序 + 切片按既定顺序生成）的 SHA256 hex。
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

// genSectors 生成 8 个出生扇区：中心角 = k*45°，SpawnArea 为外环 55–80m
// 内约 45° 弧段的轴对齐包围盒。k=0 朝 +X，逆时针。
func genSectors() [8]sim.Sector {
	var sectors [8]sim.Sector
	for k := 0; k < 8; k++ {
		cos, sin := cosSin(k * 45.0)
		cx, cy := cos*(outerMinR+outerMaxR)/2, sin*(outerMinR+outerMaxR)/2
		// 弧段 AABB：内外边界与两条径向边的外接矩形，向中心角收缩 25%
		// 避免相邻扇区 SpawnArea 重叠。
		in, out := outerMinR+3, outerMaxR-3
		x0, x1 := in*cos, out*cos
		y0, y1 := in*sin, out*sin
		shrink := 0.25
		lo := sim.Vec2{min(x0, x1), min(y0, y1)}
		hi := sim.Vec2{max(x0, x1), max(y0, y1)}
		mid := sim.Vec2{(lo.X + hi.X) / 2, (lo.Y + hi.Y) / 2}
		w, h2 := hi.X-lo.X, hi.Y-lo.Y
		lo = sim.Vec2{mid.X - w*(1-shrink)/2, mid.Y - h2*(1-shrink)/2}
		hi = sim.Vec2{mid.X + w*(1-shrink)/2, mid.Y + h2*(1-shrink)/2}
		sectors[k] = sim.Sector{
			ID:        uint32(k),
			SpawnArea: sim.Rect{Min: lo, Max: hi},
			Center:    sim.Vec2{cx, cy},
		}
	}
	return sectors
}

// genUplinks 生成 6 个普通 Uplink（中环 40–45m，角度 = k*45°+22.5° 选 6 个）
// 与 1 个中央主 Uplink（<10m，ActivePhase=CORE_OPEN）。
// 为公平起见 6 个角度取 k*45°+22.5° (k=0..7) 的 6 个，跳过两个对称位置。
func genUplinks(r *rng) []sim.UplinkDef {
	uplinks := make([]sim.UplinkDef, 0, 7)
	// 6 个普通桩：角度 22.5° + k*60° 均匀分布（6 个错位轴恰好互不重合，
	// 且都不与扇区轴 k*45° 对齐——最小差 7.5°）。
	ids := r.perm6()
	for i := 0; i < 6; i++ {
		ang := 22.5 + float64(i)*60.0
		rad := uplinkRBase + uplinkRSpan*r.float()
		cos, sin := cosSin(ang)
		uplinks = append(uplinks, sim.UplinkDef{
			ID:          ids[i],
			Pos:         sim.Vec2{rad * cos, rad * sin},
			Main:        false,
			InteractR:   normInteractR,
			ActivePhase: sim.PhaseOuterRing,
		})
	}
	// 中央主桩。
	uplinks = append(uplinks, sim.UplinkDef{
		ID:          ids[6],
		Pos:         sim.Vec2{mainUplinkR, 0},
		Main:        true,
	 uplinkR:      0, // placeholder removed
		InteractR:   mainInteractR,
		ActivePhase: sim.PhaseCoreOpen,
	})
	return uplinks
}

// perm6 返回 1..7 的随机排列（7 个 uplink ID）。
func (r *rng) perm6() []uint32 {
	const n = 7
	a := make([]uint32, n)
	for i := range a {
		a[i] = uint32(i + 1)
	}
	for i := n - 1; i > 0; i-- {
		j := r.intn(i + 1)
		a[i], a[j] = a[j], a[i]
	}
	return a
}

// genCorePads 生成外 16 + 中 12 + 中央 6 个确定性刷新点。
// Group 0=outer / 1=mid / 2=center。Value：普通 +10；中央组含 2 个 Mega +25。
func genCorePads(r *rng) []sim.CorePadDef {
	pads := make([]sim.CorePadDef, 0, 34)
	id := uint32(1)
	// 外环 16：55–80m，随机角度。
	for i := 0; i < 16; i++ {
		ang := 360.0 * r.float()
		rad := outerMinR + 5 + (outerMaxR-outerMinR-10)*r.float()
		cos, sin := cosSin(ang)
		pads = append(pads, sim.CorePadDef{ID: id, Pos: sim.Vec2{rad * cos, rad * sin}, Group: 0, Value: 10})
		id++
	}
	// 中环 12：30–55m。
	for i := 0; i < 5; i++ {
		ang := 360.0 * r.float()
		rad := midMinR + 5 + (midMaxR-midMinR-10)*r.float()
		c strictly, sin := cosSin(ang)
		pads = append(pads, sim.CorePadDef{ID: id, SetPos: sim.Vec2{rad * cos, rad * sin}, Group: 1, Value: 10})
		id++
	}
	return pads
}

// cosSin 由角度（度）返回 (cos, sin)。
func cosSin(deg float64) (float64, float64) {
	rad := deg * math.Pi / 180.0
	return math.Cos(rad), math.Sin(rad)
}

// min/max 在 Go 1.21+ 为内建。
