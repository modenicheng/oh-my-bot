// Live snapshots share the same arena and SVG entity art as the replay renderer.
import { Phase } from '@omb/protocol'
import type { WorldState } from './world'
import type { Camera } from './camera'
import type { MapDefParsed } from './mapdef'
import type { GameFeedback } from './feedback'
import { ink, mono, UPLINK_LIFT, drawArena, drawCover, drawRobot, drawCore, drawHealthPack, drawUplink, drawProjectile, drawVitals } from './art'
import { HACK_MAX_X10 } from './mapdef'
const ROBOT_R = 0.6
const DEFAULT_VISION_RADIUS = 20
const VISION_FEATHER = 3.5

const VISION_RAYS = 512
const RAY_STEP = Math.PI * 2 / VISION_RAYS
const FEATHER_BANDS = 8
const SHADOW_BANDS = 24
// 射线角度只依赖序号、与 band 无关：预计算方向与扇形边角的三角表，
// 消除每 band × 每射线的重复 cos/sin（此前每帧约 6.5 万次，98% 为重复值）。
const RAY = (() => {
  const dirX = new Float64Array(VISION_RAYS)
  const dirY = new Float64Array(VISION_RAYS)
  const a0x = new Float64Array(VISION_RAYS)
  const a0y = new Float64Array(VISION_RAYS)
  const a1x = new Float64Array(VISION_RAYS)
  const a1y = new Float64Array(VISION_RAYS)
  for (let i = 0; i < VISION_RAYS; i++) {
    const center = (i + 0.5) * RAY_STEP
    dirX[i] = Math.cos(center); dirY[i] = Math.sin(center)
    a0x[i] = Math.cos(center - RAY_STEP / 2); a0y[i] = Math.sin(center - RAY_STEP / 2)
    a1x[i] = Math.cos(center + RAY_STEP / 2); a1y[i] = Math.sin(center + RAY_STEP / 2)
  }
  return { dirX, dirY, a0x, a0y, a1x, a1y }
})()
// 与原逐帧模板字符串逐字符一致，避免 Canvas 每帧重新解析新颜色串。
const FEATHER_FILL = Array.from({ length: FEATHER_BANDS },
  (_, band) => `rgba(5, 9, 14, ${0.78 * ((band + 1) / FEATHER_BANDS) * 0.65})`)
// 阴影 band 的 alpha 表达式与 band 序号无关（t1-t0 恒为 1/24），24 个 band 共用一个颜色。
const SHADOW_FILL = `rgba(5, 9, 14, ${0.78 * (1 / SHADOW_BANDS) * 9})`
const FONT_11 = `11px ${mono}`
const FONT_14 = `14px ${mono}`

export function phaseName(p: number): string {
  switch (p) {
    case Phase.OUTER_RING: return '外环'
    case Phase.CORE_OPEN: return '核心开放'
    default: return '—'
  }
}


export interface SayBubble {
  robotId: number; text: string; at: number
  layout?: { maxWidth: number; lines: string[]; width: number }
}
export interface RenderExtras { bubbles: SayBubble[]; localAim?: number; feedback?: GameFeedback }

