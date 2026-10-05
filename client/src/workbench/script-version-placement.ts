// 版本浮层定位纯数学：portal 面板在视口内对齐 toggle 锚点。
// 抽成纯函数供 Vitest 与 Drawer 视图共用（视图层只做 DOM 读写）。

/** 视口内边距（px）：面板任意边距视口至少 8px）。 */
export const PANEL_VIEWPORT_MARGIN = 8
/** 面板最大宽度（px）。 */
export const PANEL_MAX_WIDTH = 340
/** 面板与锚点间距（px）。 */
export const PANEL_GAP = 4

export interface PanelAnchorRect {
  left: number
  right: number
  bottom: number
  top: number
}

export interface ViewportSize {
  width: number
  height: number
}

export interface PanelPlacement {
  /** style.left（px，已含 clamp；相对视口 → position:fixed）。 */
  left: number
  /** style.top（px；优先在锚点下方，空间不足翻到上方）。 */
  top: number
  /** 面板可用宽度（min(340, 视口 - 2×margin)）。 */
  width: number
  /** 面板可用最大高度（翻面后剩余空间 - gap；下限 120 防零高）。 */
  maxHeight: number
  /** 实际翻面方向（below 优先）。 */
  placement: 'below' | 'above'
}

/**
 * 计算面板几何：优先「锚点下方 + 右对齐」，下方空间不足翻上方；
 * 视口左右 clamp（8px 边距）；宽 ≤340 且 ≤ 视口-16。
 */
export function computePanelPlacement(anchor: PanelAnchorRect, viewport: ViewportSize): PanelPlacement {
  const margin = PANEL_VIEWPORT_MARGIN
  const width = Math.min(PANEL_MAX_WIDTH, viewport.width - margin * 2)
  // 右对齐锚点右缘；越界左移回 clamp（窄视口时可能盖住锚点，可接受）。
  const left = Math.min(Math.max(anchor.right - width, margin), viewport.width - width - margin)
  const belowHeight = viewport.height - anchor.bottom - PANEL_GAP - margin
  const aboveHeight = anchor.top - PANEL_GAP - margin
  const below = belowHeight >= aboveHeight || belowHeight >= 120
  const available = below ? belowHeight : aboveHeight
  return {
    left,
    top: below ? anchor.bottom + PANEL_GAP : Math.max(margin, anchor.top - PANEL_GAP - available),
    width,
    maxHeight: Math.max(120, available),
    placement: below ? 'below' : 'above',
  }
}
