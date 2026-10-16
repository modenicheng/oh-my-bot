// Live snapshots share the same arena and SVG entity art as the replay renderer.
import { Phase } from '@omb/protocol'
import type { WorldState } from './world'
import type { Camera } from './camera'
import type { MapDefParsed } from './mapdef'
import type { GameFeedback } from './feedback'
import { ink, mono, ROBOT_R, ROBOT_SHIELD_OUTER_RADIUS, ROBOT_SHIELD_RADIUS, createCanvas2d, resizeCanvas2d, prepareArena, prepareUplinkText, prepareProjectileTrail, drawArena, drawCover, drawRobot, drawCore, drawHealthPack, drawPointDrop, drawUplink, drawProjectile, drawVitals, visibleWorld, reducedMotion, type PointDropIntro } from './art'
import { beginTextPreparation, drawText, prepareText } from './text-raster'
import { appendSurfaceShadow, appendWallShadow } from './shadow'
import { hackMaxX10 } from './tuning'
import { VisionRaster } from './vision-raster'
const VISION_FEATHER = 3.5
/** 晶片散开入场时长：从阵亡点飞至落点 + 淡入放大（reduced-motion 直接落定）。 */
const POINT_DROP_INTRO_MS = 460

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

/** 每帧热路径计数：供64人夹具验证视口裁剪不会退化为全实体绘制。 */
export interface RenderFrameStats { robots: number; culledRobots: number; drawnRobots: number; delayedHealthReads: number }

