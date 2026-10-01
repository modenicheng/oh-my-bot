// Replay uses simulation ticks for animation: pausing/rewinding never leaves visual trails.
import type { Camera } from '../game/camera'
import type { MapDefParsed } from '../game/mapdef'
import type { ReplayFrame } from './index'
import { phaseNum } from './index'
import { drawIcon } from '../icons'
import { ink, mono, drawArena, drawCover, drawRobot, drawCore, drawHealthPack, drawUplink, drawProjectile, drawVitals } from '../game/art'
const ROBOT_R = 0.6

export class ReplayRenderer {
  private ctx: CanvasRenderingContext2D
  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    this.ctx = ctx
  }
  resize(w: number, h: number, dpr: number): void {
    this.canvas.width = Math.max(1, Math.floor(w * dpr))
    this.canvas.height = Math.max(1, Math.floor(h * dpr))
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
    for (const pack of frame.healthPacks) {
      const respawnInS = Math.ceil(Math.max(0, pack.readyAt - frame.tick) / 60)
      drawHealthPack(ctx, cam, pack.pos.x, pack.pos.y, pack.readyAt <= frame.tick, respawnInS, frame.tick)
    }
    drawCover(ctx, map, cam)
    const colors = new Map(frame.robots.map(r => [r.id, r.color]))
    for (const p of frame.projectiles) drawProjectile(ctx, cam, p.pos.x, p.pos.y, p.heading, colors.get(p.owner) || ink.cyan)
    for (const r of frame.robots) {
      if (!r.alive) {
        ctx.fillStyle = ink.dim; ctx.font = `11px ${mono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        const left = r.respawnAt == null ? 0 : Math.max(0, (r.respawnAt - frame.tick) / 60)
        if (left > 0) ctx.fillText(`${left.toFixed(1)}s`, cam.toPxX(r.pos.x), cam.toPxY(r.pos.y))
        else drawIcon(ctx, 'skull', cam.toPxX(r.pos.x), cam.toPxY(r.pos.y), 16)
        continue
      }
      const follow = r.id === followRobotId
      drawRobot(ctx, cam, r.pos.x, r.pos.y, r.heading, r.color || ink.cyan, follow, false, false, r.invulnerable, frame.tick)
      drawVitals(ctx, cam, r.pos.x, r.pos.y, r.hp, r.energy, r.nick, follow)
    }
    this.drawBubbles(frame, cam)
  }

  /** say 气泡：以 tick 龄淡出（暂停时保持，不依赖墙钟） */
  private drawBubbles(frame: ReplayFrame, cam: Camera): void {
    const { ctx } = this
    for (const bub of frame.bubbles) {
      const r = frame.robots.find((x) => x.id === bub.robot)
      if (!r || !r.alive) continue
      const x = cam.toPxX(r.pos.x)
      const y = cam.toPxY(r.pos.y) - ROBOT_R * cam.scale - 26
      const age = (frame.tick - bub.tick) / 60
      if (age > 4) continue
      const alpha = age < 3 ? 1 : 1 - (age - 3)
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.font = `12px ${mono}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const text = bub.text.slice(0, 40)
      const tw = ctx.measureText(text).width
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
