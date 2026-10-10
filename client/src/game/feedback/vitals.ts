// 血量视觉层（C-17 拆分自 feedback.ts）：延迟血条（白条）、伤害飘字、
// 低血红色边框。delayedHealth 保持带回写的 getter（冻结契约：连续受击白条保持）。
import type { Camera } from '../camera'
import type { MapVec2 } from '../mapdef'
import { red } from './constants'
import type { DamagePopup, HealthVisual } from './types'

// 延迟血条：受击保持 420ms 后 620ms 线性排空。
const DAMAGE_HOLD_MS = 420
const DAMAGE_FADE_MS = 620
// 伤害飘字：寿命内前 70% 全亮，余量淡出。
const DAMAGE_POPUP_MS = 850
const MAX_POPUPS = 48
const POPUP_FULL_UNTIL = 0.7
const POPUP_FONT = '14px ui-monospace, monospace'
const POPUP_DRIFT_BASE = 10
const POPUP_DRIFT_SEED = 5
const POPUP_X_SEED = 7
const POPUP_X_OFFSET = 3
const POPUP_RISE = 20
const POPUP_SHADOW_COLOR = '#071019'
const POPUP_SHADOW_OFFSET = 1
/** 低血阈值（×10）：HUD/飘字同源的边缘红框触发线。 */
export const LOW_HEALTH_X10 = 250
// 低血边缘红框（R8 打磨参数）：慢呼吸 + 受击瞬时增亮/外扩。
const LOW_HIT_FLASH_MS = 240
const LOW_PULSE_BASE = 0.34
const LOW_PULSE_SWING = 0.02
const LOW_PULSE_PERIOD_MS = 700
const LOW_HIT_BRIGHTEN = 0.16
const LOW_ALPHA_CAP = 0.52
/** 横向（上下边）深度占短边比例：基础 + 受击增量。 */
const LOW_H_DEPTH = 0.012
const LOW_H_HIT_DEPTH = 0.004
/** 纵向（左右边）深度占短边比例。 */
const LOW_V_DEPTH = 0.034
const LOW_V_HIT_DEPTH = 0.008
/** 三条环带的内外沿进度（0=屏缘，1=最内）；与透明度逐带递减配套。 */
const LOW_BAND_STEPS = [0, 0.36, 0.7, 1] as const
const LOW_BAND_OPACITY = [0.9, 0.52, 0.24] as const

export class Vitals {
  private health = new Map<number, HealthVisual>()
  private popups: DamagePopup[] = []
  private selfLow = false
  private lowHitAt = -Infinity

  constructor(private readonly reduced: MediaQueryList) {}

  /** 快照机器人循环的血量转移分支（行为保持）。返回是否为受击下降——
   *  调用方借以生成飘字与低血受击闪。 */
  absorb(id: number, prevX10: number | undefined, hpX10: number, transitions: boolean, now: number): boolean {
    let visual = this.health.get(id)
    if (!visual || !transitions || prevX10 === undefined) {
      visual = { actualX10: hpX10, delayedX10: hpX10, holdUntil: now, updatedAt: now }
    } else if (hpX10 < prevX10) {
      visual.delayedX10 = Math.max(this.delayedHpAt(visual, now), prevX10)
      visual.actualX10 = hpX10
      visual.holdUntil = now + DAMAGE_HOLD_MS
      visual.updatedAt = now
    } else if (hpX10 > prevX10) {
      visual.actualX10 = hpX10; visual.delayedX10 = hpX10; visual.holdUntil = now; visual.updatedAt = now
    } else {
      visual.actualX10 = hpX10
    }
    this.health.set(id, visual)
    return transitions && prevX10 !== undefined && hpX10 < prevX10
  }

  popup(robot: number, pos: MapVec2, amountX10: number, at: number, seed: number): void {
    if (this.popups.length >= MAX_POPUPS) this.popups.shift()
    this.popups.push({ robot, pos: { x: pos.x, y: pos.y }, amountX10, at, seed })
  }

  /** 低血状态下再次被确认命中：短暂增亮并外扩同一边框。 */
  markSelfHit(now: number): void { this.lowHitAt = now }

  /** 重生清低血受击闪（边框是否在场由 setSelfLow 每快照重算）。 */
  clearSelfHit(): void { this.lowHitAt = -Infinity }

  setSelfLow(low: boolean): void { this.selfLow = low }

  /** 带回写 getter（冻结契约）：渲染/HUD 每帧读取时推进白条排空进度。 */
  delayedHealth(robot: number, actualX10: number, now = performance.now()): number {
    const visual = this.health.get(robot)
    if (!visual) return actualX10 / 10
    const delayed = this.delayedHpAt(visual, now)
    visual.delayedX10 = delayed
    return Math.max(actualX10, delayed) / 10
  }

