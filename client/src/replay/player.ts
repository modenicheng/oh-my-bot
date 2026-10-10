// 回放器视图：预载 NDJSON → ReplayIndex → 时间轴驱动的 canvas 回放。
// 复用游戏视图的相机/地图解析/绘制令牌；无自机（全景或点击机器人跟随）。
// 时间轴：拖动条（0→endTick）+ 播放/暂停/倍速（0.5/1/2/4×）+ 步进（±1s）。
// 事件叠加层：kill/core/uplink/phase 标记点，hover 显示详情。
import { Camera } from '../game/camera'
import { rankedScores, ScoreRowRenderer } from '../game/scoreboard'
import { bgm } from '../music/bgm'
import { SpectatorCamera } from './spectator'
import { artReady } from '../game/art'
import { CanvasStage } from '../game/canvas-stage'
import { iconButton } from '../icons'
import { parseMapDef, type MapDefParsed } from '../game/mapdef'
import { ReplayIndex, type ReplayFrame, phaseName, numOr } from './index'
import { bindSpectateControls } from './spectate-controls'
import { fmtClock, setText } from '../ui/dom'
import { parseReplayNDJSONAsync, type ReplayData } from './model'
import { ReplayRenderer } from './render'
import { fetchReplayText, ReplayApiError } from './api'

const TICK_HZ = 60
const SPEEDS = [0.5, 1, 2, 4] as const

/** 由调用方注入的 DOM（index.html 中的回放视图节点）。 */
export interface ReplayPlayerDeps {
  root: HTMLElement
  canvas: HTMLCanvasElement
  spectator?: boolean
  onExit: () => void
  /** 状态回调（加载错误显示在列表页）。 */
  onError: (msg: string) => void
}

export class ReplayPlayer {
  private index: ReplayIndex | null = null
  private map: MapDefParsed | null = null
  private renderer: ReplayRenderer | null = null
  private cam = new Camera()
  private spectator: SpectatorCamera | null = null
  private disposeControls: (() => void) | null = null
  private stage: CanvasStage
  private disposed = false

  // 播放状态
  private playing = false
  private resumeAfterScrub = false
  private speed = 1
  private tick = 0
  /** 播放累计（浮点 tick，避免 0.5× 时整数截断） */
  private tickF = 0
  private lastFrameTime = 0
  private followRobotId: number | null = null
  private events = new AbortController()
  private scoreMarkup = ''
  private readonly scoreRenderer = new ScoreRowRenderer()
  private lastTimelineTick = -1
  /** 载入代际号（审计 C-33）：并发 load 只认最新一代，慢回包不得覆盖新回放。 */
  private loadGen = 0

  // DOM 引用
  private el: Record<string, HTMLElement> = {}
  private timelineMarks: Array<{ tick: number; kind: string; detail: string }> = []
  private hoveredMark = -1

  constructor(private deps: ReplayPlayerDeps) {
    if (deps.spectator) {
      this.spectator = new SpectatorCamera()
      this.cam = this.spectator.camera
    }
    // 审计 C-26：rAF/RO/DPR 漂移交给 CanvasStage；播放时钟推进在 pump()。
    this.stage = new CanvasStage(deps.canvas, { draw: () => this.pump(), onResize: () => this.resize() })
    this.bindDom()
    this.bindEvents()
  }

