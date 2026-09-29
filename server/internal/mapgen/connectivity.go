package mapgen

import (
	"math"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// BFS 连通性验证常量。
const (
	gridExtent = 80.0 // 网格覆盖 [-80,80]²（160×160m 参考）
	gridN      = 160  // 每轴格数 → 格边 1m（任务规格）
	agentR     = 0.6  // 机器人半径（墙膨胀，与 sim.RobotRadius 一致）
)

// gridIndex 返回世界坐标 v 对应的网格列（含哨兵偏移：格 gx 覆盖
// [gx-81, gx-80)，格心 gx-80.5；gx=0 与 gx=n-1 为永久封锁的哨兵圈）。
func gridIndex(v float64) int { return int(math.Floor(v+gridExtent)) + 1 }

// gridFor 光栅化墙集合（按 agentR 膨胀、保守过堵）为 n×n blocked 网格。
// coreOpen=false 时中央锁区（coreZoneR+agentR）也光栅化为障碍。
func gridFor(walls []sim.Wall, coreOpen bool) ([]bool, int) {
	n := gridN + 2
	blocked := make([]bool, n*n)
	set := func(ix, iy int) {
		if uint(ix) < uint(n) && uint(iy) < uint(n) {
			blocked[iy*n+ix] = true
		}
	}
	for i := 0; i < n; i++ { // 哨兵边界圈。
		set(i, 0)
		set(i, n-1)
		set(0, i)
		set(n-1, i)
	}
	for _, w := range walls {
		x0, x1 := gridIndex(w.Min.X-agentR), gridIndex(w.Max.X+agentR)
		y0, y1 := gridIndex(w.Min.Y-agentR), gridIndex(w.Max.Y+agentR)
		for gx := x0; gx <= x1; gx++ {
			for gy := y0; gy <= y1; gy++ {
				set(gx, gy)
			}
		}
	}
	if !coreOpen {
		rr := (coreZoneR + agentR) * (coreZoneR + agentR)
		for gx := 1; gx < n-1; gx++ {
			cx := float64(gx) - 0.5 - gridExtent
			for gy := 1; gy < n-1; gy++ {
				cy := float64(gy) - 0.5 - gridExtent
				if cx*cx+cy*cy <= rr {
					set(gx, gy)
				}
			}
		}
	}
	return blocked, n
}

// connectivityOK 验证两种阶段模式下全图自由格连通：
//
//   - OUTER_RING：中央锁区（28.6m）为额外障碍（环带必须整体连通）；
//   - CORE_OPEN：锁区开放（全图连通）。
//
// 墙按机器人半径膨胀后保守光栅化（多堵不漏堵），4-邻接 BFS，从首个自由格
// 扩散须覆盖全部自由格。出生方块/Uplink/CorePad 周围净空 ≥ 2.2m（见
// genWalls/genCorePads），其格必自由，故"全部自由格连通"即蕴含全部 POI
// 可达。
func connectivityOK(walls []sim.Wall) bool {
	return connectedGrid(walls, false) && connectedGrid(walls, true)
}

// connectedGrid 在指定模式下做 4-邻接 BFS，返回全部自由格是否彼此可达。
func connectedGrid(walls []sim.Wall, coreOpen bool) bool {
	blocked, n := gridFor(walls, coreOpen)
	visited := make([]bool, n*n)
	queue := make([]int, 0, n*n)
	for i, b := range blocked {
		if !b {
			queue = append(queue, i)
			visited[i] = true
			break
		}
	}
	for head := 0; head < len(queue); head++ {
		i := queue[head]
		x, y := i%n, i/n
		if x > 0 && !blocked[i-1] && !visited[i-1] {
			visited[i-1] = true
			queue = append(queue, i-1)
		}
		if x < n-1 && !blocked[i+1] && !visited[i+1] {
			visited[i+1] = true
			queue = append(queue, i+1)
		}
		if y > 0 && !blocked[i-n] && !visited[i-n] {
			visited[i-n] = true
			queue = append(queue, i-n)
		}
		if y < n-1 && !blocked[i+n] && !visited[i+n] {
			visited[i+n] = true
			queue = append(queue, i+n)
		}
	}
	for i, b := range blocked {
		if !b && !visited[i] {
			return false
		}
	}
	return true
}
