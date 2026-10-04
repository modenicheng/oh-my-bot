// 游戏视图编排：mapBootstrap 进入 → 快照消费 → 60Hz 渲染/输入 → matchEnd 结算。
// main.ts 在收到 mapBootstrap 事件时调用 enterGame()，收到房间回到大厅信号时调用 exitGame()。
import { create } from '@bufbuild/protobuf'
import {
  AssistToggleSchema, ClientMsgSchema, ControlSource, SaySchema,
  type ServerMsg, type EvMatchEnd, type SimTuning,
} from '@omb/protocol'
import { encodeClient } from '@omb/protocol'
import { parseMapDef, type MapDefParsed } from './mapdef'
import { resolveTuning } from './tuning'
import { emptyWorld, applySnapshot, buildResync, extractSnapshot, type WorldState } from './world'
import { Camera } from './camera'
import { Renderer, type RenderExtras, type SayBubble } from './render'
import { InputSampler, AXIS_AIM } from './input'
import { isAimUnderScript } from './axis-src'
import { Hud } from './hud'
import { Scoreboard, showMatchEnd, hideMatchEnd } from './scoreboard'
import { GameFeedback } from './feedback'
import { audio } from '../audio'
import { bgm } from '../music/bgm'

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
  /** 渲染循环每帧复用的 extras 容器，避免每帧对象字面量分配。 */
  private extras: RenderExtras = { bubbles: [] }
  private sayTicks = new Map<number, number>()
  private raf = 0
  private sendTimer: ReturnType<typeof setInterval> | undefined
  private ended = false
  private scores = new Scoreboard()
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
  private assistPreference = false
  private chat = document.getElementById('game-chat') as HTMLFormElement
  private chatInput = document.getElementById('game-chat-input') as HTMLInputElement
  private chatCount = document.getElementById('game-chat-count')!
  private chatReadyTick = 0
  private readonly submitChat = (event: Event) => {
    event.preventDefault()
    if (!this.active || this.ended || this.chat.hidden || this.world.tick < this.chatReadyTick) return
    const self = this.world.robots.get(this.world.self?.robotId ?? 0)
    if (!self || self.dead) { this.closeChat(true); return }
    const text = [...this.chatInput.value.replace(/[\s\p{Cc}]+/gu, ' ').trim()].slice(0, 160).join('')
    if (!text) { this.chatInput.focus(); return }
    this.send(encodeClient(create(ClientMsgSchema, { payload: { case: 'say', value: create(SaySchema, { text }) } })))
    this.chatReadyTick = this.world.tick + 180
    this.closeChat(true)
  }
  private readonly chatKey = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.code === 'Escape') { event.preventDefault(); this.closeChat(true) }
    if (event.code === 'Enter') {
      event.preventDefault()
      if (!event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) this.submitChat(event)
    }
  }
  private readonly countChat = (event?: Event) => {
    const chars = [...this.chatInput.value]
    if (!(event instanceof InputEvent && event.isComposing) && chars.length > 160) this.chatInput.value = chars.slice(0, 160).join('')
    this.chatCount.textContent = `${Math.min(chars.length, 160)}/160 · Enter 发送 · Esc 取消`
  }
  private readonly leaveChat = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !this.chat.contains(event.relatedTarget)) this.closeChat(false)
  }
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
    this.feedback = new GameFeedback(
      (text, kind) => this.hud.flashMsg(text, kind),
      () => this.hud.showInnerRing(),
      seconds => this.hud.pulseCountdown(seconds),
    )
    // 瞄准 guard 生效期间鼠标移动被吞时提示按 R（节流在 HUD 内部）。
    this.input.onAimGuarded = () => {
      if (this.active && !this.ended && !document.hidden) this.hud.flashAimGuardHint()
    }
    this.chat.addEventListener('submit', this.submitChat)
    this.chat.addEventListener('keydown', this.chatKey)
    this.chat.addEventListener('focusout', this.leaveChat)
    this.chatInput.addEventListener('input', this.countChat)
    this.chatInput.addEventListener('compositionend', this.countChat)
    window.addEventListener('blur', this.releaseOnBlur)
    document.addEventListener('visibilitychange', this.releaseWhenHidden)
  }

  /** 收到 mapBootstrap：解析地图，进入游戏态 */
  onMapBootstrap(mapJson: string, tuning?: SimTuning): boolean {
    try {
      this.map = parseMapDef(mapJson)
    } catch (err) {
      console.error('[game] 地图解析失败:', err)
      return false
    }
    this.stopLoops()
    this.ended = false
    this.chatReadyTick = 0
    this.closeChat(false)
    this.resyncAt = -Infinity
    this.startCuePending = false
    this.endShown = false
    this.scores.reset()
    hideMatchEnd(this.hudRoot)
    this.bubbles = []
    this.sayTicks.clear()
    this.feedback.reset()
    this.input.assistOn = this.assistPreference
    this.world = emptyWorld()
    // X-3：服务器权威对局数值；缺失（旧服务器）resolveTuning 回退兜底
    this.world.tuning = resolveTuning(tuning)
    this.hud.update(this.world, this.map, this.scores, this.assistAimCapable)
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
    this.closeChat(false)
    this.chat.removeEventListener('submit', this.submitChat)
    this.chat.removeEventListener('keydown', this.chatKey)
    this.chat.removeEventListener('focusout', this.leaveChat)
    this.chatInput.removeEventListener('input', this.countChat)
    this.chatInput.removeEventListener('compositionend', this.countChat)
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
        this.scores.observe(this.world.robots)
        this.input.acknowledge(snap.ackSeq)
        if (snap.self?.assistOn !== undefined) {
          this.assistPreference = snap.self.assistOn
          this.input.assistOn = snap.self.assistOn
        }
        // 普通 full 只是状态重同步，不代表服务端释放了 HumanAxes；保留本地
        // held/mask，避免服务端继续旧值而客户端静默停止发送对应轴。
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
        const { robot, text } = ev.kind.value
        if (ev.tick <= (this.sayTicks.get(robot) ?? -1)) break
        this.sayTicks.set(robot, ev.tick)
        if (robot === this.world.self?.robotId) this.chatReadyTick = ev.tick + 180
        if (this.active && !document.hidden && !this.ended) {
          this.bubbles = this.bubbles.filter(bubble => bubble.robotId !== robot)
          this.bubbles.push({ robotId: robot, text, at: performance.now() })
        }
        break
      }
      case 'scoreboard':
        this.scores.accept(ev.kind.value.rows, ev.kind.value.tick)
        break
      case 'matchEnd': {
        if (this.endShown) break // 事件去重：服务器幂等重发时不再重复渲染
        this.scores.accept(ev.kind.value.scores, this.world.tick, true)
        this.ended = true
        this.closeChat(false)
        this.endShown = true
        this.showEnd(ev.kind.value)
        break
      }
      default:
        break
    }
  }

  /** 离开游戏或断线时释放控制，不影响服务端模拟。 */
  setActive(active: boolean): void {
    if (this.active === active) return
    if (!active && this.map) {
      this.input.release()
      this.sampleAndSend()
      this.input.detach()
    }
    this.active = active
    if (!active) { this.feedback.pause(); this.closeChat(false); this.bubbles = [] }
    if (active && this.map) {
      if (this.inputEnabled) this.input.attach(this.canvas, this.cam)
      if (this.startCuePending && this.world.initialized && !this.ended) {
        this.startCuePending = false
        audio.play('matchStart')
      }
    }
  }

  /** 焦点离开战场时释放手操；画面、快照和脚本继续运行。 */
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

  /** 选项层等本地覆盖层打开时释放全部 held 输入，不暂停服务端模拟。 */
  releaseInput(): void {
    if (!this.map || !this.active || !this.inputEnabled) return
    this.input.release()
    this.sampleAndSend()
    this.input.detach()
    this.inputEnabled = false
  }

  /** 显式应用 Snippet / AI 结果时开启辅助并归还手操轴，绝不反向关闭。 */
  activateAssist(): boolean {
    if (!this.active || !this.map || this.ended || !this.world.initialized) return false
    if (!this.input.assistOn || (this.world.self?.manualAxesMask ?? 0) !== 0) this.toggleAssist()
    return this.input.assistOn
  }

  /** 瞄准 guard：脚本控制炮塔时鼠标移动不抢炮塔轴，R 显式夺取。 */
  seizeAim(): void {
    if (!this.active || !this.map || this.ended || !this.world.initialized) return
    if (!this.input.seizeAim()) return
    audio.play('assist')
    this.hud.flashMsg('手动瞄准 · Space 交回辅助')
  }

  /** 瞄准能力信号（Workbench 上报）：已装载玩家脚本含 aimAt 调用，或
   * 已应用自瞄 Snippet。信号在脚本装载/卸载/Snippet 应用时更新，早于
   * 服务器 turret_src 回显——敌人出现前 guard 就应生效，否则先手鼠标
   * 粘滞会永远阻止脚本拿走炮塔轴。 */
  private assistAimCapable = false

  setAssistAimCapable(capable: boolean): void {
    if (this.assistAimCapable === capable) return
    this.assistAimCapable = capable
    this.syncAimGuard()
  }

  /** 每帧按本地信号更新瞄准 guard：辅助开启 + 瞄准能力脚本在场 + 人未
   * 持有炮塔轴（本地粘滞位）时，鼠标移动不抢炮塔轴，R 显式夺取。
   * 判定与 HUD 文案同源（axis-src.isAimUnderScript，C-28）：能力信号在服务器
   * turret_src 回显之前就生效（本地先行时序不变）。
   * 字段缺失（旧服务器）不启用 guard，保持逐帧鼠标抢占。 */
  private syncAimGuard(): void {
    this.input.aimUnderScript = isAimUnderScript(
      this.input.assistOn,
      this.assistAimCapable,
      this.world.self?.turretSrc,
      this.input.holdsAim(),
    )
  }

  /** Space assist 开关：转发给服务器 */
  toggleAssist(): void {
    if (!this.active || !this.map || this.ended || !this.world.initialized) return
    if (this.input.toggleAssist(this.world.self?.manualAxesMask ?? 0)) {
      this.syncAimGuard()
      audio.play('assist')
      this.send(encodeClient(create(ClientMsgSchema, {
        payload: { case: 'assistToggle', value: create(AssistToggleSchema, {}) },
      })))
      this.hud.setAssist(this.input.assistOn)
      this.hud.flashMsg(this.input.assistOn ? '驾驶辅助 ON' : '驾驶辅助 OFF')
    }
  }

  /** Enter 打开全场发言；文本输入获得焦点，手操随之释放。 */
  openChat(): void {
    if (!this.active || this.ended || !this.world.initialized) return
    const self = this.world.robots.get(this.world.self?.robotId ?? 0)
    if (!self || self.dead) { this.hud.flashMsg('重生后可以发言'); return }
    if (this.world.tick < this.chatReadyTick) {
      this.hud.flashMsg(`发言冷却 · ${Math.ceil((this.chatReadyTick - this.world.tick) / 60)} 秒`)
      return
    }
    this.chat.hidden = false
    this.chatInput.value = ''
    this.countChat()
    this.chatInput.focus({ preventScroll: true })
  }

  private closeChat(returnFocus: boolean): void {
    const wasOpen = !this.chat.hidden
    this.chat.hidden = true
    this.chatInput.value = ''
    if (wasOpen && returnFocus) this.canvas.focus({ preventScroll: true })
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

  private selfHacking(selfId: number): boolean {
    if (selfId === 0) return false
    for (const uplink of this.world.uplinks.values()) if (uplink.hackingId === selfId) return true
    return false
  }

  private drawFrame(): void {
    if (!this.map || !this.active) return
    bgm.phase('game', this.world.phase)
    if (this.pixelRatio !== (window.devicePixelRatio || 1)) this.resizeCanvas()
    this.syncAimGuard()
    const selfId = this.world.self?.robotId ?? 0
    const self = this.world.robots.get(selfId)
    // 死亡：人工接管归零（服务端重生时已重置控制状态），本地同步清粘滞轴，
    // 防止重生后残余 held 键第一帧重新抢占。
    if (self?.dead) this.input.resetTakeover()
    const pos = self?.base?.pos
    const hacking = this.selfHacking(selfId)
    this.cam.setZoom(this.feedback.cameraZoom(this.world.tick, !!self?.dashing && !self.dead, hacking))
    if (self?.dead && !this.chat.hidden) this.closeChat(document.activeElement === this.chatInput)
    if (pos) this.cam.follow(pos.x, pos.y)
    else this.cam.follow(0, 0)
    // 原地压缩过期气泡：rAF 每帧执行，避免 filter 的每帧数组分配。
    const now = performance.now()
    let kept = 0
    for (let i = 0; i < this.bubbles.length; i++) {
      const bubble = this.bubbles[i]!
      if (now - bubble.at < 4000) this.bubbles[kept++] = bubble
    }
    this.bubbles.length = kept
    this.extras.bubbles = this.bubbles
    this.extras.localAim = pos ? this.input.aimAt(pos.x, pos.y) : undefined
    this.extras.feedback = this.feedback
    this.renderer.render(this.world, this.map, this.cam, this.extras)
    this.hud.update(this.world, this.map, this.scores, this.assistAimCapable)
    this.feedback.ambience(this.world, this.map, this.active && !this.ended)
    if (!this.ended) this.hud.setAssist(this.input.assistOn)
  }

  private sampleAndSend(): void {
    if (!this.map || !this.active || !this.inputEnabled || this.ended || !this.world.initialized) return
    this.syncAimGuard()
    const selfId = this.world.self?.robotId ?? 0
    const self = this.world.robots.get(selfId)
    const pos = self?.base?.pos
    const sx = pos?.x ?? 0
    const sy = pos?.y ?? 0
    const hacking = this.selfHacking(selfId)
    this.cam.setZoom(this.feedback.cameraZoom(this.world.tick, !!self?.dashing && !self.dead, hacking))
    if (pos) this.cam.follow(pos.x, pos.y)
    const { msg, active } = this.input.sample(sx, sy)
    this.feedback.input(msg, this.world, this.map)
    if (!active) return // 全零输入（无人类操作）不发，避免抢占脚本
    this.send(encodeClient(create(ClientMsgSchema, {
      payload: { case: 'input', value: msg },
    })))
  }

  private showEnd(ev: EvMatchEnd): void {
    showMatchEnd(this.hudRoot, ev.scores, this.scores.names, () => this.dismissMatchEnd(), this.world.self?.robotId)
  }
}
