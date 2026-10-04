// Live snapshots share the same arena and SVG entity art as the replay renderer.
import { Phase } from '@omb/protocol'
import type { WorldState } from './world'
import type { Camera } from './camera'
import type { MapDefParsed } from './mapdef'
import type { GameFeedback } from './feedback'
import { ink, mono, ROBOT_SHIELD_OUTER_RADIUS, ROBOT_SHIELD_RADIUS, drawArena, drawCover, drawRobot, drawCore, drawHealthPack, drawUplink, drawProjectile, drawVitals } from './art'
import { appendWallShadow } from './shadow'
import { hackMaxX10 } from './tuning'
const ROBOT_R = 0.6
const VISION_FEATHER = 3.5

// 旧 512 射线采样 + 多 band 填充已被逐墙精确投影取代（shadow.ts）：每帧每墙
// 常数次几何运算 + 单次非零填充，墙影轮廓不再受射线角分辨率限制。
const FONT_11 = `11px ${mono}`
const FONT_14 = `14px ${mono}`
/** 影多边形填充：与旧 24-band 叠加的收敛色一致（0.78 × 9/24），重叠区不加深。 */
const SHADOW_FILL = 'rgba(5, 9, 14, 0.2925)'

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
      const progress = st?.progressX10 ? st.progressX10 / hackMaxX10(world.tuning) : 0
      // Uplink 锚定 def.pos（进度环/交互圈同坐标）：悬浮表现归 art.ts 内部处理，
      // 此处不再对实体坐标做 lift 偏移。
      drawUplink(ctx, cam, def.pos.x, def.pos.y, def.main,
        world.phase >= def.activePhase && (st?.ready ?? true), progress, 0)
      const selfPos = world.robots.get(world.self?.robotId ?? 0)?.base?.pos
      if (selfPos && world.phase >= def.activePhase
        && Math.hypot(selfPos.x - def.pos.x, selfPos.y - def.pos.y) <= def.interactR) {
        ctx.save(); ctx.strokeStyle = `${ink.cyan}66`; ctx.lineWidth = 1; ctx.setLineDash([5, 7])
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
      const invulnerable = (r.invulnUntil ?? 0) > performance.now()
      drawRobot(ctx, cam, b.pos.x, b.pos.y, heading, r.color || ink.cyan, self,
        r.shieldOn, r.dashing, invulnerable, world.tick)
      drawVitals(ctx, cam, b.pos.x, b.pos.y, r.hpX10 / 10, r.energyX10 / 10, r.nick, self, r.shieldOn || invulnerable,
        extras.feedback?.delayedHealth(b.id, r.hpX10) ?? r.hpX10 / 10)
    }
    // Dim the rendered world itself; HUD feedback and speech stay above the fog.
    this.drawVisionMask(world, map, cam)
    extras.feedback?.draw(ctx, cam)
    this.drawBubbles(world, cam, extras)
  }

  /** 20m 圆形视野 + 墙体投射的视线阴影，全部在当前 Canvas 内合成。
   * 墙影 = 每墙一次精确凸轮廓投影（shadow.ts）：远侧边链 + 两切线延长点，
   * 全部墙的子路径合入单一 beginPath 后一次 nonzero 填充——重叠阴影天然
   * 保持一次强度（L 形两件套正面积重叠不加深）。 */
  private drawVisionMask(world: WorldState, map: MapDefParsed, cam: Camera): void {
    const self = world.robots.get(world.self?.robotId ?? 0)?.base?.pos
    if (!self || cam.scale <= 0) return

    const ctx = this.ctx
    const x = cam.toPxX(self.x)
    const y = cam.toPxY(self.y)
    const radius = world.tuning.visionRadius * cam.scale
    const feather = Math.min(VISION_FEATHER * cam.scale, radius * 0.28)
    const clearRadius = Math.max(0, radius - feather)

    ctx.save()
    // Fill only outside the 20m circle. Do not use destination-out here:
    // erasing the canvas would reveal the page background, not the world below.
    ctx.fillStyle = 'rgba(5, 9, 14, 0.78)'

    // X-9：未解锁核心区整体压黑（服务器裁剪区内实体，但雾不能「照亮」本应
    // 全黑的锁区——与弹丸撞锁区消失的体验对齐）。圆心与 drawArena 的锁区
    // 圈同为场地原点（非自机），直接填充锁区内部；解锁判定与 drawArena 的
    // unlocked（phase >= unlock_phase && phase > 0）互补。墙影/边缘渐变随后
    // 叠加只会更暗，不会重新「照亮」锁区。
    if (world.phase > 0 && world.phase < map.coreZone.unlockPhase) {
      ctx.beginPath()
      ctx.arc(cam.toPxX(0), cam.toPxY(0), map.coreZone.radius * cam.scale, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.beginPath()
    ctx.rect(0, 0, cam.cw, cam.ch)
    ctx.arc(x, y, radius, 0, Math.PI * 2, true)
    ctx.fill('evenodd')

    // 精确墙影：视野圆作为 clip，随后单次填充所有墙的影多边形。pts 为每帧
    // 复用的扁平 x,y 数组，appendWallShadow 零分配：每墙一段（顶点 + 末尾
    // 一个 NaN,NaN 墙界分隔符，自机在墙内时该墙内部另有 NaN 分隔的子路径），
    // 投影在世界坐标系完成后按 cam 变换到像素。每墙独立子路径（首顶点
    // moveTo）：子路径间的连线会在可见区拉出伪影边。
    const pts = this.shadowPts
    const range = world.tuning.visionRadius
    pts.length = 0
    for (let i = 0; i < map.walls.length; i++) {
      if (appendWallShadow(pts, self.x, self.y, map.walls[i]!, range) > 0) pts.push(Number.NaN, Number.NaN)
    }
    if (pts.length > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.clip()
      ctx.beginPath()
      let pen = false
      for (let j = 0; j < pts.length; j += 2) {
        const px = pts[j]!, py = pts[j + 1]!
        if (Number.isNaN(px) || Number.isNaN(py)) { pen = false; continue } // 墙/子路径界
        const cx = cam.toPxX(px), cy = cam.toPxY(py)
        if (pen) ctx.lineTo(cx, cy)
        else { ctx.moveTo(cx, cy); pen = true }
      }
      ctx.fillStyle = SHADOW_FILL
      ctx.fill()
      ctx.restore()
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

  /** 影多边形顶点缓冲：drawVisionMask 每帧复用（length=0 重置），零稳态分配。 */
  private readonly shadowPts: number[] = []
  private edgeKey = ''
  private edgeGradient: CanvasGradient | null = null

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
      const guarded = r.shieldOn || (r.invulnUntil ?? 0) > now
      const anchorY = cam.toPxY(pos.y) - (guarded ? radius * ROBOT_SHIELD_RADIUS * ROBOT_SHIELD_OUTER_RADIUS : radius) - 38
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