export class Renderer {
  private ctx: CanvasRenderingContext2D
  readonly lastFrameStats: RenderFrameStats = { robots: 0, culledRobots: 0, drawnRobots: 0, delayedHealthReads: 0 }
  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = createCanvas2d(canvas)
  }
  resize(w: number, h: number, dpr: number): void {
    resizeCanvas2d(this.canvas, w, h, dpr)
  }
  dispose(): void { this.visionRaster.dispose() }
  private readonly projectileTrails = new Map<number, CanvasGradient>()
  private readonly respawnLabels = new Map<number, string>()
  private readonly healthPackLabels = new Map<number, string>()
  private readonly pointDropLabels = new Map<number, string>()
  private readonly dropIntros = new Map<number, PointDropIntro>()
  private dpr = 1

  /** Snapshot/event/resize work. Drawing only reads these prepared resources. */
  prepare(world: WorldState, map: MapDefParsed, cam: Camera, extras: RenderExtras): void {
    map = map.partial ? world.localMap ?? map : map
    this.dpr = this.canvas.width / Math.max(1, cam.cw) || 1
    beginTextPreparation(this.ctx)
    prepareArena(map, this.ctx, this.dpr, cam)
    this.prepareVision(world, map, cam)
    this.prepareBubbles(extras.bubbles, cam)
    for (const id of this.respawnLabels.keys()) if (!world.robots.has(id)) this.respawnLabels.delete(id)
    for (const [id, robot] of world.robots) if (robot.dead) this.respawnLabels.set(id, `${robot.respawnInS}s`)
    this.healthPackLabels.clear()
    for (const [id, pack] of world.healthPacks) if (pack.respawnInS > 0) this.healthPackLabels.set(id, `${pack.respawnInS}s`)
    this.pointDropLabels.clear()
    for (const [id, drop] of world.pointDrops) if (drop.points > 1) this.pointDropLabels.set(id, String(drop.points))
    for (const [id, robot] of world.robots) {
      if (robot.dead) prepareText(this.respawnLabels.get(id) ?? '', FONT_11, ink.dim, this.dpr, this.ctx)
      else prepareText(robot.nick ?? '', FONT_11, id === world.self?.robotId ? ink.cyan : ink.text, this.dpr, this.ctx)
    }
    for (const label of this.healthPackLabels.values()) prepareText(label, `10px ${mono}`, ink.dim, this.dpr, this.ctx)
    for (const label of this.pointDropLabels.values()) prepareText(label, `10px ${mono}`, ink.amber, this.dpr, this.ctx)
    for (const uplink of world.uplinks.values()) prepareUplinkText(uplink.progressX10 / hackMaxX10(world.tuning), this.dpr, this.ctx)
    for (const id of this.projectileTrails.keys()) if (!world.projectiles.has(id)) this.projectileTrails.delete(id)
    for (const [id, projectile] of world.projectiles) {
      const color = projectile.color || world.robots.get(projectile.ownerId)?.color || ink.cyan
      this.projectileTrails.set(id, prepareProjectileTrail(this.ctx, cam.scale, color))
    }
    const now = performance.now()
    for (const id of this.dropIntros.keys()) if (!world.pointDrops.has(id)) this.dropIntros.delete(id)
    for (const [id, drop] of world.pointDrops) {
      const pos = drop.base?.pos
      if (!pos || drop.bornAt === undefined || now - drop.bornAt >= POINT_DROP_INTRO_MS) continue
      // Keep unresolved origins pending: a reliable spawn event can follow its snapshot.
      if (!drop.introFrom) drop.introFrom = extras.feedback?.nearestDropOrigin(pos.x, pos.y, now)
      const from = drop.introFrom ?? pos
      let intro = this.dropIntros.get(id)
      if (!intro) { intro = { p: 0, fromX: from.x, fromY: from.y }; this.dropIntros.set(id, intro) }
      else { intro.fromX = from.x; intro.fromY = from.y }
    }
  }

  prepareBubbles(bubbles: SayBubble[], cam: Camera, force = false): void {
    if (!bubbles.length) return
    const ctx = this.ctx, maxWidth = Math.max(80, Math.min(240, cam.cw - 40))
    ctx.save(); ctx.font = FONT_14
    for (const bubble of bubbles) {
      if (!force && bubble.layout?.maxWidth === maxWidth) {
        for (const line of bubble.layout.lines) prepareText(line, FONT_14, ink.text, this.dpr, ctx)
        continue
      }
      const lines: string[] = []
      let line = '', width = 0
      for (const char of [...bubble.text].slice(0, 160)) {
        const measured = ctx.measureText(line + char).width
        if (line && measured > maxWidth) { lines.push(line); width = Math.max(width, ctx.measureText(line).width); line = '' }
        line += char
      }
      if (line) { lines.push(line); width = Math.max(width, ctx.measureText(line).width) }
      bubble.layout = { maxWidth, lines, width: Math.ceil(width) + 20 }
      for (const text of lines) prepareText(text, FONT_14, ink.text, this.dpr, ctx)
    }
    ctx.restore()
  }
  render(world: WorldState, map: MapDefParsed, cam: Camera, extras: RenderExtras): void {
    const observation = world.localMap ?? map
    if (map.partial) map = observation
    const ctx = this.ctx
    const stats = this.lastFrameStats
    stats.robots = 0; stats.culledRobots = 0; stats.drawnRobots = 0; stats.delayedHealthReads = 0
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = ink.bg; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    const dpr = this.canvas.width / Math.max(1, cam.cw)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const shake = extras.feedback?.cameraShake(world.tick)
    if (shake && (shake.x || shake.y)) ctx.translate(shake.x, shake.y)
    drawArena(ctx, map, cam, world.phase)
    const now = performance.now()
    const introOff = reducedMotion()
    for (const def of observation.uplinks) {
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
    for (const drop of world.pointDrops.values()) {
      const p = drop.base?.pos
      if (!p) continue
      let x = p.x, y = p.y
      let intro: PointDropIntro | undefined
      if (drop.bornAt !== undefined) {
        const t = (now - drop.bornAt) / POINT_DROP_INTRO_MS
        if (!introOff && t >= 0 && t < 1) {
          intro = this.dropIntros.get(drop.base!.id)
          const fromX = intro?.fromX ?? p.x, fromY = intro?.fromY ?? p.y
          const e = 1 - (1 - t) ** 3 // easeOutCubic：先快后缓地滑向落点
          x = fromX + (p.x - fromX) * e
          y = fromY + (p.y - fromY) * e
          if (intro) intro.p = e
        }
      }
      drawPointDrop(ctx, cam, x, y, drop.points, world.tick, intro, this.pointDropLabels.get(drop.base!.id))
    }
    for (const def of observation.healthPacks) {
      const state = world.healthPacks.get(def.id)
      drawHealthPack(ctx, cam, def.pos.x, def.pos.y, state?.available ?? true, this.healthPackLabels.get(def.id) ?? '', world.tick)
    }
    if (!map.partial) drawCover(ctx, map, cam)
    for (const p of world.projectiles.values()) {
      const b = p.base
      if (b?.pos) drawProjectile(ctx, cam, b.pos.x, b.pos.y, b.heading, p.color || world.robots.get(p.ownerId)?.color || ink.cyan, this.projectileTrails.get(b.id))
    }
    extras.feedback?.drawTrails(ctx, cam, world.tick)
    for (const r of world.robots.values()) {
      stats.robots++
      const b = r.base
      if (!b?.pos || !visibleWorld(cam, b.pos.x, b.pos.y, 96)) { stats.culledRobots++; continue }
      stats.drawnRobots++
      if (r.dead) {
        drawText(ctx, this.respawnLabels.get(b.id) ?? '', FONT_11, ink.dim, cam.toPxX(b.pos.x), cam.toPxY(b.pos.y), 'center', 'middle')
        continue
      }
      const self = b.id === world.self?.robotId
      const heading = self && extras.localAim !== undefined ? extras.localAim : b.heading
      const invulnerable = r.invulnerable || (r.invulnUntil ?? 0) > now
      drawRobot(ctx, cam, b.pos.x, b.pos.y, heading, r.color || ink.cyan, self,
        r.shieldOn, r.dashing, invulnerable, world.tick)
      const delayedHp = extras.feedback
        ? (stats.delayedHealthReads++, extras.feedback.delayedHealth(b.id, r.hpX10, now))
        : r.hpX10 / 10
      // 头顶条分母走 per-robot 上限（ADR-0016）；缺失（旧服务器）回退 100。
      const maxHp = r.maxHpX10 ? r.maxHpX10 / 10 : 100
      const maxEn = r.maxEnergyX10 ? r.maxEnergyX10 / 10 : 100
      drawVitals(ctx, cam, b.pos.x, b.pos.y, r.hpX10 / 10, r.energyX10 / 10, r.nick, self, r.shieldOn || invulnerable, delayedHp, maxHp, maxEn)
    }
    // Dim the rendered world itself; HUD feedback and speech stay above the fog.
    extras.feedback?.draw(ctx, cam, 'world')
    this.drawVisionMask(world, map, cam)
    if (map.partial) {
      const observer = world.robots.get(world.self?.robotId ?? 0)?.base?.pos
      if (observer) {
        ctx.save(); ctx.beginPath()
        ctx.arc(cam.toPxX(observer.x), cam.toPxY(observer.y), (world.visionRadius ?? world.tuning.visionRadius) * cam.scale, 0, Math.PI * 2)
        ctx.clip(); drawCover(ctx, map, cam, observer); ctx.restore()
      }
    }
    extras.feedback?.draw(ctx, cam, 'screen')
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
    const radius = (world.visionRadius ?? world.tuning.visionRadius) * cam.scale
    ctx.save()
    // Fill only outside the 20m circle. Do not use destination-out here:
    // erasing the canvas would reveal the page background, not the world below.
    ctx.fillStyle = map.partial ? 'rgb(5, 9, 14)' : 'rgba(5, 9, 14, 0.78)'

    // X-9：未解锁核心区整体压黑（服务器裁剪区内实体，但雾不能「照亮」本应
    // 全黑的锁区——与弹丸撞锁区消失的体验对齐）。圆心与 drawArena 的锁区
    // 圈同为场地原点（非自机），直接填充锁区内部；解锁判定与 drawArena 的
    // unlocked（phase >= unlock_phase && phase > 0）互补。墙影/边缘渐变随后
    // 叠加只会更暗，不会重新「照亮」锁区。
    if (!map.partial && world.phase > 0 && world.phase < map.coreZone.unlockPhase) {
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
      ctx.fillStyle = map.partial ? 'rgb(5, 9, 14)' : SHADOW_FILL
      ctx.fill()
      ctx.restore()
    }

    // Keep the circular feather visible where there is no wall shadow.
    // 渐变参数仅随自机屏幕位置变化，稳态下恒定：单槽缓存消除每帧重建。
    if (!this.visionRaster.draw(ctx)) {
      ctx.fillStyle = this.edgeGradient ?? SHADOW_FILL
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      // The gradient is exactly transparent inside clearRadius. Excluding that
      // disk avoids shading most of the viewport during animated zoom.
      const clearRadius = this.edgeClearRadius
      if (clearRadius > 0) {
        ctx.moveTo(x + clearRadius, y)
        ctx.arc(x, y, clearRadius, 0, Math.PI * 2, true)
      }
      ctx.fill()
    }
    ctx.restore()
  }

  /** World-space shadow geometry changes only with observer/map/range, not camera frames. */
  private readonly shadowPts: number[] = []
  private edgeKey = ''
  private edgeGradient: CanvasGradient | null = null
  private edgeClearRadius = 0
  private readonly visionRaster = new VisionRaster()
  private shadowMap: MapDefParsed | undefined
  private shadowX = Number.NaN
  private shadowY = Number.NaN
  private shadowRange = Number.NaN

  private prepareVision(world: WorldState, map: MapDefParsed, cam: Camera): void {
    const self = world.robots.get(world.self?.robotId ?? 0)?.base?.pos
    if (!self || cam.scale <= 0) { this.shadowPts.length = 0; this.shadowMap = undefined; return }
    const range = world.visionRadius ?? world.tuning.visionRadius
    if (map !== this.shadowMap || self.x !== this.shadowX || self.y !== this.shadowY || range !== this.shadowRange) {
      const pts = this.shadowPts
      pts.length = 0
      for (const wall of map.walls) {
        if (appendWallShadow(pts, self.x, self.y, wall, range) > 0) pts.push(Number.NaN, Number.NaN)
      }
      for (const boundary of map.boundaries ?? []) {
        if (appendSurfaceShadow(pts, self.x, self.y, boundary.start, boundary.end, range) > 0) pts.push(Number.NaN, Number.NaN)
      }
      this.shadowMap = map; this.shadowX = self.x; this.shadowY = self.y; this.shadowRange = range
    }
    const x = cam.toPxX(self.x), y = cam.toPxY(self.y), radius = range * cam.scale
    const clearRadius = Math.max(0, radius - Math.min(VISION_FEATHER * cam.scale, radius * 0.28))
    this.edgeClearRadius = clearRadius
    if (this.visionRaster.prepare(cam.cw, cam.ch, this.dpr, x, y, radius, clearRadius, world.tick)) return
    const key = `${x},${y},${clearRadius},${radius}`
    if (key === this.edgeKey && this.edgeGradient) return
    this.edgeKey = key
    const gradient = this.ctx.createRadialGradient(x, y, clearRadius, x, y, radius)
    gradient.addColorStop(0, 'rgba(5, 9, 14, 0)')
    gradient.addColorStop(0.72, 'rgba(5, 9, 14, 0.08)')
    gradient.addColorStop(1, 'rgba(5, 9, 14, 0.78)')
    this.edgeGradient = gradient
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
      const guarded = r.shieldOn || r.invulnerable || (r.invulnUntil ?? 0) > now
      const anchorY = cam.toPxY(pos.y) - (guarded ? radius * ROBOT_SHIELD_RADIUS * ROBOT_SHIELD_OUTER_RADIUS : radius) - 38
      if (x < -radius || x > cam.cw + radius || anchorY > cam.ch) continue
      ctx.save()
      if (!bub.layout) { ctx.restore(); continue }
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
      lines.forEach((text, i) => drawText(ctx, text, FONT_14, ink.text, left + width / 2, top + 17 + i * 18, 'center', 'middle'))
      ctx.restore()
    }
  }
}
