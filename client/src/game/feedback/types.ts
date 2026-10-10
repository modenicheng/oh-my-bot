import type { MapVec2 } from '../mapdef'

/** HUD/kill-feed 消息类别（hud.ts BANNER_ICON 消费）。 */
export type FeedbackKind = 'status' | 'kill' | 'uplink'

/** 瞬态特效类别；draw 侧按 Record<EffectKind, DrawFn> 注册表分发。 */
export type EffectKind = 'shot' | 'impact' | 'spawn' | 'pickup' | 'heal' | 'uplink' | 'splash' | 'dash' | 'death'

export interface Effect { kind: EffectKind; pos: MapVec2; at: number; duration: number; color: string; seed: number; heading: number }

/** 延迟血条（白条）视觉态：受击保持后线性排空到实际值。 */
export interface HealthVisual { actualX10: number; delayedX10: number; holdUntil: number; updatedAt: number }

export interface DamagePopup { robot: number; pos: MapVec2; amountX10: number; at: number; seed: number }

export interface TrailPoint { pos: MapVec2; tick: number; color: string }
