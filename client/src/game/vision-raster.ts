const MAX_PIXELS = 16 * 1024 * 1024

interface Tile {
  image: OffscreenCanvas | ImageBitmap
  x: number
  y: number
  width: number
  height: number
}

function release(tiles: readonly Tile[]): void {
  for (const { image } of tiles) if ('close' in image) image.close()
}

/** Prepared, tightly sized feather tiles. A cropped drawImage from one large
 * OffscreenCanvas can still copy the entire source for every strip in Firefox. */
export class VisionRaster {
  private tiles: Tile[] = []
  private key = ''
  private candidate = ''
  private candidateTick: number | undefined
  private ready = false

  prepare(width: number, height: number, dpr: number, x: number, y: number,
    radius: number, clearRadius: number, tick?: number): boolean {
    this.ready = false
    if (typeof OffscreenCanvas === 'undefined' || width <= 0 || height <= 0 || radius <= 0) return false
    const key = `${width},${height},${dpr},${x},${y},${radius},${clearRadius}`
    if (key === this.key) { this.candidate = key; this.candidateTick = tick; this.ready = true; return true }
    // A snapshot and its reliable events can prepare the same tick repeatedly.
    const stable = !this.candidate || (key === this.candidate && (tick === undefined || tick !== this.candidateTick))
    if (key !== this.candidate) { this.candidate = key; this.candidateTick = tick }
    if (!stable) return false
    const w = Math.max(1, Math.ceil(width * dpr)), h = Math.max(1, Math.ceil(height * dpr))
    // Keep extra memory bounded without reducing resolution on large displays.
    if (w * h > MAX_PIXELS) { release(this.tiles); this.tiles = []; this.key = ''; return false }
    // Eight disjoint bands bound both edges of the annulus. This avoids copying
    // transparent pixels inside the clear circle and outside the vision circle.
    // Inward/outward margins retain the antialiased edge and filtering footprint.
    const cx = x * dpr, cy = y * dpr
    const inner = Math.max(0, clearRadius * dpr - 2), outer = radius * dpr + 2
    const strips: number[] = []
    for (let band = 0; band < 8; band++) {
      const top = Math.floor(h * band / 8), bottom = Math.floor(h * (band + 1) / 8)
      const near = Math.max(0, top - cy, cy - bottom)
      if (near >= outer || top === bottom) continue
      const extent = Math.sqrt(outer * outer - near * near)
      const left = Math.max(0, Math.floor(cx - extent)), right = Math.min(w, Math.ceil(cx + extent))
      if (left >= right) continue
      const far = Math.max(Math.abs(top - cy), Math.abs(bottom - cy))
      const hole = Math.sqrt(Math.max(0, inner * inner - far * far))
      const holeLeft = Math.max(left, Math.ceil(cx - hole)), holeRight = Math.min(right, Math.floor(cx + hole))
      if (holeLeft >= holeRight) strips.push(left, top, right - left, bottom - top)
      else {
        if (holeLeft > left) strips.push(left, top, holeLeft - left, bottom - top)
        if (holeRight < right) strips.push(holeRight, top, right - holeRight, bottom - top)
      }
    }
    const source = new OffscreenCanvas(w, h), sourceCtx = source.getContext('2d')
    if (!sourceCtx) return false
    sourceCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const gradient = sourceCtx.createRadialGradient(x, y, clearRadius, x, y, radius)
    gradient.addColorStop(0, 'rgba(5, 9, 14, 0)')
    gradient.addColorStop(.72, 'rgba(5, 9, 14, .08)')
    gradient.addColorStop(1, 'rgba(5, 9, 14, .78)')
    sourceCtx.fillStyle = gradient
    sourceCtx.beginPath(); sourceCtx.arc(x, y, radius, 0, Math.PI * 2); sourceCtx.fill()
    const tiles: Tile[] = []
    for (let i = 0; i < strips.length; i += 4) {
      const sx = strips[i]!, sy = strips[i + 1]!, sw = strips[i + 2]!, sh = strips[i + 3]!
      const image = new OffscreenCanvas(sw, sh), ctx = image.getContext('2d')
      if (!ctx) { release(tiles); return false }
      // Rasterizing arcs per tile changes backend tessellation at the circle edge.
      // Crop once in preparation instead; draw only sees small immutable sources.
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
      tiles.push({ image: typeof image.transferToImageBitmap === 'function' ? image.transferToImageBitmap() : image,
        x: sx / dpr, y: sy / dpr, width: sw / dpr, height: sh / dpr })
    }
    source.width = 1; source.height = 1
    release(this.tiles); this.tiles = tiles
    this.key = key; this.ready = true
    return true
  }

  /** No texture allocation, text shaping, or gradient rasterization during draw. */
  draw(ctx: CanvasRenderingContext2D): boolean {
    if (!this.ready) return false
    for (const tile of this.tiles) ctx.drawImage(tile.image, tile.x, tile.y, tile.width, tile.height)
    return true
  }

  dispose(): void {
    release(this.tiles); this.tiles = []
    this.key = ''; this.candidate = ''; this.candidateTick = undefined; this.ready = false
  }
}
