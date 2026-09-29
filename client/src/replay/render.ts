// 回放渲染器：复用游戏视图的绘制令牌与实体画法（render.ts 同源），但面向
// ReplayFrame（checkpoint 重建态）而非实时 WorldState。无自机：全景视角
// （整图缩放）或点击机器人跟随。绘制层次与 Renderer.render 一致：
// 环线 → 扇区 → 核心区 → Uplink → 核心 → 墙 → 弹丸 → 机器人 → 气泡。
import type { Camera } from '../game/camera'
import type { MapDefParsed } from '../game/mapdef'
import { RING_CORE, RING_MID, RING_OUTER } from '../game/mapdef'
import type { ReplayFrame } from './index'
import { phaseNum } from './index'

const C = {
  bg: '#0a0e14',
  line: '#1f2733',
  lineSoft: '#1f2733b0',
  wall: '#1f2733',
  fg: '#d8dee9',
  dim: '#8b98a9',
  cyan: '#22d3ee',
  lime: '#a3e635',
  magenta: '#f472b6',
  red: '#ff5c5c',
  amber: '#fbbf24',
} as const

const MONO = 'ui-monospace, "JetBrains Mono", monospace'
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
    const { ctx } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = C.bg
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)

    const dpr = this.canvas.width / Math.max(1, cam.cw)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const phase = phaseNum(frame.phase)
    this.drawRings(map, cam)
    this.drawSectors(map, cam)
    this.drawCoreZone(map, cam, phase)
    this.drawUplinks(map, phase, cam)
    this.drawCores(map, frame, cam)
    this.drawWalls(map, cam)
    this.drawProjectiles(frame, cam)
    this.drawRobots(frame, cam, followRobotId)
    this.drawBubbles(frame, cam)
  }

  // ---- 地图静态层（与游戏视图一致） --------------------------------------

  private drawRings(map: MapDefParsed, cam: Camera): void {
    const { ctx } = this
    const cx = cam.toPxX(0)
    const cy = cam.toPxY(0)
    ctx.lineWidth = 1
    ctx.strokeStyle = C.lineSoft
    for (const r of [RING_OUTER, RING_MID]) {
      ctx.beginPath()
      ctx.arc(cx, cy, r * cam.scale, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.strokeStyle = C.line
    ctx.beginPath()
    ctx.arc(cx, cy, map.extent * cam.scale, 0, Math.PI * 2)
    ctx.stroke()
  }

  private drawSectors(map: MapDefParsed, cam: Camera): void {
    const { ctx } = this
    const cx = cam.toPxX(0)
    const cy = cam.toPxY(0)
    const n = map.sectors.length > 0 ? map.sectors.length : 8
    ctx.strokeStyle = C.lineSoft
    ctx.lineWidth = 1
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * RING_CORE * cam.scale, cy + Math.sin(a) * RING_CORE * cam.scale)
      ctx.lineTo(cx + Math.cos(a) * RING_OUTER * cam.scale, cy + Math.sin(a) * RING_OUTER * cam.scale)
      ctx.stroke()
    }
  }

  private drawCoreZone(map: MapDefParsed, cam: Camera, phase: number): void {
    const { ctx } = this
    const cx = cam.toPxX(0)
    const cy = cam.toPxY(0)
    const unlocked = phase >= map.coreZone.unlockPhase && phase > 0
    ctx.save()
    ctx.setLineDash([6, 6])
    ctx.lineWidth = unlocked ? 1.5 : 1
    if (unlocked) {
      ctx.strokeStyle = C.cyan
      ctx.shadowColor = C.cyan
      ctx.shadowBlur = 6
    } else {
      ctx.strokeStyle = C.dim
    }
    ctx.beginPath()
    ctx.arc(cx, cy, map.coreZone.radius * cam.scale, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  /** Uplink：静态定义渲染；激活阶段前灰化（进度态不随事件流，从略） */
  private drawUplinks(map: MapDefParsed, phase: number, cam: Camera): void {
    const { ctx } = this
    for (const def of map.uplinks) {
      const x = cam.toPxX(def.pos.x)
      const y = cam.toPxY(def.pos.y)
      const r = Math.max(4, 0.5 * cam.scale)
      const color = def.main ? C.cyan : C.lime
      const active = phase >= def.activePhase && phase > 0
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      if (active) {
        ctx.fillStyle = color
        ctx.shadowColor = color
        ctx.shadowBlur = 8
      } else {
        ctx.fillStyle = C.dim
      }
      ctx.fill()
      ctx.shadowBlur = 0
      if (def.main) {
        ctx.strokeStyle = active ? C.cyan : C.dim
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(x, y, r + 3, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
  }

  /** 核心：checkpoint 帧优先（含 taken/存活）；否则按地图静态 corePads 画 */
  private drawCores(map: MapDefParsed, frame: ReplayFrame, cam: Camera): void {
    if (frame.cores.length > 0) {
      for (const core of frame.cores) {
        if (core.taken) continue
        this.drawDiamond(cam, core.pos.x, core.pos.y, core.value >= 25)
      }
      return
    }
    for (const pad of map.corePads) {
      this.drawDiamond(cam, pad.pos.x, pad.pos.y, pad.value >= 25)
    }
  }

  private drawDiamond(cam: Camera, wx: number, wy: number, mega: boolean): void {
    const { ctx } = this
    const x = cam.toPxX(wx)
    const y = cam.toPxY(wy)
    const s = (mega ? 1.6 : 1.0) * Math.max(3, 0.55 * cam.scale)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(Math.PI / 4)
    ctx.fillStyle = mega ? C.amber : C.lime
    ctx.shadowColor = mega ? C.amber : C.lime
    ctx.shadowBlur = 6
    ctx.fillRect(-s / 2, -s / 2, s, s)
    ctx.restore()
  }

  private drawWalls(map: MapDefParsed, cam: Camera): void {
    const { ctx } = this
    ctx.fillStyle = C.wall
    ctx.strokeStyle = C.line
    ctx.lineWidth = 1
    for (const w of map.walls) {
      const x0 = cam.toPxX(w.min.x)
      const y0 = cam.toPxY(w.min.y)
      const x1 = cam.toPxX(w.max.x)
      const y1 = cam.toPxY(w.max.y)
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
    }
  }

  private drawProjectiles(frame: ReplayFrame, cam: Camera): void {
    const { ctx } = this
    if (!frame.projectiles) return
    const colors = new Map<number, string>()
    for (const r of frame.robots) colors.set(r.id, r.color)
    for (const p of frame.projectiles) {
      const color = colors.get(p.owner) || C.fg
      const x0 = cam.toPxX(p.pos.x)
      const y0 = cam.toPxY(p.pos.y)
      const len = 1.2 * cam.scale
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x0 + Math.cos(p.heading) * len, y0 + Math.sin(p.heading) * len)
      ctx.stroke()
    }
  }

  private drawRobots(frame: ReplayFrame, cam: Camera, followRobotId: number): void {
    const { ctx } = this
    for (const r of frame.robots) {
      const x = cam.toPxX(r.pos.x)
      const y = cam.toPxY(r.pos.y)
      const isFollow = r.id === followRobotId
      const color = r.color || C.fg

      if (!r.alive) {
        ctx.fillStyle = C.dim
        ctx.font = `10px ${MONO}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const left = r.respawnAt != null ? Math.max(0, (r.respawnAt - frame.tick) / 60) : 0
        ctx.fillText(left > 0 ? `${left.toFixed(1)}s` : '×', x, y)
        continue
      }

      ctx.save()
      if (r.invulnerable) ctx.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(frame.tick / 90))

      ctx.beginPath()
      ctx.arc(x, y, ROBOT_R * cam.scale, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.shadowColor = color
      ctx.shadowBlur = isFollow ? 10 : 4
      ctx.fill()
      ctx.shadowBlur = 0

      const hx = x + Math.cos(r.heading) * ROBOT_R * cam.scale * 1.7
      const hy = y + Math.sin(r.heading) * ROBOT_R * cam.scale * 1.7
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(hx, hy)
      ctx.stroke()

      // 跟随目标：青色虚线描边圈（对齐游戏视图自机视觉）
      if (isFollow) {
        ctx.strokeStyle = C.cyan
        ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.arc(x, y, ROBOT_R * cam.scale + 6, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.restore()

      // HP/EN 条 + 昵称（对齐游戏视图；HP 单位为游戏值 0–100）
      const barW = Math.max(18, ROBOT_R * cam.scale * 3)
      const barY = y - ROBOT_R * cam.scale - 10
      ctx.fillStyle = '#000000a0'
      ctx.fillRect(x - barW / 2, barY, barW, 3)
      ctx.fillStyle = hpColor(r.hp / 100)
      ctx.fillRect(x - barW / 2, barY, barW * clamp01(r.hp / 100), 3)
      ctx.fillStyle = '#000000a0'
      ctx.fillRect(x - barW / 2, barY + 4, barW, 2)
      ctx.fillStyle = C.cyan
      ctx.fillRect(x - barW / 2, barY + 4, barW * clamp01(r.energy / 100), 2)
      if (r.nick) {
        ctx.font = `10px ${MONO}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = isFollow ? C.cyan : C.fg
        ctx.fillText(r.nick, x, barY - 4)
      }
    }
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
      ctx.font = `12px ${MONO}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const text = bub.text.slice(0, 40)
      const tw = ctx.measureText(text).width
      ctx.fillStyle = '#10141acc'
      ctx.fillRect(x - tw / 2 - 6, y - 9, tw + 12, 18)
      ctx.strokeStyle = C.line
      ctx.lineWidth = 1
      ctx.strokeRect(x - tw / 2 - 6, y - 9, tw + 12, 18)
      ctx.fillStyle = C.fg
      ctx.fillText(text, x, y)
      ctx.restore()
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function hpColor(ratio: number): string {
  if (ratio > 0.5) return C.lime
  if (ratio > 0.25) return C.amber
  return C.red
}
