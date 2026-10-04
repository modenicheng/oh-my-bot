import type { ServerMsg } from '@omb/protocol'
import { RoomSession, type SessionState } from './net'
import { SpectatorCamera } from './replay/spectator'
import { artReady } from './game/art'
import { parseMapDef, type MapDefParsed } from './game/mapdef'
import { resolveTuning } from './game/tuning'
import { Renderer, phaseName, type SayBubble } from './game/render'
import { Scoreboard, type ScoreDisplay, scoreRow } from './game/scoreboard'
import { bgm } from './music/bgm'
import { applySnapshot, buildResync, emptyWorld } from './game/world'
import { el as domEl, fmtClock, setText } from './ui/dom'

export interface LiveSpectatorDeps {
  root: HTMLElement
  canvas: HTMLCanvasElement
  onExit: () => void
}

/** A spectator owns only its camera and snapshot consumer, never gameplay input. */
export class LiveSpectator {
  private session = new RoomSession()
  private world = emptyWorld()
  private map: MapDefParsed | null = null
  private mapSource = ''
  private renderer: Renderer
  private camera = new SpectatorCamera()
  private events = new AbortController()
  private observer: ResizeObserver
  private disposed = false
  private raf = 0
  private dpr = 0
  private roomCode = ''
  private needsFull = true
  private resyncSent = false
  private ended = false
  private roomState = 0
  private bubbles: SayBubble[] = []
  private roster = ''
  private rosterSize = -1
  private scores = new Scoreboard()
  private lastRows: ScoreDisplay[] | null = null
  private lastEnded = false
  /** 脏标记：快照/事件/相机变化才整帧重绘，空闲观战不再永动重绘。 */
  private dirty = true
  private drag: { id: number; x: number; y: number } | null = null
  private follow: HTMLSelectElement
  private status: HTMLElement
  private retry: HTMLButtonElement
  private zoomEl: HTMLElement
  private phaseEl: HTMLElement
  private timeEl: HTMLElement
  private countEl: HTMLElement