  forget(robot: number): void { this.health.delete(robot) }

  /** 飘字 + 低血边框（原 draw() 的 popups/low-frame 段，行为保持）。 */
  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    const now = performance.now()
    let damageKept = 0
    for (let i = 0; i < this.popups.length; i++) {
      const popup = this.popups[i]!
      if (now - popup.at < DAMAGE_POPUP_MS) this.popups[damageKept++] = popup
    }
    this.popups.length = damageKept
    ctx.globalAlpha = 1
    ctx.font = POPUP_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    for (const popup of this.popups) {
      const t = Math.min(1, (now - popup.at) / DAMAGE_POPUP_MS)
      const drift = this.reduced.matches ? 0 : (POPUP_DRIFT_BASE + (popup.seed % POPUP_DRIFT_SEED)) * t
      const x = cam.toPxX(popup.pos.x) + ((popup.seed % POPUP_X_SEED) - POPUP_X_OFFSET)
      const y = cam.toPxY(popup.pos.y) - POPUP_RISE - drift
      const text = `-${(popup.amountX10 / 10).toFixed(popup.amountX10 % 10 ? 1 : 0)}`
      ctx.globalAlpha = t < POPUP_FULL_UNTIL ? 1 : (1 - t) / (1 - POPUP_FULL_UNTIL)
      ctx.fillStyle = POPUP_SHADOW_COLOR; ctx.fillText(text, x + POPUP_SHADOW_OFFSET, y + POPUP_SHADOW_OFFSET)
      ctx.fillStyle = red; ctx.fillText(text, x, y)
    }
    if (this.selfLow) {
      const hit = this.reduced.matches ? 0 : Math.max(0, 1 - (now - this.lowHitAt) / LOW_HIT_FLASH_MS)
      const pulse = this.reduced.matches ? LOW_PULSE_BASE : LOW_PULSE_BASE + Math.sin(now / LOW_PULSE_PERIOD_MS) * LOW_PULSE_SWING
      const alpha = Math.min(LOW_ALPHA_CAP, pulse + hit * LOW_HIT_BRIGHTEN)
      const shortSide = Math.min(cam.cw, cam.ch)
      const horizontalDepth = shortSide * (LOW_H_DEPTH + hit * LOW_H_HIT_DEPTH)
      const sideDepth = shortSide * (LOW_V_DEPTH + hit * LOW_V_HIT_DEPTH)
      const steps = LOW_BAND_STEPS
      const opacity = LOW_BAND_OPACITY
      ctx.fillStyle = red
      // Each band is one continuous rectangular ring. Corners share the same path, so no seams.
      for (let i = 0; i < opacity.length; i++) {
        const outerX = sideDepth * steps[i]!, outerY = horizontalDepth * steps[i]!
        const innerX = sideDepth * steps[i + 1]!, innerY = horizontalDepth * steps[i + 1]!
        ctx.globalAlpha = alpha * opacity[i]!
        ctx.beginPath()
        ctx.rect(outerX, outerY, cam.cw - outerX * 2, cam.ch - outerY * 2)
        ctx.rect(innerX, innerY, cam.cw - innerX * 2, cam.ch - innerY * 2)
        ctx.fill('evenodd')
      }
    }
  }

  /** 静默判定（纯查询，无回写）：飘字存活、低血呼吸帧或任一白条仍在排空。 */
  busy(now = performance.now()): boolean {
    if (this.selfLow) return true
    if (this.popups.some(p => now - p.at < DAMAGE_POPUP_MS)) return true
    for (const visual of this.health.values()) {
      if (this.delayedHpAt(visual, now) > visual.actualX10) return true
    }
    return false
  }

  /** 白条排空进度（纯计算；回写只发生在 delayedHealth getter）。 */
  private delayedHpAt(visual: HealthVisual, now: number): number {
    if (now <= visual.holdUntil) return visual.delayedX10
    const elapsed = now - visual.holdUntil
    if (elapsed >= DAMAGE_FADE_MS) return visual.actualX10
    return visual.actualX10 + (visual.delayedX10 - visual.actualX10) * (1 - elapsed / DAMAGE_FADE_MS)
  }

  reset(): void {
    this.health.clear()
    this.popups = []
    this.selfLow = false
    this.lowHitAt = -Infinity
  }

  /** pause 语义：只清瞬态（飘字），健康视觉随基线重建。 */
  clearPopups(): void { this.popups = [] }
}