export class Renderer {
  private ctx: CanvasRenderingContext2D
  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    this.ctx = ctx
  }
  resize(w: number, h: number, dpr: number): void {
    const width = Math.max(1, Math.floor(w * dpr))
    const height = Math.max(1, Math.floor(h * dpr))
    // 同值赋 width/height 也会清屏并重置全部 ctx 状态，resize 抖动时须短路。
    if (this.canvas.width === width && this.canvas.height === height) return
    this.canvas.width = width
    this.canvas.height = height
  }
  render(world: WorldState, map: MapDefParsed, cam: Camera, extras: RenderExtras): void {
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = ink.bg; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    const dpr = this.canvas.width / Math.max(1, cam.cw)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const shake = extras.feedback?.cameraShake(world.tick)
    if (shake && (shake.x || shake.y)) ctx.translate(shake.x, shake.y)
    drawArena(ctx, map, cam, world.phase)
    for (const def of map.uplinks) {
      const st = world.uplinks.get(def.id)
      const progress = st?.progressX10 ? st.progressX10 / HACK_MAX_X10 : 0
      const lift = extras.feedback?.uplinkLift(progress) ?? 0
      drawUplink(ctx, cam, def.pos.x, def.pos.y - lift * UPLINK_LIFT, def.main,
        world.phase >= def.activePhase && (st?.ready ?? true), progress, lift)
      const selfPos = world.robots.get(world.self?.robotId ?? 0)?.base?.pos
      if (selfPos && world.phase >= def.activePhase && Math.hypot(selfPos.x - def.pos.x, selfPos.y - def.pos.y) <= def.interactR) {
        ctx.save(); ctx.strokeStyle = '#22d3ee66'; ctx.lineWidth = 1; ctx.setLineDash([5, 7])
        ctx.beginPath(); ctx.arc(cam.toPxX(def.pos.x), cam.toPxY(def.pos.y), def.interactR * cam.scale, 0, Math.PI * 2); ctx.stroke(); ctx.restore()
      }
    }
    for (const core of world.cores.values()) {
      const p = core.base?.pos
      if (p) drawCore(ctx, cam, p.x, p.y, core.value >= 25, world.tick)
    }
    for (const def of map.healthPacks) {
      const state = world.healthPacks.get(def.id)
      drawHealthPack(ctx, cam, def.pos.x, def.pos.y, state?.available ?? true, state?.respawnInS ?? 0, world.tick)
    }
    drawCover(ctx, map, cam)
    for (const p of world.projectiles.values()) {
      const b = p.base
      if (b?.pos) drawProjectile(ctx, cam, b.pos.x, b.pos.y, b.heading, p.color || world.robots.get(p.ownerId)?.color || ink.cyan)
    }
    extras.feedback?.drawTrails(ctx, cam, world.tick)
    for (const r of world.robots.values()) {
      const b = r.base
      if (!b?.pos) continue
      if (r.dead) {
        ctx.fillStyle = ink.dim; ctx.font = FONT_11; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(`${r.respawnInS}s`, cam.toPxX(b.pos.x), cam.toPxY(b.pos.y))
        continue
      }
      const self = b.id === world.self?.robotId
      const heading = self && extras.localAim !== undefined ? extras.localAim : b.heading
      drawRobot(ctx, cam, b.pos.x, b.pos.y, heading, r.color || ink.cyan, self,
        r.shieldOn, r.dashing, (r.invulnUntil ?? 0) > performance.now(), world.tick)
      drawVitals(ctx, cam, b.pos.x, b.pos.y, r.hpX10 / 10, r.energyX10 / 10, r.nick, self, r.shieldOn,
        extras.feedback?.delayedHealth(b.id, r.hpX10) ?? r.hpX10 / 10)
    }
    // Dim the rendered world itself; HUD feedback and speech stay above the fog.
    this.drawVisionMask(world, map, cam)
    extras.feedback?.draw(ctx, cam)
    this.drawBubbles(world, cam, extras)
  }

  /** 20m 圆形视野 + 墙体投射的视线阴影，全部在当前 Canvas 内合成。 */
  private drawVisionMask(world: WorldState, map: MapDefParsed, cam: Camera): void {
    const self = world.robots.get(world.self?.robotId ?? 0)?.base?.pos
    if (!self || cam.scale <= 0) return

    const ctx = this.ctx
    const x = cam.toPxX(self.x)
    const y = cam.toPxY(self.y)
    const radius = DEFAULT_VISION_RADIUS * cam.scale
    const feather = Math.min(VISION_FEATHER * cam.scale, radius * 0.28)
    const clearRadius = Math.max(0, radius - feather)

    ctx.save()
    // Fill only outside the 20m circle. Do not use destination-out here:
    // erasing the canvas would reveal the page background, not the world below.
    ctx.fillStyle = 'rgba(5, 9, 14, 0.78)'
    ctx.beginPath()
    ctx.rect(0, 0, cam.cw, cam.ch)
    ctx.arc(x, y, radius, 0, Math.PI * 2, true)
    ctx.fill('evenodd')

    // Put back only the parts of the radius hidden behind walls. Sampling rays
    // avoids fragile corner-angle ordering for thin and wraparound AABBs.
    const hits = this.hits
    const range = radius / cam.scale
    for (let i = 0; i < VISION_RAYS; i++) {
      const distance = this.nearestWallHit(self.x, self.y, RAY.dirX[i]!, RAY.dirY[i]!, range, map.walls)
      hits[i] = distance === null ? -1 : Math.max(0, (distance - 0.03) * cam.scale)
    }

    // Feather just behind each wall, then continue the shadow to the view edge.
    // The narrow alpha bands remove the hard wall cut without polygon aliasing.
    const wallFeather = Math.max(8, Math.min(24, 1.2 * cam.scale))
    for (let band = 0; band < FEATHER_BANDS; band++) {
      const t0 = band / FEATHER_BANDS
      const t1 = (band + 1) / FEATHER_BANDS
      ctx.fillStyle = FEATHER_FILL[band]!
      ctx.beginPath()
      for (let i = 0; i < VISION_RAYS; i++) {
        const near = hits[i]!
        if (near < 0 || near >= radius) continue
        const start = near + wallFeather * t0
        const end = Math.min(radius, near + wallFeather * t1)
        ctx.moveTo(x + RAY.a0x[i]! * start, y + RAY.a0y[i]! * start)
        ctx.lineTo(x + RAY.a1x[i]! * start, y + RAY.a1y[i]! * start)
        ctx.lineTo(x + RAY.a1x[i]! * end, y + RAY.a1y[i]! * end)
        ctx.lineTo(x + RAY.a0x[i]! * end, y + RAY.a0y[i]! * end)
        ctx.closePath()
      }
      ctx.fill()
    }

    ctx.fillStyle = SHADOW_FILL
    for (let band = 0; band < SHADOW_BANDS; band++) {
      const t0 = band / SHADOW_BANDS
      const t1 = (band + 1) / SHADOW_BANDS
      ctx.beginPath()
      for (let i = 0; i < VISION_RAYS; i++) {
        const near = hits[i]!
        if (near < 0 || near + wallFeather >= radius) continue
        const start = near + wallFeather + (radius - near - wallFeather) * t0
        const end = near + wallFeather + (radius - near - wallFeather) * t1
        ctx.moveTo(x + RAY.a0x[i]! * start, y + RAY.a0y[i]! * start)
        ctx.lineTo(x + RAY.a1x[i]! * start, y + RAY.a1y[i]! * start)
        ctx.lineTo(x + RAY.a1x[i]! * end, y + RAY.a1y[i]! * end)
        ctx.lineTo(x + RAY.a0x[i]! * end, y + RAY.a0y[i]! * end)
        ctx.closePath()
      }
      ctx.fill()
    }

    // Keep the circular feather visible where there is no wall shadow.
    // 渐变参数仅随自机屏幕位置变化，稳态下恒定：单槽缓存消除每帧重建。
    const edgeKey = `${x},${y},${clearRadius},${radius}`
    if (this.edgeKey !== edgeKey || !this.edgeGradient) {
      const gradient = ctx.createRadialGradient(x, y, clearRadius, x, y, radius)
      gradient.addColorStop(0, 'rgba(5, 9, 14, 0)')
      gradient.addColorStop(0.72, 'rgba(5, 9, 14, 0.08)')
      gradient.addColorStop(1, 'rgba(5, 9, 14, 0.78)')
      this.edgeKey = edgeKey
      this.edgeGradient = gradient
    }
    ctx.fillStyle = this.edgeGradient
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  private readonly hits = new Float64Array(VISION_RAYS)
  private edgeKey = ''
  private edgeGradient: CanvasGradient | null = null

  /** 单射线对全部墙 AABB 的 slab 相交：标量化实现，调用频率为 射线数 × 墙数 × 60fps，
   * 不做任何中间数组分配（此前每墙每次调用新建 3 个短命数组，为全库最大 GC 压力点）。 */
  private nearestWallHit(x: number, y: number, dx: number, dy: number, radius: number, walls: MapDefParsed['walls']): number | null {
    let nearest = radius
    let hit = false
    for (let i = 0; i < walls.length; i++) {
      const wall = walls[i]!
      let enter = 0
      let exit = radius
      if (dx > -1e-8 && dx < 1e-8) {
        if (x < wall.min.x || x > wall.max.x) continue
      } else {
        const t0 = (wall.min.x - x) / dx
        const t1 = (wall.max.x - x) / dx
        if (t0 < t1) { if (t0 > enter) enter = t0; if (t1 < exit) exit = t1 }
        else { if (t1 > enter) enter = t1; if (t0 < exit) exit = t0 }
      }
      if (dy > -1e-8 && dy < 1e-8) {
        if (y < wall.min.y || y > wall.max.y) continue
      } else {
        const t0 = (wall.min.y - y) / dy
        const t1 = (wall.max.y - y) / dy
        if (t0 < t1) { if (t0 > enter) enter = t0; if (t1 < exit) exit = t1 }
        else { if (t1 > enter) enter = t1; if (t0 < exit) exit = t0 }
      }
      if (enter <= exit && exit >= 0 && enter <= radius) {
        // Keep the wall face visible; the occluded region starts after its far edge.
        nearest = Math.min(nearest, Math.max(0, exit))
        hit = true
      }
    }
    return hit ? nearest : null
  }

  /** say 气泡：随机器人移动的像素框，长消息换行，4s 后消失。 */
  private drawBubbles(world: WorldState, cam: Camera, extras: RenderExtras): void {
    const { ctx } = this
    const now = performance.now()
    for (const bub of extras.bubbles) {
      const r = world.robots.get(bub.robotId)
      const pos = r?.base?.pos
      if (!pos || r?.dead) continue
      const age = (now - bub.at) / 1000
      if (age > 4) continue
      const x = cam.toPxX(pos.x)
      const radius = Math.max(6, ROBOT_R * cam.scale)
      const anchorY = cam.toPxY(pos.y) - (r.shieldOn ? radius * 1.65 + 9 : radius) - 38
      if (x < -radius || x > cam.cw + radius || anchorY > cam.ch) continue
      ctx.save()
      ctx.font = FONT_14
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const maxWidth = Math.max(80, Math.min(240, cam.cw - 40))
      if (!bub.layout || bub.layout.maxWidth !== maxWidth) {
        const lines: string[] = []
        let line = ''
        for (const char of [...bub.text].slice(0, 160)) {
          if (line && ctx.measureText(line + char).width > maxWidth) { lines.push(line); line = '' }
          line += char
        }
        if (line) lines.push(line)
        bub.layout = { maxWidth, lines, width: Math.ceil(Math.max(0, ...lines.map(text => ctx.measureText(text).width))) + 20 }
      }
      const { lines, width } = bub.layout
      if (!lines.length) { ctx.restore(); continue }
      const height = lines.length * 18 + 16
      const left = Math.round(Math.max(8, Math.min(cam.cw - width - 8, x - width / 2)))
      const right = left + width
      const bottom = Math.round(Math.max(height + 8, anchorY))
      const top = bottom - height
      const tail = Math.round(Math.max(left + 10, Math.min(right - 10, x)))
      ctx.beginPath()
      ctx.moveTo(left + 4, top); ctx.lineTo(right - 4, top)
      ctx.lineTo(right - 4, top + 4); ctx.lineTo(right, top + 4)
      ctx.lineTo(right, bottom - 4); ctx.lineTo(right - 4, bottom - 4)
      ctx.lineTo(right - 4, bottom); ctx.lineTo(tail + 4, bottom)
      ctx.lineTo(tail + 4, bottom + 4); ctx.lineTo(tail, bottom + 4)
      ctx.lineTo(tail, bottom + 8); ctx.lineTo(tail - 4, bottom + 8)
      ctx.lineTo(tail - 4, bottom); ctx.lineTo(left + 4, bottom)
      ctx.lineTo(left + 4, bottom - 4); ctx.lineTo(left, bottom - 4)
      ctx.lineTo(left, top + 4); ctx.lineTo(left + 4, top + 4); ctx.closePath()
      ctx.fillStyle = '#10141af5'; ctx.fill()
      ctx.strokeStyle = r.color || ink.cyan; ctx.lineWidth = 1; ctx.stroke()
      ctx.fillStyle = ink.text
      lines.forEach((text, i) => ctx.fillText(text, left + width / 2, top + 17 + i * 18))
      ctx.restore()
    }
  }
}
