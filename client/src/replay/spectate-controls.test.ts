// bindSpectateControls 共享观战交互的单元测试。
// 仓库单测无 jsdom，按 dom.test.ts 惯例用最小 DOM 桩：只实现被测路径用到的
// addEventListener / classList / 指针捕获 / getBoundingClientRect。
// 相机用记录型 spy，直接断言 pan/zoomAt/fit/follow 的实参（含滚轮数学的精确值）。
import { describe, expect, it, vi } from 'vitest'
import { bindSpectateControls, wheelUnits, wheelZoomFactor } from './spectate-controls'
import type { SpectatorCamera } from './spectator'

// ---- 桩 -------------------------------------------------------------------

type Handler = (e: any) => void

function stubTarget() {
  const bound: Array<{ type: string; handler: Handler }> = []
  return {
    bound,
    // 与真实 DOM 一致：{ signal } 注册的监听在 abort 时移除。
    addEventListener(type: string, handler: Handler, options?: { signal?: AbortSignal }): void {
      const signal = options?.signal
      if (signal?.aborted) return
      const entry = { type, handler }
      bound.push(entry)
      signal?.addEventListener('abort', () => {
        const i = bound.indexOf(entry)
        if (i >= 0) bound.splice(i, 1)
      }, { once: true })
    },
    fire(type: string, props: Record<string, unknown> = {}) {
      let prevented = false
      const event = {
        ...props,
        preventDefault() { prevented = true },
        get defaultPrevented() { return prevented },
      }
      for (const { type: t, handler } of [...bound]) if (t === type) handler(event)
      return event
    },
  }
}

function spyCamera() {
  return {
    pans: [] as Array<[number, number]>,
    zooms: [] as Array<[number, number, number]>,
    fits: 0,
    follows: [] as Array<number | null>,
    pan(dx: number, dy: number) { this.pans.push([dx, dy]) },
    zoomAt(factor: number, x = 0, y = 0) { this.zooms.push([factor, x, y]) },
    fit() { this.fits++ },
    follow(id: number | null) { this.follows.push(id) },
  }
}

function stubCanvas(rect = { left: 10, top: 20, width: 400, height: 300 }) {
  const target = stubTarget()
  const captures: number[] = []
  const releases: number[] = []
  const focuses: unknown[] = []
  const captured = new Set<number>()
  const classes = new Set<string>()
  const node = {
    ...target,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    focus(opts?: unknown) { focuses.push(opts) },
    setPointerCapture(id: number) { captures.push(id); captured.add(id) },
    releasePointerCapture(id: number) { releases.push(id); captured.delete(id) },
    hasPointerCapture: (id: number) => captured.has(id),
    getBoundingClientRect: () => rect,
  }
  return { node, target, captures, releases, focuses, classes, rect }
}

interface Harness {
  canvas: ReturnType<typeof stubCanvas>
  root: ReturnType<typeof stubTarget>
  camera: ReturnType<typeof spyCamera>
  draws: number[]
  exits: number[]
  spaces: number[]
  /** 模块在 bind 时读 window.addEventListener：用真实 EventTarget 桩接住 blur。 */
  windowBus: EventTarget
  dispose: () => void
}

function setup(overrides: Record<string, unknown> = {}): Harness {
  const windowBus = new EventTarget()
  vi.stubGlobal('window', windowBus)
  const canvas = stubCanvas()
  const root = stubTarget()
  const camera = spyCamera()
  const draws: number[] = []
  const exits: number[] = []
  const spaces: number[] = []
  const deps = {
    root: root as unknown as HTMLElement,
    canvas: canvas.node as unknown as HTMLCanvasElement,
    camera: camera as unknown as SpectatorCamera,
    enabled: () => true,
    onExit: () => { exits.push(1) },
    requestDraw: () => { draws.push(1) },
    ...overrides,
  }
  return {
    canvas, root, camera, draws, exits, spaces, windowBus,
    dispose: bindSpectateControls(deps as any),
  }
}

function key(harness: Harness, props: Record<string, unknown>) {
  return harness.root.fire('keydown', props)
}

function pointerDown(harness: Harness, pointerId = 5, clientX = 100, clientY = 50, extra: Record<string, unknown> = {}) {
  return harness.canvas.target.fire('pointerdown', {
    button: 0, isPrimary: true, pointerId, clientX, clientY, ...extra,
  })
}

// ---- 纯滚轮数学 -----------------------------------------------------------

