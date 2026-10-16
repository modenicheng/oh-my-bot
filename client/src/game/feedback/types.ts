import type { MapVec2 } from '../mapdef'

/** HUD 消息类别（hud.ts BANNER_ICON 消费）。 */
export type FeedbackKind = 'status' | 'uplink'

/** 瞬态特效类别；draw 侧按 Record<EffectKind, DrawFn> 注册表分发。 */
export type EffectKind = 'shot' | 'impact' | 'spawn' | 'pickup' | 'heal' | 'uplink' | 'splash' | 'dash' | 'death'

export interface Effect { kind: EffectKind; pos: MapVec2; at: number; duration: number; color: string; seed: number; heading: number }

/** 延迟血条（白条）视觉态：受击保持后线性排空到实际值。 */
export interface HealthVisual { actualX10: number; delayedX10: number; holdUntil: number; updatedAt: number }

/** 飘字：color/prefix 区分伤害（red/-）与技能点拾取（amber/+）。 */
export interface DamagePopup { robot: number; pos: MapVec2; amountX10: number; at: number; seed: number; color: string; prefix: string; text: string }

export interface TrailPoint { pos: MapVec2; tick: number; color: string }