  constructor(private deps: LiveSpectatorDeps) {
    this.renderer = new Renderer(deps.canvas)
    this.follow = this.el<HTMLSelectElement>('live-follow')
    this.status = this.el('live-status')
    this.retry = this.el<HTMLButtonElement>('live-retry')
    this.zoomEl = this.el('live-zoom')
    this.phaseEl = this.el('live-phase')
    this.timeEl = this.el('live-time')
    this.countEl = this.el('live-count')
    this.resetMatchDisplay()
    this.el('live-online').textContent = '真人 0'
    this.bindEvents()
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(deps.canvas)
    this.resize()
    void artReady.then(() => { if (!this.disposed) this.requestDraw() })
    const loop = () => {
      if (this.disposed) return
      if (this.bubbles.length) this.dirty = true // 气泡 4s 寿命，存在期间保持重绘以自然过期
      if (!this.dirty && this.dpr !== (window.devicePixelRatio || 1)) this.dirty = true
      if (this.dirty) {
        this.dirty = false
        this.draw()
      }
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  async connect(roomCode: string): Promise<void> {
    this.roomCode = roomCode
    this.el('live-room').textContent = roomCode
    this.needsFull = true
    const s = this.session
    await s.connect({
      roomCode, nick: '', color: '', spectator: true,
      onMessage: msg => { if (this.session === s && !this.disposed) this.onMessage(msg) },
      onDisconnect: reason => {
        if (this.session !== s || this.disposed) return
        this.needsFull = true
        if (s.state === 'disconnected') this.status.textContent = reason
      },
      onStateChange: (state, delay) => { if (this.session === s && !this.disposed) this.onState(state, delay) },
    })
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    return domEl<T>(this.deps.root, id)
  }

  /** 标记下一帧重绘（rAF 合帧；相机交互/快照路径都可安全高频调用）。 */
  private requestDraw(): void {
    this.dirty = true
  }

  private onState(state: SessionState, delay = 0): void {
    if (state === 'connecting' || state === 'reconnecting') {
      this.needsFull = true
      this.resyncSent = false
    }
    this.deps.root.dataset.connection = state
    this.retry.hidden = state === 'online' || state === 'idle'
    this.retry.disabled = state === 'connecting'
    this.status.textContent = state === 'online' ? this.needsFull ? '正在同步' : '已连接'
      : state === 'connecting' ? '正在连接'
      : state === 'reconnecting' ? navigator.onLine === false ? '网络已离线'
        : delay > 0 ? `${(delay / 1000).toFixed(1)} 秒后重连` : '正在重连'
      : state === 'disconnected' ? '观战连接失败' : '已断开'
  }

  private onMessage(msg: ServerMsg): void {
    if (msg.payload.case === 'snapshot') {
      const snap = msg.payload.value
      if (this.needsFull && !snap.full) { this.requestResync(); return }
      const result = applySnapshot(this.world, snap)
      if (result === 'resync-needed') { this.needsFull = true; this.requestResync(); return }
      if (result !== 'applied') return
      // Do not present personal state even if a malformed server sends it.
      this.world.self = undefined
      this.needsFull = false
      this.resyncSent = false
      this.status.textContent = '已连接'
      this.deps.root.dataset.tick = String(this.world.tick)
      setText(this.phaseEl, phaseName(this.world.phase))
      setText(this.timeEl, fmtClock(this.world.timeLeftS))
      setText(this.countEl, `机器人 ${this.world.robots.size}`)
      // 花名册只依赖 full 快照（nick 仅 full 携带）与机器人集合规模变化，
      // delta 帧跳过逐快照的排序/序列化。
      if (snap.full || this.world.robots.size !== this.rosterSize) this.updateRoster()
      this.scores.observe(this.world.robots)
      this.renderScores()
      this.requestDraw()
      return
    }
    if (msg.payload.case !== 'event') return
    const kind = msg.payload.value.kind
    if (kind.case === 'mapBootstrap') {
      try {
        const source = kind.value.mapJson
        const map = parseMapDef(source)
        const sameMap = source === this.mapSource
        this.mapSource = source
        this.map = map
        this.world.tuning = resolveTuning(kind.value.tuning)
        if (!sameMap) this.camera.fit()
        this.resetMatchDisplay()
        this.resize()
      } catch {
        this.map = null
        this.mapSource = ''
        this.resetMatchDisplay()
        this.resize()
        this.session.close()
        this.deps.root.dataset.connection = 'disconnected'
        this.retry.hidden = false
        this.retry.disabled = false
        this.status.textContent = '地图数据异常，请重试'
      }
    } else if (kind.case === 'roomState') {
      this.roomState = kind.value.state
      this.updateMatchState()
      this.el('live-online').textContent = `真人 ${kind.value.robotsOnline}`
      if (!this.map && kind.value.state === 0) this.status.textContent = '已连接'
    } else if (kind.case === 'scoreboard') {
      this.scores.accept(kind.value.rows, kind.value.tick)
      this.renderScores()
    } else if (kind.case === 'matchEnd') {
      this.ended = true
      this.el('live-match').textContent = '已结束'
      this.scores.accept(kind.value.scores, this.world.tick, true)
      this.renderScores()
    } else if (kind.case === 'say' && kind.value.robot !== 0 && !this.ended) {
      const say = kind.value
      const previous = this.bubbles.find(b => b.robotId === say.robot)
      if (previous?.text === say.text && performance.now() - previous.at < 4000) return
      this.bubbles = this.bubbles.filter(b => b.robotId !== say.robot)
      this.bubbles.push({ robotId: say.robot, text: say.text, at: performance.now() })
      this.requestDraw()
    }
  }

  private renderScores(): void {
    // scoreboard.display 返回缓存数组：引用相同（且结算位未变）即跳过重建，
    // 免去逐快照的 JSON.stringify 签名。
    const rows = this.scores.display(this.world.robots)
    if (rows === this.lastRows && this.scores.ended === this.lastEnded) return
    this.lastRows = rows
    this.lastEnded = this.scores.ended
    const list = this.el('live-scores')
    list.replaceChildren(...rows.map(row => scoreRow(row, 'li', this.scores.ended)))
    list.hidden = rows.length === 0
    list.setAttribute('aria-label', this.scores.ended ? '最终积分与称号' : '实时积分榜')
  }

  private resetMatchDisplay(): void {
    this.scores.reset()
    this.lastRows = null
    this.lastEnded = false
    this.rosterSize = -1
    this.world = emptyWorld()
    this.needsFull = true
    this.resyncSent = false
    this.ended = false
    this.bubbles = []
    this.roster = ''
    this.follow.replaceChildren(new Option('自由视角', ''))
    this.follow.disabled = true
    this.el('live-scores').replaceChildren()
    this.el('live-scores').hidden = true
    this.updateMatchState()
    this.el('live-phase').textContent = '\u2014'
    this.el('live-time').textContent = '0:00'
    this.el('live-count').textContent = '机器人 0'
    this.el('live-zoom').textContent = `${this.camera.zoom.toFixed(1)}\u00d7`
    this.deps.root.dataset.tick = '0'
  }

  private updateMatchState(): void {
    this.el('live-match').textContent = this.ended ? '已结束'
      : ['等待开场', '热身中', '对局中', '已结束'][this.roomState] ?? '\u2014'
  }

  private requestResync(): void {
    if (this.resyncSent) return
    this.resyncSent = true
    this.session.send(buildResync())
  }

  private updateRoster(): void {
    this.rosterSize = this.world.robots.size
    const robots = [...this.world.robots.values()].sort((a, b) => (a.base?.id ?? 0) - (b.base?.id ?? 0))
    const key = JSON.stringify(robots.map(r => [r.base?.id, r.nick]))
    if (key === this.roster) return
    this.roster = key
    this.follow.replaceChildren(new Option('自由视角', ''))
    for (const robot of robots) if (robot.base) this.follow.add(new Option(robot.nick || `#${robot.base.id}`, String(robot.base.id)))
    this.follow.disabled = robots.length === 0
  }

  private draw(): void {
    if (!this.map || this.disposed) return
    bgm.phase('live', this.world.phase)
    if (this.dpr !== (window.devicePixelRatio || 1)) { this.resize(); return }
    this.camera.update([...this.world.robots.values()].flatMap(r => r.base?.pos ? [{ id: r.base.id, pos: r.base.pos }] : []))
    const followValue = this.camera.followId === null ? '' : String(this.camera.followId)
    if (this.follow.value !== followValue) this.follow.value = followValue
    setText(this.zoomEl, `${this.camera.zoom.toFixed(1)}\u00d7`)
    if (this.bubbles.length) this.bubbles = this.bubbles.filter(b => performance.now() - b.at < 4000)
    this.renderer.render(this.world, this.map, this.camera.camera, { bubbles: this.bubbles })
  }

  private resize(): void {
    if (this.disposed) return
    const rect = this.deps.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    this.dpr = window.devicePixelRatio || 1
    this.renderer.resize(rect.width, rect.height, this.dpr)
    this.camera.resize(rect.width, rect.height, this.map?.extent ?? 80)
    this.draw()
  }

  private bindEvents(): void {
    const { canvas, root } = this.deps
    const camera = this.camera
    const signal = this.events.signal
    this.el('live-back').addEventListener('click', this.deps.onExit, { signal })
    this.retry.addEventListener('click', () => {
      if (this.session.state === 'connecting' || this.session.state === 'reconnecting') { this.session.retryNow(); return }
      this.session.close()
      this.session = new RoomSession()
      void this.connect(this.roomCode)
    }, { signal })
    this.follow.addEventListener('change', () => { camera.follow(this.follow.value ? Number(this.follow.value) : null); this.requestDraw() }, { signal })
    this.el('live-free').addEventListener('click', () => { camera.follow(null); this.requestDraw() }, { signal })
    this.el('live-fit').addEventListener('click', () => { camera.fit(); this.requestDraw() }, { signal })
    this.el('live-in').addEventListener('click', () => { camera.zoomAt(1.25); this.requestDraw() }, { signal })
    this.el('live-out').addEventListener('click', () => { camera.zoomAt(0.8); this.requestDraw() }, { signal })
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !e.isPrimary || !this.map) return
      canvas.focus({ preventScroll: true })
      canvas.setPointerCapture(e.pointerId)
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
      canvas.classList.add('dragging')
      e.preventDefault()
    }, { signal })
    canvas.addEventListener('pointermove', e => {
      if (!this.drag || e.pointerId !== this.drag.id) return
      camera.pan(e.clientX - this.drag.x, e.clientY - this.drag.y)
      this.drag.x = e.clientX; this.drag.y = e.clientY
      this.requestDraw()
    }, { signal })
    const release = (e: PointerEvent) => { if (e.pointerId === this.drag?.id) this.endDrag() }
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) canvas.addEventListener(event, release, { signal })
    window.addEventListener('blur', () => this.endDrag(), { signal })
    window.addEventListener('resize', () => this.resize(), { signal })
    canvas.addEventListener('wheel', e => {
      if (!this.map) return
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1
      camera.zoomAt(Math.exp(-Math.max(-400, Math.min(400, e.deltaY * units)) * 0.002), e.clientX - rect.left, e.clientY - rect.top)
      this.requestDraw()
    }, { signal, passive: false })
    root.addEventListener('keydown', e => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Escape') { e.preventDefault(); this.deps.onExit(); return }
      if (e.target !== canvas || !this.map) return
      switch (e.key) {
        case 'ArrowLeft': camera.pan(48, 0); break
        case 'ArrowRight': camera.pan(-48, 0); break
        case 'ArrowUp': camera.pan(0, 48); break
        case 'ArrowDown': camera.pan(0, -48); break
        case '+': case '=': camera.zoomAt(1.25); break
        case '-': case '_': camera.zoomAt(0.8); break
        case 'Home': camera.fit(); break
        default: return
      }
      e.preventDefault()
      this.requestDraw()
    }, { signal })
  }

  private endDrag(): void {
    const id = this.drag?.id
    this.drag = null
    const canvas = this.deps.canvas
    canvas.classList.remove('dragging')
    if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id)
  }

  dispose(): void {
    this.disposed = true
    this.session.close()
    cancelAnimationFrame(this.raf)
    this.endDrag()
    this.events.abort()
    this.observer.disconnect()
  }
}
