// 输入采样：keydown/keyup WASD + 鼠标 aim/fire + Shift dash + Q shield + E/F interact
// （v1 协议只有一个 interact 位，E 与 F 等效）+ Space assist 三分支。
// 60Hz 定时采样打包 ClientInput：seq 递增、axis_mask 只在真实人类操作对应轴时置位
// （未置位轴不抢占脚本控制 —— 见 docs/manual/rules/controls.md 仲裁语义）。
// 接管为边沿触发：仅非 repeat 的 keydown / 真实指针事件才置位；重复系统 keyrepeat
// 帧、恢复 Space 后仍按住的键不得重新抢占（ADR-0009）。
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

/** 驾驶辅助（Space 三分支：关→开并清接管；开+手操→交回脚本；开+全脚本→关）。
 * 本地 assistOn 仅为镜像，权威状态以 SelfState.assist_on 为准（快照回写）。 */
export class InputSampler {
  private keys = new Set<string>()
  private mouseDown = false
  private dashMouseDown = false
  private pointer = { x: 0, y: 0 }
  /** 人类操作轴的粘性：某轴被真实人类操作（非 repeat 边沿）后持续置位，
   * 直到 Space 交回辅助/关闭或失焦。assist 关闭期间不置位（无脚本可抢占）。
   * 恢复（Space 开启/交回）时清零并释放按键，防止仍按住的键持续帧重新抢占。 */
  private stickyAxes = 0
  private releaseAxes = 0
  private seq = 0
  private lastAim = 0
  private cam: Camera | null = null
  private canvas: HTMLCanvasElement | null = null
  private disposers: (() => void)[] = []
  /** assist 开关状态（本地镜像，快照权威回写） */
  assistOn = false

  attach(canvas: HTMLCanvasElement, cam: Camera): void {
    this.detach()
    this.canvas = canvas
    this.cam = cam

    const onKeyDown = (e: KeyboardEvent) => {
      // 输入框聚焦时不动游戏输入（大厅/聊天场景）
      const t = e.target as HTMLElement | null
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || t?.closest('input, textarea, select, button, a, summary, [contenteditable]')) return
      const k = e.code
      // 接管为边沿触发：系统 auto-repeat 的重复 keydown 不重新抢占
      // （Space 交回辅助后仍按住的键不能靠 repeat 帧抢回轴；辅助关闭时同样
      // 只在真实按下时置位，mask 反映真实操作）。
      const edge = !e.repeat
      if (k === 'KeyW' || k === 'KeyA' || k === 'KeyS' || k === 'KeyD') {
        this.keys.add(k)
        if (edge) this.stickyAxes |= AXIS_MOVE
        e.preventDefault()
      } else if (k === 'KeyE' || k === 'KeyF') {
        this.keys.add(k)
        if (edge) this.stickyAxes |= AXIS_ABILITY
        e.preventDefault()
      } else if (k === 'ShiftLeft' || k === 'ShiftRight') {
        this.keys.add(k)
        if (edge) this.stickyAxes |= AXIS_ABILITY
        e.preventDefault()
      } else if (k === 'KeyQ') {
        this.keys.add(k)
        if (edge) this.stickyAxes |= AXIS_ABILITY
        e.preventDefault()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.code
      if (k === 'KeyW' || k === 'KeyA' || k === 'KeyS' || k === 'KeyD' || k === 'KeyQ' || k === 'KeyE' || k === 'KeyF' || k === 'ShiftLeft' || k === 'ShiftRight') this.keys.delete(k)
    }
    const onMouseMove = (e: MouseEvent) => {
      // 指针微抖也会持续置位：只在真实移动（坐标变化）时抢占 aim 轴。
      if (e.clientX !== this.pointer.x || e.clientY !== this.pointer.y) {
        this.stickyAxes |= AXIS_AIM
      }
      this.pointer.x = e.clientX
      this.pointer.y = e.clientY
    }
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        onMouseMove(e)
        this.mouseDown = true
        this.stickyAxes |= AXIS_FIRE
        e.preventDefault()
      } else if (e.button === 2) {
        this.dashMouseDown = true
        this.stickyAxes |= AXIS_ABILITY
        e.preventDefault()
      }
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) this.mouseDown = false
      if (e.button === 2) this.dashMouseDown = false
    }
    const onContextMenu = (e: MouseEvent) => e.preventDefault()
    const onBlur = () => {
      this.release()
      this.releaseAxes = this.stickyAxes
      this.stickyAxes = 0
    }

    const onVisibility = () => { if (document.hidden) onBlur() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('keydown', onKeyDown, { passive: false })
    window.addEventListener('keyup', onKeyUp)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('blur', onBlur)

    this.disposers.push(
      () => document.removeEventListener('visibilitychange', onVisibility),
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => canvas.removeEventListener('mousemove', onMouseMove),
      () => canvas.removeEventListener('mousedown', onMouseDown),
      () => canvas.removeEventListener('contextmenu', onContextMenu),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => window.removeEventListener('blur', onBlur),
    )
  }

  acknowledge(seq: number): void {
    this.seq = Math.max(this.seq, seq)
  }

  /** 清除按键/鼠标按下状态，但不改轴归属：接管轴保持人工（停止帧仍带 mask），
   * 之后不再发接管帧，直到真实新输入。blur/死亡/重连/full snapshot 时调用。
   * 若需同时交回轴（Space、失焦归零），调用 resetTakeover()。 */
  release(): void {
    this.keys.clear()
    this.mouseDown = false
    this.dashMouseDown = false
  }

  /** 释放按键并把全部人工接管轴归零（下一个采样帧发出 0 mask，交回仲裁）。
   * 用于恢复辅助/死亡重生/重连：仍按住的键不会凭旧 sticky 重新抢占。 */
  resetTakeover(): void {
    this.release()
    this.stickyAxes = 0
    this.releaseAxes = 0
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

  /** Every draw and input sample uses the same current camera and CSS pointer position. */
  aimAt(selfX: number, selfY: number): number | undefined {
    if (!(this.stickyAxes & AXIS_AIM) || !this.cam || !this.canvas) return undefined
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return undefined
    const px = (this.pointer.x - rect.left) * this.cam.cw / rect.width
    const py = (this.pointer.y - rect.top) * this.cam.ch / rect.height
    return Math.atan2(this.cam.toWorldY(py) - selfY, this.cam.toWorldX(px) - selfX)
  }

  /** Space：向服务端发 assistToggle（服务端三分支权威裁决），本地镜像先翻转。
   * 无论裁决结果如何都释放按键并清轴归属：交回脚本后仍按住的键、仍按着的鼠标
   * 不得靠持续帧/系统 repeat 重新抢占；真实新 keydown/指针事件才可再次接管。 */
  toggleAssist(): boolean {
    this.assistOn = !this.assistOn
    this.resetTakeover()
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

    const aim = this.aimAt(selfX, selfY) ?? this.lastAim
    this.lastAim = aim
    const dash = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.dashMouseDown
    const interact = this.keys.has('KeyE') || this.keys.has('KeyF')

      // Q 护盾、E/F 破解和 Shift/右键 Dash 均按住持续，松开后发送显式 false。
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
