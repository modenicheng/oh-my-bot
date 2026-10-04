// Shared vector art for live play and replay. SVGs decode once; drawing uses simulation time.
import type { Camera } from './camera'
import type { MapDefParsed } from './mapdef'

export const ink = {
  bg: '#070d14', floor: '#101b25', panel: '#182735', line: '#29414f',
  text: '#d8e5eb', dim: '#8b9fab', cyan: '#22d3ee', lime: '#b9d985', danger: '#ff756d', white: '#f4fbff',
} as const
export const mono = '"Fusion Pixel", ui-monospace, monospace'
const FONT_10 = `10px ${mono}`
const FONT_11 = `11px ${mono}`
const FONT_16 = `16px ${mono}`
const tau = Math.PI * 2
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

function sprite(ctx: CanvasRenderingContext2D, name: keyof typeof sprites, x: number, y: number, size: number): void {
  const image = sprites[name]
  if (image.complete && image.naturalWidth) ctx.drawImage(image, x - size / 2, y - size / 2, size, size)
  else { ctx.fillStyle = ink.dim; ctx.fillRect(x - size / 4, y - size / 4, size / 2, size / 2) }
}
function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath(); ctx.arc(x, y, r, 0, tau)
}
function visible(cam: Camera, x: number, y: number, margin = 80): boolean {
  return x > -margin && y > -margin && x < cam.cw + margin && y < cam.ch + margin
}

export function drawArena(ctx: CanvasRenderingContext2D, map: MapDefParsed, cam: Camera, phase: number): void {
  const x = cam.toPxX(0), y = cam.toPxY(0), s = cam.scale
  ctx.save()
  circle(ctx, x, y, 80 * s)
  ctx.fillStyle = ink.floor; ctx.fill(); ctx.clip()
  // Eight equal sectors and concentric service lanes give orientation at both zoom levels.
  for (let i = 0; i < 8; i++) {
    const a = (i - 0.5) * tau / 8
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, 80 * s, a, a + tau / 8); ctx.closePath()
    ctx.fillStyle = i % 2 ? '#13212b' : ink.floor; ctx.fill()
  }
  ctx.lineWidth = 1; ctx.strokeStyle = '#263b4760'
  const left = Math.max(-80, Math.floor(cam.toWorldX(0) / 4) * 4)
  const top = Math.max(-80, Math.floor(cam.toWorldY(0) / 4) * 4)
  const right = Math.min(80, cam.toWorldX(cam.cw)), bottom = Math.min(80, cam.toWorldY(cam.ch))
  ctx.beginPath()
  for (let gx = left; gx <= right; gx += 4) { ctx.moveTo(cam.toPxX(gx), cam.toPxY(-80)); ctx.lineTo(cam.toPxX(gx), cam.toPxY(80)) }
  for (let gy = top; gy <= bottom; gy += 4) { ctx.moveTo(cam.toPxX(-80), cam.toPxY(gy)); ctx.lineTo(cam.toPxX(80), cam.toPxY(gy)) }
  ctx.stroke()
  for (const r of [55, 78.5]) {
    circle(ctx, x, y, r * s); ctx.strokeStyle = '#0a131d'; ctx.lineWidth = Math.max(2, s * 0.65); ctx.stroke()
    ctx.strokeStyle = '#3c5564'; ctx.lineWidth = 1; ctx.stroke()
  }
  for (let i = 0; i < 8; i++) {
    const a = (i + 0.5) * tau / 8
    ctx.strokeStyle = '#3c55647a'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 30 * s, y + Math.sin(a) * 30 * s)
    ctx.lineTo(x + Math.cos(a) * 78.5 * s, y + Math.sin(a) * 78.5 * s); ctx.stroke()
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
      ctx.fillText(`出生区 ${String(sector.id + 1).padStart(2, '0')}`, px + 8, py + 8)
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
  // Solid outer fence corresponds to the authoritative 80m boundary.
  ctx.save()
  circle(ctx, x, y, 80 * s); ctx.strokeStyle = '#3b6878'; ctx.lineWidth = 3; ctx.stroke()
  circle(ctx, x, y, 80 * s); ctx.strokeStyle = '#6dd1db'; ctx.lineWidth = 1; ctx.stroke()
  ctx.strokeStyle = '#87c9d3'; ctx.lineWidth = Math.max(1, s * 0.08); ctx.beginPath()
  for (let i = 0; i < 128; i++) {
    const a = i * tau / 128, c = Math.cos(a), sn = Math.sin(a)
    ctx.moveTo(x + c * 79.3 * s, y + sn * 79.3 * s); ctx.lineTo(x + c * 80 * s, y + sn * 80 * s)
  }
  ctx.stroke(); ctx.restore()
}

