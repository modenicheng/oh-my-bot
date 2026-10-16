// Shared vector art for live play and replay. SVGs decode once; drawing uses simulation time.
import type { Camera } from './camera'
import type { MapDefParsed } from './mapdef'

export const ink = {
  bg: '#070d14', floor: '#101b25', panel: '#182735', line: '#29414f',
  text: '#d8e5eb', dim: '#8b9fab', cyan: '#22d3ee', lime: '#b9d985', danger: '#ff756d', white: '#f4fbff',
  // 技能点/成长语义色（ADR-0016），与 CSS --amber 同值。
  amber: '#fbbf24',
} as const
export const mono = '"Fusion Pixel", ui-monospace, monospace'
const FONT_10 = `10px ${mono}`
const FONT_11 = `11px ${mono}`
const FONT_16 = `16px ${mono}`
const tau = Math.PI * 2
const PERCENT_LABELS = Array.from({ length: 101 }, (_, percent) => `${percent}%`)
const POINT_LABELS = Array.from({ length: 5 }, (_, points) => String(points))
const ARENA_LANES = Array.from({ length: 8 }, (_, i) => {
  const angle = (i + 0.5) * tau / 8
  return { x: Math.cos(angle), y: Math.sin(angle) }
})
const FENCE_DIRECTIONS = Array.from({ length: 128 }, (_, i) => {
  const angle = i * tau / 128
  return { x: Math.cos(angle), y: Math.sin(angle) }
})
const sectorLabels = new WeakMap<MapDefParsed, Map<number, string>>()

export function prepareArena(map: MapDefParsed): void {
  if (!sectorLabels.has(map)) {
    sectorLabels.set(map, new Map(map.sectors.map(sector => [sector.id, `出生区 ${String(sector.id + 1).padStart(2, '0')}`])))
  }
}
export const ROBOT_SHIELD_RADIUS = 2.05
export const ROBOT_SHIELD_OUTER_RADIUS = 1.16
/** 机器人碰撞半径（世界单位）：各渲染器/反馈共用，勿再各自声明本地副本。 */
export const ROBOT_R = 0.6
const motion = matchMedia('(prefers-reduced-motion: reduce)')
/** @deprecated 仅兼容旧调用方；Uplink 绘制不再使用悬浮偏移。 */
export const UPLINK_LIFT = 0.38
const sources = {
  robot: new URL('../assets/robot.svg', import.meta.url).href,
  turret: new URL('../assets/turret.svg', import.meta.url).href,
  core: new URL('../assets/core.svg', import.meta.url).href,
  uplink: new URL('../assets/uplink.svg', import.meta.url).href,
  healthPack: new URL('../assets/health-pack.svg', import.meta.url).href,
}
const sprites = {} as Record<keyof typeof sources, HTMLImageElement>
export const fontReady = document.fonts.load(`12px ${mono}`).then(fonts => fonts.length > 0, () => false)
export const spritesReady = Promise.all(Object.entries(sources).map(([name, url]) => new Promise<boolean>(resolve => {
  const image = new Image()
  sprites[name as keyof typeof sources] = image
  image.onload = () => resolve(true)
  image.onerror = () => resolve(false)
  image.src = url
}))).then(results => results.every(Boolean))
export const artReady = Promise.all([fontReady, spritesReady])

const rasterSprites = new Map<keyof typeof sources, { pixels: number; image: CanvasImageSource }>()

/** One raster per asset at the viewport's maximum zoom, never an unbounded zoom atlas. */
export function prepareArt(scale: number, dpr: number): void {
  if (typeof OffscreenCanvas === 'undefined') return
  const sizes = { robot: 1.2, turret: 1.2, core: 1.05, uplink: 1.7, healthPack: 0.95 }
  for (const name of Object.keys(sources) as (keyof typeof sources)[]) {
    const image = sprites[name]
    if (!image.complete || !image.naturalWidth) continue
    const pixels = Math.max(16, Math.ceil(sizes[name] * scale * dpr))
    if (rasterSprites.get(name)?.pixels === pixels) continue
    const canvas = new OffscreenCanvas(pixels, pixels)
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    ctx.drawImage(image, 0, 0, pixels, pixels)
    rasterSprites.set(name, { pixels, image: canvas })
  }
}

/** 取 2d 上下文；两个渲染器共用同一失败语义。三块全屏画布每帧首操作都是
 * 不透明 fillRect 全量覆盖（审计 C-40），关闭 alpha 让合成器走不透明加速路径。 */
