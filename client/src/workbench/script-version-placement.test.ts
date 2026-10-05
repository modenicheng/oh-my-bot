// 版本浮层定位纯数学：优先下方 + 右对齐、翻面、视口 clamp、宽度/最大高度。
// 视图层（script-version-drawer）只做 DOM 读写，几何断言全部在此。
import { describe, expect, it } from 'vitest'
import { computePanelPlacement, PANEL_GAP, PANEL_MAX_WIDTH, PANEL_VIEWPORT_MARGIN } from './script-version-placement'

const viewport = (width: number, height: number) => ({ width, height })

describe('computePanelPlacement', () => {
  it('常规：锚点下方 + 右对齐，宽 340，maxHeight = 下方剩余空间', () => {
    // 锚点在 1200×800 视口右上区（编辑器标题栏版本按钮的典型位置）。
    const place = computePanelPlacement({ left: 900, right: 1000, top: 120, bottom: 150 }, viewport(1200, 800))
    expect(place.placement).toBe('below')
    expect(place.left).toBe(1000 - place.width)
    expect(place.width).toBe(340)
    expect(place.top).toBe(150 + PANEL_GAP)
    expect(place.maxHeight).toBe(800 - 150 - PANEL_GAP - PANEL_VIEWPORT_MARGIN)
  })

  it('下方空间不足且上方更宽裕：翻到上方', () => {
    // 锚点贴近视口底部：below ≈ 22px，above ≈ 148px。
    const place = computePanelPlacement({ left: 400, right: 500, top: 160, bottom: 770 }, viewport(1000, 800))
    expect(place.placement).toBe('above')
    expect(place.top).toBeLessThan(160)
    expect(place.maxHeight).toBeGreaterThanOrEqual(120)
    // 上缘仍受 8px 视口边距约束。
    expect(place.top).toBeGreaterThanOrEqual(PANEL_VIEWPORT_MARGIN)
  })

  it('两侧都矮时优先下方（below ≥ 120 可用即不翻面）', () => {
    const place = computePanelPlacement({ left: 300, right: 400, top: 320, bottom: 360 }, viewport(800, 500))
    // below = 500-360-4-8 = 128 ≥ 120 → 仍选下方。
    expect(place.placement).toBe('below')
    expect(place.maxHeight).toBe(128)
  })

  it('clamp：窄视口宽度收到 viewport - 2×margin，左缘不小于 margin', () => {
    const place = computePanelPlacement({ left: 0, right: 200, top: 40, bottom: 70 }, viewport(240, 600))
    expect(place.width).toBe(240 - PANEL_VIEWPORT_MARGIN * 2)
    expect(place.width).toBeLessThanOrEqual(PANEL_MAX_WIDTH)
    expect(place.left).toBe(PANEL_VIEWPORT_MARGIN)
    // 右缘同样不越界。
    expect(place.left + place.width).toBeLessThanOrEqual(240 - PANEL_VIEWPORT_MARGIN)
  })

  it('maxHeight 有 120px 下限（极矮视口不至于零高度）', () => {
    const place = computePanelPlacement({ left: 100, right: 200, top: 90, bottom: 110 }, viewport(400, 160))
    expect(place.maxHeight).toBeGreaterThanOrEqual(120)
  })
})
