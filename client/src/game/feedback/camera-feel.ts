// 相机手感层（C-17 拆分自 feedback.ts）：击毁震屏与 dash/hack 变焦。
// cameraShake 每次返回新对象、cameraZoom 每 tick 只推进一步（C-4 缓存）均为冻结契约。
/** 震屏持续 tick 数与方向表（种子取模轮转四象限）。 */
const CAMERA_SHAKE_TICKS = 16
const CAMERA_SHAKE_X = 8
const CAMERA_SHAKE_Y = 6
const CAMERA_SHAKE_DIRECTIONS = [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const
/** 变焦目标：dash 轻拉近、hack 略拉远。 */
const ZOOM_DASH_TARGET = 0.92
const ZOOM_HACK_TARGET = 0.96
/** 每 tick 指数混合系数（越大收敛越快）：dash/hack/常态三档。 */
const ZOOM_DASH_BLEND = 0.64
const ZOOM_HACK_BLEND = 0.82
const ZOOM_NORMAL_BLEND = 0.78
/** 收敛判定（静默门用）：与目标距离小于该值后视作静止。 */
const ZOOM_SETTLED_EPS = 0.0005

export class CameraFeel {
  private shake: { tick: number; seed: number } | undefined
  private dashZoom = { value: 1, tick: 0 }
  /** cameraZoom 每 tick 只推进一步（C-4）：记录已缓存的 tick，undefined 表示尚未推进过。 */
  private zoomAtTick: number | undefined
  private zoomSettled = true

  constructor(private readonly reduced: MediaQueryList) {}

  /** 自机被击毁：以击杀事件为种子起振。 */
  jolt(tick: number, seed: number): void { this.shake = { tick, seed } }

  /** 重生等场景立即静止。 */
  calm(): void { this.shake = undefined }

  /** 冻结契约：每次调用返回新对象；过期即在调用中清除。 */
  shakeAt(tick: number): { x: number; y: number } {
    if (this.reduced.matches) return { x: 0, y: 0 }
    let x = 0, y = 0
    const shake = this.shake
    if (shake) {
      const age = Math.max(0, tick - shake.tick)
      if (age >= CAMERA_SHAKE_TICKS) this.shake = undefined
      else {
        const decay = 1 - age / CAMERA_SHAKE_TICKS
        const direction = CAMERA_SHAKE_DIRECTIONS[Math.abs(shake.seed + age) % CAMERA_SHAKE_DIRECTIONS.length]!
        x += Math.round(direction[0] * CAMERA_SHAKE_X * decay); y += Math.round(direction[1] * CAMERA_SHAKE_Y * decay)
      }
    }
    return { x, y }
  }

  zoomAt(tick: number, dashing: boolean, hacking = false): number {
    if (this.reduced.matches) { this.zoomSettled = true; return 1 }
    // rAF drawFrame 与 60Hz sampleAndSend 同 tick 各调一次（C-4）：同 tick 返回
    // 缓存，每 tick 只推进一步，收敛速度不随刷新率变化（此前 144Hz≈204 步/s）。
    if (this.zoomAtTick === tick) return this.dashZoom.value
    const elapsed = Math.max(1, Math.min(6, tick - this.dashZoom.tick || 1))
    const target = dashing ? ZOOM_DASH_TARGET : hacking ? ZOOM_HACK_TARGET : 1
    const base = dashing ? ZOOM_DASH_BLEND : hacking ? ZOOM_HACK_BLEND : ZOOM_NORMAL_BLEND
    const blend = 1 - Math.pow(base, elapsed)
    this.dashZoom.value += (target - this.dashZoom.value) * blend
    this.dashZoom.tick = tick
    this.zoomAtTick = tick
    this.zoomSettled = Math.abs(this.dashZoom.value - target) < ZOOM_SETTLED_EPS
    return this.dashZoom.value
  }

  /** 静默判定（纯查询，不清除）：震屏是否仍在持续窗口内。 */
  shaking(tick: number): boolean {
    return !!this.shake && tick - this.shake.tick < CAMERA_SHAKE_TICKS
  }

  /** 静默判定：变焦是否已收敛（跳帧期间 zoom 不再推进，未收敛必须逐帧）。 */
  get settled(): boolean { return this.zoomSettled }

  reset(): void {
    this.shake = undefined
    this.dashZoom = { value: 1, tick: 0 }
    this.zoomAtTick = undefined
    this.zoomSettled = true
  }
}