export function createCanvas2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('canvas 2d context unavailable')
  return ctx
}
/**
 * 按 CSS 尺寸 × DPR 设置后备缓冲。同值赋值也会清屏并重置 ctx 状态，
 * 故尺寸未变时短路——拖拽窗口时渲染器不得被清成黑屏。
 */
export function resizeCanvas2d(canvas: HTMLCanvasElement, w: number, h: number, dpr: number): void {
  const width = Math.max(1, Math.floor(w * dpr))
  const height = Math.max(1, Math.floor(h * dpr))
  if (canvas.width === width && canvas.height === height) return
  canvas.width = width
  canvas.height = height
}

function sprite(ctx: CanvasRenderingContext2D, name: keyof typeof sprites, x: number, y: number, size: number): void {
  const image = sprites[name]
  const raster = rasterSprites.get(name)
  if (raster) ctx.drawImage(raster.image, x - size / 2, y - size / 2, size, size)
  else if (image.complete && image.naturalWidth) ctx.drawImage(image, x - size / 2, y - size / 2, size, size)
  else { ctx.fillStyle = ink.dim; ctx.fillRect(x - size / 4, y - size / 4, size / 2, size / 2) }
}
function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath(); ctx.arc(x, y, r, 0, tau)
}
export function visibleWorld(cam: Camera, wx: number, wy: number, margin = 80): boolean {
  const x = cam.toPxX(wx), y = cam.toPxY(wy)
  return x > -margin && y > -margin && x < cam.cw + margin && y < cam.ch + margin
}

function visible(cam: Camera, x: number, y: number, margin = 80): boolean {
  return x > -margin && y > -margin && x < cam.cw + margin && y < cam.ch + margin
}

