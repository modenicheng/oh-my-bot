// Package mapgen 生成 oh-my-bot 的确定性八辐轮盘地图（sim.MapDef）。
//
// 骨架拓扑固定（v0.3 §3）：8 个 45° 出生扇区（轴角 k*45°，SpawnArea 为外环
// 55–80m 内的轴对齐方块）、三环（外 55–80 / 中 30–55 / 中央 <30m）、6 个普通
// Uplink 位于中环且角度 = k*45°+22.5°、1 个中央主 Uplink（CORE_OPEN 激活）、
// 外 16 + 中 12 + 中央 6 个 CorePad。gen2 资源按环带和角度槽位抖动；
// Core 实际常驻量和补货周期按参赛机器人数量确定性缩放。掩体按分层候选
// 生成，中央两层长掩体、中环密、外环疏。全部墙体为 AABB。
//
// 墙体八楔统计对称、90° 几何对称：每个掩体原型同时盖 8 块，
// 各楔拥有相同的数量、面积和尺寸。候选整批接受或重选（净空/连通检查），
// 分层槽位不得省略；候选耗尽时返回错误。
//
// 确定性：生成路径使用整数、浮点算术/平方根及字面量方向表（零三角函数、零
// map 遍历序依赖），同 seed 必产出同 MapHash = SHA256(canonical JSON)。
package mapgen

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ---- 环带与锁区（单位米）----
//
// GeneratorVer 8 起这些不再是常量而是人数推导值（见 layoutFor）：场地线性
// 尺度 scale = max(1, sqrt(n/64))，n≤64 时恰为下列原版数值。

const (
	uplinkNormSteps = 6    // 22.5° 偏移族基础对数（n<96）
	uplinkDenseN    = 96   // n≥96 追加第 4 对径对（族在 7.5° 格点上恰好 4 对）
	packDenseN      = 96   // n≥96 血包加一圈外环带
	packWidestN     = 160  // n≥160 再加一圈
	corePeriodTick  = 1200 // Core 刷新周期下限：20s @ 60Hz，降低单人空场等待
)

// layout 承载一次生成所需的全部骨架参数，唯一入参是参赛机器人数。
// 设计原则（v0.3 §3 骨架的规模化推广）：
//   - 密度恒定：面积 ∝ 人数（线性尺度 ∝ √人数），视野内邻居数、AOI 规模、
//     单玩家快照体积与出生密度不随房间规模变化——这同时保住服务端感知/
//     编码的线性扩展与客户端渲染负载；
//   - 资源随档位增长：Pad 数按面积配额（偶数化保持对径对），血包按同心环
//     加圈，Uplink 追加对径对至格点上限 8 只（吞吐缺口由 v4 的 4s 引导
//     时间补齐）；
//   - 八辐 45° 对称、90° 旋转多重集不变、确定性生成等契约一概不动。
type layout struct {
	scale                                  float64
	outerMinR, outerMaxR, midMinR, midMaxR float64
	coreZoneR, spawnRadius, spawnHalf      float64
	uplinkRLo, uplinkRHi                   float64
	uplinkPairs                            int // 普通桩对径对数（3 或 4）
	padOuterN, padMidN, padCenterN         int
	packRadii                              []float64
}

