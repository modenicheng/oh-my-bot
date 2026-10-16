import { readWebSocketMetrics, type WebSocketMetrics } from '@omb/protocol'
import { SAMPLE_MS, DebugHistory, type DebugSample } from './history'

/** Optional Chromium heap estimate, deliberately labelled JS heap rather than process memory. */
export function readHeapMiB(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  const bytes = memory?.usedJSHeapSize
  return bytes !== undefined && Number.isFinite(bytes) && bytes >= 0 ? bytes / 1024 ** 2 : null
}

export class DebugSampler {
  readonly history = new DebugHistory()
  /** Reused reading; the history copies values into its typed ring. */
  latest: DebugSample | undefined
  private baseline: WebSocketMetrics = {
    receivedBytes: 0, sentBytes: 0, receivedMessages: 0, sentMessages: 0, connections: 0, rttMs: null,
  }
  private current: WebSocketMetrics = { ...this.baseline }
  private readonly reading: DebugSample = {
    time: 0, fps: 0, heapMiB: null, receivedKiB: 0, sentKiB: 0,
    receivedMessages: 0, sentMessages: 0, connections: 0, rttMs: null,
  }
  private running = false
  private sampledAt = 0
  private frames = 0

  constructor(
    private readonly network = readWebSocketMetrics,
    private readonly memory = readHeapMiB,
  ) {}

  /** Reset the measurement interval after tab suspension; do not manufacture background FPS. */
  resume(now: number): void {
    this.history.prune(now)
    this.latest = undefined
    this.network(this.baseline)
    this.running = true
    this.sampledAt = now
    this.frames = 0
  }

  frame(now: number): DebugSample | undefined {
    if (!this.running) {
      this.resume(now)
      return
    }
    this.frames++
    const elapsed = now - this.sampledAt
    if (elapsed < SAMPLE_MS) return
    const network = this.network(this.current)
    const seconds = elapsed / 1000
    const sample = this.reading
    sample.time = now
    sample.fps = this.frames / seconds
    sample.heapMiB = this.memory()
    sample.receivedKiB = Math.max(0, network.receivedBytes - this.baseline.receivedBytes) / seconds / 1024
    sample.sentKiB = Math.max(0, network.sentBytes - this.baseline.sentBytes) / seconds / 1024
    sample.receivedMessages = Math.max(0, network.receivedMessages - this.baseline.receivedMessages) / seconds
    sample.sentMessages = Math.max(0, network.sentMessages - this.baseline.sentMessages) / seconds
    sample.connections = network.connections
    sample.rttMs = network.rttMs
    this.history.push(sample)
    this.latest = sample
    this.sampledAt = now
    const previous = this.baseline
    this.baseline = this.current
    this.current = previous
    this.frames = 0
    return sample
  }

  clear(): void {
    this.history.clear()
    this.latest = undefined
    this.running = false
    this.frames = 0
  }
}
