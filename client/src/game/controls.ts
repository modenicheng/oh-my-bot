// 游戏视图编排：mapBootstrap 进入 → 快照消费 → 60Hz 渲染/输入 → matchEnd 结算。
// main.ts 在收到 mapBootstrap 事件时调用 enterGame()，收到房间回到大厅信号时调用 exitGame()。
import { create } from '@bufbuild/protobuf'
import {
  AssistToggleSchema, ClientMsgSchema,
  type ServerMsg, type ScoreRow, type EvMatchEnd,
} from '@omb/protocol'
import { encodeClient } from '@omb/protocol'
import { parseMapDef, type MapDefParsed } from './mapdef'
import { emptyWorld, applySnapshot, buildResync, extractSnapshot, type WorldState } from './world'
import { Camera } from './camera'
import { Renderer, type SayBubble } from './render'
import { InputSampler } from './input'
import { Hud, showMatchEnd, hideMatchEnd } from './hud'
import { GameFeedback } from './feedback'
import { audio } from '../audio'

const SEND_HZ = 60
const FRAME_MS = 1000 / SEND_HZ

export interface GameDeps {
  canvas: HTMLCanvasElement
  hudRoot: HTMLElement
  /** 上行发送（RoomSession.send，帧已编码） */
  send: (data: Uint8Array) => void
  /** 「回到房间」回调：结算层关闭后由大厅接手视图与操作栏（不发 RoomAction） */
  onExitToRoom?: () => void
}

export class GameController {
  private world = emptyWorld()
  private map: MapDefParsed | null = null
  private cam = new Camera()
  private renderer: Renderer
  private input = new InputSampler()
  private hud: Hud
  private feedback: GameFeedback
  private bubbles: SayBubble[] = []
  private raf = 0
  private sendTimer: ReturnType<typeof setInterval> | undefined
  private ended = false
  private matchEndRows: ScoreRow[] = []
  private endShown = false
  private canvas: HTMLCanvasElement
  private hudRoot: HTMLElement
  private send: (data: Uint8Array) => void
  private onExitToRoom?: () => void
  private resizeObserver?: ResizeObserver
  private pixelRatio = 0
  private active = true
  private inputEnabled = true
  private resyncAt = -Infinity
  private startCuePending = false
  private readonly releaseOnBlur = () => {
    this.input.release()
    this.sampleAndSend()
  }
  private readonly releaseWhenHidden = () => { if (document.hidden) this.releaseOnBlur() }

  constructor(deps: GameDeps) {
    this.canvas = deps.canvas
    this.hudRoot = deps.hudRoot
    this.send = deps.send
    this.onExitToRoom = deps.onExitToRoom
    this.renderer = new Renderer(deps.canvas)
    this.hud = new Hud(deps.hudRoot)
    this.feedback = new GameFeedback(text => this.hud.flashMsg(text))
    window.addEventListener('blur', this.releaseOnBlur)
    document.addEventListener('visibilitychange', this.releaseWhenHidden)
  }

  /** 收到 mapBootstrap：解析地图，进入游戏态 */
  onMapBootstrap(mapJson: string): boolean {
    try {
      this.map = parseMapDef(mapJson)
    } catch (err) {
      console.error('[game] 地图解析失败:', err)
      return false
    }
    this.stopLoops()
    this.ended = false
    this.resyncAt = -Infinity
    this.startCuePending = false
    this.endShown = false
    this.matchEndRows = []
    hideMatchEnd(this.hudRoot)
    this.bubbles = []
    this.feedback.reset()
    this.input.assistOn = false
    this.world = emptyWorld()
    this.hud.update(this.world, this.map)
    this.hud.setAssist(false)
    this.setupCanvas()
    if (this.active && this.inputEnabled) this.input.attach(this.canvas, this.cam)
    this.startLoops()
    return true
  }