// layoutFor 把参赛人数翻译成骨架参数。纯函数：同 participants 必产出同
// layout，配合分段盐保持「同 seed 同产出」契约。
func layoutFor(participants int) layout {
	if participants < 1 {
		participants = 1
	}
	s := math.Sqrt(float64(participants) / 64)
	if s < 1 {
		s = 1
	}
	l := layout{
		scale:       s,
		outerMinR:   55 * s,
		outerMaxR:   80 * s,
		midMinR:     30 * s,
		midMaxR:     55 * s,
		coreZoneR:   28 * s,
		spawnRadius: 67.5 * s,
		spawnHalf:   6.5 * s,
		uplinkRLo:   40 * s,
		uplinkRHi:   45 * s,
		uplinkPairs: uplinkNormSteps / 2,
		padCenterN:  evenPadCount(6, s),
		packRadii:   []float64{43 * s},
	}
	if participants >= uplinkDenseN {
		l.uplinkPairs = 4
		l.packRadii = append(l.packRadii, 57.5*s)
	}
	if participants >= packWidestN {
		l.packRadii = append(l.packRadii, 69*s)
	}
	// padTargetFloor（v9）：外/中环 pad 配额保底 ≥ TargetAlive（4+n/2）。
	// 面积配额 28/64×n 在 n≥50 后低于 TA，coreSupply 的封顶（=外+中 pad 数）
	// 会咬住，把大房人均 core 上限压到 ~26——升级点数经济随之枯竭。差额全部
	// 补到外环（周长最长、双径向轨道交错角距宽裕）；中环保留面积配额不动，
	// 贴中环 Pad 带的追加掩体层（extraCoverCells 30–49m）不因此加密。n≤49
	// 配额已达 TA，几何与 v8 逐点一致。
	l.padOuterN = evenPadCount(16, s)
	l.padMidN = evenPadCount(12, s)
	if ta := 4 + participants/2; l.padOuterN+l.padMidN < ta {
		l.padOuterN = evenPadQuota(float64(l.padOuterN)+float64(ta-l.padOuterN-l.padMidN), 16)
		if l.padOuterN+l.padMidN < ta { // 取整偶化后仍不足：成对补外环
			l.padOuterN += 2
		}
	}
	return l
}

// evenPadCount 面积配额取整并偶数化（Pad 以对径对放置，奇数会丢一只）。
func evenPadCount(base int, s float64) int {
	return evenPadQuota(float64(base)*s*s, base)
}

// evenPadQuota 对（可能被保底加成过的）配额取整并偶数化，下界为基数。
func evenPadQuota(quota float64, base int) int {
	n := int(math.Round(quota))
	if n < base {
		n = base
	}
	if n%2 == 1 {
		n++
	}
	return n
}

// extraCoverCells 大房追加掩体层的预缩放原型（半径/角度选在既有层空档）：
// 每 +0.25 线性尺度启用一层，近似保持掩体面密度（体验调参而非严格面积
// 配额——净空由 genWalls 的候选搜索保证，合法性由 golden 断点钉死）。
var extraCoverCells = []coverCell{
	{radius: 30, angle: 15, halfLen: 2.0, halfThick: coverThick / 2},
	{radius: 43, angle: 15, halfLen: 2.0, halfThick: coverThick / 2, lShape: true},
	{radius: 67, angle: 15, halfLen: 2.0, halfThick: coverThick / 2},
	{radius: 55, angle: 0, halfLen: 2.5, halfThick: coverThick / 2},
	{radius: 31, angle: 37, halfLen: 2.0, halfThick: coverThick / 2, lShape: true},
	{radius: 55, angle: 37, halfLen: 2.0, halfThick: coverThick / 2},
}

