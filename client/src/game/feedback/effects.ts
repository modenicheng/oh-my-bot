// 瞬态特效层（C-17 拆分自 feedback.ts）：持有特效列表，按
// Record<EffectKind, EffectDrawer> 注册表绘制；reduced-motion 的动效相位
// 收敛到 motionScale getter（原 7 处 ternary 的单点）。
import type { Camera } from '../camera'
import type { MapVec2 } from '../mapdef'
import { cyan, tau } from './constants'
import type { Effect, EffectKind } from './types'

/** 特效列表容量（超出丢最旧，防极端事件风暴）。 */
const MAX_EFFECTS = 160
/** reduced-motion：动效相位冻结在 30%（骨架保留、扩散停止）。 */
const REDUCED_MOTION_SCALE = 0.3
/** 视口外裁剪余量（px）。 */
const CULL_MARGIN = 100
const EFFECT_ALPHA = 0.95
const EFFECT_LINE_WIDTH = 2
const UPLINK_LINE_WIDTH = 3
/** 各事件特效寿命（毫秒）；同名 kind 不同来源（墙体撞击更短）单独命名。 */
export const EFFECT_MS = {
  shot: 110,
  impact: 330,
  wallImpact: 220,
  dash: 320,
  coreSpawn: 850,
  corePickup: 600,
  heal: 720,
  uplinkRing: 1000,
  uplinkSplash: 520,
  death: 650,
} as const
// shot：炮口闪光沿弹向拉伸，随动效相位回收。
const SHOT_MUZZLE_SCALE = 0.65
const SHOT_LENGTH = 12
const SHOT_MIN_LENGTH = 4
const SHOT_HEIGHT = 6
// impact/death：散射方块。reduced 下减少颗粒数并冻结扩散。
const IMPACT_BITS = 7
const DEATH_BITS = 14
const REDUCED_BITS = 3
const SCATTER_BASE_D = 3
const IMPACT_SPREAD = 0.8
const DEATH_SPREAD = 2
const SCATTER_BIT = 4
const SCATTER_SEED_MOD = 19
// splash：uplink 完成时的扇形上扬水花 + 椭圆涟漪。
const SPLASH_BITS = 10
const REDUCED_SPLASH_BITS = 4
const SPLASH_ALPHA = 0.85
const SPLASH_ARC_START = -Math.PI * 0.92
const SPLASH_ARC_SPAN = Math.PI * 0.84
const SPLASH_BASE_D = 0.35
const SPLASH_REACH = 0.7
const SPLASH_ROW_STEP = 0.16
const SPLASH_DROP = 0.5
const SPLASH_RING_COLOR = '#a5e6ef'
const SPLASH_RING_WIDTH = 2
const SPLASH_RING_Y_OFFSET = 3
const SPLASH_RING_RX = 1.5
const SPLASH_RING_RY = 0.42
// spawn/pickup/heal/uplink/dash：扩散圆环；前三者带四角颗粒。
const RING_ENTITY_BASE = 0.4
const RING_UPLINK_BASE = 1.5
const RING_GROW = 1.4
const RING_SPARKS = 4
const RING_SPARK_SIZE = 6
const RING_SPARK_OFFSET = 3

interface Brush {
  ctx: CanvasRenderingContext2D
  cam: Camera
  /** 屏幕像素坐标。 */
  x: number
  y: number
  /** 归一化年龄 [0,1)。 */
  t: number
  /** 动效相位（reduced-motion 下按 motionScale 缩放）。 */
  motion: number
  reduced: boolean
}
type EffectDrawer = (b: Brush, e: Effect) => void

const drawShot: EffectDrawer = ({ ctx, cam, x, y, motion }, e) => {
  ctx.save(); ctx.translate(x, y); ctx.rotate(e.heading)
  const muzzle = cam.scale * SHOT_MUZZLE_SCALE
  ctx.fillRect(muzzle, -SHOT_HEIGHT / 2, SHOT_LENGTH * (1 - motion) + SHOT_MIN_LENGTH, SHOT_HEIGHT)
  ctx.restore()
}

const scatterBits = ({ ctx, cam, x, y, motion }: Brush, e: Effect, count: number, spread: number): void => {
  for (let i = 0; i < count; i++) {
    const a = (i / count + (e.seed % SCATTER_SEED_MOD) / SCATTER_SEED_MOD) * tau
    const d = SCATTER_BASE_D + motion * spread * cam.scale
    const px = Math.round(x + Math.cos(a) * d), py = Math.round(y + Math.sin(a) * d)
    ctx.fillRect(px - SCATTER_BIT / 2, py - SCATTER_BIT / 2, SCATTER_BIT, SCATTER_BIT)
  }
}
const drawImpact: EffectDrawer = (b, e) => scatterBits(b, e, b.reduced ? REDUCED_BITS : IMPACT_BITS, IMPACT_SPREAD)
const drawDeath: EffectDrawer = (b, e) => scatterBits(b, e, b.reduced ? REDUCED_BITS : DEATH_BITS, DEATH_SPREAD)