  /** 载入并播放指定对局。'superseded' 表示已被更新的 load 取代（非错误，调用方不应回列表）。 */
  async load(matchId: string): Promise<'loaded' | 'failed' | 'superseded'> {
    if (this.disposed) return 'failed'
    const gen = ++this.loadGen
    this.setBusy(true)
    try {
      const [text] = await Promise.all([fetchReplayText(matchId), artReady])
      if (this.disposed) return 'failed'
      if (gen !== this.loadGen) return 'superseded'
      // 分片异步解析：长录像不再冻结主线程（loading 提示保持动画、可取消）。
      const data = await parseReplayNDJSONAsync(text)
      if (gen !== this.loadGen) return 'superseded'
      this.index = new ReplayIndex(data)
      // 地图来自 checkpoint.map（全量快照自带 MapDef）
      const mapJson = extractMapJson(data)
      this.map = mapJson ? parseMapDef(mapJson) : null
      if (!this.map) {
        this.deps.onError('回放数据缺少地图信息')
        return 'failed'
      }
      this.tick = 0
      this.tickF = 0
      this.followRobotId = null
      this.lastTimelineTick = -1
      this.spectator?.fit()
      const select = this.el['sp-follow'] as HTMLSelectElement | undefined
      if (this.spectator && select) {
        select.replaceChildren(new Option('自由视角', ''))
        for (const robot of this.index.robots.values()) select.add(new Option(`${robot.nick} · #${robot.id}`, String(robot.id)))
        select.disabled = false
      }
      if (this.spectator) this.deps.canvas.focus({ preventScroll: true })
      this.buildTimeline(data)
      this.updateSpeedUi()
      this.resize()
      this.play()
      return 'loaded'
    } catch (e) {
      if (this.disposed || gen !== this.loadGen) return 'superseded'
      const msg = e instanceof ReplayApiError || e instanceof Error ? e.message : String(e)
      this.deps.onError(`回放载入失败: ${msg}`)
      return 'failed'
    } finally {
      if (!this.disposed && gen === this.loadGen) this.setBusy(false)
    }
  }

  // ---- DOM 绑定 -----------------------------------------------------------

  private bindDom(): void {
    const root = this.deps.root
    const ids = [
      'rp-timeline', 'rp-play', 'rp-speed', 'rp-back', 'rp-fwd', 'rp-return',
      'rp-tick', 'rp-time', 'rp-phase', 'rp-score', 'rp-marks', 'rp-mark-tip',
      'rp-follow', 'rp-title', 'rp-status',
      'sp-follow', 'sp-free', 'sp-in', 'sp-out', 'sp-fit', 'sp-zoom',
    ]
    for (const id of ids) {
      const el = root.querySelector(`#${id}`)
      if (el instanceof HTMLElement) this.el[id] = el
    }
    const btnPlay = this.el['rp-play']
    if (btnPlay) iconButton(btnPlay, 'play', '播放')
  }

  private bindEvents(): void {
    const listen = (target: EventTarget | undefined, type: string, handler: (e: any) => void) => {
      target?.addEventListener(type, handler, { signal: this.events.signal })
    }
    const play = this.el['rp-play']
    listen(play, 'click', () => this.togglePlay())

    const speed = this.el['rp-speed']
    listen(speed, 'click', () => {
      const i = SPEEDS.indexOf(this.speed as (typeof SPEEDS)[number])
      this.speed = SPEEDS[(i + 1) % SPEEDS.length] ?? 1
      this.updateSpeedUi()
    })

    listen(this.el['rp-back'], 'click', () => this.step(-TICK_HZ))
    listen(this.el['rp-fwd'], 'click', () => this.step(TICK_HZ))
    listen(this.el['rp-return'], 'click', () => this.deps.onExit())

    const tl = this.el['rp-timeline'] as HTMLInputElement | undefined
    listen(tl, 'input', () => {
      this.seekTo(numOr(tl?.value, 0))
    })
    listen(tl, 'pointerdown', () => {
      this.resumeAfterScrub = this.playing
      this.pause()
    })
    const finishScrub = () => {
      if (!this.resumeAfterScrub) return
      this.resumeAfterScrub = false
      this.play()
    }
    listen(tl, 'pointerup', finishScrub)
    listen(tl, 'pointercancel', finishScrub)
    listen(tl, 'change', finishScrub)

    // 时间轴标记 hover 详情
    const marks = this.el['rp-marks']
    listen(marks, 'pointermove', (e) => this.onMarksHover(e))
    listen(marks, 'pointerleave', () => this.setMarkTip(-1))

    // Spectator navigation is scoped to this canvas; never bind GameController inputs.
    if (this.spectator) this.bindSpectatorEvents()
    else listen(this.deps.canvas, 'pointerdown', (e) => this.onCanvasClick(e))

    const follow = this.el['rp-follow']
    listen(follow, 'click', () => {
      this.followRobotId = null
      this.drawFrame()
    })

    listen(window, 'resize', this.onResize)
    this.onResize()
  }

