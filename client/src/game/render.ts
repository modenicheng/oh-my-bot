// Live snapshots share the same arena and SVG entity art as the replay renderer.
import { Phase } from '@omb/protocol'
import type { WorldState } from './world'
import type { Camera } from './camera'
import type { MapDefParsed } from './mapdef'
import type { GameFeedback } from './feedback'
import { ink, mono, drawArena, drawCover, drawRobot, drawCore, drawUplink, drawProjectile, drawVitals } from './art'
const ROBOT_R = 0.6

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
    this.canvas.width = Math.max(1, Math.floor(w * dpr))
    this.canvas.height = Math.max(1, Math.floor(h * dpr))
  }
  render(world: WorldState, map: MapDefParsed, cam: Camera, extras: RenderExtras): void {
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = ink.bg; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    const dpr = this.canvas.width / Math.max(1, cam.cw)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawArena(ctx, map, cam, world.phase)
    for (const def of map.uplinks) {
      const st = world.uplinks.get(def.id)
      drawUplink(ctx, cam, def.pos.x, def.pos.y, def.main,
        world.phase >= def.activePhase && (st?.ready ?? true), st?.hackingId ? st.progressX10 / 80 : 0)
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
    drawCover(ctx, map, cam)
    for (const p of world.projectiles.values()) {
      const b = p.base
      if (b?.pos) drawProjectile(ctx, cam, b.pos.x, b.pos.y, b.heading, world.robots.get(p.ownerId)?.color || ink.cyan)
    }
    for (const r of world.robots.values()) {
      const b = r.base
      if (!b?.pos) continue
      if (r.dead) {
        ctx.fillStyle = ink.dim; ctx.font = `11px ${mono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(`${r.respawnInS}s`, cam.toPxX(b.pos.x), cam.toPxY(b.pos.y))
        continue
      }
      const self = b.id === world.self?.robotId
      const heading = self && extras.localAim !== undefined ? extras.localAim : b.heading
      drawRobot(ctx, cam, b.pos.x, b.pos.y, heading, r.color || ink.cyan, self,
        r.shieldOn, r.dashing, r.isPartner, (r.invulnUntil ?? 0) > performance.now(), world.tick)
      drawVitals(ctx, cam, b.pos.x, b.pos.y, r.hpX10 / 10, r.energyX10 / 10, r.nick, self, r.shieldOn)
    }
    extras.feedback?.draw(ctx, cam)
    this.drawBubbles(world, cam, extras)
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
      ctx.font = `14px ${mono}`
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
