// 游戏视图渲染器：canvas 2D，60Hz 快照驱动（rAF 直画最新世界状态，不做插值预测）。
// 设计令牌见 client/STYLE.md：墙体 #1f2733 填充、荧光只用于状态/数据（Uplink 进度、自机、弹丸）。
import { Phase, Title } from '@omb/protocol'
import type { WorldState } from './world'
import type { Camera } from './camera'
import type { MapDefParsed } from './mapdef'
import { RING_CORE, RING_MID, RING_OUTER } from './mapdef'

// ---- STYLE.md 令牌 ---------------------------------------------------------

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
const ROBOT_R = 0.6 // 机器人碰撞半径（米），渲染半径同步

// ---- 称号/阶段文案 -----------------------------------------------------------

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

// ---- 渲染器 ---------------------------------------------------------------

export interface SayBubble {
  robotId: number
  text: string
  /** 创建时间戳（performance.now()）；4s 淡出 */
  at: number
}

export interface RenderExtras {
  bubbles: SayBubble[]
}

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
    const { ctx } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = C.bg
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)

    // cam.toPx 输出 CSS 像素；乘 dpr 到物理像素
    const dpr = this.canvas.width / Math.max(1, cam.cw)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    this.drawRings(map, cam)
    this.drawSectors(map, cam)
    this.drawCoreZone(map, cam, world.phase)
    this.drawUplinks(map, world, cam)
    this.drawCores(world, cam)
    this.drawWalls(map, cam)
    this.drawProjectiles(world, cam)
    this.drawRobots(world, cam)
    this.drawBubbles(world, cam, extras)
  }

  // ---- 地图静态层 ---------------------------------------------------------

  /** 三环同心圆环线：外环 80 / 中环 55（核心区边界由 CoreZone 虚线圆负责） */
  private drawRings(map: MapDefParsed, cam: Camera): void {
    const { ctx } = this
    const cx = cam.toPxX(0)
    const cy = cam.toPxY(0)
    ctx.lineWidth = 1
    for (const r of [RING_OUTER, RING_MID]) {
      ctx.strokeStyle = C.lineSoft
      ctx.beginPath()
      ctx.arc(cx, cy, r * cam.scale, 0, Math.PI * 2)
      ctx.stroke()
    }
    // 地图外接边界参照
    ctx.strokeStyle = C.line
    ctx.beginPath()
    ctx.arc(cx, cy, map.extent * cam.scale, 0, Math.PI * 2)
    ctx.stroke()
  }

  /** 8 扇区分界线：从核心区边缘到外环边缘 */
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

  /** CoreZone 虚线圆：锁定时灰暗，解锁后荧光青 */
  private drawCoreZone(map: MapDefParsed, cam: Camera, phase: number): void {
    const { ctx } = this
    const cx = cam.toPxX(0)
    const cy = cam.toPxY(0)
    const unlocked = phase >= map.coreZone.unlockPhase && phase !== Phase.PHASE_UNSPECIFIED
    ctx.save()
    ctx.setLineDash([6, 6])
    ctx.lineWidth = 1
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

  /** Uplink：荧光点；hacking 时画进度环（0–8s×10）；ready=false 冷却灰化 */
  private drawUplinks(map: MapDefParsed, world: WorldState, cam: Camera): void {
    const { ctx } = this
    for (const def of map.uplinks) {
      const st = world.uplinks.get(def.id)
      const x = cam.toPxX(def.pos.x)
      const y = cam.toPxY(def.pos.y)
      const r = Math.max(4, 0.5 * cam.scale)
      const ready = st?.ready ?? true
      const color = def.main ? C.cyan : C.lime

      // 本体：主桩荧光青、副桩荧光绿；冷却灰化
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      if (ready) {
        ctx.fillStyle = color
        ctx.shadowColor = color
        ctx.shadowBlur = 8
      } else {
        ctx.fillStyle = C.dim
      }
      ctx.fill()
      ctx.shadowBlur = 0

      // 主桩标识：外圈细环
      if (def.main) {
        ctx.strokeStyle = ready ? C.cyan : C.dim
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(x, y, r + 3, 0, Math.PI * 2)
        ctx.stroke()
      }

      // hacking 进度环
      if (st && st.hackingId !== 0) {
        const p = Math.min(1, st.progressX10 / 80)
        ctx.strokeStyle = C.amber
        ctx.lineWidth = 2
        ctx.shadowColor = C.amber
        ctx.shadowBlur = 6
        ctx.beginPath()
        ctx.arc(x, y, r + 5, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2)
        ctx.stroke()
        ctx.shadowBlur = 0
      }
    }
  }

  /** Core：小菱形（Mega value>=25 大一档、琥珀色；普通 +10 荧光绿） */
  private drawCores(world: WorldState, cam: Camera): void {
    const { ctx } = this
    for (const core of world.cores.values()) {
      const b = core.base
      if (!b?.pos) continue
      const mega = core.value >= 25
      const x = cam.toPxX(b.pos.x)
      const y = cam.toPxY(b.pos.y)
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
  }

  /** 墙体：#1f2733 填充 + 同色描边 */
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

  /** 弹丸：短线段（沿 heading，约 1.2m），颜色跟随 owner */
  private drawProjectiles(world: WorldState, cam: Camera): void {
    const { ctx } = this
    for (const p of world.projectiles.values()) {
      const b = p.base
      if (!b?.pos) continue
      const owner = world.robots.get(p.ownerId)
      const color = owner?.color || C.fg
      const x0 = cam.toPxX(b.pos.x)
      const y0 = cam.toPxY(b.pos.y)
      const len = 1.2 * cam.scale
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x0 + Math.cos(b.heading) * len, y0 + Math.sin(b.heading) * len)
      ctx.stroke()
    }
  }

  // ---- 机器人 ---------------------------------------------------------------

  private drawRobots(world: WorldState, cam: Camera): void {
    const { ctx } = this
    const now = performance.now()
    const selfId = world.self?.robotId ?? 0
    for (const r of world.robots.values()) {
      const b = r.base
      if (!b?.pos) continue
      const x = cam.toPxX(b.pos.x)
      const y = cam.toPxY(b.pos.y)
      const isSelf = b.id === selfId
      const color = r.color || C.fg

      // 死亡：只画重生倒计时，不画本体
      if (r.dead) {
        ctx.fillStyle = C.dim
        ctx.font = `10px ${MONO}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${r.respawnInS.toFixed(1)}s`, x, y)
        continue
      }

      const invuln = (r.invulnUntil ?? 0) > now
      ctx.save()
      if (invuln) ctx.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(now / 90))

      // 本体色块圆
      ctx.beginPath()
      ctx.arc(x, y, ROBOT_R * cam.scale, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.shadowColor = color
      ctx.shadowBlur = isSelf ? 10 : 4
      ctx.fill()
      ctx.shadowBlur = 0

      // 炮口方向线（heading 仅炮塔，底盘全向）
      const hx = x + Math.cos(b.heading) * ROBOT_R * cam.scale * 1.7
      const hy = y + Math.sin(b.heading) * ROBOT_R * cam.scale * 1.7
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(hx, hy)
      ctx.stroke()

      // 护盾：青色外环
      if (r.shieldOn) {
        ctx.strokeStyle = C.cyan
        ctx.shadowColor = C.cyan
        ctx.shadowBlur = 8
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(x, y, ROBOT_R * cam.scale + 4, 0, Math.PI * 2)
        ctx.stroke()
        ctx.shadowBlur = 0
      }

      // 冲刺：残影线（速度方向由 dash 状态近似，画切向短线）
      if (r.dashing) {
        ctx.strokeStyle = C.fg
        ctx.globalAlpha *= 0.6
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(x, y, ROBOT_R * cam.scale + 2, 0, Math.PI * 2)
        ctx.stroke()
      }

      // 搭档描边：洋红外圈
      if (r.isPartner) {
        ctx.strokeStyle = C.magenta
        ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.arc(x, y, ROBOT_R * cam.scale + 6, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }

      // 自机瞄准射线（淡）
      if (isSelf) {
        ctx.strokeStyle = `${C.dim}80`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(hx, hy)
        ctx.lineTo(hx + Math.cos(b.heading) * 16 * cam.scale, hy + Math.sin(b.heading) * 16 * cam.scale)
        ctx.stroke()
      }
      ctx.restore()

      // 昵称 + HP/能量条（世界空间锚定，UI 不缩放字号）
      const barW = Math.max(18, ROBOT_R * cam.scale * 3)
      const barY = y - ROBOT_R * cam.scale - 10
      // HP
      ctx.fillStyle = '#000000a0'
      ctx.fillRect(x - barW / 2, barY, barW, 3)
      ctx.fillStyle = hpColor(r.hpX10 / 10 / 100)
      ctx.fillRect(x - barW / 2, barY, barW * clamp01(r.hpX10 / 1000), 3)
      // 能量
      ctx.fillStyle = '#000000a0'
      ctx.fillRect(x - barW / 2, barY + 4, barW, 2)
      ctx.fillStyle = C.cyan
      ctx.fillRect(x - barW / 2, barY + 4, barW * clamp01(r.energyX10 / 1000), 2)
      // 昵称
      if (r.nick) {
        ctx.font = `10px ${MONO}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = isSelf ? C.cyan : C.fg
        ctx.fillText(r.nick, x, barY - 4)
      }
    }
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
