// 输入采样：keydown/keyup WASD + 鼠标 aim/fire + Shift dash + Q shield + E/F interact
// （v1 协议只有一个 interact 位，E 与 F 等效）+ Space assist 开关。
// 60Hz 定时采样打包 ClientInput：seq 递增、axis_mask 只在人类操作对应轴时置位
// （未置位轴不抢占脚本控制 —— 见 docs/manual/controls.md 仲裁语义）。
import { create } from '@bufbuild/protobuf'
import { ClientInputSchema, type ClientInput } from '@omb/protocol'
import type { Camera } from './camera'

// axis_mask 位定义（omb.proto ClientInput.axis_mask）
export const AXIS_MOVE = 1 << 0
export const AXIS_AIM = 1 << 1
export const AXIS_FIRE = 1 << 2
export const AXIS_ABILITY = 1 << 3

const MOVE_PER_MILLE = 1000

export interface InputSample {
  msg: ClientInput
  /** 该帧是否值得发送（有任一轴被人类操作过） */
  active: boolean
}

/** 驾驶辅助总开关（Space 切换）；仅本地提示，切换需另发 assistToggle */
export class InputSampler {
  private keys = new Set<string>()
  private mouseDown = false
  private mousePx = { x: 0, y: 0 }
  /** 人类操作轴的粘性：某轴一旦被人类操作，就一直发该轴（人优先，直到脚本重新接管？不——
   * 语义按 controls.md：人类输入逐轴抢占且不自动归还。客户端实现：人类按下后轴位持续置 1，
   * 失焦时只发送一次停止帧；恢复脚本控制仍需显式切换辅助。 */
  private stickyAxes = 0
  private releaseAxes = 0
  private seq = 0
  private cam: Camera | null = null
  private canvas: HTMLCanvasElement | null = null
  private disposers: (() => void)[] = []
  /** E/F interact 按下沿（单帧 true） */
  private interactEdge = false
  /** Shift dash 按下沿（单帧 true） */
  private dashEdge = false
  /** assist 开关状态（本地镜像） */
  assistOn = true

  attach(canvas: HTMLCanvasElement, cam: Camera): void {
    this.detach()
    this.canvas = canvas
    this.cam = cam

    const onKeyDown = (e: KeyboardEvent) => {
      // 输入框聚焦时不动游戏输入（大厅/聊天场景）
      const t = e.target as HTMLElement | null
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || t?.closest('input, textarea, select, [contenteditable]')) return
      const k = e.code
      if (k === 'KeyW' || k === 'KeyA' || k === 'KeyS' || k === 'KeyD') {
        this.keys.add(k)
        this.stickyAxes |= AXIS_MOVE
        e.preventDefault()
      } else if (k === 'KeyE' || k === 'KeyF') {
        if (!e.repeat) this.interactEdge = true
        this.stickyAxes |= AXIS_ABILITY
        e.preventDefault()
      } else if (k === 'ShiftLeft' || k === 'ShiftRight') {
        if (!e.repeat) this.dashEdge = true
        this.stickyAxes |= AXIS_ABILITY
        e.preventDefault()
      } else if (k === 'KeyQ') {
        this.keys.add(k)
        this.stickyAxes |= AXIS_ABILITY
        e.preventDefault()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.code
      if (k === 'KeyW' || k === 'KeyA' || k === 'KeyS' || k === 'KeyD' || k === 'KeyQ') this.keys.delete(k)
    }
    const onMouseMove = (e: MouseEvent) => {
      const rect = this.canvas?.getBoundingClientRect()
      if (!rect) return
      this.mousePx.x = e.clientX - rect.left
      this.mousePx.y = e.clientY - rect.top
      this.stickyAxes |= AXIS_AIM
    }
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        this.mouseDown = true
        this.stickyAxes |= AXIS_FIRE
        e.preventDefault()
      }
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) this.mouseDown = false
    }
    const onBlur = () => {
      this.release()
      this.releaseAxes = this.stickyAxes
      this.stickyAxes = 0
    }

    window.addEventListener('keydown', onKeyDown, { passive: false })
    window.addEventListener('keyup', onKeyUp)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('blur', onBlur)

    this.disposers.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => canvas.removeEventListener('mousemove', onMouseMove),
      () => canvas.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => window.removeEventListener('blur', onBlur),
    )
  }

  acknowledge(seq: number): void {
    this.seq = Math.max(this.seq, seq)
  }

  release(): void {
    this.keys.clear()
    this.mouseDown = false
    this.dashEdge = false
    this.interactEdge = false
  }

  detach(): void {
    for (const d of this.disposers) d()
    this.disposers = []
    this.release()
    this.stickyAxes = 0
    this.releaseAxes = 0
    this.canvas = null
    this.cam = null
  }

  /** Space 切换 assist：返回是否需要发 assistToggle 上行 */
  toggleAssist(): boolean {
    this.assistOn = !this.assistOn
    if (this.assistOn) { this.stickyAxes = 0; this.releaseAxes = 0; this.release() }
    return true
  }

  /**
   * 采样一帧。targetPos 为自机世界坐标（aim 反算参考点）。
   * aim = atan2(mouseWorld - selfWorld)。
   */
  sample(selfX: number, selfY: number): InputSample {
    let mx = 0
    let my = 0
    if (this.keys.has('KeyW')) my -= 1
    if (this.keys.has('KeyS')) my += 1
    if (this.keys.has('KeyA')) mx -= 1
    if (this.keys.has('KeyD')) mx += 1
    // 对角归一化 → per-mille
    let moveX = 0
    let moveY = 0
    if (mx !== 0 || my !== 0) {
      const len = Math.hypot(mx, my)
      moveX = Math.round((mx / len) * MOVE_PER_MILLE)
      moveY = Math.round((my / len) * MOVE_PER_MILLE)
    }

    // aim：canvas 像素 → 世界 → 弧度
    let aim = 0
    const cam = this.cam
    if (cam) {
      const wx = cam.toWorldX(this.mousePx.x)
      const wy = cam.toWorldY(this.mousePx.y)
      aim = Math.atan2(wy - selfY, wx - selfX)
    }

    const dash = this.dashEdge
    const interact = this.interactEdge
    this.dashEdge = false
    this.interactEdge = false

    // Q 为持续护盾；E/F 为交互按下沿。
    const shield = this.keys.has('KeyQ')

    const heldAxes = this.stickyAxes | this.releaseAxes
    this.releaseAxes = 0
    const axisMask =
      (heldAxes & AXIS_MOVE ? AXIS_MOVE : 0) |
      (heldAxes & AXIS_AIM ? AXIS_AIM : 0) |
      (heldAxes & AXIS_FIRE ? AXIS_FIRE : 0) |
      (heldAxes & AXIS_ABILITY ? AXIS_ABILITY : 0)

    const msg = create(ClientInputSchema, {
      seq: ++this.seq,
      moveX,
      moveY,
      aim,
      fire: this.mouseDown,
      dash,
      shield,
      interact,
      axisMask,
    })
    return { msg, active: axisMask !== 0 || dash || interact }
  }
}
