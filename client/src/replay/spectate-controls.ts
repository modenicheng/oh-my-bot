// 实况观战（live.ts）与录像观战（replay/player.ts）共用的相机交互接线。
// 两个视图行为逐位一致：滚轮 deltaMode 归一（行 ×16 / 页 ×视口高）+ ±400 钳制
// + 0.002 指数灵敏度；方向键 48px 平移；Home 全图复位；Escape 先于
// enabled/焦点门；修饰键/输入法守卫；指针捕获 + dragging 类 +
// pointerup/pointercancel/lostpointercapture/窗口失焦清理；跟随/自由/复位/缩放按钮。
// 播放语义留在调用方：live 无 Space 动作，replay 经 onSpace 切换播放；
// 重绘入口由调用方注入（live: requestDraw，replay: drawFrame）。
import type { SpectatorCamera } from './spectator'

const PAN_STEP_PX = 48
const ZOOM_IN = 1.25
const ZOOM_OUT = 0.8

/** 滚轮 deltaMode 归一：行模式 ×16，页模式 ×视口高，像素（含未知模式）×1。 */
export function wheelUnits(deltaMode: number, viewportHeight: number): number {
  return deltaMode === 1 ? 16 : deltaMode === 2 ? viewportHeight : 1
}

/** 纯滚轮数学：|delta| 钳到 400 后映射为指数缩放因子（>1 放大，<1 缩小）。 */
export function wheelZoomFactor(deltaY: number, units: number): number {
  return Math.exp(-Math.max(-400, Math.min(400, deltaY * units)) * 0.002)
}

export interface SpectateControlsDeps {
  /** keydown 委托根（视图容器）。 */
  root: HTMLElement
  canvas: HTMLCanvasElement
  camera: SpectatorCamera
  /** 数据就绪门：false 时滚轮/拖拽/键盘导航全部惰性（Escape 仍生效）。 */
  enabled: () => boolean
  /** Escape 出口（live: 关闭观战页，replay: 返回列表）。 */
  onExit: () => void
  /** 跟随下拉框；无花名册的视图可省略。 */
  follow?: HTMLSelectElement
  /** 自由视角按钮。 */
  free?: HTMLElement
  /** 全图复位按钮。 */
  fit?: HTMLElement
  /** 放大按钮（×1.25）。 */
  zoomIn?: HTMLElement
  /** 缩小按钮（×0.8）。 */
  zoomOut?: HTMLElement
  /** Space 动作；缺省时 Space 不拦截（live 语义）。 */
  onSpace?: () => void
  /** 相机变化后的重绘入口。 */
  requestDraw: () => void
}

/** 绑定共享观战交互；返回 dispose（移除全部监听并结束进行中的拖拽）。 */
export function bindSpectateControls(deps: SpectateControlsDeps): () => void {
  const { canvas, camera, requestDraw } = deps
  const ac = new AbortController()
  const signal = ac.signal
  let drag: { id: number; x: number; y: number } | null = null

  const endDrag = (): void => {
    const id = drag?.id
    drag = null
    canvas.classList.remove('dragging')
    if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id)
  }

  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.isPrimary || !deps.enabled()) return
    canvas.focus({ preventScroll: true })
    canvas.setPointerCapture(e.pointerId)
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
    canvas.classList.add('dragging')
    e.preventDefault()
  }, { signal })

  canvas.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    if (dx === 0 && dy === 0) return // 同点重复派发不触发平移/重绘
    camera.pan(dx, dy)
    drag.x = e.clientX
    drag.y = e.clientY
    requestDraw()
  }, { signal })

  const release = (e: PointerEvent): void => { if (e.pointerId === drag?.id) endDrag() }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    canvas.addEventListener(type, release, { signal })
  }
  window.addEventListener('blur', () => endDrag(), { signal })

  canvas.addEventListener('wheel', e => {
    if (!deps.enabled()) return
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const units = wheelUnits(e.deltaMode, rect.height)
    camera.zoomAt(wheelZoomFactor(e.deltaY, units), e.clientX - rect.left, e.clientY - rect.top)
    requestDraw()
  }, { signal, passive: false })

  deps.root.addEventListener('keydown', e => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
    // Escape 先于 enabled/焦点门：任何时候都可退出观战视图。
    if (e.key === 'Escape') { e.preventDefault(); deps.onExit(); return }
    if (e.target !== canvas || !deps.enabled()) return
    switch (e.key) {
      case 'ArrowLeft': camera.pan(PAN_STEP_PX, 0); break
      case 'ArrowRight': camera.pan(-PAN_STEP_PX, 0); break
      case 'ArrowUp': camera.pan(0, PAN_STEP_PX); break
      case 'ArrowDown': camera.pan(0, -PAN_STEP_PX); break
      case '+': case '=': camera.zoomAt(ZOOM_IN); break
      case '-': case '_': camera.zoomAt(ZOOM_OUT); break
      case 'Home': camera.fit(); break
      case ' ':
        if (!deps.onSpace) return
        deps.onSpace()
        break
      default: return
    }
    e.preventDefault()
    requestDraw()
  }, { signal })

  const follow = deps.follow
  follow?.addEventListener('change', () => {
    camera.follow(follow.value === '' ? null : Number(follow.value))
    requestDraw()
  }, { signal })
  deps.free?.addEventListener('click', () => { camera.follow(null); requestDraw() }, { signal })
  deps.fit?.addEventListener('click', () => { camera.fit(); requestDraw() }, { signal })
  deps.zoomIn?.addEventListener('click', () => { camera.zoomAt(ZOOM_IN); requestDraw() }, { signal })
  deps.zoomOut?.addEventListener('click', () => { camera.zoomAt(ZOOM_OUT); requestDraw() }, { signal })

  return () => {
    ac.abort()
    endDrag()
  }
}