export function drawArena(ctx: CanvasRenderingContext2D, map: MapDefParsed, cam: Camera, phase: number): void {
  if (map.partial) {
    ctx.save()
    ctx.fillStyle = ink.floor
    ctx.fillRect(0, 0, cam.cw, cam.ch)
    ctx.strokeStyle = '#263b4760'
    ctx.lineWidth = 1
    const left = Math.floor(cam.toWorldX(0) / 4) * 4
    const top = Math.floor(cam.toWorldY(0) / 4) * 4
    const right = cam.toWorldX(cam.cw), bottom = cam.toWorldY(cam.ch)
    ctx.beginPath()
    for (let gridX = left; gridX <= right; gridX += 4) {
      const pixelX = cam.toPxX(gridX)
      ctx.moveTo(pixelX, 0); ctx.lineTo(pixelX, cam.ch)
    }
    for (let gridY = top; gridY <= bottom; gridY += 4) {
      const pixelY = cam.toPxY(gridY)
      ctx.moveTo(0, pixelY); ctx.lineTo(cam.cw, pixelY)
    }
    ctx.stroke()
    ctx.restore()
    return
  }
  const x = cam.toPxX(0), y = cam.toPxY(0), s = cam.scale
  // 竞技场骨架按 arenaRadius 等比绘制（人数自适应地图会下发更大的圆盘；
  // 环线/服务车道半径取与原版 80m 图相同的占比）。
  const R = map.arenaRadius
  const laneOuter = R * (78.5 / 80)
  const ringMid = R * (55 / 80)
  const laneInner = R * (30 / 80)
  ctx.save()
  circle(ctx, x, y, R * s)
  ctx.fillStyle = ink.floor; ctx.fill(); ctx.clip()
  // Eight equal sectors and concentric service lanes give orientation at both zoom levels.
  for (let i = 0; i < 8; i++) {
    const a = (i - 0.5) * tau / 8
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, R * s, a, a + tau / 8); ctx.closePath()
    ctx.fillStyle = i % 2 ? '#13212b' : ink.floor; ctx.fill()
  }
  ctx.lineWidth = 1; ctx.strokeStyle = '#263b4760'
  const left = Math.max(-R, Math.floor(cam.toWorldX(0) / 4) * 4)
  const top = Math.max(-R, Math.floor(cam.toWorldY(0) / 4) * 4)
  const right = Math.min(R, cam.toWorldX(cam.cw)), bottom = Math.min(R, cam.toWorldY(cam.ch))
  ctx.beginPath()
  for (let gx = left; gx <= right; gx += 4) { ctx.moveTo(cam.toPxX(gx), cam.toPxY(-R)); ctx.lineTo(cam.toPxX(gx), cam.toPxY(R)) }
  for (let gy = top; gy <= bottom; gy += 4) { ctx.moveTo(cam.toPxX(-R), cam.toPxY(gy)); ctx.lineTo(cam.toPxX(R), cam.toPxY(gy)) }
  ctx.stroke()
  for (const r of [ringMid, laneOuter]) {
    circle(ctx, x, y, r * s); ctx.strokeStyle = '#0a131d'; ctx.lineWidth = Math.max(2, s * 0.65); ctx.stroke()
    ctx.strokeStyle = '#3c5564'; ctx.lineWidth = 1; ctx.stroke()
  }
  for (const direction of ARENA_LANES) {
    ctx.strokeStyle = '#3c55647a'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x + direction.x * laneInner * s, y + direction.y * laneInner * s)
    ctx.lineTo(x + direction.x * laneOuter * s, y + direction.y * laneOuter * s); ctx.stroke()
  }
  // Spawn plates use the exact authored spawn rectangle; brackets do not imply collision.
  for (const sector of map.sectors) {
    const a = sector.spawnArea, px = cam.toPxX(a.min.x), py = cam.toPxY(a.min.y)
    const w = (a.max.x - a.min.x) * s, h = (a.max.y - a.min.y) * s
    if (!visible(cam, px + w / 2, py + h / 2, Math.max(w, h))) continue
    ctx.fillStyle = '#182d38'; ctx.fillRect(px, py, w, h)
    ctx.strokeStyle = '#365969'; ctx.strokeRect(px, py, w, h)
    const b = Math.min(12, w / 4)
    ctx.strokeStyle = '#73a3b0'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(px, py + b); ctx.lineTo(px, py); ctx.lineTo(px + b, py)
    ctx.moveTo(px + w - b, py + h); ctx.lineTo(px + w, py + h); ctx.lineTo(px + w, py + h - b); ctx.stroke()
    if (s >= 8) {
      ctx.font = FONT_11; ctx.textAlign = 'left'; ctx.fillStyle = '#9cb0bb'; ctx.textBaseline = 'top'
      ctx.fillText(sectorLabels.get(map)?.get(sector.id) ?? '', px + 8, py + 8)
      ctx.strokeStyle = '#486775'; ctx.lineWidth = 1
      const cx = px + w / 2, cy = py + h / 2
      ctx.beginPath(); ctx.moveTo(cx - 7, cy); ctx.lineTo(cx + 7, cy); ctx.moveTo(cx, cy - 7); ctx.lineTo(cx, cy + 7); ctx.stroke()
    }
  }
  const unlocked = phase >= map.coreZone.unlockPhase && phase > 0
  circle(ctx, x, y, map.coreZone.radius * s); ctx.fillStyle = unlocked ? '#12303a' : '#0c1620'; ctx.fill()
  ctx.lineWidth = 1.5; ctx.strokeStyle = unlocked ? ink.cyan : '#71909f'; ctx.setLineDash([8, 6]); ctx.stroke(); ctx.setLineDash([])
  if (visible(cam, x, y)) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = FONT_11; ctx.fillStyle = unlocked ? ink.cyan : ink.dim
    ctx.fillText(unlocked ? '核心区 · 已开放' : '核心区 · 待开放', x, y + Math.max(28, 5 * s))
  }
  ctx.restore()
  // Solid outer fence corresponds to the authoritative arena boundary.
  ctx.save()
  circle(ctx, x, y, R * s); ctx.strokeStyle = '#3b6878'; ctx.lineWidth = 3; ctx.stroke()
  circle(ctx, x, y, R * s); ctx.strokeStyle = '#6dd1db'; ctx.lineWidth = 1; ctx.stroke()
  ctx.strokeStyle = '#87c9d3'; ctx.lineWidth = Math.max(1, s * 0.08); ctx.beginPath()
  for (const { x: c, y: sn } of FENCE_DIRECTIONS) {
    ctx.moveTo(x + c * (R - 0.7) * s, y + sn * (R - 0.7) * s); ctx.lineTo(x + c * R * s, y + sn * R * s)
  }
  ctx.stroke(); ctx.restore()
}

