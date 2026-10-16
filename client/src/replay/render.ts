// Replay uses simulation ticks for animation: pausing/rewinding never leaves visual trails.
import type { Camera } from '../game/camera'
import type { MapDefParsed } from '../game/mapdef'
import type { ReplayFrame } from './index'
import { phaseNum } from './index'
import { drawIcon } from '../icons'
import { ink, mono, ROBOT_R, createCanvas2d, resizeCanvas2d, prepareArt, prepareArena, prepareProjectileTrail, drawArena, drawCover, drawRobot, drawCore, drawPointDrop, drawHealthPack, drawUplink, drawProjectile, drawVitals } from '../game/art'

const BUBBLE_FONT = `12px ${mono}`

export class ReplayRenderer {
  private ctx: CanvasRenderingContext2D
  private readonly byId = new Map<number, ReplayFrame['robots'][number]>()
  private readonly projectileTrails = new Map<number, CanvasGradient>()
  private readonly bubbleLayouts = new Map<string, { text: string; width: number }>()
  private readonly respawnLabels = new Map<number, string>()
  private readonly healthPackLabels = new Map<number, string>()
  private readonly pointDropLabels = new Map<number, string>()
  private dpr = 1
  private assetScale = 0
  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = createCanvas2d(canvas)
  }
  resize(w: number, h: number, dpr: number): void {
    resizeCanvas2d(this.canvas, w, h, dpr)
    this.dpr = dpr; this.assetScale = 0
  }
  prepare(frame: ReplayFrame, cam: Camera, map?: MapDefParsed): void {
    if (map) prepareArena(map)
    if (cam.scale !== this.assetScale) { prepareArt(cam.scale, this.dpr); this.assetScale = cam.scale }
    this.byId.clear()
    this.respawnLabels.clear()
    for (const robot of frame.robots) {
      this.byId.set(robot.id, robot)
      const left = robot.respawnAt == null ? 0 : Math.max(0, (robot.respawnAt - frame.tick) / 60)
      if (!robot.alive && left > 0) this.respawnLabels.set(robot.id, `${left.toFixed(1)}s`)
    }
    this.healthPackLabels.clear()
    for (const pack of frame.healthPacks) {
      const seconds = Math.ceil(Math.max(0, pack.readyAt - frame.tick) / 60)
      if (seconds > 0) this.healthPackLabels.set(pack.id, `${seconds}s`)
    }
    this.pointDropLabels.clear()
    for (const drop of frame.pointDrops) if (drop.points > 1) this.pointDropLabels.set(drop.id, String(drop.points))
    this.projectileTrails.clear()
    for (const projectile of frame.projectiles) {
      this.projectileTrails.set(projectile.id, prepareProjectileTrail(this.ctx, cam.scale, this.byId.get(projectile.owner)?.color || ink.cyan))
    }
    this.ctx.save(); this.ctx.font = BUBBLE_FONT
    for (const bubble of frame.bubbles) {
      if (this.bubbleLayouts.has(bubble.text)) continue
      if (this.bubbleLayouts.size >= 128) this.bubbleLayouts.clear()
      const text = bubble.text.slice(0, 40)
      this.bubbleLayouts.set(bubble.text, { text, width: this.ctx.measureText(text).width })
    }
    this.ctx.restore()
  }
  render(frame: ReplayFrame, map: MapDefParsed, cam: Camera, followRobotId: number): void {
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = ink.bg; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    const dpr = this.canvas.width / Math.max(1, cam.cw)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const phase = phaseNum(frame.phase)
    drawArena(ctx, map, cam, phase)
    for (const u of map.uplinks) drawUplink(ctx, cam, u.pos.x, u.pos.y, u.main, phase >= u.activePhase && phase > 0)
    for (const core of frame.cores) {
      if (!core.taken) drawCore(ctx, cam, core.pos.x, core.pos.y, core.value >= 25, frame.tick)
    }
    for (const drop of frame.pointDrops) drawPointDrop(ctx, cam, drop.pos.x, drop.pos.y, drop.points, frame.tick, undefined, this.pointDropLabels.get(drop.id))
    for (const pack of frame.healthPacks) {
      drawHealthPack(ctx, cam, pack.pos.x, pack.pos.y, pack.readyAt <= frame.tick, this.healthPackLabels.get(pack.id) ?? '', frame.tick)
    }
    drawCover(ctx, map, cam)
    // 审计 C-40：一次建 id→robot 索引，弹丸取色与气泡定位共用，
    // 替代「每帧 color Map + 逐气泡 robots.find 线性扫」。
    const byId = this.byId
    for (const p of frame.projectiles) drawProjectile(ctx, cam, p.pos.x, p.pos.y, p.heading, byId.get(p.owner)?.color || ink.cyan, this.projectileTrails.get(p.id))
    for (const r of frame.robots) {
      if (!r.alive) {
        ctx.fillStyle = ink.dim; ctx.font = `11px ${mono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        const label = this.respawnLabels.get(r.id)
        if (label) ctx.fillText(label, cam.toPxX(r.pos.x), cam.toPxY(r.pos.y))
        else drawIcon(ctx, 'skull', cam.toPxX(r.pos.x), cam.toPxY(r.pos.y), 16)
        continue
      }
      const follow = r.id === followRobotId
      drawRobot(ctx, cam, r.pos.x, r.pos.y, r.heading, r.color || ink.cyan, follow, false, false, r.invulnerable, frame.tick)
      drawVitals(ctx, cam, r.pos.x, r.pos.y, r.hp, r.energy, r.nick, follow, r.invulnerable)
    }
    this.drawBubbles(frame, cam, byId)
  }

  /** say 气泡：以 tick 龄淡出（暂停时保持，不依赖墙钟） */
  private drawBubbles(frame: ReplayFrame, cam: Camera, byId: Map<number, ReplayFrame['robots'][number]>): void {
    const { ctx } = this
    for (const bub of frame.bubbles) {
      const r = byId.get(bub.robot)
      if (!r || !r.alive) continue
      const x = cam.toPxX(r.pos.x)
      const y = cam.toPxY(r.pos.y) - ROBOT_R * cam.scale - 26
      const age = (frame.tick - bub.tick) / 60
      if (age > 4) continue
      const alpha = age < 3 ? 1 : 1 - (age - 3)
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.font = BUBBLE_FONT
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const layout = this.bubbleLayouts.get(bub.text)
      if (!layout) { ctx.restore(); continue }
      const { text, width: tw } = layout
      ctx.fillStyle = '#10141acc'
      ctx.fillRect(x - tw / 2 - 6, y - 9, tw + 12, 18)
      ctx.strokeStyle = ink.line
      ctx.lineWidth = 1
      ctx.strokeRect(x - tw / 2 - 6, y - 9, tw + 12, 18)
      ctx.fillStyle = ink.text
      ctx.fillText(text, x, y)
      ctx.restore()
    }
  }
}
