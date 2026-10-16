import { HISTORY_MS, SAMPLE_MS, scaleCeiling, type Metric } from './history'
import { DebugSampler } from './sampler'
import './panel.css'

interface Series { key: Metric; color: string; label?: string }
interface Chart { title: string; unit: string; series: Series[]; minimum: number; integer?: boolean }

const CYAN = '#22d3ee'
const LIME = '#a3e635'
const BACKGROUND = '#10141a'
const ROW_HEIGHT = 58
const charts: Chart[] = [
  { title: '帧率', unit: 'FPS', series: [{ key: 'fps', color: CYAN }], minimum: 30 },
  { title: 'JS 堆', unit: 'MiB', series: [{ key: 'heapMiB', color: CYAN }], minimum: 1 },
  { title: 'WS 带宽', unit: 'KiB/s', minimum: 1, series: [
    { key: 'receivedKiB', color: CYAN, label: '收' }, { key: 'sentKiB', color: LIME, label: '发' },
  ] },
  { title: 'WS 消息', unit: '条/s', minimum: 1, series: [
    { key: 'receivedMessages', color: CYAN, label: '收' }, { key: 'sentMessages', color: LIME, label: '发' },
  ] },
  { title: 'WS 连接', unit: '个', series: [{ key: 'connections', color: CYAN }], minimum: 1, integer: true },
  { title: 'RTT', unit: 'ms', series: [{ key: 'rttMs', color: CYAN }], minimum: 10 },
]
const HEIGHT = charts.length * ROW_HEIGHT

function number(value: number, integer = false): string {
  return value.toFixed(integer || value >= 100 ? 0 : 1)
}

/** One canvas for all readings and graphs; no DOM writes or layout reads on the frame path. */
export class DebugPanel {
  readonly root = document.createElement('aside')
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly observer: ResizeObserver
  private readonly sampler = new DebugSampler()
  private width = 0
  private dpr = 0
  private raf: number | undefined
  private suspended = false
  private disposed = false

  constructor() {
    this.root.className = 'debug-panel'
    this.root.id = 'debug-panel'
    this.root.hidden = true
    this.root.setAttribute('aria-label', '开发者调试面板')
    this.root.innerHTML = '<header><h2>开发者调试</h2><span>30s / 自动缩放</span><button type="button" aria-label="关闭调试面板">F3 关闭</button></header>'
    this.root.querySelector('button')!.addEventListener('click', () => this.hide())
    this.canvas.setAttribute('role', 'img')
    this.canvas.setAttribute('aria-label', '最近 30 秒：帧率、JS 堆、WS 上下行带宽、消息速率、活跃连接数、RTT')
    this.canvas.title = '青色：接收；绿色：发送。仅统计应用 WS 载荷（含心跳），不含 HTTP/TLS 与帧头。JS 堆为浏览器估计，不支持时显示不可用。RTT 为活跃 WS 最近心跳测量的最大值。'
    this.root.append(this.canvas)
    const footer = document.createElement('footer')
    footer.innerHTML = '<span>-30s</span><span>采样 250ms / 过期淘汰</span><span>现在</span>'
    this.root.append(footer)
    document.body.append(this.root)
    this.ctx = this.canvas.getContext('2d', { alpha: false })!
    this.observer = new ResizeObserver(entries => {
      this.width = entries[0]!.contentRect.width
      if (!this.root.hidden) this.render(performance.now())
    })
    this.observer.observe(this.canvas)
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('pagehide', this.onPageHide)
    window.addEventListener('pageshow', this.onPageShow)
    document.addEventListener('visibilitychange', this.syncActivity)
    this.syncActivity()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.observer.disconnect()
    this.sampler.clear()
    window.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('pagehide', this.onPageHide)
    window.removeEventListener('pageshow', this.onPageShow)
    document.removeEventListener('visibilitychange', this.syncActivity)
    this.root.remove()
  }

