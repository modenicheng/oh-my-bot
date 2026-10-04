export type ResourceState = 'loading' | 'done' | 'error'

export interface ProgressTarget {
  real: number
  cap: number
  complete: boolean
  pending: number
  failed: number
}

const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback
const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, finite(value)))

/** Equal resource milestones, not a byte/download estimate. Only success counts. */
export function progressTarget(states: readonly ResourceState[]): ProgressTarget {
  const done = states.filter(state => state === 'done').length
  const failed = states.filter(state => state === 'error').length
  const complete = states.length > 0 && done === states.length
  const real = states.length ? done / states.length * 100 : 0
  return { real, cap: complete ? 100 : Math.min(98, real + (100 - real) * 0.75), complete,
    pending: states.length - done - failed, failed }
}

/** Time-based, deterministic easing. Pending work can never consume the final 2%. */
export function advanceProgress(current: number, target: ProgressTarget, elapsedMs: number, reducedMotion = false): number {
  const ceiling = target.complete ? 100 : 98
  const before = clamp(current, ceiling)
  const real = clamp(target.real, ceiling)
  if (reducedMotion) return Math.max(before, real)
  const elapsed = clamp(elapsedMs, 1000)
  if (target.complete) return Math.min(100, before + elapsed)
  const cap = Math.max(before, real, clamp(target.cap, ceiling))
  const caughtUp = before + Math.max(0, real - before) * (1 - Math.exp(-elapsed / 90))
  // No pretend activity after every resource settled but one failed.
  return target.pending > 0
    ? Math.min(cap, caughtUp + (cap - caughtUp) * (1 - Math.exp(-elapsed / 2800)))
    : caughtUp
}

export function progressPercent(value: number): number {
  return Math.floor(clamp(value, 100))
}

/** Fixed-width track; pulse glyph and travelling tail keep partial cells alive. */
export function asciiProgress(value: number, frame = 0, width = 28, reducedMotion = false): string {
  const cells = Math.max(24, Math.min(32, Math.floor(finite(width, 28))))
  const percent = clamp(value, 100)
  if (percent === 100) return `[${'#'.repeat(cells)}]`
  const filled = Math.min(cells - 1, Math.floor(percent / 100 * cells))
  const track: string[] = Array.from({ length: cells }, (_, index) => index < filled ? '#' : '.')
  const tick = Math.abs(Math.floor(finite(frame)))
  track[filled] = reducedMotion ? '>' : ['>', '=', '+', '>'][tick % 4]!
  if (!reducedMotion && filled > 1) track[tick % filled] = '='
  return `[${track.join('')}]`
}

export function loadingDots(frame: number): string {
  return '.'.repeat(Math.abs(Math.floor(finite(frame))) % 3 + 1)
}
