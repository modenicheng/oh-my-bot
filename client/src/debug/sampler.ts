import { readWebSocketMetrics, type WebSocketMetrics } from '@omb/protocol'
import { SAMPLE_MS, DebugHistory, type DebugSample } from './history'

export interface ServerTickTelemetry {
  tick: number
  tickAvgMs: number
  tickP95Ms: number
  windowTicks: number
  scriptDeferrals: number
  tickRate: number
  frameBudgetMs: number
  warmup: boolean
}

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
    serverTick: null, serverTickAvgMs: null, serverTickP95Ms: null,
    serverScriptDeferrals: null, serverWindowTicks: null, serverTickRate: null,
    serverFrameBudgetMs: null, serverWarmup: null,
  }
  private serverTick: ServerTickTelemetry | undefined
  private serverTickAt = 0
  private running = false
  private sampledAt = 0
  private frames = 0

  constructor(
    private readonly network = readWebSocketMetrics,
    private readonly memory = readHeapMiB,
  ) {}

  updateServerTick(telemetry: ServerTickTelemetry, receivedAt: number): void {
    this.serverTick = { ...telemetry }
    this.serverTickAt = receivedAt
    this.history.prune(receivedAt)
  }

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
    if (this.serverTick && now - this.serverTickAt > 3000) this.serverTick = undefined
    const server = this.serverTick
    if (server) {
      sample.serverTick = server.tick
      sample.serverTickAvgMs = server.tickAvgMs
      sample.serverTickP95Ms = server.tickP95Ms
      sample.serverScriptDeferrals = server.scriptDeferrals
      sample.serverWindowTicks = server.windowTicks
      sample.serverTickRate = server.tickRate
      sample.serverFrameBudgetMs = server.frameBudgetMs
      sample.serverWarmup = server.warmup
    } else {
      clearServerFields(sample)
    }
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
    this.serverTick = undefined
    this.serverTickAt = 0
    this.running = false
    this.frames = 0
  }
}

const serverMetricKeys = [
  'serverTick', 'serverTickAvgMs', 'serverTickP95Ms', 'serverScriptDeferrals',
  'serverWindowTicks', 'serverTickRate', 'serverFrameBudgetMs', 'serverWarmup',
] as const

function clearServerFields(sample: DebugSample): void {
  for (const key of serverMetricKeys) delete sample[key]
}