export function drawCover(ctx: CanvasRenderingContext2D, map: MapDefParsed, cam: Camera, observer?: { x: number; y: number }): void {
  if (map.partial) {
    ctx.save()
    ctx.lineCap = 'butt'
    ctx.lineJoin = 'miter'
    const self = observer ?? { x: cam.cx, y: cam.cy }
    for (const wall of map.walls) {
      const startX = cam.toPxX(wall.min.x), startY = cam.toPxY(wall.min.y)
      const endX = cam.toPxX(wall.max.x), endY = cam.toPxY(wall.max.y)
      const length = Math.hypot(endX - startX, endY - startY)
      if (length <= 0) continue
      const tangentX = (endX - startX) / length, tangentY = (endY - startY) / length
      let normalX = -tangentY, normalY = tangentX
      if (normalX * (self.x - wall.min.x) + normalY * (self.y - wall.min.y) > 0) { normalX = -normalX; normalY = -normalY }
      const depth = Math.max(7, cam.scale * 0.45)
      const faceX = normalX * depth, faceY = normalY * depth
      ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(endX, endY)
      ctx.lineTo(endX + faceX, endY + faceY); ctx.lineTo(startX + faceX, startY + faceY); ctx.closePath()
      ctx.fillStyle = '#293e4c'; ctx.fill()
      ctx.strokeStyle = '#111e28'; ctx.lineWidth = 2; ctx.stroke()
      ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(endX, endY)
      ctx.strokeStyle = '#99b4c2'; ctx.lineWidth = 1.5; ctx.stroke()
      ctx.beginPath(); ctx.moveTo(startX + faceX, startY + faceY); ctx.lineTo(endX + faceX, endY + faceY)
      ctx.strokeStyle = '#5c798b'; ctx.lineWidth = 1; ctx.stroke()
      ctx.beginPath()
      for (let offset = 12; offset < length - 6; offset += 14) {
        const pixelX = startX + tangentX * offset, pixelY = startY + tangentY * offset
        ctx.moveTo(pixelX + normalX * 2, pixelY + normalY * 2)
        ctx.lineTo(pixelX + faceX - normalX * 2, pixelY + faceY - normalY * 2)
      }
      ctx.strokeStyle = '#131f2a'; ctx.stroke()
    }
    for (const boundary of map.boundaries ?? []) {
      ctx.beginPath(); ctx.moveTo(cam.toPxX(boundary.start.x), cam.toPxY(boundary.start.y))
      ctx.lineTo(cam.toPxX(boundary.end.x), cam.toPxY(boundary.end.y))
      ctx.strokeStyle = boundary.kind === 'lock' ? '#71909f' : '#3b6878'; ctx.lineWidth = 7; ctx.stroke()
      ctx.strokeStyle = boundary.kind === 'lock' ? '#b4c8d1' : '#6dd1db'; ctx.lineWidth = 1.5; ctx.stroke()
    }
    ctx.restore()
    return
  }
  // 墙体 AABB 互不重叠且样式只有 4 种：按样式分桶遍历，把每墙 4 次样式切换
  // 降为常量次；描边合并为整批 beginPath/stroke。绘制次序(影→体→描边)不变。
  const s = cam.scale
  ctx.fillStyle = '#03090dbb'
  for (const wall of map.walls) {
    const x = cam.toPxX(wall.min.x), y = cam.toPxY(wall.min.y)
    const w = (wall.max.x - wall.min.x) * s, h = (wall.max.y - wall.min.y) * s
    if (!visible(cam, x, y, Math.max(w, h))) continue
    ctx.fillRect(x + 3, y + 4, w, h)
  }
  ctx.fillStyle = '#293e4c'
  for (const wall of map.walls) {
    const x = cam.toPxX(wall.min.x), y = cam.toPxY(wall.min.y)
    const w = (wall.max.x - wall.min.x) * s, h = (wall.max.y - wall.min.y) * s
    if (!visible(cam, x, y, Math.max(w, h))) continue
    ctx.fillRect(x, y, w, h)
  }
  ctx.strokeStyle = '#5c798b'; ctx.lineWidth = 1
  for (const wall of map.walls) {
    const x = cam.toPxX(wall.min.x), y = cam.toPxY(wall.min.y)
    const w = (wall.max.x - wall.min.x) * s, h = (wall.max.y - wall.min.y) * s
    if (!visible(cam, x, y, Math.max(w, h))) continue
    ctx.strokeRect(x, y, w, h)
  }
  ctx.strokeStyle = '#99b4c2'
  ctx.beginPath()
  for (const wall of map.walls) {
    const x = cam.toPxX(wall.min.x), y = cam.toPxY(wall.min.y)
    const w = (wall.max.x - wall.min.x) * s, h = (wall.max.y - wall.min.y) * s
    if (!visible(cam, x, y, Math.max(w, h))) continue
    ctx.moveTo(x, y + h); ctx.lineTo(x, y); ctx.lineTo(x + w, y)
  }
  ctx.stroke()
  if (s > 10) {
    ctx.strokeStyle = '#131f2a'
    ctx.beginPath()
    for (const wall of map.walls) {
      const x = cam.toPxX(wall.min.x), y = cam.toPxY(wall.min.y)
      const w = (wall.max.x - wall.min.x) * s, h = (wall.max.y - wall.min.y) * s
      if (!visible(cam, x, y, Math.max(w, h))) continue
      if (w > h) for (let i = 12; i < w - 8; i += 14) { ctx.moveTo(x + i, y + 3); ctx.lineTo(x + i, y + h - 3) }
      else for (let i = 12; i < h - 8; i += 14) { ctx.moveTo(x + 3, y + i); ctx.lineTo(x + w - 3, y + i) }
    }
    ctx.stroke()
  }
}

