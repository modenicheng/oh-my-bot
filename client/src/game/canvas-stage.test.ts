import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// canvas-stage.ts → art.ts 在模块加载期访问 matchMedia/document.fonts/Image
// （Node 环境缺失）：先桩再动态导入（同 render.test.ts 约定）。
beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('document', { fonts: { load: () => Promise.resolve([]) } })
  vi.stubGlobal('Image', class { onload?: () => void; onerror?: () => void; src = '' })
})

/** 轻量桩（同 kill-feed.test.ts 约定）：手动 rAF 队列 + 可触发的 ResizeObserver；
 *  canvas 只需 getContext/getBoundingClientRect/width/height。 */
async function stageFixture() {
  const { CanvasStage } = await import('./canvas-stage')
  let dpr = 1
  const frames = new Map<number, FrameRequestCallback>()
  let nextId = 0
  let observerCallback: (() => void) | undefined
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({}),
    getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
  }
  vi.stubGlobal('window', { get devicePixelRatio() { return dpr } })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++nextId, cb); return nextId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { observerCallback = cb }
    observe(): void {}
    disconnect(): void {}
  })
  const draws: number[] = []
  const resizes: Array<[number, number, number]> = []
  const stage = new CanvasStage(canvas as unknown as HTMLCanvasElement, {
    draw: () => draws.push(draws.length),
    onResize: (w, h, d) => resizes.push([w, h, d]),
  })
  const pump = (): void => {
    const cb = frames.values().next().value
    if (!cb) throw new Error('no scheduled frame')
    frames.clear() // loop 在回调末尾重新登记自己
    cb(0)
  }
  return {
    stage, draws, resizes, pump,
    resize: () => observerCallback?.(),
    setDpr: (v: number) => { dpr = v },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('CanvasStage awake gate (C-26 idle skip)', () => {
  it('draws every frame while awake, skips when quiet, and honors requestDraw', async () => {
    const f = await stageFixture()
    let awake = true
    f.stage.start({ awake: () => awake })
    f.pump(); f.pump(); f.pump()
    expect(f.draws).toHaveLength(3)
    awake = false
    f.pump(); f.pump(); f.pump(); f.pump()
    expect(f.draws).toHaveLength(3) // 全静默：空闲不再逐帧重绘
    f.stage.requestDraw()
    f.pump()
    expect(f.draws).toHaveLength(4) // 脏标记合帧后立即出画
    f.pump()
    expect(f.draws).toHaveLength(4) // 只画一帧，随后继续跳帧
    f.stage.dispose()
  })

  it('redraws on the very next frame when awake flips back on (recovery)', async () => {
    const f = await stageFixture()
    let awake = false
    f.stage.start({ awake: () => awake })
    f.pump() // 首帧：首次尺寸同步本身触发一次绘制
    const baseline = f.draws.length
    f.pump(); f.pump()
    expect(f.draws).toHaveLength(baseline) // 静默跳帧中
    awake = true // 新效果 / 指针进入：谓词翻真
    f.pump()
    expect(f.draws).toHaveLength(baseline + 1) // 下一帧立即重绘
    f.stage.dispose()
  })

  it('still redraws immediately on resize and DPR drift while quiet', async () => {
    const f = await stageFixture()
    f.stage.start({ awake: () => false })
    f.pump() // 首次同步绘制
    const baseline = f.draws.length
    f.pump()
    expect(f.draws).toHaveLength(baseline) // 静默
    f.resize() // RO：真实浏览器仅在尺寸变化时触发
    f.pump()
    expect(f.draws).toHaveLength(baseline + 1) // resize 立即重绘
    f.pump()
    expect(f.draws).toHaveLength(baseline + 1) // 稳定后回到静默
    f.setDpr(2) // 逐帧 DPR 漂移检测路径
    f.pump()
    expect(f.draws).toHaveLength(baseline + 2)
    expect(f.resizes.at(-1)).toEqual([800, 600, 2])
    f.pump()
    expect(f.draws).toHaveLength(baseline + 2) // 同 DPR 不再重绘
    f.stage.dispose()
  })

  it('drawOnce still paints synchronously without a frame while quiet', async () => {
    const f = await stageFixture()
    f.stage.start({ awake: () => false })
    f.pump()
    const baseline = f.draws.length
    f.pump()
    expect(f.draws).toHaveLength(baseline)
    f.stage.drawOnce()
    expect(f.draws).toHaveLength(baseline + 1)
    f.stage.dispose()
  })
})
