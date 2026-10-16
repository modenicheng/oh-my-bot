export const HISTORY_MS = 30_000
export const SAMPLE_MS = 250

export interface DebugSample {
  time: number
  fps: number
  heapMiB: number | null
  receivedKiB: number
  sentKiB: number
  receivedMessages: number
  sentMessages: number
  connections: number
  rttMs: number | null
}

export const metricKeys = [
  'fps', 'heapMiB', 'receivedKiB', 'sentKiB', 'receivedMessages', 'sentMessages', 'connections', 'rttMs',
] as const
export type Metric = typeof metricKeys[number]
const STRIDE = metricKeys.length + 1
const columns = Object.fromEntries(metricKeys.map((key, index) => [key, index + 1])) as Record<Metric, number>

/** Fixed typed storage: no sample objects or growing arrays are retained by the history. */
export class DebugHistory {
  private readonly data: Float64Array
  private head = 0
  private count = 0

  constructor(readonly capacity = Math.ceil(HISTORY_MS / SAMPLE_MS) + 1, readonly windowMs = HISTORY_MS) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('Invalid history capacity or window')
    }
    this.data = new Float64Array(capacity * STRIDE)
  }

  get size(): number { return this.count }

  push(sample: DebugSample): void {
    this.prune(sample.time)
    if (this.count === this.capacity) this.shift()
    const offset = this.offset(this.count)
    this.data[offset] = sample.time
    for (let i = 0; i < metricKeys.length; i++) this.data[offset + i + 1] = sample[metricKeys[i]!] ?? NaN
    this.count++
  }

  timeAt(index: number): number { return this.data[this.offset(index)]! }
  valueAt(index: number, key: Metric): number { return this.data[this.offset(index) + columns[key]]! }

  prune(now: number): void {
    while (this.count && this.timeAt(0) < now - this.windowMs) this.shift()
  }

  clear(): void {
    this.data.fill(0)
    this.head = 0
    this.count = 0
  }

  private offset(index: number): number { return ((this.head + index) % this.capacity) * STRIDE }

  private shift(): void {
    const offset = this.head * STRIDE
    this.data.fill(0, offset, offset + STRIDE)
    this.head = (this.head + 1) % this.capacity
    this.count--
  }
}

/** Recomputed from the visible window so expired peaks stop affecting the scale. */
export function scaleCeiling(peak: number, minimum = 1): number {
  const target = Math.max(minimum, Number.isFinite(peak) ? peak * 1.1 : 0)
  const power = 10 ** Math.floor(Math.log10(target))
  const fraction = target / power
  return power * (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10)
}