// coverCells 返回本次生成的掩体层集合：8 层基础层整体乘 scale，再按尺度
// 追加 extraCoverCells 的前 int((scale-1)/0.25) 层。追加层全部位于基础层
// 之后——innerCoverCells 索引语义（前两层允许触核）不受影响。
//
// 角向避让：Pad 径向带与掩体层天然重叠，共存靠角度错位（原版 12/16 只
// Pad 的半槽角 ~11°）。Pad 数量随面积增长后槽角收窄、会压到掩体角度族，
// 因此超基础档时把中/外环掩体角度吸附到「相邻 Pad 组的槽边界」——即两
// 只 Pad 的正中间，恢复半槽错位。同径向组内还须互相错开（mod 45 ≥ 半槽
// 角，防止两族吸附到同一槽边界跨 45° 接缝相撞），候选取原角度两侧最近
// 的两个槽边界、择组内间隔更大者。n≤64（基础档位）不吸附，几何冻结。
func (l layout) coverCells() []coverCell {
	s := l.scale
	midSlot, outSlot := 360.0/float64(l.padMidN), 360.0/float64(l.padOuterN)
	snapMid, snapOut := l.padMidN > 12, l.padOuterN > 16
	var midChosen, outChosen []float64
	snap := func(angle, slot float64, enabled bool, chosen *[]float64) float64 {
		if !enabled {
			return angle
		}
		wedgeDist := func(a, b float64) float64 {
			d := math.Mod(math.Abs(a-b), 45)
			if d > 22.5 {
				d = 45 - d
			}
			return d
		}
		floor := math.Floor(angle / slot)
		best, bestScore := angle, -1.0
		for _, k := range [2]float64{floor, floor + 1} {
			cand := math.Mod(k*slot, 360)
			score := 22.5
			for _, c := range *chosen {
				if d := wedgeDist(cand, c); d < score {
					score = d
				}
			}
			// 先比组内间隔；同分取更贴近原角度者（确定性）。
			if score > bestScore+1e-9 || (math.Abs(score-bestScore) <= 1e-9 && bestScore >= 0 && math.Abs(cand-angle) < math.Abs(best-angle)) {
				best, bestScore = cand, score
			}
		}
		*chosen = append(*chosen, best)
		return best
	}
	base := []coverCell{
		{radius: 19.5 * s, angle: 0, halfLen: 2.5, halfThick: coverThick / 2},    // inner ring: 5m cover, axis-aligned per wedge family
		{radius: 24.0 * s, angle: 22.5, halfLen: 3.0, halfThick: coverThick / 2}, // inner ring: 6m offset cover near the lock boundary
		{radius: 36 * s, angle: snap(8, midSlot, snapMid, &midChosen), halfLen: 2.0, halfThick: coverThick / 2},
		{radius: 36 * s, angle: snap(37, midSlot, snapMid, &midChosen), halfLen: 2.0, halfThick: coverThick / 2, lShape: true}, // inner-mid L stratum
		{radius: 49 * s, angle: snap(8, midSlot, snapMid, &midChosen), halfLen: 2.0, halfThick: coverThick / 2, lShape: true},  // outer-mid L stratum
		{radius: 49 * s, angle: snap(37, midSlot, snapMid, &midChosen), halfLen: 2.0, halfThick: coverThick / 2},
		{radius: 60 * s, angle: snap(22.5, outSlot, snapOut, &outChosen), halfLen: 2.0, halfThick: coverThick / 2},
		{radius: 75 * s, angle: snap(22.5, outSlot, snapOut, &outChosen), halfLen: 2.0, halfThick: coverThick / 2},
	}
	for i := 0; i < int((s-1)/0.25) && i < len(extraCoverCells); i++ {
		e := extraCoverCells[i]
		e.radius *= s
		// 30–49m 的追加层贴中环 Pad 带，52m+ 贴外环 Pad 带。
		if e.radius < 52*s {
			e.angle = snap(e.angle, midSlot, snapMid, &midChosen)
		} else {
			e.angle = snap(e.angle, outSlot, snapOut, &outChosen)
		}
		base = append(base, e)
	}
	return base
}

// GeneratorVer 是 mapgen 算法版本；布局算法任何变更必须递增。
// 8：人数自适应骨架（场地/资源随 participants 缩放，MapDef.ArenaRadius 进图）。
// 9：外/中环 pad 配额保底 ≥ TargetAlive——升级玩法（ADR-0016）的点数经济
//
//	在大房不被 pad 面积配额封顶；n≤49 配额已达 TA，几何与 v8 完全一致。
const GeneratorVer = 9

// 分段盐：各生成阶段使用独立随机流，避免阶段间拒绝采样纠缠。
const (
	saltUplinks uint64 = 0xD1B54A327F6109C3
	saltPads    uint64 = 0x6A2E88C041D7B5A4
	saltWalls   uint64 = 0x9F03C2D15E47A8B0
)

// Uplink 交互半径是玩家尺度，不随场地缩放。
const (
	normInteractR = 2.5 // 普通 Uplink 交互半径（v0.3 §6）
	mainInteractR = 3.0 // 主 Uplink 交互半径
)

// Generate 为单人/工具调用生成地图；真实对局用 GenerateForPlayers 将场上
// 人数编码进骨架与 Core 供给规则。两者都只依赖显式参数，保持可回放确定性。
func Generate(seed uint64) (*sim.MapDef, error) { return GenerateForPlayers(seed, 1) }

