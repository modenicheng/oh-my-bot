// 相机：跟随自机，视口固定逻辑尺寸 40m×25m 缩放到窗口（等比，letterbox 不裁切）。
// 地图大于视口时平移并钳制在地图范围内。

export const VIEW_W = 40 // 逻辑视口宽（米）
export const VIEW_H = 25 // 逻辑视口高（米）

export class Camera {
  /** 相机中心的世界坐标 */
  cx = 0
  cy = 0
  /** 画布像素尺寸 */
  cw = 0
  ch = 0
  /** 每米像素数（等比缩放，含表现层 zoom） */
  scale = 1
  private baseScale = 1
  private zoom = 1
  /** 世界钳制范围（地图外接） */
  extent = 100

  resize(canvasW: number, canvasH: number, mapExtent: number): void {
    this.cw = canvasW
    this.ch = canvasH
    this.extent = mapExtent
    this.baseScale = Math.min(canvasW / VIEW_W, canvasH / VIEW_H)
    this.scale = this.baseScale * this.zoom
  }

  /** 表现层缩放；世界/鼠标反算共享同一 scale，避免冲刺时瞄准漂移。 */
  setZoom(zoom: number): void {
    this.zoom = clamp(zoom, 0.85, 1.05)
    this.scale = this.baseScale * this.zoom
  }

  /** 跟随目标（含瞬时平滑），钳制到地图范围 */
  follow(tx: number, ty: number): void {
    // 视口世界尺寸
    const vw = this.cw / this.scale
    const vh = this.ch / this.scale
    // 地图范围（extent 为外接半径 → 边长 2*extent）
    const halfW = Math.max(0, this.extent - vw / 2)
    const halfH = Math.max(0, this.extent - vh / 2)
    this.cx = clamp(tx, -halfW, halfW)
    this.cy = clamp(ty, -halfH, halfH)
  }

  /** 世界 → 画布像素 */
  toPxX(wx: number): number { return (wx - this.cx) * this.scale + this.cw / 2 }
  toPxY(wy: number): number { return (wy - this.cy) * this.scale + this.ch / 2 }

  /** 画布像素 → 世界（鼠标 aim 反算） */
  toWorldX(px: number): number { return (px - this.cw / 2) / this.scale + this.cx }
  toWorldY(py: number): number { return (py - this.ch / 2) / this.scale + this.cy }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
