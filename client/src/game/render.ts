// Live snapshots share the same arena and SVG entity art as the replay renderer.
import { Phase, Title } from '@omb/protocol'
import type { WorldState } from './world'
import type { Camera } from './camera'
import type { MapDefParsed } from './mapdef'
import { ink, mono, drawArena, drawCover, drawRobot, drawCore, drawUplink, drawProjectile, drawVitals } from './art'
const ROBOT_R = 0.6

export function titleName(t: number): string {
  switch (t) {
    case Title.WAR_MACHINE: return '战争机器'
    case Title.SCAVENGER: return '垃圾佬'
    case Title.SIGNAL_THIEF: return '信号大盗'
    case Title.RUNNER: return '跑路大师'
    case Title.WALL_HEAD: return '铁头娃'
    case Title.SURVIVOR: return '苟王'
    case Title.PEACEMAKER: return '和平使者'
    case Title.AI_IDIOT: return '人工智障'
    case Title.BARRAGE: return '弹幕大师'
    case Title.BEST_PARTNER: return '最佳搭档'
    case Title.AI_REGULAR: return 'AI 常客'
    case Title.OLD_SCHOOL: return '古法编程'
    case Title.CNMB: return '充能面包'
    default: return ''
  }
}

export function phaseName(p: number): string {
  switch (p) {
    case Phase.OUTER_RING: return '外环'
    case Phase.CORE_OPEN: return '核心开放'
    default: return '—'
  }
}


export interface SayBubble { robotId: number; text: string; at: number }
export interface RenderExtras { bubbles: SayBubble[] }

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
      drawRobot(ctx, cam, b.pos.x, b.pos.y, b.heading, r.color || ink.cyan, self,
        r.shieldOn, r.dashing, r.isPartner, (r.invulnUntil ?? 0) > performance.now(), world.tick)
      drawVitals(ctx, cam, b.pos.x, b.pos.y, r.hpX10 / 10, r.energyX10 / 10, r.nick, self)
    }
    this.drawBubbles(world, cam, extras)
  }

  /** say 气泡：机器人头顶文字，4s 淡出 */
  private drawBubbles(world: WorldState, cam: Camera, extras: RenderExtras): void {
    const { ctx } = this
    const now = performance.now()
    for (const bub of extras.bubbles) {
      const r = world.robots.get(bub.robotId)
      const pos = r?.base?.pos
      if (!pos) continue
      const age = (now - bub.at) / 1000
      if (age > 4) continue
      const alpha = age < 3 ? 1 : 1 - (age - 3)
      const x = cam.toPxX(pos.x)
      const y = cam.toPxY(pos.y) - ROBOT_R * cam.scale - 26
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
