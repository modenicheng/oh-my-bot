// 撞击可见性判定（C-17 拆分自 feedback.ts，纯函数）：事件为全房间广播；
// 颜色元数据不能使视野外或掩体后的撞击凭空可见。
import type { MapDefParsed, MapVec2 } from '../mapdef'
import type { WorldState } from '../world'

/** 距离上限：已知弹丸（视野内射出）放宽到 32，否则 20。 */
const IMPACT_SIGHT_RANGE = 32
const IMPACT_KNOWN_RANGE = 20
/** 截短射线末端：撞击墙体近表面本身不应成为遮挡。 */
const WALL_TRACE_END = 0.03
const PARALLEL_EPS = 1e-8

export function visibleImpact(at: MapVec2, world: WorldState, map: MapDefParsed, projectileId: number): boolean {
  const self = world.robots.get(world.self?.robotId ?? 0)?.base?.pos
  if (!self) return false
  const dx = at.x - self.x, dy = at.y - self.y, distance = Math.hypot(dx, dy)
  const knownProjectile = world.projectiles.get(projectileId)
  if (distance > IMPACT_SIGHT_RANGE || (distance > IMPACT_KNOWN_RANGE && !knownProjectile)) return false
  const end = Math.max(0, 1 - WALL_TRACE_END / Math.max(distance, WALL_TRACE_END))
  for (const wall of map.walls) {
    // 标量化两轴 slab 测试，语义与原数组解构版一致（平行且在外 → 不遮挡该墙）。
    let enter = 0, exit = end
    let parallelOutside = false
    if (dx > -PARALLEL_EPS && dx < PARALLEL_EPS) {
      if (self.x < wall.min.x || self.x > wall.max.x) parallelOutside = true
    } else {
      const a = (wall.min.x - self.x) / dx, b = (wall.max.x - self.x) / dx
      enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b))
    }
    if (!parallelOutside) {
      if (dy > -PARALLEL_EPS && dy < PARALLEL_EPS) {
        if (self.y < wall.min.y || self.y > wall.max.y) parallelOutside = true
      } else {
        const a = (wall.min.y - self.y) / dy, b = (wall.max.y - self.y) / dy
        enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b))
      }
      if (enter <= exit) return false
    }
  }
  return true
}