const drawSplash: EffectDrawer = ({ ctx, cam, x, y, t, motion, reduced }) => {
  const count = reduced ? REDUCED_SPLASH_BITS : SPLASH_BITS
  ctx.globalAlpha = (1 - t) * SPLASH_ALPHA
  ctx.fillStyle = cyan
  for (let i = 0; i < count; i++) {
    const a = SPLASH_ARC_START + i / Math.max(1, count - 1) * SPLASH_ARC_SPAN
    const d = (SPLASH_BASE_D + motion * (SPLASH_REACH + i % 3 * SPLASH_ROW_STEP)) * cam.scale
    const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d + motion * motion * cam.scale * SPLASH_DROP
    ctx.fillRect(Math.round(px) - 2, Math.round(py) - 2, 4, 4)
  }
  ctx.strokeStyle = SPLASH_RING_COLOR
  ctx.lineWidth = SPLASH_RING_WIDTH
  ctx.beginPath()
  ctx.ellipse(x, y + SPLASH_RING_Y_OFFSET, motion * cam.scale * SPLASH_RING_RX, motion * cam.scale * SPLASH_RING_RY, 0, 0, tau)
  ctx.stroke()
}

const drawRing = (sparks: boolean): EffectDrawer => ({ ctx, cam, x, y, motion }, e) => {
  const radius = (e.kind === 'uplink' ? RING_UPLINK_BASE : RING_ENTITY_BASE) * cam.scale + motion * cam.scale * RING_GROW
  ctx.beginPath(); ctx.arc(x, y, radius, 0, tau); ctx.stroke()
  if (sparks) {
    for (let i = 0; i < RING_SPARKS; i++) {
      const a = i * tau / RING_SPARKS
      ctx.fillRect(Math.round(x + Math.cos(a) * radius) - RING_SPARK_OFFSET, Math.round(y + Math.sin(a) * radius) - RING_SPARK_OFFSET, RING_SPARK_SIZE, RING_SPARK_SIZE)
    }
  }
}

/** 特效绘制注册表：新 kind 只需登记一个 drawer，不再复制 draw() 骨架。 */
const DRAWERS: Record<EffectKind, EffectDrawer> = {
  shot: drawShot,
  impact: drawImpact,
  death: drawDeath,
  splash: drawSplash,
  spawn: drawRing(true),
  pickup: drawRing(true),
  heal: drawRing(true),
  uplink: drawRing(false),
  dash: drawRing(false),
}

export class Effects {
  private list: Effect[] = []

  constructor(private readonly reduced: MediaQueryList) {}

  /** reduced-motion 动效相位缩放：motion = t * motionScale。 */
  get motionScale(): number { return this.reduced.matches ? REDUCED_MOTION_SCALE : 1 }

  add(kind: EffectKind, pos: MapVec2, color: string, seed: number, duration: number, heading = 0): void {
    if (this.list.length >= MAX_EFFECTS) this.list.shift()
    this.list.push({ kind, pos: { x: pos.x, y: pos.y }, at: performance.now(), duration, color, seed, heading })
  }

  /** 就地压缩过期特效（避免每帧 filter 分配）后按注册表绘制。 */
  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    const now = performance.now()
    let kept = 0
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i]!
      if (now - e.at < e.duration) this.list[kept++] = e
    }
    this.list.length = kept
    const scale = this.motionScale
    for (const e of this.list) {
      const x = cam.toPxX(e.pos.x), y = cam.toPxY(e.pos.y)
      if (x < -CULL_MARGIN || y < -CULL_MARGIN || x > cam.cw + CULL_MARGIN || y > cam.ch + CULL_MARGIN) continue
      const t = (now - e.at) / e.duration, motion = t * scale
      ctx.globalAlpha = (1 - t) * EFFECT_ALPHA; ctx.strokeStyle = e.color; ctx.fillStyle = e.color
      ctx.lineWidth = e.kind === 'uplink' ? UPLINK_LINE_WIDTH : EFFECT_LINE_WIDTH
      DRAWERS[e.kind]({ ctx, cam, x, y, t, motion, reduced: this.reduced.matches }, e)
    }
  }

  /** 静默判定（纯查询，不改列表）：是否仍有存活特效。 */
  busy(now = performance.now()): boolean {
    return this.list.some(e => now - e.at < e.duration)
  }

  clear(): void { this.list = [] }
}