  /** 房间回到大厅 / 断线：退出游戏态，释放循环 */
  exit(): void {
    this.stopLoops()
    this.input.detach()
    this.feedback.reset()
    this.hud.dispose()
    window.removeEventListener('blur', this.releaseOnBlur)
    document.removeEventListener('visibilitychange', this.releaseWhenHidden)
    this.map = null
    this.world = emptyWorld()
    this.endShown = false
    hideMatchEnd(this.hudRoot)
  }

  /** 结算覆盖层是否在场（main.ts 据此决定 roomState 回大厅时不抢切视图） */
  isMatchEndShown(): boolean {
    return this.endShown && this.map !== null
  }

  /** 「回到房间」：本地关闭结算层并退回大厅视图；不发 RoomAction，
   *  等下一次 roomState 刷新房间状态。 */
  dismissMatchEnd(): void {
    if (!this.endShown) return
    this.endShown = false
    hideMatchEnd(this.hudRoot)
    this.exit()
    this.onExitToRoom?.()
  }

  /** 最近一次 full 快照的机器人名单（大厅成员列表数据源；空 = 尚无对局数据） */
  lastRoster(): Array<{ nick: string; color: string }> {
    const out: Array<{ nick: string; color: string }> = []
    for (const r of this.world.robots.values()) {
      if (r.nick) out.push({ nick: r.nick, color: r.color || '' })
    }
    return out
  }

  /** ServerMsg 分发（main.ts 转发所有下行） */
  onMessage(msg: ServerMsg): void {
    if (!this.map) return
    const snap = extractSnapshot(msg)
    if (snap) {
      const result = applySnapshot(this.world, snap)
      if (result === 'resync-needed' && performance.now() - this.resyncAt > 500) {
        this.resyncAt = performance.now()
        this.send(buildResync())
      } else if (result === 'applied') {
        this.input.acknowledge(snap.ackSeq)
        if (snap.self?.assistOn !== undefined) this.input.assistOn = snap.self.assistOn
        this.feedback.snapshot(this.world, this.map, snap, this.active && !this.ended)
        if (snap.full) this.resyncAt = -Infinity
      }
      return
    }
    if (msg.payload.case !== 'event') return
    const ev = msg.payload.value
    if (!(ev.kind.case === 'matchEnd' && this.endShown)) this.feedback.event(ev, this.world, this.map, this.active)
    switch (ev.kind.case) {
      case 'matchStart':
        // The reliable start event precedes the first full snapshot.
        this.startCuePending = !this.active
        break
      case 'say': {
        this.bubbles.push({ robotId: ev.kind.value.robot, text: ev.kind.value.text, at: performance.now() })
        if (this.bubbles.length > 12) this.bubbles.shift()
        this.hud.flashMsg(`say: ${ev.kind.value.text}`)
        break
      }
      case 'matchEnd': {
        if (this.endShown) break // 事件去重：服务器幂等重发时不再重复渲染
        this.matchEndRows = ev.kind.value.scores
        this.ended = true
        this.endShown = true
        this.showEnd(ev.kind.value)
        break
      }
      case 'phaseChange': {
        const to = ev.kind.value.to
        this.hud.flashMsg(to === 2 ? '核心区已开放' : '阶段切换')
        break
      }
      case 'kill': {
        const k = this.nickOf(ev.kind.value.killer)
        const v = this.nickOf(ev.kind.value.victim)
        this.hud.flashMsg(`${k} 击毁 ${v}`)
        break
      }
      default:
        break
    }
  }

  /** 隐藏视图时释放控制，避免阅读手册仍在驾驶。 */
  setActive(active: boolean): void {
    if (this.active === active) return
    if (!active && this.map) {
      this.input.release()
      this.sampleAndSend()
      this.input.detach()
    }
    this.active = active
    if (!active) this.feedback.pause()
    if (active && this.map) {
      if (this.inputEnabled) this.input.attach(this.canvas, this.cam)
      if (this.startCuePending && this.world.initialized && !this.ended) {
        this.startCuePending = false
        audio.play('matchStart')
      }
    }
  }