export function drawRobot(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number, heading: number,
  color: string, selected: boolean, shield = false, dashing = false, invulnerable = false, tick = 0): void {
  const x = cam.toPxX(wx), y = cam.toPxY(wy), r = Math.max(6, 0.6 * cam.scale)
  if (!visible(cam, x, y)) return
  ctx.save()
  circle(ctx, x + 2, y + 3, r); ctx.fillStyle = '#02070cca'; ctx.fill()
  circle(ctx, x, y, r + 2); ctx.strokeStyle = color; ctx.lineWidth = selected ? 2 : 1; ctx.stroke()
  sprite(ctx, 'robot', x, y, r * 2)
  ctx.save(); ctx.translate(x, y); ctx.rotate(heading)
  sprite(ctx, 'turret', 0, 0, r * 2)
  ctx.fillStyle = color; ctx.fillRect(-r * 0.18, -r * 0.13, r * 0.24, r * 0.26)
  ctx.restore()
  if (selected) {
    ctx.strokeStyle = '#829ba766'; ctx.lineWidth = 1; ctx.setLineDash([2, 8])
    ctx.beginPath(); ctx.moveTo(x + Math.cos(heading) * r * 1.2, y + Math.sin(heading) * r * 1.2)
    ctx.lineTo(x + Math.cos(heading) * 16 * cam.scale, y + Math.sin(heading) * 16 * cam.scale); ctx.stroke(); ctx.setLineDash([])
    ctx.strokeStyle = color; ctx.lineWidth = 2
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(x, y, r + 6, i * tau / 4 + 0.15, i * tau / 4 + 0.65); ctx.stroke() }
  }
  const guardR = r * ROBOT_SHIELD_RADIUS
  const guardOuterR = guardR * ROBOT_SHIELD_OUTER_RADIUS
  if (shield) {
    circle(ctx, x, y, guardR); ctx.fillStyle = '#eff9ff12'; ctx.fill()
    ctx.strokeStyle = ink.white; ctx.lineWidth = r * 0.18; ctx.stroke()
    circle(ctx, x, y, guardOuterR); ctx.strokeStyle = '#ffffff70'; ctx.lineWidth = r * 0.06; ctx.stroke()
    const marker = r * 0.22
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < 4; i++) {
      const a = i * tau / 4
      ctx.fillRect(x + Math.cos(a) * guardR - marker / 2, y + Math.sin(a) * guardR - marker / 2, marker, marker)
    }
  }
  if (invulnerable) {
    ctx.globalAlpha = motion.matches ? 0.64 : 0.64 + 0.1 * Math.sin(tick / 12)
    circle(ctx, x, y, guardR); ctx.fillStyle = `${ink.lime}14`; ctx.fill()
    ctx.strokeStyle = ink.lime; ctx.lineWidth = r * 0.12; ctx.setLineDash([r * 0.3, r * 0.2]); ctx.stroke()
    circle(ctx, x, y, guardOuterR); ctx.globalAlpha *= 0.52; ctx.lineWidth = r * 0.06; ctx.setLineDash([]); ctx.stroke()
  } else if (dashing) {
    ctx.lineWidth = r * 0.07; ctx.strokeStyle = ink.cyan; ctx.globalAlpha = 0.85
    circle(ctx, x, y, r * 1.75); ctx.stroke()
  }
  ctx.restore()
}

export function drawCore(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number, mega: boolean, tick = 0): void {
  const x = cam.toPxX(wx), y = cam.toPxY(wy), size = Math.max(8, (mega ? 1.05 : 0.8) * cam.scale)
  if (!visible(cam, x, y)) return
  const bob = motion.matches ? 0 : Math.sin(tick / 24 + wx) * Math.min(2, cam.scale * 0.06)
  ctx.save(); ctx.fillStyle = '#02091090'
  ctx.beginPath(); ctx.ellipse(x, y + size * 0.5, size * 0.4, size * 0.14, 0, 0, tau); ctx.fill()
  sprite(ctx, 'core', x, y + bob, size)
  if (mega) { ctx.strokeStyle = ink.lime; ctx.lineWidth = 1; circle(ctx, x, y, size * 0.7); ctx.stroke() }
  ctx.restore()
}

/** 散开入场参数（render 插值后传入）：p 为缓动后的飞行进度 0..1，from 为出发原点（世界坐标）。 */
export interface PointDropIntro { p: number; fromX: number; fromY: number }