  private bindSpectatorEvents(): void {
    // 与实况观战共用的滚轮/拖拽/键盘/按钮交互；Space 经 onSpace 切换播放。
    this.disposeControls = bindSpectateControls({
      root: this.deps.root,
      canvas: this.deps.canvas,
      camera: this.spectator!,
      enabled: () => this.index !== null,
      onExit: () => this.deps.onExit(),
      follow: this.el['sp-follow'] as HTMLSelectElement | undefined,
      free: this.el['sp-free'],
      fit: this.el['sp-fit'],
      zoomIn: this.el['sp-in'],
      zoomOut: this.el['sp-out'],
      onSpace: () => this.togglePlay(),
      requestDraw: () => this.drawFrame(),
    })
  }

  private onResize = (): void => {
    if (this.disposed) return
    this.resize()
  }

  private bindRenderer(): void {
    if (!this.renderer) this.renderer = new ReplayRenderer(this.deps.canvas)
  }

  // ---- 播放控制 -----------------------------------------------------------

  private play(): void {
    if (!this.index) return
    if (this.tick >= this.index.endTick) this.seekTo(0)
    this.playing = true
    this.lastFrameTime = performance.now()
    const btn = this.el['rp-play']
    if (btn) iconButton(btn, 'pause', '暂停')
    this.startRaf()
  }

  private pause(): void {
    this.playing = false
    this.stage.stop()
    const btn = this.el['rp-play']
    if (btn) iconButton(btn, 'play', '播放')
  }

  private togglePlay(): void {
    this.resumeAfterScrub = false
    this.playing ? this.pause() : this.play()
  }

  private step(ticks: number): void {
    if (!this.index) return
    this.pause()
    this.seekTo(this.tick + ticks)
  }

  private seekTo(t: number): void {
    if (!this.index) return
    this.tickF = Math.max(0, Math.min(this.index.endTick, t))
    this.tick = Math.round(this.tickF)
    this.drawFrame()
  }

  private updateSpeedUi(): void {
    const el = this.el['rp-speed']
    if (el) el.textContent = `${this.speed}×`
  }

  private updateFollowUi(): void {
    const el = this.el['rp-follow']
    if (!el || !this.index) return
    const r = this.followRobotId === null ? undefined : this.index.robots.get(this.followRobotId)
    setText(el, r ? `跟随: ${r.nick}` : '视角: 全景')
    if (el.hidden) el.hidden = false
  }

  // ---- 时间轴标记 -----------------------------------------------------------

  private buildTimeline(data: ReplayData): void {
    this.timelineMarks = []
    if (!this.index) return
    for (const m of this.index.marks) {
      this.timelineMarks.push({ tick: m.tick, kind: m.kind, detail: m.detail })
    }
    this.layoutMarks()
  }

  /** 在 rp-marks 容器里生成荧光标记点（绝对定位按 tick 比例）。 */
  private layoutMarks(): void {
    const box = this.el['rp-marks']
    if (!box || !this.index) return
    box.innerHTML = ''
    const end = Math.max(1, this.index.endTick)
    for (let i = 0; i < this.timelineMarks.length; i++) {
      const m = this.timelineMarks[i]!
      const dot = document.createElement('div')
      dot.className = `rp-mark rp-mark-${m.kind}`
      const pct = (m.tick / end) * 100
      dot.style.left = `${pct}%`
      dot.dataset.idx = String(i)
      box.appendChild(dot)
    }
  }