export function drawCover(ctx: CanvasRenderingContext2D, map: MapDefParsed, cam: Camera): void {
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
  if (shield) {
    const sr = r * 1.65 + 5
    circle(ctx, x, y, sr); ctx.fillStyle = '#eff9ff12'; ctx.fill()
    ctx.strokeStyle = ink.white; ctx.lineWidth = Math.max(3, cam.scale * 0.06); ctx.stroke()
    circle(ctx, x, y, sr + 4); ctx.strokeStyle = '#ffffff70'; ctx.lineWidth = 1; ctx.stroke()
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < 4; i++) {
      const a = i * tau / 4
      ctx.fillRect(Math.round(x + Math.cos(a) * sr) - 2, Math.round(y + Math.sin(a) * sr) - 2, 4, 4)
    }
  }
  if (invulnerable || dashing) {
    ctx.lineWidth = 1; ctx.strokeStyle = ink.cyan
    ctx.globalAlpha = invulnerable && !motion.matches ? 0.65 + 0.25 * Math.sin(tick / 12) : 0.85
    if (invulnerable) ctx.setLineDash([3, 4])
    circle(ctx, x, y, r + (dashing ? 9 : 5)); ctx.stroke()
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

export function drawHealthPack(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number, available: boolean, respawnInS: number, tick = 0): void {
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
  } else if (respawnInS > 0) {
    ctx.globalAlpha = 0.85; ctx.fillStyle = ink.dim; ctx.font = FONT_10; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillText(`${respawnInS}s`, x, y + size * 0.55)
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
    ctx.fillText(`${Math.min(100, Math.floor(progress * 100))}%`, x, y + size + 5)
  }
  ctx.restore()
}

// 弹道渐变坐标是 translate 后的局部坐标，只依赖 (颜色, 长度)，与弹丸位置无关；
// 长度仅随 cam.scale（一局内恒定）变化。按 ctx 分桶缓存（CanvasGradient 跨 ctx 使用
// 无规范保证），长度按 1/4 像素分桶限容，消除每弹每帧 createLinearGradient。
const beamGradients = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient>>()

export function drawProjectile(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number, heading: number, color: string): void {
  const x = cam.toPxX(wx), y = cam.toPxY(wy)
  if (!visible(cam, x, y)) return
  ctx.save(); ctx.translate(x, y); ctx.rotate(heading)
  const length = 1.4 * cam.scale
  let cached = beamGradients.get(ctx)
  if (!cached) { cached = new Map(); beamGradients.set(ctx, cached) }
  const bucket = Math.round(length * 4) / 4
  const key = color + '|' + bucket
  let trail = cached.get(key)
  if (!trail) {
    // One bounded beam, no frame-history allocations and no trail beyond the authoritative projectile.
    trail = ctx.createLinearGradient(-bucket, 0, 0, 0)
    trail.addColorStop(0, `${ink.cyan}00`); trail.addColorStop(1, color)
    cached.set(key, trail)
  }
  ctx.fillStyle = trail; ctx.fillRect(-length, -2, length, 4)
  ctx.fillStyle = ink.text; ctx.fillRect(-3, -1, 4, 2); ctx.restore()
}

export function drawVitals(ctx: CanvasRenderingContext2D, cam: Camera, wx: number, wy: number, hp: number, energy: number, nick: string, selected: boolean, shield = false, delayedHp = hp): void {
  const x = cam.toPxX(wx), y = cam.toPxY(wy), r = Math.max(6, 0.6 * cam.scale)
  if (!visible(cam, x, y)) return
  const clearance = shield ? r * 1.65 + 9 : r
  const w = Math.max(24, r * 2.5), by = y - clearance - 12
  ctx.save(); ctx.fillStyle = '#060c12'; ctx.fillRect(x - w / 2 - 1, by - 1, w + 2, 8)
  const actualRatio = Math.min(1, Math.max(0, hp / 100))
  const delayedRatio = Math.min(1, Math.max(actualRatio, delayedHp / 100))
  if (delayedRatio > actualRatio) { ctx.fillStyle = ink.white; ctx.fillRect(x - w / 2, by, w * delayedRatio, 3) }
  ctx.fillStyle = hp > 25 ? ink.lime : ink.danger; ctx.fillRect(x - w / 2, by, w * actualRatio, 3)
  ctx.fillStyle = ink.cyan; ctx.fillRect(x - w / 2, by + 5, w * Math.min(1, Math.max(0, energy / 100)), 2)
  ctx.font = FONT_11; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = selected ? ink.cyan : ink.text; ctx.fillText(nick, x, by - 5); ctx.restore()
}