/** reduced-motion 查询：渲染层据此跳过晶片入场动画（本体浮动在内部同源裁决）。 */
export function reducedMotion(): boolean { return motion.matches }

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y)
  ctx.closePath()
}

// drawPointDrop：技能点晶片（ADR-0016）——amber 小菱形（0.315m，明显小于
// 0.8m 的 core），与 HUD 计数器同一语义形状（icons.skillPoint 的画布近亲）：
// 微光外菱 + amber 本体 + 深色内菱 + 闪点，>1 点才带数值角标。轻微浮动
// （reduced-motion 关）与落地阴影；入场期（intro）自阵亡点飞来：淡入、
// 放大弹出并拖出渐隐运动条。
export function drawPointDrop(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number, points: number, tick = 0, intro?: PointDropIntro, label = POINT_LABELS[points] ?? ''): void {
  const x = cam.toPxX(wx), y = cam.toPxY(wy), size = Math.max(4.5, 0.315 * cam.scale)
  if (!visible(cam, x, y)) return
  // reduced-motion 下入场动画整体退化（渲染层也会跳过，这里兜底独立调用方）。
  const fly = !motion.matches && intro !== undefined && intro.p < 1 ? intro : undefined
  const p = fly?.p ?? 1
  const s = size * (fly ? 0.55 + 0.45 * p : 1)
  const alpha = fly ? Math.min(1, 0.3 + p * 2.2) : 1
  const bob = motion.matches || fly ? 0 : Math.sin(tick / 20 + wx) * Math.min(1.125, cam.scale * 0.03)
  const cy = y + bob
  ctx.save()
  if (fly) {
    const fx = cam.toPxX(fly.fromX), fy = cam.toPxY(fly.fromY)
    if (Math.hypot(x - fx, y - fy) > 3) {
      ctx.globalAlpha = 0.38 * (1 - p); ctx.strokeStyle = ink.amber
      ctx.lineWidth = Math.max(1, s * 0.14)
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(x, cy); ctx.stroke()
    }
  }
  ctx.globalAlpha = alpha * (fly ? 0.3 + 0.7 * p : 1)
  ctx.fillStyle = '#02091090'
  ctx.beginPath(); ctx.ellipse(x, y + size * 0.4, s * 0.26, s * 0.09, 0, 0, tau); ctx.fill()
  ctx.globalAlpha = alpha * 0.16; ctx.fillStyle = ink.amber
  diamond(ctx, x, cy, s * 0.85); ctx.fill()
  ctx.globalAlpha = alpha; ctx.fillStyle = ink.amber
  diamond(ctx, x, cy, s * 0.5); ctx.fill()
  ctx.fillStyle = '#070d14'
  diamond(ctx, x, cy, s * 0.3); ctx.fill()
  const twinkle = motion.matches ? 0.6 : 0.5 + 0.5 * Math.sin(tick / 9 + wx * 3)
  ctx.globalAlpha = alpha * (0.3 + 0.4 * twinkle)
  ctx.fillStyle = ink.white
  const g = Math.max(1, s * 0.1)
  ctx.fillRect(x - s * 0.2, cy - s * 0.36, g, g)
  if (points > 1) {
    ctx.fillStyle = ink.amber; ctx.font = FONT_10; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillText(label, x, cy + s * 0.55)
  }
  ctx.restore()
}

export function drawHealthPack(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number, available: boolean, respawnLabel: string, tick = 0): void {
  // 0.95 m sprite: clearly bigger than a core (0.8 m) but smaller than a
  // robot (1.2 m), matching the 1.15 m pickup reach of HealthPackRadius.
  const x = cam.toPxX(wx), y = cam.toPxY(wy), size = Math.max(10, 0.95 * cam.scale)
  if (!visible(cam, x, y)) return
  const bob = available && !motion.matches ? Math.sin(tick / 18 + wx * 0.1) * Math.min(2, cam.scale * 0.05) : 0
  ctx.save()
  ctx.globalAlpha = available ? 1 : 0.35
  sprite(ctx, 'healthPack', x, y + bob, size)
  if (available) {
    ctx.strokeStyle = `${ink.lime}88`; ctx.lineWidth = 1; ctx.setLineDash([2, 5]); circle(ctx, x, y, size * 0.62); ctx.stroke()
  } else if (respawnLabel) {
    ctx.globalAlpha = 0.85; ctx.fillStyle = ink.dim; ctx.font = FONT_10; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillText(respawnLabel, x, y + size * 0.55)
  }
  ctx.restore()
}