  private onMarksHover(e: PointerEvent): void {
    const box = this.el['rp-marks']
    if (!box) return
    const target = e.target as HTMLElement
    const idxStr = target?.dataset?.idx
    if (idxStr != null) {
      this.setMarkTip(numOr(idxStr, -1))
    } else {
      this.setMarkTip(-1)
    }
    void box
  }

  private setMarkTip(idx: number): void {
    const tip = this.el['rp-mark-tip']
    if (!tip) return
    this.hoveredMark = idx
    if (idx < 0 || idx >= this.timelineMarks.length) {
      tip.hidden = true
      return
    }
    const m = this.timelineMarks[idx]!
    const t = m.tick / TICK_HZ
    tip.textContent = `[${fmtClock(t)}] ${m.detail}`
    tip.hidden = false
    // 定位：跟随标记点
    if (this.index) {
      const pct = (m.tick / Math.max(1, this.index.endTick)) * 100
      tip.style.left = `${Math.min(85, Math.max(2, pct))}%`
    }
  }

  // ---- 渲染循环 -----------------------------------------------------------

  private startRaf(): void {
    this.stage.start({ always: true })
  }

  /** 播放时钟推进 + 出画（仅恒绘路径；scrub/resize 走 drawFrame 直绘，不推进时间）。 */
  private pump(): void {
    if (this.disposed || !this.playing) return
    const now = performance.now()
    const dt = Math.min(0.25, (now - this.lastFrameTime) / 1000)
    this.lastFrameTime = now
    if (!this.index) return
    this.tickF += dt * TICK_HZ * this.speed
    if (this.tickF >= this.index.endTick) {
      this.tickF = this.index.endTick
      this.pause() // stage.stop()：本轮 draw 返回后循环即退役（代际号失效）
    }
    this.tick = Math.round(this.tickF)
    this.drawFrame()
  }

  private drawFrame(): void {
    if (!this.index || !this.map) return
    this.bindRenderer()
    const frame = this.index.frameAt(this.tick)
    bgm.phase('replay', frame.phase)
    // 相机：跟随或全景（地图中心）
    if (this.spectator) {
      this.spectator.update(frame.robots)
      this.followRobotId = this.spectator.followId
      const select = this.el['sp-follow'] as HTMLSelectElement | undefined
      const followValue = this.followRobotId === null ? '' : String(this.followRobotId)
      if (select && select.value !== followValue) select.value = followValue
      setText(this.el['sp-zoom'], `${this.spectator.zoom.toFixed(1)}×`)
    } else if (this.followRobotId !== null) {
      this.cam.scale = Math.min(this.cam.cw / 40, this.cam.ch / 25)
      const r = frame.robots.find((x) => x.id === this.followRobotId)
      if (r && r.alive) this.cam.follow(r.pos.x, r.pos.y)
      else this.cam.follow(0, 0)
    } else {
      // Keep the entire arena between the heading and transport controls.
      const top = this.cam.cw <= 760 ? 106 : 72
      const bottom = 132
      const height = Math.max(80, this.cam.ch - top - bottom)
      this.cam.scale = Math.min(Math.max(80, this.cam.cw - 40), height) / (this.map.extent * 2 + 10)
      this.cam.cx = 0
      this.cam.cy = (this.cam.ch / 2 - (top + height / 2)) / this.cam.scale
    }
    this.renderer!.render(frame, this.map, this.cam, this.followRobotId ?? -1)
    this.updateHud(frame)
  }

  private resize(): void {
    const canvas = this.deps.canvas
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dpr = this.stage.dpr || window.devicePixelRatio || 1
    this.bindRenderer()
    this.renderer?.resize(rect.width, rect.height, dpr)
    if (this.spectator) this.spectator.resize(rect.width, rect.height, this.map?.extent ?? 100)
    else this.cam.resize(rect.width, rect.height, this.map?.extent ?? 100)
    this.drawFrame()
  }