  private hide(): void {
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
    this.root.hidden = true
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.code !== 'F3' && event.key !== 'F3') return
    if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.repeat) return
    if (this.root.hidden) {
      this.root.hidden = false
      // Showing the panel is the only synchronous layout read; resize uses the observer.
      this.width = this.canvas.getBoundingClientRect().width
      this.render(performance.now())
    } else this.hide()
  }

  private readonly onPageHide = (): void => {
    this.suspended = true
    this.stop()
    this.sampler.clear()
  }

  private readonly onPageShow = (): void => {
    this.suspended = false
    this.syncActivity()
  }

  private readonly syncActivity = (): void => {
    if (this.disposed) return
    if (document.hidden || this.suspended) {
      this.stop()
      return
    }
    if (this.raf !== undefined) return
    const now = performance.now()
    this.sampler.resume(now)
    if (!this.root.hidden) this.render(now)
    this.raf = requestAnimationFrame(this.frame)
  }

  private readonly frame = (now: number): void => {
    // Most frames only increment a counter and compare timestamps; sampling/drawing is 4 Hz.
    if (this.sampler.frame(now) && !this.root.hidden) this.render(now)
    this.raf = requestAnimationFrame(this.frame)
  }

  private stop(): void {
    if (this.raf !== undefined) cancelAnimationFrame(this.raf)
    this.raf = undefined
  }

  private render(now: number): void {
    if (this.width <= 0 || !this.ctx) return
    this.sampler.history.prune(now)
    const ctx = this.ctx
    const dpr = window.devicePixelRatio || 1
    // Keep the backing store stable between resizes instead of clearing Canvas state every draw.
    if (this.dpr !== dpr || this.canvas.width !== Math.round(this.width * dpr)) {
      this.dpr = dpr
      this.canvas.width = Math.round(this.width * dpr)
      this.canvas.height = Math.round(HEIGHT * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    ctx.fillStyle = BACKGROUND
    ctx.fillRect(0, 0, this.width, HEIGHT)
    for (let row = 0; row < charts.length; row++) this.drawChart(charts[row]!, row * ROW_HEIGHT, now)
  }

  private drawChart(chart: Chart, offset: number, now: number): void {
    const ctx = this.ctx
    const history = this.sampler.history
    const size = history.size
    const right = this.width - 2
    let peak = 0
    for (const series of chart.series) {
      for (let i = 0; i < size; i++) {
        const value = history.valueAt(i, series.key)
        if (value > peak) peak = value
      }
    }
    // Byte-sized heartbeat traffic should remain readable in an otherwise idle connection.
    const factor = chart.unit === 'KiB/s' && peak < 1 ? 1024 : 1
    const unit = factor === 1024 ? 'B/s' : chart.unit
    const ceiling = scaleCeiling(peak * factor, chart.minimum)
    ctx.font = '11px ui-monospace, monospace'
    ctx.textAlign = 'left'
    ctx.fillStyle = '#d8dee9'
    ctx.fillText(chart.title, 0, offset + 12)
    ctx.font = '10px ui-monospace, monospace'
    ctx.textAlign = 'right'
    let textRight = right
    for (let i = chart.series.length - 1; i >= 0; i--) {
      const series = chart.series[i]!
      const value = this.sampler.latest?.[series.key]
      const reading = value == null ? (this.sampler.latest ? '不可用' : '等待采样') : `${number(value * factor, chart.integer)} ${unit}`
      const text = `${series.label ? `${series.label} ` : ''}${reading}`
      ctx.fillStyle = series.color
      ctx.fillText(text, textRight, offset + 12)
      textRight -= ctx.measureText(text).width + 10
    }

    const left = 35
    const top = offset + 22
    const bottom = offset + ROW_HEIGHT - 5
    const plotWidth = right - left
    const plotHeight = bottom - top
    ctx.lineWidth = 1
    ctx.strokeStyle = '#1f2733'
    ctx.beginPath()
    for (let tick = 0; tick <= 3; tick++) {
      const x = left + plotWidth * tick / 3
      ctx.moveTo(x, top); ctx.lineTo(x, bottom)
    }
    for (let tick = 0; tick <= 2; tick++) {
      const y = top + plotHeight * tick / 2
      ctx.moveTo(left, y); ctx.lineTo(right, y)
    }
    ctx.stroke()
    ctx.font = '9px ui-monospace, monospace'
    ctx.fillStyle = '#8b98a9'
    ctx.fillText(number(ceiling, chart.integer), left - 4, top + 3)
    ctx.fillText('0', left - 4, bottom)
    for (const series of chart.series) {
      ctx.beginPath()
      ctx.strokeStyle = series.color
      ctx.lineWidth = 1.25
      let previousTime = -Infinity
      let previousValue = 0
      let lastX = 0
      let lastY = 0
      for (let i = 0; i < size; i++) {
        const time = history.timeAt(i)
        const value = history.valueAt(i, series.key)
        if (!Number.isFinite(value)) { previousTime = -Infinity; continue }
        const x = left + (time - (now - HISTORY_MS)) / HISTORY_MS * plotWidth
        const y = bottom - value * factor / ceiling * plotHeight
        // Suspended tabs and unavailable measurements leave a gap in the trace.
        if (time - previousTime > SAMPLE_MS * 2) ctx.moveTo(x, y)
        else if (chart.integer) {
          ctx.lineTo(x, bottom - previousValue * factor / ceiling * plotHeight)
          ctx.lineTo(x, y)
        } else ctx.lineTo(x, y)
        previousTime = time
        previousValue = value
        lastX = x
        lastY = y
      }
      ctx.stroke()
      if (previousTime !== -Infinity) {
        ctx.fillStyle = series.color
        ctx.fillRect(lastX - 1, lastY - 1, 2, 2)
      }
    }
  }
}
