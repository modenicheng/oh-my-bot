// 冲刺拖尾层（C-17 拆分自 feedback.ts）：按机器人记录采样点，随 tick 老化淡出。
import type { Camera } from '../camera'
import type { MapVec2 } from '../mapdef'
import type { TrailPoint } from './types'

/** 拖尾采样保留窗口（tick）：alpha 在窗口内线性衰减。 */
const TRAIL_TICKS = 15
/** 尺寸保留窗口略长于 alpha 窗口（收尾方块先淡后缩）。 */
const TRAIL_TAIL_TICKS = TRAIL_TICKS * 1.4
const TRAIL_ALPHA = 0.42
const TRAIL_WIDTH_SCALE = 0.42
const TRAIL_MIN_SIZE = 4

export class Trails {
  private byRobot = new Map<number, TrailPoint[]>()

  constructor(private readonly reduced: MediaQueryList) {}

  /** 记录本 tick 采样点（同 tick 去重）并裁剪过期点。 */
  record(id: number, tick: number, pos: MapVec2, color: string): void {
    const trail = this.byRobot.get(id) ?? []
    const last = trail[trail.length - 1]
    if (!last || last.tick !== tick) trail.push({ pos: { x: pos.x, y: pos.y }, tick, color })
    while (trail.length && trail[0]!.tick < tick - TRAIL_TICKS) trail.shift()
    this.byRobot.set(id, trail)
  }

  drop(id: number): void { this.byRobot.delete(id) }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, tick: number): void {
    if (this.reduced.matches) return
    ctx.save()
    for (const trail of this.byRobot.values()) {
      for (let i = 0; i < trail.length; i++) {
        const point = trail[i]!, age = Math.max(0, tick - point.tick)
        if (age > TRAIL_TICKS) continue
        const x = cam.toPxX(point.pos.x), y = cam.toPxY(point.pos.y)
        const alpha = (1 - age / TRAIL_TICKS) * (i + 1) / trail.length * TRAIL_ALPHA
        const size = Math.max(TRAIL_MIN_SIZE, cam.scale * TRAIL_WIDTH_SCALE * (1 - age / TRAIL_TAIL_TICKS))
        ctx.globalAlpha = alpha; ctx.strokeStyle = point.color; ctx.lineWidth = 1
        ctx.strokeRect(Math.round(x - size), Math.round(y - size), Math.round(size * 2), Math.round(size * 2))
      }
    }
    ctx.restore()
  }

  /** 静默判定（纯查询）：是否仍有可见（未过 alpha 窗口）的拖尾点。 */
  visible(tick: number): boolean {
    for (const trail of this.byRobot.values()) {
      for (const point of trail) if (tick - point.tick <= TRAIL_TICKS) return true
    }
    return false
  }

  clear(): void { this.byRobot.clear() }
}
