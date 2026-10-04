// 视线墙影的精确投影几何（render.ts drawVisionMask 消费）。
// 点光源（自机）对每堵 AABB 墙独立求两个轮廓切线角点与远侧边链，构造固定
// 绕向（代数正，角点按 c0..c3 循环序）的影多边形，并沿切线方向延长到视野
// 圆之外；不做全局 corner-angle 排序，天然规避跨 ±π 的方向回绕。
//
// 分配纪律：顶点以 x,y 交错写入调用方提供的扁平数组（render 每帧复用同一
// 数组、length=0 重置），本模块零分配。同一墙需要多个子路径（自机在墙内的
// 「大框 − 墙身」结构）时以 NaN,NaN 对分隔。

export interface ShadowAABB { min: { x: number; y: number }; max: { x: number; y: number } }

/** 自机落入墙 AABB（含该 epsilon 外扩，含贴边/贴角）即视为「在墙内」。 */
const INSIDE_EPS = 1e-9

function cornerX(i: number, minx: number, maxx: number): number { return i === 0 || i === 3 ? minx : maxx }
function cornerY(i: number, miny: number, maxy: number): number { return i === 0 || i === 1 ? miny : maxy }

/**
 * 追加一堵墙的影多边形顶点（世界坐标）到 pts。
 * @returns 写入的数值个数；0 = 该墙不产生阴影（零面积 / 整体在视野圆外）。
 * 常规墙输出单一子路径共 len+2 个顶点（len∈[2,4] 为远侧链角数，链角点 +
 * 终点切线延长点 + 起点切线延长点）；自机在墙内时输出两个子路径（正向视野
 * 大框 + 逆向墙身矩形，nonzero 绕向相消使墙身保持可见），以 NaN,NaN 分隔。
 */
export function appendWallShadow(pts: number[], sx: number, sy: number, wall: ShadowAABB, range: number): number {
  const minx = wall.min.x, miny = wall.min.y, maxx = wall.max.x, maxy = wall.max.y
  const w = maxx - minx, h = maxy - miny
  // 零面积/退化（含 NaN 坐标：比较全 false）不投影。
  if (!(w > 0) || !(h > 0)) return 0

  // 影多边形整体位于远侧链之外：与墙的最近距离 ≥ 视野半径时整块在视野圆外。
  const ddx = sx < minx ? minx - sx : sx > maxx ? sx - maxx : 0
  const ddy = sy < miny ? miny - sy : sy > maxy ? sy - maxy : 0
  if (ddx * ddx + ddy * ddy >= range * range) return 0

  if (sx > minx - INSIDE_EPS && sx < maxx + INSIDE_EPS && sy > miny - INSIDE_EPS && sy < maxy + INSIDE_EPS) {
    // 自机在墙内：视野圆内除墙身外全暗 —— 正向大框 − 逆向墙身。等价旧射线法
    // 「阴影从墙出口边开始」：墙身内部保持可见，墙外一片全暗。
    const pad = range * 2.5 + Math.max(w, h)
    pts.push(sx - pad, sy - pad, sx + pad, sy - pad, sx + pad, sy + pad, sx - pad, sy + pad)
    pts.push(Number.NaN, Number.NaN)
    pts.push(minx, miny, minx, maxy, maxx, maxy, maxx, miny)
    return 18
  }

  // CCW 角点 c0..c3 = 左下/右下/右上/左上；边 e_i = c_i→c_{i+1}（下/右/上/左）。
  // 背向边（光源在其内侧半平面）：e0 下 sy>miny · e1 右 sx<maxx · e2 上 sy<maxy · e3 左 sx>minx。
  const back0 = sy > miny, back1 = sx < maxx, back2 = sy < maxy, back3 = sx > minx
  // 轮廓切线角点 = 相邻两边背向性翻转处。链起点 = 出边背向、入边迎光的角点；
  // 外部光源恒存在（角点共 4 个翻转位，成对出现），防御性兜底返回 0。
  let start = -1
  if (back0 && !back3) start = 0
  else if (back1 && !back0) start = 1
  else if (back2 && !back1) start = 2
  else if (back3 && !back2) start = 3
  if (start < 0) return 0

  // 远侧链 = 自 e_start 起的连续背向边串（可回绕跨边），链角点共 len 个。
  // 外部光源恒有 ≥2 条背向边（轴线内 3–4 条、象限内 2 条），len<2 仅在
  // 假想退化下出现，返回 0 不画零面积子路径。
  let len = 1
  let edge = start
  while (len < 4) {
    const back = edge === 0 ? back0 : edge === 1 ? back1 : edge === 2 ? back2 : edge === 3 ? back3 : false
    if (!back) break
    len++
    edge = (edge + 1) & 3
  }
  if (len < 2) return 0

  // 两个切线角点沿「光源→角点」方向延长到视野圆之外（≥2.5×视野半径），
  // 保证 clip 到视野圆后圆锥完整封闭。墙外分支保证角点距离 > 0；
  // isFinite 双保险，任何非有限坐标都不进入 Canvas 路径。
  const reach = range * 2.5 + Math.max(w, h)
  const end = (start + len - 1) & 3
  const endX = cornerX(end, minx, maxx), endY = cornerY(end, miny, maxy)
  const startX = cornerX(start, minx, maxx), startY = cornerY(start, miny, maxy)
  const edx = endX - sx, edy = endY - sy
  const sdx = startX - sx, sdy = startY - sy
  const ed = Math.hypot(edx, edy), sd = Math.hypot(sdx, sdy)
  if (!(ed > 0) || !(sd > 0) || !Number.isFinite(reach)) return 0
  const endExtX = endX + (edx / ed) * reach, endExtY = endY + (edy / ed) * reach
  const startExtX = startX + (sdx / sd) * reach, startExtY = startY + (sdy / sd) * reach
  if (!Number.isFinite(endExtX) || !Number.isFinite(endExtY) || !Number.isFinite(startExtX) || !Number.isFinite(startExtY)) return 0

  for (let k = 0; k < len; k++) {
    const idx = (start + k) & 3
    pts.push(cornerX(idx, minx, maxx), cornerY(idx, miny, maxy))
  }
  pts.push(endExtX, endExtY, startExtX, startExtY)
  return (len + 2) * 2
}