function drawMainUplink(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, ready: boolean, progress: number): void {
  // Armored command relay: a centered chassis, directional crown and twin energy banks.
  // All hardware stays fixed; progress only fills the four paired cells from bottom to top.
  ctx.beginPath(); ctx.moveTo(x - size * 0.42, y - size * 0.7)
  ctx.lineTo(x + size * 0.42, y - size * 0.7); ctx.lineTo(x + size * 0.7, y - size * 0.42)
  ctx.lineTo(x + size * 0.7, y + size * 0.42); ctx.lineTo(x + size * 0.42, y + size * 0.7)
  ctx.lineTo(x - size * 0.42, y + size * 0.7); ctx.lineTo(x - size * 0.7, y + size * 0.42)
  ctx.lineTo(x - size * 0.7, y - size * 0.42); ctx.closePath()
  ctx.fillStyle = '#101e28'; ctx.fill(); ctx.strokeStyle = '#73939e'; ctx.lineWidth = 1; ctx.stroke()
  ctx.fillStyle = ink.panel; ctx.fillRect(x - size * 0.58, y - size * 0.4, size * 1.16, size * 0.8)
  ctx.strokeStyle = ink.line; ctx.strokeRect(x - size * 0.58, y - size * 0.4, size * 1.16, size * 0.8)

  ctx.strokeStyle = '#b6cdd2'; ctx.lineWidth = Math.max(1, size * 0.04); ctx.beginPath()
  for (const side of [-1, 1]) {
    ctx.moveTo(x + side * size * 0.22, y - size * 0.7)
    ctx.lineTo(x + side * size * 0.42, y - size * 0.7); ctx.lineTo(x + side * size * 0.7, y - size * 0.42)
    ctx.moveTo(x + side * size * 0.7, y + size * 0.42)
    ctx.lineTo(x + side * size * 0.42, y + size * 0.7); ctx.lineTo(x + side * size * 0.22, y + size * 0.7)
    ctx.moveTo(x + side * size * 0.28, y - size * 0.7)
    ctx.lineTo(x + side * size * 0.28, y - size * 0.94); ctx.lineTo(x + side * size * 0.44, y - size * 0.94)
  }
  ctx.moveTo(x, y - size * 0.7); ctx.lineTo(x, y - size * 1.12); ctx.stroke()
  ctx.fillStyle = ready ? ink.lime : ink.dim
  ctx.fillRect(x - size * 0.12, y - size * 1.12, size * 0.24, size * 0.06)
  for (const side of [-1, 1]) ctx.fillRect(x + side * size * 0.4 - size * 0.04, y - size * 0.98, size * 0.08, size * 0.08)

  ctx.beginPath(); ctx.moveTo(x, y - size * 0.34); ctx.lineTo(x + size * 0.3, y)
  ctx.lineTo(x, y + size * 0.34); ctx.lineTo(x - size * 0.3, y); ctx.closePath()
  ctx.fillStyle = '#2c4650'; ctx.fill(); ctx.strokeStyle = ink.text; ctx.lineWidth = 1; ctx.stroke()
  ctx.strokeStyle = '#7aa1a7'; ctx.beginPath()
  ctx.moveTo(x, y - size * 0.24); ctx.lineTo(x, y + size * 0.24)
  ctx.moveTo(x - size * 0.2, y); ctx.lineTo(x + size * 0.2, y); ctx.stroke()
  ctx.fillStyle = ink.floor; ctx.fillRect(x - size * 0.1, y - size * 0.12, size * 0.2, size * 0.24)
  ctx.strokeStyle = '#b6cdd2'; ctx.strokeRect(x - size * 0.1, y - size * 0.12, size * 0.2, size * 0.24)
  ctx.fillStyle = ready ? ink.lime : ink.dim; ctx.fillRect(x - size * 0.04, y - size * 0.04, size * 0.08, size * 0.08)

  for (const side of [-1, 1]) {
    const bx = x + side * size * 0.49 - size * 0.06
    ctx.strokeStyle = '#486768'; ctx.strokeRect(bx - size * 0.03, y - size * 0.36, size * 0.18, size * 0.72)
    for (let i = 0; i < 4; i++) {
      const by = y + size * (0.22 - i * 0.17)
      ctx.fillStyle = '#486768'; ctx.fillRect(bx, by, size * 0.12, size * 0.1)
      const filled = Math.min(1, Math.max(0, progress * 4 - i))
      if (filled > 0) { ctx.fillStyle = ink.cyan; ctx.fillRect(bx, by, size * 0.12 * filled, size * 0.1) }
    }
  }
}