  // ---- HUD ---------------------------------------------------------------

  private updateHud(frame: ReplayFrame): void {
    setText(this.el['rp-tick'], String(frame.tick))
    setText(this.el['rp-time'], fmtClock(frame.tick / TICK_HZ))
    setText(this.el['rp-phase'], phaseName(frame.phase as any))
    const scoreEl = this.el['rp-score']
    if (scoreEl && this.index) {
      const rows = rankedScores(frame.finalScores ?? [...frame.scores.values()].map(s => ({ robot: s.id, score: s.total })))
      // 签名只含 会发生变化的行内容（robot/score/titles）；不得混入 frame.tick——
      // tick 每帧必变会让缓存失效，积分面板被 60Hz 全量重写（审计 C-31）。
      // evidence 与 score 同源单调，行相同即 evidence 相同，不进签名。
      const signature = `${frame.finalScores !== null}:${rows.map(row => {
        const titles = 'titles' in row ? (row as { titles?: readonly number[] }).titles : undefined
        return `${row.robot},${row.score},${titles?.join('.') ?? ''}`
      }).join(';')}`
      if (signature !== this.scoreMarkup) {
        const displays = rows.map((row, i) => ({ ...row, rank: i + 1, nick: this.index!.robots.get(row.robot)?.nick ?? `#${row.robot}`,
          self: false, dead: false, status: 'unknown' as const, replayEvidence: frame.scores.get(row.robot) }))
        // Replay evidence is part of the keyed row structure, so seeking never
        // appends another evidence node to an existing row.
        this.scoreRenderer.update(scoreEl, displays, { titles: frame.finalScores !== null, ended: frame.finalScores !== null })
        scoreEl.setAttribute('aria-label', frame.finalScores ? '最终积分与称号' : '回放积分')
        this.scoreMarkup = signature
      }
    }
    // 时间轴滑块同步
    const tl = this.el['rp-timeline'] as HTMLInputElement | undefined
    if (tl && this.index) {
      if (this.lastTimelineTick !== frame.tick) {
        this.lastTimelineTick = frame.tick
        tl.value = String(frame.tick)
      }
      if (tl.max !== String(this.index.endTick)) tl.max = String(this.index.endTick)
    }
    // 跟随目标死亡时保持 UI
    this.updateFollowUi()
  }

  // ---- 交互 ---------------------------------------------------------------

  private onCanvasClick(e: PointerEvent): void {
    if (!this.index) return
    const rect = this.deps.canvas.getBoundingClientRect()
    const wx = this.cam.toWorldX(e.clientX - rect.left)
    const wy = this.cam.toWorldY(e.clientY - rect.top)
    // Full-map targets retain a 12px hit area at small viewport scales.
    const hitR = Math.max(1.1, 12 / this.cam.scale)
    let bestId: number | null = null
    let bestDist = Infinity
    const frame = this.index.frameAt(this.tick)
    for (const r of frame.robots) {
      if (!r.alive) continue
      const d = Math.hypot(r.pos.x - wx, r.pos.y - wy)
      if (d <= hitR && d < bestDist) {
        bestDist = d
        bestId = r.id
      }
    }
    this.followRobotId = bestId
    this.drawFrame()
  }

  // ---- 杂项 ---------------------------------------------------------------

  private setBusy(busy: boolean): void {
    const status = this.el['rp-status']
    if (status) {
      status.hidden = !busy
      status.textContent = busy ? '载入中…' : ''
    }
  }

  dispose(): void {
    this.disposed = true
    this.pause()
    this.disposeControls?.()
    this.events.abort()
    this.stage.dispose()
  }
}

// ---- 工具 ----------------------------------------------------------------

function extractMapJson(data: ReplayData): string | null {
  const rec = data.records.find((r) => r.state?.mapJson)
  return rec?.state?.mapJson ?? null
}
