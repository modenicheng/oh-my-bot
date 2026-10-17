type TextContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type TextCanvas = HTMLCanvasElement | OffscreenCanvas

export interface PreparedText {
  text: string
  font: string
  color: string
  width: number
  ascent: number
  descent: number
  left: number
  top: number
  image?: TextCanvas
  dpr: number
  epoch: number
}

const MAX_ENTRIES = 512
const MAX_PIXELS = 4 * 1024 * 1024
const cache = new Map<string, PreparedText>()
const active = new WeakMap<TextContext, {
  current: Map<string, PreparedText>
  previous: Map<string, PreparedText>
}>()
let pixels = 0
let epoch = 0
let scratch: TextContext | undefined

function canvas(width: number, height: number): TextCanvas | undefined {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return undefined
  const result = document.createElement('canvas')
  result.width = width; result.height = height
  return result
}

export function invalidateTextRasters(): void {
  cache.clear(); pixels = 0; epoch++
}

function key(text: string, font: string, color: string): string {
  return `${font}|${color}|${text}`
}

/** Keep this snapshot's labels alive even when the shared reuse cache evicts them. */
export function beginTextPreparation(ctx: TextContext): void {
  let labels = active.get(ctx)
  if (!labels) {
    labels = { current: new Map(), previous: new Map() }
    active.set(ctx, labels)
  }
  // Retain the preceding working set independently of the smaller shared LRU.
  labels.previous.clear()
  const available = labels.previous
  labels.previous = labels.current
  labels.current = available
}

/** Resolve fonts, measure, and rasterize only at snapshot/event/resize boundaries. */
export function prepareText(text: string, font: string, color: string, dpr = 1, fallback?: TextContext): PreparedText {
  dpr = Math.max(1, dpr)
  const id = key(text, font, color)
  const labels = fallback ? active.get(fallback) : undefined
  const retained = labels?.current.get(id) ?? labels?.previous.get(id)
  if (retained?.dpr === dpr && retained.epoch === epoch) {
    labels!.current.set(id, retained)
    return retained
  }
  const previous = cache.get(id)
  if (previous?.dpr === dpr && previous.epoch === epoch) {
    cache.delete(id); cache.set(id, previous)
    labels?.current.set(id, previous)
    return previous
  }
  scratch ??= canvas(1, 1)?.getContext('2d') as TextContext | undefined
  const ctx = scratch ?? fallback
  const size = Number.parseFloat(font) || 12
  if (ctx) ctx.font = font
  const metrics = ctx?.measureText(text)
  const width = metrics?.width ?? text.length * size
  const ascent = Math.max(metrics?.actualBoundingBoxAscent ?? size, size)
  const descent = Math.max(metrics?.actualBoundingBoxDescent ?? size * .3, size * .3)
  const left = Math.ceil(Math.max(0, metrics?.actualBoundingBoxLeft ?? 0)) + 2
  const right = Math.ceil(Math.max(width, metrics?.actualBoundingBoxRight ?? width)) + 2
  const top = Math.ceil(ascent) + 2
  const w = Math.max(1, Math.ceil((left + right) * dpr))
  const h = Math.max(1, Math.ceil((top + descent + 2) * dpr))
  const image = text ? canvas(w, h) : undefined
  const raster = image?.getContext('2d') as TextContext | null | undefined
  if (raster) {
    raster.setTransform(dpr, 0, 0, dpr, 0, 0)
    raster.font = font; raster.fillStyle = color
    raster.textAlign = 'left'; raster.textBaseline = 'alphabetic'
    raster.fillText(text, left, top)
  }
  if (previous) {
    cache.delete(id)
    pixels -= (previous.image?.width ?? 0) * (previous.image?.height ?? 0)
  }
  while (cache.size && (cache.size >= MAX_ENTRIES || pixels + w * h > MAX_PIXELS)) {
    const oldest = cache.keys().next().value!
    const entry = cache.get(oldest)!
    pixels -= (entry.image?.width ?? 0) * (entry.image?.height ?? 0)
    cache.delete(oldest)
  }
  const result = { text, font, color, width, ascent, descent, left, top,
    image: raster ? image : undefined, dpr, epoch }
  cache.set(id, result)
  labels?.current.set(id, result)
  pixels += result.image ? w * h : 0
  return result
}

/** Lookup only. A cache miss must never shape text or allocate during drawing. */
export function drawText(ctx: CanvasRenderingContext2D, text: string, font: string, color: string,
  x: number, y: number, align: CanvasTextAlign = 'center', baseline: CanvasTextBaseline = 'alphabetic'): void {
  if (!text) return
  const id = key(text, font, color)
  const prepared = active.get(ctx)?.current.get(id) ?? cache.get(id)
  if (prepared) drawPreparedText(ctx, prepared, x, y, align, baseline)
  else if (typeof OffscreenCanvas === 'undefined' && (typeof document === 'undefined' || typeof document.createElement !== 'function')) {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = baseline
    ctx.fillText(text, x, y)
  }
}

export function drawPreparedText(ctx: CanvasRenderingContext2D, prepared: PreparedText,
  x: number, y: number, align: CanvasTextAlign = 'center', baseline: CanvasTextBaseline = 'alphabetic'): void {
  if (prepared?.image) {
    const dx = align === 'center' ? -prepared.width / 2 : align === 'right' || align === 'end' ? -prepared.width : 0
    const dy = baseline === 'top' ? prepared.ascent : baseline === 'middle' ? (prepared.ascent - prepared.descent) / 2
      : baseline === 'bottom' || baseline === 'ideographic' ? -prepared.descent : 0
    ctx.drawImage(prepared.image, x + dx - prepared.left, y + dy - prepared.top,
      prepared.image.width / prepared.dpr, prepared.image.height / prepared.dpr)
  } else if (typeof OffscreenCanvas === 'undefined' && (typeof document === 'undefined' || typeof document.createElement !== 'function')) {
    // Non-DOM canvas consumers have no detached raster surface.
    ctx.font = prepared.font; ctx.fillStyle = prepared.color; ctx.textAlign = align; ctx.textBaseline = baseline
    ctx.fillText(prepared.text, x, y)
  }
}
