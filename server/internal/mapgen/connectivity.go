package mapgen

import "fmt"

// 连通性验证常量。
const (
	gridExtent = 80.0 // 网格覆盖 [-80,80]×[-80,80]（160×160m 参考）
	gridN       = 160 // 每轴格数 → 格边 1m（任务规格）
	agentR      = 0.6 // 机器人半径（膨胀判定，与 sim.RobotRadius 一致）
)

// connectivityOK 在 1m 网格上做 4-邻接 BFS，验证两种模式都全图连通：
//
//   - OUTER_RING：中央锁区（r=28.6=28+0.6）视为障碍；
//   - CORE_OPEN：锁区开放。
//
// "连通"定义：所有自由格子（含出生方块中心、全部 Uplink 位置、全部 CorePad
// 位置所在的格子）从任一自由格出发可达。墙按机器人半径膨胀后光栅化。
func connectivityOK(walls []wallLike, uplinks []ptLike, pads []ptLike) bool {
	return connected(walls, false) && connected(walls, true)
}

type wallLike = interface{}
type ptLike = interface{}

// connected 光栅化 + BFS。coreOpen=true 时中央锁区不作障碍。
func connected(walls []wallLike, coreOpen bool) bool {
	n := gridN + 2 // 哨兵边界：四周留一圈墙，免越界判断
	blocked := make([]bool, n*n)
	mark := func(gx, gy int) {
		if gx >= 0 && gx < n && gy >= 0 && gy < n {
			blocked[gy*n+gx] = true
		}
	}
	// 光栅化：墙膨胀 agentR 后覆盖的格子全部标 blocked。
	for _, w := range walls {
		minX := w.(rectProvider).rectMinX() - agentR
		_ = minX
	}
	_ = mark
	_ = coreOpen
	return false // TODO
}

type rectProvider interface {
	rectMinX() float64
}

var _ = fmt.Sprintf