describe('wheelZoomFactor', () => {
  it('把像素 delta 映射为指数缩放因子（下滚缩小、上滚放大）', () => {
    expect(wheelZoomFactor(100, 1)).toBeCloseTo(Math.exp(-0.2))
    expect(wheelZoomFactor(-100, 1)).toBeCloseTo(Math.exp(0.2))
    expect(wheelZoomFactor(0, 1)).toBe(1)
  })

  it('|delta| 在 ±400 处钳制', () => {
    expect(wheelZoomFactor(1e9, 1)).toBeCloseTo(Math.exp(-0.8))
    expect(wheelZoomFactor(-1e9, 1)).toBeCloseTo(Math.exp(0.8))
    expect(wheelZoomFactor(401, 1)).toBeCloseTo(Math.exp(-0.8))
    expect(wheelZoomFactor(400, 1)).toBeCloseTo(Math.exp(-0.8))
  })

  it('units 线性放大 delta 后再钳制', () => {
    expect(wheelZoomFactor(10, 16)).toBeCloseTo(Math.exp(-0.32))
    expect(wheelZoomFactor(10, 30)).toBeCloseTo(Math.exp(-0.6))
    // 10 × 300 = 3000 与 10 × 60 = 600 均超出 400 → 钳到 400
    expect(wheelZoomFactor(10, 300)).toBeCloseTo(Math.exp(-0.8))
    expect(wheelZoomFactor(10, 60)).toBeCloseTo(Math.exp(-0.8))
  })
})

describe('wheelUnits', () => {
  it('行模式 ×16、页模式 ×视口高、像素与未知模式 ×1', () => {
    expect(wheelUnits(0, 300)).toBe(1)
    expect(wheelUnits(1, 300)).toBe(16)
    expect(wheelUnits(2, 300)).toBe(300)
    expect(wheelUnits(3, 300)).toBe(1)
  })
})

// ---- 滚轮交互 -------------------------------------------------------------

describe('wheel interaction', () => {
  it('按指针锚点缩放并请求重绘', () => {
    const h = setup()
    // rect {left:10, top:20}; clientX 110, clientY 70 → 锚点 (100, 50)
    const e = h.canvas.target.fire('wheel', { deltaY: 100, deltaMode: 0, clientX: 110, clientY: 70 })
    expect(e.defaultPrevented).toBe(true)
    expect(h.camera.zooms).toEqual([[Math.exp(-0.2), 100, 50]])
    expect(h.draws).toEqual([1])
  })

  it('deltaMode 行/页先归一再参与缩放', () => {
    const line = setup()
    line.canvas.target.fire('wheel', { deltaY: 10, deltaMode: 1, clientX: 0, clientY: 0 })
    expect(line.camera.zooms[0]![0]).toBeCloseTo(Math.exp(-10 * 16 * 0.002))

    const page = setup()
    page.canvas.target.fire('wheel', { deltaY: 10, deltaMode: 2, clientX: 0, clientY: 0 })
    // 10 × 300 = 3000 → 钳到 400
    expect(page.camera.zooms[0]![0]).toBeCloseTo(Math.exp(-0.8))

    const pixel = setup()
    pixel.canvas.target.fire('wheel', { deltaY: 10, deltaMode: 0, clientX: 0, clientY: 0 })
    expect(pixel.camera.zooms[0]![0]).toBeCloseTo(Math.exp(-0.02))
  })

  it('未就绪（enabled=false）时滚轮放行页面滚动', () => {
    const h = setup({ enabled: () => false })
    const e = h.canvas.target.fire('wheel', { deltaY: 100, deltaMode: 0, clientX: 0, clientY: 0 })
    expect(e.defaultPrevented).toBe(false)
    expect(h.camera.zooms).toEqual([])
    expect(h.draws).toEqual([])
  })
})

// ---- 键盘 -----------------------------------------------------------------

