// 回放器视图：预载 NDJSON → ReplayIndex → 时间轴驱动的 canvas 回放。
// 复用游戏视图的相机/地图解析/绘制令牌；无自机（全景或点击机器人跟随）。
// 时间轴：拖动条（0→endTick）+ 播放/暂停/倍速（0.5/1/2/4×）+ 步进（±1s）。
// 事件叠加层：kill/core/uplink/phase 标记点，hover 显示详情。
import { Camera } from '../game/camera'
import { SpectatorCamera } from './spectator'
import { artReady } from '../game/art'
import { iconButton } from '../icons'
import { parseMapDef, type MapDefParsed } from '../game/mapdef'
import { ReplayIndex, type ReplayFrame, phaseName, numOr } from './index'
import { parseReplayNDJSON } from './model'
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
  private drag: { id: number; x: number; y: number } | null = null
  private raf = 0
  private disposed = false

  // 播放状态
  private playing = false
  private speed = 1
  private tick = 0
  /** 播放累计（浮点 tick，避免 0.5× 时整数截断） */
  private tickF = 0
  private lastFrameTime = 0
  private followRobotId: number | null = null
  private events = new AbortController()
  private resizeObserver?: ResizeObserver
  private pixelRatio = 0
  private scoreMarkup = ''

  // DOM 引用
  private el: Record<string, HTMLElement> = {}
  private timelineMarks: Array<{ tick: number; kind: string; detail: string }> = []
  private hoveredMark = -1

  constructor(private deps: ReplayPlayerDeps) {
    if (deps.spectator) {
      this.spectator = new SpectatorCamera()
      this.cam = this.spectator.camera
    }
    this.bindDom()
    this.bindEvents()
  }

  /** 载入并播放指定对局。 */
  async load(matchId: string): Promise<boolean> {
    if (this.disposed) return false
    this.setBusy(true)
    try {
      const [text] = await Promise.all([fetchReplayText(matchId), artReady])
      if (this.disposed) return false
      const data = parseReplayNDJSON(text)
      this.index = new ReplayIndex(data)
      // 地图来自 checkpoint.map（全量快照自带 MapDef）
      const mapJson = extractMapJson(data)
      this.map = mapJson ? parseMapDef(mapJson) : null
      if (!this.map) {
        this.deps.onError('回放数据缺少地图信息')
        return false
      }
      this.tick = 0
      this.tickF = 0
      this.followRobotId = null
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
      return true
    } catch (e) {
      const msg = e instanceof ReplayApiError || e instanceof Error ? e.message : String(e)
      if (!this.disposed) this.deps.onError(`回放载入失败: ${msg}`)
      return false
    } finally {
      if (!this.disposed) this.setBusy(false)
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
    listen(tl, 'pointerdown', () => this.pause())

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
    this.resizeObserver = new ResizeObserver(this.onResize)
    this.resizeObserver.observe(this.deps.canvas)
    this.onResize()
  }

  private bindSpectatorEvents(): void {
    const canvas = this.deps.canvas
    const camera = this.spectator!
    const signal = this.events.signal
    const select = this.el['sp-follow'] as HTMLSelectElement | undefined
    select?.addEventListener('change', () => {
      camera.follow(select.value === '' ? null : Number(select.value))
      this.drawFrame()
    }, { signal })
    this.el['sp-free']?.addEventListener('click', () => { camera.follow(null); this.drawFrame() }, { signal })
    this.el['sp-fit']?.addEventListener('click', () => { camera.fit(); this.drawFrame() }, { signal })
    this.el['sp-in']?.addEventListener('click', () => { camera.zoomAt(1.25); this.drawFrame() }, { signal })
    this.el['sp-out']?.addEventListener('click', () => { camera.zoomAt(0.8); this.drawFrame() }, { signal })
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !e.isPrimary || !this.index) return
      canvas.focus({ preventScroll: true })
      canvas.setPointerCapture(e.pointerId)
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
      canvas.classList.add('dragging')
      e.preventDefault()
    }, { signal })
    canvas.addEventListener('pointermove', e => {
      if (!this.drag || e.pointerId !== this.drag.id) return
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y
      if (dx === 0 && dy === 0) return
      camera.pan(dx, dy)
      this.drag.x = e.clientX; this.drag.y = e.clientY
      this.drawFrame()
    }, { signal })
    const release = (e: PointerEvent) => { if (e.pointerId === this.drag?.id) this.endDrag() }
    canvas.addEventListener('pointerup', release, { signal })
    canvas.addEventListener('pointercancel', release, { signal })
    canvas.addEventListener('lostpointercapture', release, { signal })
    window.addEventListener('blur', () => this.endDrag(), { signal })
    canvas.addEventListener('wheel', e => {
      if (!this.index) return
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1
      camera.zoomAt(Math.exp(-Math.max(-400, Math.min(400, e.deltaY * units)) * 0.002), e.clientX - rect.left, e.clientY - rect.top)
      this.drawFrame()
    }, { signal, passive: false })
    this.deps.root.addEventListener('keydown', e => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Escape') { e.preventDefault(); this.deps.onExit(); return }
      if (e.target !== canvas || !this.index) return
      switch (e.key) {
        case 'ArrowLeft': camera.pan(48, 0); break
        case 'ArrowRight': camera.pan(-48, 0); break
        case 'ArrowUp': camera.pan(0, 48); break
        case 'ArrowDown': camera.pan(0, -48); break
        case '+': case '=': camera.zoomAt(1.25); break
        case '-': case '_': camera.zoomAt(0.8); break
        case 'Home': camera.fit(); break
        case ' ': this.togglePlay(); break
        default: return
      }
      e.preventDefault()
      this.drawFrame()
    }, { signal })
  }

  private endDrag(): void {
    const id = this.drag?.id
    this.drag = null
    this.deps.canvas.classList.remove('dragging')
    if (id !== undefined && this.deps.canvas.hasPointerCapture(id)) this.deps.canvas.releasePointerCapture(id)
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
    cancelAnimationFrame(this.raf)
    const btn = this.el['rp-play']
    if (btn) iconButton(btn, 'play', '播放')
  }

  private togglePlay(): void {
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
    el.textContent = r ? `跟随: ${r.nick}` : '视角: 全景'
    el.hidden = false
  }

  // ---- 时间轴标记 -----------------------------------------------------------

  private buildTimeline(data: ReturnType<typeof parseReplayNDJSON>): void {
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
    cancelAnimationFrame(this.raf)
    const loop = (now: number) => {
      if (this.disposed || !this.playing) return
      const dt = Math.min(0.25, (now - this.lastFrameTime) / 1000)
      this.lastFrameTime = now
      if (this.index) {
        this.tickF += dt * TICK_HZ * this.speed
        if (this.tickF >= this.index.endTick) {
          this.tickF = this.index.endTick
          this.pause()
        }
        this.tick = Math.round(this.tickF)
        this.drawFrame()
      }
      if (this.playing) this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  private drawFrame(): void {
    if (!this.index || !this.map) return
    this.bindRenderer()
    const frame = this.index.frameAt(this.tick)
    // 相机：跟随或全景（地图中心）
    if (this.pixelRatio !== (window.devicePixelRatio || 1)) { this.resize(); return }
    if (this.spectator) {
      this.spectator.update(frame.robots)
      this.followRobotId = this.spectator.followId
      const select = this.el['sp-follow'] as HTMLSelectElement | undefined
      if (select) select.value = this.followRobotId === null ? '' : String(this.followRobotId)
      const zoom = this.el['sp-zoom']
      if (zoom) zoom.textContent = `${this.spectator.zoom.toFixed(1)}×`
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
    const dpr = window.devicePixelRatio || 1
    this.pixelRatio = dpr
    this.bindRenderer()
    this.renderer?.resize(rect.width, rect.height, dpr)
    if (this.spectator) this.spectator.resize(rect.width, rect.height, this.map?.extent ?? 100)
    else this.cam.resize(rect.width, rect.height, this.map?.extent ?? 100)
    this.drawFrame()
  }

  // ---- HUD ---------------------------------------------------------------

  private updateHud(frame: ReplayFrame): void {
    const tickEl = this.el['rp-tick']
    if (tickEl) tickEl.textContent = String(frame.tick)
    const timeEl = this.el['rp-time']
    if (timeEl) timeEl.textContent = fmtClock(frame.tick / TICK_HZ)
    const phaseEl = this.el['rp-phase']
    if (phaseEl) phaseEl.textContent = phaseName(frame.phase as any)
    // 比分表：事件累计分数排序
    const scoreEl = this.el['rp-score']
    if (scoreEl && this.index) {
      const rows = [...frame.scores.values()]
        .map((s) => {
          const r = this.index!.robots.get(s.id)
          return { nick: r?.nick ?? `#${s.id}`, color: r?.color ?? '#d8dee9', total: s.total, kill: s.kill, hit: s.hit, core: s.core, uplink: s.uplink, assist: s.assist }
        })
        .sort((a, b) => b.total - a.total)
      const markup = rows
        .map(
          (r) =>
            `<div class="rp-score-row"><span class="rp-score-dot" style="--c:${r.color}"></span>` +
            `<span class="rp-score-nick">${escapeHtml(r.nick)}</span>` +
            `<span class="rp-score-detail">K${r.kill} H${r.hit} C${r.core} U${r.uplink} A${r.assist}</span>` +
            `<span class="rp-score-total">${r.total}</span></div>`,
        )
        .join('')
      if (markup !== this.scoreMarkup) {
        scoreEl.innerHTML = markup
        this.scoreMarkup = markup
      }
    }
    // 时间轴滑块同步
    const tl = this.el['rp-timeline'] as HTMLInputElement | undefined
    if (tl && this.index) {
      tl.value = String(frame.tick)
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
    cancelAnimationFrame(this.raf)
    this.endDrag()
    this.events.abort()
    this.resizeObserver?.disconnect()
  }
}

// ---- 工具 ----------------------------------------------------------------

/** 从解析结果中提取 checkpoint.map（MapDef JSON 字符串化）。 */
function extractMapJson(data: ReturnType<typeof parseReplayNDJSON>): string | null {
  const rec = data.records.find((r) => r.state?.mapJson)
  return rec?.state?.mapJson ?? null
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}
