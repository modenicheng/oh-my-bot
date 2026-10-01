// Read-only navigation over arena frames. No session, protocol or gameplay input.
import { Camera } from '../game/camera'

export class SpectatorCamera {
  readonly camera = new Camera()
  followId: number | null = null
  zoom = 1
  private fitScale = 1
  private overview = true

  resize(width: number, height: number, extent: number): void {
    this.camera.resize(width, height, extent)
    this.fitScale = Math.min(width, height) / (extent * 2 + 10)
    this.camera.scale = this.fitScale * this.zoom
    if (this.overview) this.fit()
  }

  fit(): void {
    this.followId = null
    this.overview = true
    this.zoom = 1
    this.camera.scale = this.fitScale
    this.camera.cx = this.camera.cy = 0
  }

  follow(id: number | null): void {
    this.followId = id
    this.overview = false
    // Selecting a bot from the overview reveals its immediate surroundings.
    if (id !== null && this.zoom === 1) this.zoomAt(4)
  }

  update(robots: readonly { id: number; pos: { x: number; y: number } }[]): void {
    if (this.followId === null) return
    const robot = robots.find(r => r.id === this.followId)
    // Keep the last position through absence/death; follow the next recorded respawn.
    if (robot) { this.camera.cx = robot.pos.x; this.camera.cy = robot.pos.y }
  }

  pan(dx: number, dy: number): void {
    this.followId = null
    this.overview = false
    this.camera.cx -= dx / this.camera.scale
    this.camera.cy -= dy / this.camera.scale
    this.clamp()
  }

  zoomAt(factor: number, x = this.camera.cw / 2, y = this.camera.ch / 2): void {
    if (!Number.isFinite(factor) || factor <= 0) return
    const wx = this.camera.toWorldX(x), wy = this.camera.toWorldY(y)
    this.zoom = Math.max(1, Math.min(24, this.zoom * factor))
    this.camera.scale = this.fitScale * this.zoom
    this.overview = false
    // A following camera stays centered on its bot, otherwise anchor at the pointer.
    if (this.followId === null) {
      this.camera.cx += wx - this.camera.toWorldX(x)
      this.camera.cy += wy - this.camera.toWorldY(y)
      this.clamp()
    }
  }

  private clamp(): void {
    const { camera } = this
    camera.cx = Math.max(-camera.extent, Math.min(camera.extent, camera.cx))
    camera.cy = Math.max(-camera.extent, Math.min(camera.extent, camera.cy))
  }
}