describe('keyboard interaction', () => {
  it('方向键按 48px 平移且符号与画布朝向一致', () => {
    const h = setup()
    key(h, { key: 'ArrowLeft', target: h.canvas.node })
    key(h, { key: 'ArrowRight', target: h.canvas.node })
    key(h, { key: 'ArrowUp', target: h.canvas.node })
    key(h, { key: 'ArrowDown', target: h.canvas.node })
    expect(h.camera.pans).toEqual([[48, 0], [-48, 0], [0, 48], [0, -48]])
    expect(h.draws).toHaveLength(4)
  })

  it('加减号缩放 1.25/0.8，Home 全图复位，均 preventDefault + 重绘', () => {
    const h = setup()
    for (const k of ['+', '=', '-', '_', 'Home']) {
      const e = key(h, { key: k, target: h.canvas.node })
      expect(e.defaultPrevented).toBe(true)
    }
    expect(h.camera.zooms.map(z => z[0])).toEqual([1.25, 1.25, 0.8, 0.8])
    expect(h.camera.fits).toBe(1)
    expect(h.draws).toHaveLength(5)
  })

  it('Escape 先于 enabled/焦点门：任何时候都可退出', () => {
    const h = setup({ enabled: () => false })
    const e = key(h, { key: 'Escape', target: { other: true } })
    expect(e.defaultPrevented).toBe(true)
    expect(h.exits).toEqual([1])
    expect(h.camera.pans).toEqual([])
    expect(h.draws).toEqual([])
  })

  it('修饰键/输入法守卫先于 Escape 与导航', () => {
    const h = setup()
    for (const guard of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      key(h, { key: 'Escape', ...guard })
      key(h, { key: 'ArrowLeft', target: h.canvas.node, ...guard })
    }
    expect(h.exits).toEqual([])
    expect(h.camera.pans).toEqual([])
    expect(h.draws).toEqual([])
  })

  it('焦点不在画布或未就绪时导航键不拦截', () => {
    const elsewhere = setup()
    const e1 = key(elsewhere, { key: 'ArrowLeft', target: { other: true } })
    expect(e1.defaultPrevented).toBe(false)
    expect(elsewhere.camera.pans).toEqual([])

    const disabled = setup({ enabled: () => false })
    const e2 = key(disabled, { key: 'ArrowLeft', target: disabled.canvas.node })
    expect(e2.defaultPrevented).toBe(false)
    expect(disabled.camera.pans).toEqual([])
    expect(disabled.draws).toEqual([])
  })

  it('未映射的按键不拦截也不重绘', () => {
    const h = setup()
    const e = key(h, { key: 'x', target: h.canvas.node })
    expect(e.defaultPrevented).toBe(false)
    expect(h.draws).toEqual([])
    expect(h.camera.pans).toEqual([])
  })

  it('live 语义：未提供 onSpace 时 Space 不拦截', () => {
    const h = setup()
    const e = key(h, { key: ' ', target: h.canvas.node })
    expect(e.defaultPrevented).toBe(false)
    expect(h.draws).toEqual([])
  })

  it('replay 语义：提供 onSpace 时 Space 触发动作并拦截', () => {
    const spaces: number[] = []
    const h = setup({ onSpace: () => { spaces.push(1) } })
    const e = key(h, { key: ' ', target: h.canvas.node })
    expect(spaces).toEqual([1])
    expect(e.defaultPrevented).toBe(true)
    expect(h.draws).toEqual([1])
  })
})

// ---- 拖拽 -----------------------------------------------------------------

describe('drag lifecycle', () => {
  it('主键按下：聚焦、指针捕获、dragging 类、preventDefault，且不重绘', () => {
    const h = setup()
    const e = pointerDown(h)
    expect(e.defaultPrevented).toBe(true)
    expect(h.canvas.focuses).toEqual([{ preventScroll: true }])
    expect(h.canvas.captures).toEqual([5])
    expect(h.canvas.classes.has('dragging')).toBe(true)
    expect(h.draws).toEqual([])
  })

  it('非主键/非主指针/未就绪时不进入拖拽', () => {
    const secondary = setup()
    secondary.canvas.target.fire('pointerdown', { button: 2, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0 })
    const auxiliary = setup()
    auxiliary.canvas.target.fire('pointerdown', { button: 0, isPrimary: false, pointerId: 1, clientX: 0, clientY: 0 })
    const disabled = setup({ enabled: () => false })
    disabled.canvas.target.fire('pointerdown', { button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0 })
    for (const h of [secondary, auxiliary, disabled]) {
      expect(h.canvas.captures).toEqual([])
      expect(h.canvas.focuses).toEqual([])
      expect(h.canvas.classes.has('dragging')).toBe(false)
    }
  })

  it('按增量平移，同点重复 pointermove 跳过（零增量归一化）', () => {
    const h = setup()
    pointerDown(h, 5, 100, 50)
    h.canvas.target.fire('pointermove', { pointerId: 5, clientX: 130, clientY: 60 })
    expect(h.camera.pans).toEqual([[30, 10]])
    expect(h.draws).toEqual([1])
    // 同一位置重复派发：不平移、不重绘、锚点不变
    h.canvas.target.fire('pointermove', { pointerId: 5, clientX: 130, clientY: 60 })
    expect(h.camera.pans).toHaveLength(1)
    expect(h.draws).toHaveLength(1)
    // 锚点已更新：继续移动按增量平移
    h.canvas.target.fire('pointermove', { pointerId: 5, clientX: 120, clientY: 60 })
    expect(h.camera.pans).toEqual([[30, 10], [-10, 0]])
  })

  it('pointerId 不匹配或无拖拽时 pointermove 忽略', () => {
    const h = setup()
    h.canvas.target.fire('pointermove', { pointerId: 9, clientX: 1, clientY: 1 })
    expect(h.camera.pans).toEqual([])
    pointerDown(h, 5)
    h.canvas.target.fire('pointermove', { pointerId: 9, clientX: 200, clientY: 200 })
    expect(h.camera.pans).toEqual([])
    expect(h.draws).toEqual([])
  })

  it('pointerup/pointercancel/lostpointercapture 释放捕获并移除 dragging', () => {
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      const h = setup()
      pointerDown(h, 5)
      h.canvas.target.fire(type, { pointerId: 5 })
      expect(h.canvas.releases).toEqual([5])
      expect(h.canvas.classes.has('dragging')).toBe(false)
      // 释放后移动不再平移
      h.canvas.target.fire('pointermove', { pointerId: 5, clientX: 300, clientY: 300 })
      expect(h.camera.pans).toEqual([])
    }
  })

  it('非拖拽指针的释放事件不触发清理', () => {
    const h = setup()
    pointerDown(h, 5)
    h.canvas.target.fire('pointerup', { pointerId: 9 })
    expect(h.canvas.releases).toEqual([])
    expect(h.canvas.classes.has('dragging')).toBe(true)
  })

  it('已释放后重复的释放事件不再 releasePointerCapture', () => {
    const h = setup()
    pointerDown(h, 5)
    h.canvas.target.fire('pointerup', { pointerId: 5 })
    h.canvas.target.fire('pointerup', { pointerId: 5 })
    expect(h.canvas.releases).toEqual([5])
  })

  it('窗口失焦结束拖拽', () => {
    const h = setup()
    pointerDown(h, 5)
    h.windowBus.dispatchEvent(new Event('blur'))
    expect(h.canvas.releases).toEqual([5])
    expect(h.canvas.classes.has('dragging')).toBe(false)
  })
})

