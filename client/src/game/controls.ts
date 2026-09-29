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

  constructor(deps: GameDeps) {
    this.canvas = deps.canvas
    this.hudRoot = deps.hudRoot
    this.send = deps.send
    this.onExitToRoom = deps.onExitToRoom
    this.renderer = new Renderer(deps.canvas)
    this.hud = new Hud(deps.hudRoot)
  }

  /** 收到 mapBootstrap：解析地图，进入游戏态 */
  onMapBootstrap(mapJson: string): boolean {
    try {
      this.map = parseMapDef(mapJson)
    } catch (err) {
      console.error('[game] 地图解析失败:', err)
      return false
    }
    this.ended = false
    this.endShown = false
    this.matchEndRows = []
    hideMatchEnd(this.hudRoot)
    this.bubbles = []
    this.world = emptyWorld()
    this.setupCanvas()
    this.input.attach(this.canvas, this.cam)
    this.startLoops()
    return true
  }

  /** 房间回到大厅 / 断线：退出游戏态，释放循环 */
  exit(): void {
    this.stopLoops()
    this.input.detach()
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
      if (applySnapshot(this.world, snap) === 'resync-needed') {
        this.send(buildResync())
      }
      return
    }
    if (msg.payload.case !== 'event') return
    const ev = msg.payload.value
    switch (ev.kind.case) {
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

  /** Space assist 开关：转发给服务器 */
  toggleAssist(): void {
    if (this.input.toggleAssist()) {
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
    const dpr = window.devicePixelRatio || 1
    const doResize = () => {
      const rect = this.canvas.getBoundingClientRect()
      this.renderer.resize(rect.width, rect.height, dpr)
      this.cam.resize(rect.width, rect.height, this.map!.extent)
    }
    doResize()
    this.resizeObserver = new ResizeObserver(doResize)
    this.resizeObserver.observe(this.canvas)
  }

  private startLoops(): void {
    this.stopLoops()

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
    if (!this.map) return
    const selfId = this.world.self?.robotId ?? 0
    const self = this.world.robots.get(selfId)
    const pos = self?.base?.pos
    if (pos) this.cam.follow(pos.x, pos.y)
    else this.cam.follow(0, 0)
    this.renderer.render(this.world, this.map, this.cam, { bubbles: this.bubbles })
    this.hud.update(this.world)
    if (!this.ended) this.hud.setAssist(this.input.assistOn)
  }

  private sampleAndSend(): void {
    if (!this.map) return
    const selfId = this.world.self?.robotId ?? 0
    const self = this.world.robots.get(selfId)
    const pos = self?.base?.pos
    const sx = pos?.x ?? 0
    const sy = pos?.y ?? 0
    const { msg, active } = this.input.sample(sx, sy)
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