export function drawUplink(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number, main: boolean, ready: boolean, progress = 0, _lift = 0): void {
  // Keep the legacy argument for callers; neither hardware nor its base floats.
  const x = cam.toPxX(wx), y = cam.toPxY(wy), size = Math.max(12, (main ? 2.1 : 1.7) * cam.scale)
  if (!visible(cam, x, y)) return
  ctx.save(); ctx.globalAlpha = ready || progress > 0 ? 1 : 0.55
  if (main) drawMainUplink(ctx, x, y, size, ready, progress)
  else {
    circle(ctx, x, y, size * 0.7); ctx.fillStyle = '#1c343a'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = '#486768'; ctx.stroke()
    sprite(ctx, 'uplink', x, y, size)
  }
  if (progress > 0) {
    if (!main) {
      circle(ctx, x, y, size * 0.9); ctx.strokeStyle = '#49616e'; ctx.lineWidth = 5; ctx.stroke()
      ctx.strokeStyle = ink.cyan; ctx.lineWidth = 5; ctx.beginPath()
      const a = -tau / 4 + Math.min(1, progress) * tau
      ctx.arc(x, y, size * 0.9, -tau / 4, a); ctx.stroke()
      ctx.fillStyle = ink.white; ctx.fillRect(x + Math.cos(a) * size * 0.9 - 3, y + Math.sin(a) * size * 0.9 - 3, 6, 6)
    }
    ctx.font = FONT_16; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = ink.text
    ctx.fillText(PERCENT_LABELS[Math.min(100, Math.floor(progress * 100))] ?? '', x, y + size + 5)
  }
  ctx.restore()
}

// 弹道渐变坐标是 translate 后的局部坐标，只依赖 (颜色, 长度)，与弹丸位置无关；
// 长度仅随 cam.scale（一局内恒定）变化。按 ctx 分桶缓存（CanvasGradient 跨 ctx 使用
// 无规范保证），长度按 1/4 像素分桶限容，消除每弹每帧 createLinearGradient。
const beamGradients = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient>>()

export function prepareProjectileTrail(ctx: CanvasRenderingContext2D, scale: number, color: string): CanvasGradient {
  let cached = beamGradients.get(ctx)
  if (!cached) { cached = new Map(); beamGradients.set(ctx, cached) }
  const bucket = Math.round(1.4 * scale * 4) / 4
  const key = color + '|' + bucket
  let trail = cached.get(key)
  if (!trail) {
    if (cached.size >= 128) cached.clear()
    trail = ctx.createLinearGradient(-bucket, 0, 0, 0)
    trail.addColorStop(0, `${ink.cyan}00`); trail.addColorStop(1, color)
    cached.set(key, trail)
  }
  return trail
}

export function drawProjectile(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number, heading: number, color: string, trail?: CanvasGradient): void {
  const x = cam.toPxX(wx), y = cam.toPxY(wy)
  if (!visible(cam, x, y)) return
  ctx.save(); ctx.translate(x, y); ctx.rotate(heading)
  const length = 1.4 * cam.scale
  ctx.fillStyle = trail ?? color; ctx.fillRect(-length, -2, length, 4)
  ctx.fillStyle = ink.text; ctx.fillRect(-3, -1, 4, 2); ctx.restore()
}

export function drawVitals(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number, hp: number, energy: number, nick: string, selected: boolean, shield = false, delayedHp = hp, maxHp = 100, maxEnergy = 100): void {
  const x = cam.toPxX(wx), y = cam.toPxY(wy), r = Math.max(6, 0.6 * cam.scale)
  if (!visible(cam, x, y)) return
  const clearance = shield ? r * ROBOT_SHIELD_RADIUS * ROBOT_SHIELD_OUTER_RADIUS : r
  const w = Math.max(24, r * 2.5), by = y - clearance - 12
  ctx.save(); ctx.fillStyle = '#060c12'; ctx.fillRect(x - w / 2 - 1, by - 1, w + 2, 8)
  const actualRatio = Math.min(1, Math.max(0, hp / maxHp))
  const delayedRatio = Math.min(1, Math.max(actualRatio, delayedHp / maxHp))
  if (delayedRatio > actualRatio) {
    ctx.fillStyle = '#ffb066'; ctx.fillRect(x - w / 2 + w * actualRatio, by, w * (delayedRatio - actualRatio), 3)
  }
  ctx.fillStyle = hp > 25 ? '#8cff66' : ink.danger; ctx.fillRect(x - w / 2, by, w * actualRatio, 3)
  ctx.fillStyle = ink.cyan; ctx.fillRect(x - w / 2, by + 5, w * Math.min(1, Math.max(0, energy / maxEnergy)), 2)
  ctx.font = FONT_11; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = selected ? ink.cyan : ink.text; ctx.fillText(nick, x, by - 5); ctx.restore()
}
