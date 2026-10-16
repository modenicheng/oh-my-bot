import type { Camera } from './camera'
import type { MapDefParsed } from './mapdef'

const directions = Array.from({ length: 8 }, (_, i) => ({
  x: Math.cos((i + .5) * Math.PI / 4), y: Math.sin((i + .5) * Math.PI / 4),
}))
interface Sectors {
  map: MapDefParsed; cx: number; cy: number; cw: number; ch: number; scale: number
  polygons?: { alternate: boolean; points: number[] }[]
}
const prepared = new WeakMap<Camera, Sectors>()

function matches(value: Sectors, map: MapDefParsed, cam: Camera): boolean {
  return value.map === map && value.cx === cam.cx && value.cy === cam.cy
    && value.cw === cam.cw && value.ch === cam.ch && value.scale === cam.scale
}

/** Clip a polygon to one side of a ray. Runs only when camera geometry changes. */
function clip(points: number[], ox: number, oy: number, dx: number, dy: number, side: number): number[] {
  const result: number[] = []
  let ax = points.at(-2)!, ay = points.at(-1)!
  let a = ((ax - ox) * dy - (ay - oy) * dx) * side
  for (let i = 0; i < points.length; i += 2) {
    const bx = points[i]!, by = points[i + 1]!
    const b = ((bx - ox) * dy - (by - oy) * dx) * side
    if ((a >= 0) !== (b >= 0)) {
      const t = a / (a - b)
      result.push(ax + (bx - ax) * t, ay + (by - ay) * t)
    }
    if (b >= 0) result.push(bx, by)
    ax = bx; ay = by; a = b
  }
  return result
}

export function prepareArenaSectors(map: MapDefParsed, cam: Camera): void {
  const previous = prepared.get(cam)
  if (previous && matches(previous, map, cam)) return
  const entry: Sectors = { map, cx: cam.cx, cy: cam.cy, cw: cam.cw, ch: cam.ch, scale: cam.scale }
  prepared.set(cam, entry)
  if (map.partial) return
  const x = cam.toPxX(0), y = cam.toPxY(0)
  const farthest = Math.hypot(Math.max(Math.abs(x), Math.abs(x - cam.cw)), Math.max(Math.abs(y), Math.abs(y - cam.ch)))
  // Inside the disk, sector arcs are invisible. Clip their two straight edges
  // to the viewport instead of submitting world-sized circle wedges.
  if (farthest >= map.arenaRadius * cam.scale - 16) return
  entry.polygons = []
  for (let i = 0; i < 8; i++) {
    const start = directions[(i + 7) % 8]!, end = directions[i]!
    let points = [-16, -16, cam.cw + 16, -16, cam.cw + 16, cam.ch + 16, -16, cam.ch + 16]
    points = clip(points, x, y, start.x, start.y, -1)
    points = clip(points, x, y, end.x, end.y, 1)
    if (points.length >= 6) entry.polygons.push({ alternate: i % 2 === 1, points })
  }
}

export function arenaSectors(map: MapDefParsed, cam: Camera): Sectors['polygons'] {
  const entry = prepared.get(cam)
  return entry && matches(entry, map, cam) ? entry.polygons : undefined
}