  /** 侧栏只暂停手操采样；画面、快照和脚本继续运行。 */
  setInputEnabled(enabled: boolean): void {
    if (this.inputEnabled === enabled) return
    if (!enabled) {
      this.input.release()
      this.sampleAndSend()
      this.input.detach()
    }
    this.inputEnabled = enabled
    if (enabled && this.active && this.map) this.input.attach(this.canvas, this.cam)
  }

  /** Space assist 开关：转发给服务器 */
  toggleAssist(): void {
    if (!this.active || !this.map || this.ended || !this.world.initialized) return
    if (this.input.toggleAssist()) {
      audio.play('assist')
      this.send(encodeClient(create(ClientMsgSchema, {
        payload: { case: 'assistToggle', value: create(AssistToggleSchema, {}) },
      })))
      this.hud.setAssist(this.input.assistOn)
      this.hud.flashMsg(this.input.assistOn ? '驾驶辅助 ON' : '驾驶辅助 OFF')
    }
  }

  // ---- 内部 ---------------------------------------------------------------

  private setupCanvas(): void {
    if (!this.map) return
    this.resizeCanvas()
    this.resizeObserver?.disconnect()
    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas())
    this.resizeObserver.observe(this.canvas)
  }

  private resizeCanvas(): void {
    if (!this.map) return
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    this.pixelRatio = window.devicePixelRatio || 1
    this.renderer.resize(rect.width, rect.height, this.pixelRatio)
    this.cam.resize(rect.width, rect.height, this.map.extent)
  }

  private startLoops(): void {

    // 渲染循环：rAF
    const draw = () => {
      this.drawFrame()
      this.raf = requestAnimationFrame(draw)
    }
    this.raf = requestAnimationFrame(draw)

    // 输入采样：60Hz
    this.sendTimer = setInterval(() => this.sampleAndSend(), FRAME_MS)
  }

  private stopLoops(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    if (this.sendTimer) clearInterval(this.sendTimer)
    this.sendTimer = undefined
    this.resizeObserver?.disconnect()
    this.resizeObserver = undefined
  }

  private drawFrame(): void {
    if (!this.map || !this.active) return
    if (this.pixelRatio !== (window.devicePixelRatio || 1)) this.resizeCanvas()
    const selfId = this.world.self?.robotId ?? 0
    const self = this.world.robots.get(selfId)
    const pos = self?.base?.pos
    if (pos) this.cam.follow(pos.x, pos.y)
    else this.cam.follow(0, 0)
    this.renderer.render(this.world, this.map, this.cam, {
      bubbles: this.bubbles, localAim: pos ? this.input.aimAt(pos.x, pos.y) : undefined, feedback: this.feedback,
    })
    this.hud.update(this.world, this.map)
    this.feedback.ambience(this.world, this.map, this.active && !this.ended)
    if (!this.ended) this.hud.setAssist(this.input.assistOn)
  }

  private sampleAndSend(): void {
    if (!this.map || !this.active || !this.inputEnabled || this.ended || !this.world.initialized) return
    const selfId = this.world.self?.robotId ?? 0
    const self = this.world.robots.get(selfId)
    const pos = self?.base?.pos
    const sx = pos?.x ?? 0
    const sy = pos?.y ?? 0
    if (pos) this.cam.follow(pos.x, pos.y)
    const { msg, active } = this.input.sample(sx, sy)
    this.feedback.input(msg, this.world, this.map)
    if (!active) return // 全零输入（无人类操作）不发，避免抢占脚本
    this.send(encodeClient(create(ClientMsgSchema, {
      payload: { case: 'input', value: msg },
    })))
  }

  private nickOf(id: number): string {
    const r = this.world.robots.get(id)
    return r?.nick || `robot-${id}`
  }

  private showEnd(ev: EvMatchEnd): void {
    const idToNick = new Map<number, string>()
    for (const r of this.world.robots.values()) {
      const id = r.base?.id
      if (id !== undefined) idToNick.set(id, r.nick || `robot-${id}`)
    }
    showMatchEnd(this.hudRoot, ev.scores, idToNick, () => this.dismissMatchEnd())
  }
}
