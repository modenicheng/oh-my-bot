export interface TouchSnapshot {
  moveX: number
  moveY: number
  aim?: number
  fire: boolean
  dash: boolean
  shield: boolean
  interact: boolean
  axisMask: number
}

export type FireMode = 'single' | 'hold'
export type TouchAbility = 'dash' | 'shield' | 'interact'
export interface TouchPoint { x: number; y: number }
export interface TouchRect { left: number; top: number; width: number; height: number }
export interface TouchGeometry {
  left: TouchRect
  moveRadius: number
  right: TouchPoint & { radius: number }
  abilities: Partial<Record<TouchAbility, TouchRect>>
}

interface LeftGesture { pointerId: number; origin: TouchPoint; point: TouchPoint }
interface RightGesture {
  phase: 'idle' | 'tracking' | 'aiming' | 'ability-held'
  pointerId?: number
  ability?: TouchAbility
  point?: TouchPoint
}

const MOVE = 1, AIM_FIRE = 2 | 4, ABILITY = 8
const DEAD_ZONE = 0.18
const ABILITIES: readonly TouchAbility[] = ['dash', 'shield', 'interact']

export function contains(rect: TouchRect, x: number, y: number): boolean {
  return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.left + rect.width
    && y >= rect.top && y <= rect.top + rect.height
}

/** Radial mapping avoids the extra speed of independently clamped diagonal axes. */
export function stickVector(dx: number, dy: number, radius: number): TouchPoint {
  const length = Math.hypot(dx, dy)
  if (!Number.isFinite(length) || !Number.isFinite(radius) || radius <= 0 || length <= radius * DEAD_ZONE) {
    return { x: 0, y: 0 }
  }
  const strength = Math.min(1, (length / radius - DEAD_ZONE) / (1 - DEAD_ZONE)) * 1000
  let x = Math.round(dx / length * strength), y = Math.round(dy / length * strength)
  const roundedLength = Math.hypot(x, y)
  if (roundedLength > 1000) {
    x = Math.trunc(x * 1000 / roundedLength)
    y = Math.trunc(y * 1000 / roundedLength)
  }
  return { x, y }
}

/** Pure CSS-coordinate state machine. A captured finger never changes handedness. */
export class TouchState {
  left: LeftGesture | undefined
  right: RightGesture = { phase: 'idle' }
  private value: TouchSnapshot = { moveX: 0, moveY: 0, fire: false, dash: false, shield: false, interact: false, axisMask: 0 }

  constructor(private geometry: TouchGeometry, private fireMode: FireMode = 'single') {}

  get mode(): FireMode { return this.fireMode }
  get snapshot(): TouchSnapshot { return { ...this.value } }
  get owners(): number[] {
    return [this.left?.pointerId, this.right.pointerId].filter((id): id is number => id !== undefined)
  }

  setGeometry(geometry: TouchGeometry): void {
    this.cancel()
    this.geometry = geometry
  }

  setMode(mode: FireMode): void {
    if (mode === this.fireMode) return
    this.fireMode = mode
    if (this.right.pointerId !== undefined) this.pointerCancel(this.right.pointerId)
  }

  pointerDown(pointerId: number, x: number, y: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y) || this.owners.includes(pointerId)) return false
    const ability = this.abilityAt(x, y)
    if (ability || Math.hypot(x - this.geometry.right.x, y - this.geometry.right.y) <= this.geometry.right.radius) {
      if (this.right.pointerId !== undefined) return false
      this.right = { pointerId, phase: 'tracking', point: { x, y } }
      if (ability) this.holdAbility(ability)
      return true
    }
    const bounds = this.geometry.left, radius = this.geometry.moveRadius
    if (this.left || !contains(bounds, x, y) || bounds.width < radius * 2 || bounds.height < radius * 2) return false
    this.left = {
      pointerId, point: { x, y },
      origin: {
        x: Math.max(bounds.left + radius, Math.min(bounds.left + bounds.width - radius, x)),
        y: Math.max(bounds.top + radius, Math.min(bounds.top + bounds.height - radius, y)),
      },
    }
    return true
  }

  pointerMove(pointerId: number, x: number, y: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return this.pointerCancel(pointerId)
    if (this.left?.pointerId === pointerId) {
      this.left.point = { x, y }
      const v = stickVector(x - this.left.origin.x, y - this.left.origin.y, this.geometry.moveRadius)
      this.value.moveX = v.x
      this.value.moveY = v.y
      if (v.x || v.y) this.value.axisMask |= MOVE
      return true
    }
    if (this.right.pointerId !== pointerId) return false
    this.right.point = { x, y }
    if (this.right.phase === 'ability-held') return true
    // Aiming owns the whole gesture after a free-stick down. The ability
    // buttons are close enough to the stick that crossing one must not steal
    // the thumb, stop continuous fire, or activate a skill by accident.
    this.trackAim(x, y)
    return true
  }

  pointerUp(pointerId: number, x: number, y: number): { handled: boolean; shot?: number } {
    if (!this.owners.includes(pointerId)) return { handled: false }
    let shot: number | undefined
    if (this.right.pointerId === pointerId && this.right.phase !== 'ability-held'
      && Number.isFinite(x) && Number.isFinite(y)) {
      // Up may contain the last motion even if the browser omitted pointermove.
      this.trackAim(x, y)
      if (this.right.phase === 'aiming' && this.fireMode === 'single') shot = this.value.aim
    }
    this.pointerCancel(pointerId)
    return shot === undefined ? { handled: true } : { handled: true, shot }
  }

  pointerCancel(pointerId: number): boolean {
    if (this.left?.pointerId === pointerId) {
      this.left = undefined
      this.value.moveX = this.value.moveY = 0
      return true
    }
    if (this.right.pointerId !== pointerId) return false
    this.right = { phase: 'idle' }
    this.value.fire = this.value.dash = this.value.shield = this.value.interact = false
    return true
  }

  cancel(): void {
    for (const id of this.owners) this.pointerCancel(id)
    // Keep the operated axes on the stop frame; mask=0 cannot stop a held server axis.
  }

  /** Caller sends the neutral snapshot before explicitly handing axes back to Assist. */
  resetTakeover(): void {
    this.cancel()
    this.value.axisMask = 0
    delete this.value.aim
  }

  private abilityAt(x: number, y: number): TouchAbility | undefined {
    return ABILITIES.find(ability => {
      const rect = this.geometry.abilities[ability]
      return rect && contains(rect, x, y)
    })
  }

  private holdAbility(ability: TouchAbility): void {
    this.right.phase = 'ability-held'
    this.right.ability = ability
    this.value.fire = false
    this.value[ability] = true
    this.value.axisMask |= ABILITY
  }

  private trackAim(x: number, y: number): void {
    const dx = x - this.geometry.right.x, dy = y - this.geometry.right.y
    const outside = Math.hypot(dx, dy) > this.geometry.right.radius * DEAD_ZONE
    this.right.phase = outside ? 'aiming' : 'tracking'
    this.value.fire = outside && this.fireMode === 'hold'
    if (outside) {
      this.value.aim = Math.atan2(dy, dx)
      this.value.axisMask |= AIM_FIRE
    }
  }
}