// GenerateForPlayers 按 seed 与完整参赛机器人数量生成确定性 MapDef：人数自
// 适应骨架 + Core 供给 + seed 驱动布局。产出前经双模式 BFS 连通验证。
func GenerateForPlayers(seed uint64, participants int) (*sim.MapDef, error) {
	l := layoutFor(participants)
	uplinks := genUplinks(newRng(seed^saltUplinks), l)
	pads := genCorePads(newRng(seed^saltPads), l)
	healthPacks := genHealthPacks(l)
	walls, err := genWalls(newRng(seed^saltWalls), l, uplinks, pads, healthPacks)
	if err != nil {
		return nil, fmt.Errorf("mapgen: walls: %w", err)
	}

	period, target := coreSupply(participants, l.padOuterN, l.padMidN)
	def := &sim.MapDef{
		Version:      1,
		GeneratorVer: GeneratorVer,
		Seed:         seed,
		ArenaRadius:  l.outerMaxR,
		Walls:        walls,
		Sectors:      l.genSectors(),
		Uplinks:      uplinks,
		HealthPacks:  healthPacks,
		CorePads:     pads,
		CoreZone: sim.CoreZoneDef{
			Radius:      l.coreZoneR,
			UnlockPhase: sim.PhaseCoreOpen,
		},
		CoreRules: sim.CoreRulesDef{
			PeriodTicks: period,
			TargetAlive: target,
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

// coreSupply 保持单人也有 4 个目标可选；之后约每 2 名机器人增加 1 个
// 常驻 Core，封顶 = 锁区关闭时可用的外/中环 Pad 总数（随人数缩放）。
// 高人数房间缩短补货周期，但不使用墙钟或在线状态：
// 参数被写入 MapDef/回放，重放时完全复现。
func coreSupply(participants, padsOuter, padsMid int) (periodTicks, targetAlive int) {
	if participants < 1 {
		participants = 1
	}
	targetAlive = 4 + (participants-1+1)/2
	if cap := padsOuter + padsMid; targetAlive > cap {
		targetAlive = cap
	}
	switch {
	case participants >= 40:
		periodTicks = 8 * sim.TickRate
	case participants >= 24:
		periodTicks = 10 * sim.TickRate
	case participants >= 12:
		periodTicks = 12 * sim.TickRate
	case participants >= 5:
		periodTicks = 15 * sim.TickRate
	default:
		periodTicks = corePeriodTick
	}
	return periodTicks, targetAlive
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
func (l layout) sectorCenter(k int) sim.Vec2 { return dirAt(6 * k).Scale(l.spawnRadius) }

// spawnArea 返回第 k 扇区的出生方块（轴对齐，四角全部落在外环带内且不越出
// 相邻扇区界；等比缩放下该不变式保持成立——半径与半边长同乘 scale）。
// AABB 世界无法精确表达 45° 弧段；方块是"外环 + 扇区内 + 8 重旋转一致"的
// 保守逼近。
func (l layout) spawnArea(k int) rect {
	c := l.sectorCenter(k)
	return rect{MinX: c.X - l.spawnHalf, MinY: c.Y - l.spawnHalf, MaxX: c.X + l.spawnHalf, MaxY: c.Y + l.spawnHalf}
}

// genSectors 生成 8 个出生扇区：中心角 = k*45°，SpawnArea 为外环内方块。
func (l layout) genSectors() [8]sim.Sector {
	var out [8]sim.Sector
	for k := 0; k < 8; k++ {
		c := l.sectorCenter(k)
		out[k] = sim.Sector{
			ID: uint32(k),
			SpawnArea: sim.Rect{
				Min: sim.Vec2{X: c.X - l.spawnHalf, Y: c.Y - l.spawnHalf},
				Max: sim.Vec2{X: c.X + l.spawnHalf, Y: c.Y + l.spawnHalf},
			},
			Center: c,
		}
	}
	return out
}

// uplinkStepPairs 为普通 Uplink 的对径对（7.5°/步）：22.5° 偏移族在 48 格
// 点上恰有 4 对。基础 3 对（n<96，与旧算法逐位一致）；n≥96 启用第 4 对。
// 同一对共享半径，集合保持中心对称；ID 按角度升序编号。
var uplinkStepPairs = [4][2]int{{3, 27}, {9, 33}, {15, 39}, {21, 45}}

// uplinkStepsFor 展开前 pairs 个对径对并按角度升序排序（n 小于 6 只时与
// 旧版 {3,9,15,27,33,39} 逐位一致）。
func uplinkStepsFor(pairs int) []int {
	steps := make([]int, 0, pairs*2)
	for p := 0; p < pairs; p++ {
		steps = append(steps, uplinkStepPairs[p][0], uplinkStepPairs[p][1])
	}
	for i := 1; i < len(steps); i++ {
		for j := i; j > 0 && steps[j] < steps[j-1]; j-- {
			steps[j], steps[j-1] = steps[j-1], steps[j]
		}
	}
	return steps
}

// genUplinks 生成普通 Uplink（中环 40–45m·s；同一直径对共享半径，使集合
// 保持中心对称）与 1 个中央主 Uplink（原点，CORE_OPEN 激活）。
// ID：普通桩按角度升序，主桩最后。
func genUplinks(r *rng, l layout) []sim.UplinkDef {
	steps := uplinkStepsFor(l.uplinkPairs)
	count := len(steps)
	radii := make([]float64, l.uplinkPairs)
	for i := range radii {
		radii[i] = r.rangeF(l.uplinkRLo, l.uplinkRHi)
	}
	out := make([]sim.UplinkDef, 0, count+1)
	for i, step := range steps {
		out = append(out, sim.UplinkDef{
			ID:          uint32(i + 1),
			Pos:         dirAt(step).Scale(radii[i%l.uplinkPairs]),
			InteractR:   normInteractR,
			ActivePhase: sim.PhaseOuterRing,
		})
	}
	out = append(out, sim.UplinkDef{
		ID:          uint32(count + 1),
		Pos:         sim.Vec2{},
		Main:        true,
		InteractR:   mainInteractR,
		ActivePhase: sim.PhaseCoreOpen,
	})
	return out
}

// genHealthPacks 在对角族（45°+90k）上按同心环放置血包：基础 1 圈 4 只，
// n≥96 两圈 8 只，n≥160 三圈 12 只。环半径选在中环/外环的资源空档带上，
// 与 Pad 带、Uplink 带（角度差 22.5°）保持净空。
func genHealthPacks(l layout) []sim.HealthPackDef {
	out := make([]sim.HealthPackDef, 0, 4*len(l.packRadii))
	id := 1
	for _, radius := range l.packRadii {
		diag := radius / math.Sqrt2
		for _, pos := range [4]sim.Vec2{{X: diag, Y: diag}, {X: -diag, Y: diag}, {X: -diag, Y: -diag}, {X: diag, Y: -diag}} {
			out = append(out, sim.HealthPackDef{ID: uint32(id), Pos: pos})
			id++
		}
	}
	return out
}

// genCorePads fills every angular slot, with bounded jitter of ±10% of its
// width. Outer/mid slots alternate inner and outer radial tracks. Antipodal
// pairs share jitter, preserving central fairness without rejection holes.
// Track separation also keeps pads at least 3m from the uplink band; counts
// scale with the room size (area quota, even for antipodal pairing).
func genCorePads(r *rng, l layout) []sim.CorePadDef {
	counts := [3]int{l.padOuterN, l.padMidN, l.padCenterN}
	s := l.scale
	bands := [3][2][2]float64{{{60 * s, 63 * s}, {72 * s, 75 * s}}, {{33 * s, 36 * s}, {49 * s, 52 * s}}, {{10 * s, 14 * s}, {10 * s, 14 * s}}}
	pads := make([]sim.CorePadDef, 0, counts[0]+counts[1]+counts[2])
	for group, count := range counts {
		placed := make([]sim.Vec2, 0, count)
		for i := 0; i < count/2; i++ {
			band := bands[group][i%2]
			step := (float64(i) + 0.5 + r.rangeF(-0.1, 0.1)) * dirCount / float64(count)
			p := slotDirection(step).Scale(r.rangeF(band[0], band[1]))
			placed = append(placed, p, p.Scale(-1))
		}
		sortVec2(placed)
		for _, p := range placed {
			pads = append(pads, sim.CorePadDef{ID: uint32(len(pads) + 1), Pos: p, Group: group, Value: 10})
		}
	}
	pads[len(pads)-l.padCenterN].Value = 25
	pads[len(pads)-l.padCenterN+1].Value = 25
	return pads
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