// ---- 按钮 -----------------------------------------------------------------

describe('follow/free/fit/zoom buttons', () => {
  function setupWithButtons() {
    const follow = { value: '', ...stubTarget() } as any
    const free = stubTarget()
    const fit = stubTarget()
    const zoomIn = stubTarget()
    const zoomOut = stubTarget()
    const h = setup({
      follow: follow as unknown as HTMLSelectElement,
      free: free as unknown as HTMLElement,
      fit: fit as unknown as HTMLElement,
      zoomIn: zoomIn as unknown as HTMLElement,
      zoomOut: zoomOut as unknown as HTMLElement,
    })
    return { h, follow, free, fit, zoomIn, zoomOut }
  }

  it('跟随下拉：空串回自由视角，数字字符串跟随对应机器人', () => {
    const { h, follow } = setupWithButtons()
    follow.value = ''
    follow.fire('change')
    follow.value = '7'
    follow.fire('change')
    expect(h.camera.follows).toEqual([null, 7])
    expect(h.draws).toHaveLength(2)
  })

  it('自由/复位/放大/缩小按钮走对应相机动作', () => {
    const { h, free, fit, zoomIn, zoomOut } = setupWithButtons()
    free.fire('click')
    fit.fire('click')
    zoomIn.fire('click')
    zoomOut.fire('click')
    expect(h.camera.follows).toEqual([null])
    expect(h.camera.fits).toBe(1)
    expect(h.camera.zooms.map(z => z[0])).toEqual([1.25, 0.8])
    expect(h.draws).toHaveLength(4)
  })
})

// ---- dispose --------------------------------------------------------------

describe('dispose', () => {
  it('dispose 后所有监听失效（滚轮/键盘/拖拽/按钮/Escape/失焦）', () => {
    const follow = { value: '3', ...stubTarget() } as any
    const free = stubTarget()
    const h = setup({ follow, free })
    pointerDown(h)
    h.dispose()
    expect(h.canvas.classes.has('dragging')).toBe(false)
    expect(h.canvas.releases).toEqual([5]) // dispose 结束进行中的拖拽

    const wheel = h.canvas.target.fire('wheel', { deltaY: 100, deltaMode: 0, clientX: 0, clientY: 0 })
    expect(wheel.defaultPrevented).toBe(false)
    const esc = h.root.fire('keydown', { key: 'Escape', target: h.canvas.node })
    expect(esc.defaultPrevented).toBe(false)
    h.canvas.target.fire('pointerdown', { button: 0, isPrimary: true, pointerId: 9, clientX: 0, clientY: 0 })
    expect(h.canvas.captures).toEqual([5])
    follow.fire('change')
    free.fire('click')
    h.windowBus.dispatchEvent(new Event('blur'))
    expect(h.exits).toEqual([])
    expect(h.camera.follows).toEqual([])
    expect(h.camera.zooms).toEqual([])
    expect(h.camera.pans).toEqual([])
    expect(h.draws).toEqual([])
  })

  it('dispose 在无拖拽时也安全', () => {
    const h = setup()
    expect(() => h.dispose()).not.toThrow()
    expect(h.canvas.releases).toEqual([])
  })
})
