// CanvasStage：canvas + DPR 后备缓冲 + rAF 宿主（审计 C-26）。
// 三处手写循环（controls / live / replay-player）共用：同尺寸短路、DPR 漂移
// 逐帧检测、ResizeObserver 与 rAF 生命周期集中在这里，绘制回调只管画。
// 两种模式：start({ always: true }) 恒绘（游戏画面含时间驱动动效）；
// 默认脏标记模式——requestDraw() 合帧重绘，空闲不重绘（live 的既有语义）。
import { createCanvas2d, resizeCanvas2d } from './art'

export interface CanvasStageOpts {
  /** 帧绘制（stage 已保证后备缓冲与 ctx 就绪；可在回调内 stop()，不会泄漏续帧）。 */
  draw: () => void
  /** 后备缓冲尺寸/DPR 变化（含首次同步）：调用方同步相机等派生状态。 */
  onResize: (w: number, h: number, dpr: number) => void
}

export class CanvasStage {
  readonly ctx: CanvasRenderingContext2D
  private observer: ResizeObserver
  private raf = 0
  /** 代际号：stop() 后在途的已调度帧立即失效（draw 回调内 stop 亦安全）。 */
  private gen = 0
  private dpr_ = 0
  private w = 0
  private h = 0
  private sizeDirty = true
  private dirty = true
  private always = false
  private disposed = false

  constructor(private canvas: HTMLCanvasElement, private opts: CanvasStageOpts) {
    this.ctx = createCanvas2d(canvas)
    // RO 同步触发 syncSize：循环停着（如暂停的回放）时窗口变化也要立即出画。
    this.observer = new ResizeObserver(() => { this.sizeDirty = true; this.dirty = true; this.syncSize() })
    this.observer.observe(canvas)
  }

  /** 最近一次同步的 devicePixelRatio（首同步前为 0，调用方需兜底）。 */
  get dpr(): number { return this.dpr_ }

  /** 标记下一帧重绘（rAF 合帧；相机交互/快照路径可安全高频调用）。 */
  requestDraw(): void { this.dirty = true }

  /** 启动 rAF 循环；已在运行则幂等。 */
  start(opts?: { always?: boolean }): void {
    if (this.disposed || this.raf) return
    this.always = !!opts?.always
    const gen = ++this.gen
    const loop = () => {
      if (this.disposed || gen !== this.gen) return
      if (this.syncSize() || this.always || this.dirty) {
        this.dirty = false
        this.opts.draw()
      }
      if (gen === this.gen) this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    this.gen++
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /** 立即同步尺寸并画一帧（scrub/地图切换等需要同步出画的路径）。 */
  drawOnce(): void {
    if (this.disposed) return
    this.syncSize()
    this.dirty = false
    this.opts.draw()
  }

  /** 检测 RO/DPR 漂移并同步后备缓冲；变化时回调 onResize。返回是否变化。 */
  syncSize(): boolean {
    if (this.disposed) return false
    const dpr = window.devicePixelRatio || 1
    if (!this.sizeDirty && dpr === this.dpr_) return false
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    this.sizeDirty = false
    const changed = rect.width !== this.w || rect.height !== this.h || dpr !== this.dpr_
    this.w = rect.width
    this.h = rect.height
    this.dpr_ = dpr
    resizeCanvas2d(this.canvas, rect.width, rect.height, dpr)
    this.opts.onResize(rect.width, rect.height, dpr)
    return changed
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.observer.disconnect()
  }
}
