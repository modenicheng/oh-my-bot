import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { ChipMusic } from './player'
import type { SongRender, StageStem, VoiceRender } from './render'
import type { StageId } from './types'

/**
 * Fake WebAudio graph: records gain automation on a monotonic virtual clock
 * so quantized scheduling can be asserted sample-free but exactly in time.
 */

class FakeParam {
  value = 1
  events: { type: string; time: number; value: number }[] = []
  private hold(): number {
    // Value at `now` following the recorded automation.
    let v = this.value
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]!
      if (e.type === 'setValue') v = e.value
      else if (e.type === 'ramp') {
        const prev = this.events[i - 1]
        const span = e.time - (prev?.time ?? e.time)
        const t = span > 0 ? Math.min(1, Math.max(0, (FakeAudioContext.now - (prev?.time ?? e.time)) / span)) : 1
        v = (prev?.value ?? v) + (e.value - (prev?.value ?? v)) * t
      }
    }
    return v
  }
  setValueAtTime(v: number, t: number) { this.events.push({ type: 'setValue', time: t, value: v }) }
  linearRampToValueAtTime(v: number, t: number) { this.events.push({ type: 'ramp', time: t, value: v }); this.value = v }
  cancelScheduledValues(t: number) { this.events = this.events.filter(e => e.time < t) }
  cancelAndHoldAtTime(t: number) { this.value = this.hold(); this.events = this.events.filter(e => e.time <= t) }
}

class FakeGain {
  gain = new FakeParam()
  connect(node: unknown) { return node }
  disconnect() {}
}

class FakeSource {
  buffer: unknown = null
  loop = false
  loopStart = 0
  loopEnd = 0
  started = false
  stopped = false
  onended: (() => void) | null = null
  gain: FakeGain | null = null
  connect(node: unknown) {
    if (node instanceof FakeGain) this.gain = node
    return node
  }
  disconnect() {}
  start(_when: number, _offset = 0) { this.started = true }
  stop(_when: number) { this.stopped = true; this.onended?.() }
}

class FakeAudioContext {
  static now = 0
  state = 'running'
  destination = {}
  sampleRate = 44100
  currentTime = 0
  private listeners: ((e: { type: string }) => void)[] = []
  createGain() { return new FakeGain() }
  createBufferSource() { return new FakeSource() }
  createBuffer(_ch: number, frames: number, _rate: number) {
    return { length: frames, sampleRate: this.sampleRate, getChannelData: () => new Float32Array(frames) }
  }
  createStereoPanner() { return { pan: new FakeParam(), connect: (n: unknown) => n, disconnect: () => {} } }
  createDelay() { return { delayTime: new FakeParam(), connect: (n: unknown) => n, disconnect: () => {} } }
  createBiquadFilter() { return { frequency: new FakeParam(), Q: new FakeParam(), type: '', connect: (n: unknown) => n, disconnect: () => {} } }
  createConvolver() { return { normalize: false, buffer: null, connect: (n: unknown) => n, disconnect: () => {} } }
  createWaveShaper() { return { curve: null, oversample: '', connect: (n: unknown) => n, disconnect: () => {} } }
  createOscillator() { return { type: '', frequency: new FakeParam(), connect: (n: unknown) => n, start: () => {}, stop: () => {}, disconnect: () => {} } }
  addEventListener(_t: string, fn: (e: { type: string }) => void) { this.listeners.push(fn) }
  resume() { this.state = 'running'; return Promise.resolve() }
  close() { this.state = 'closed'; return Promise.resolve() }
}

// The player reads window.setTimeout; route it to the virtual clock. Node has
// no `window`, so install the stub on globalThis for the harness lifetime.
let timers: { at: number; fn: () => void }[] = []
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const w = globalThis as unknown as { setTimeout: typeof setTimeout; clearTimeout: (id: number) => void }
w.setTimeout = ((fn: () => void, ms: number) => {
  timers.push({ at: FakeAudioContext.now + ms / 1000, fn })
  return timers.length
}) as typeof setTimeout
w.clearTimeout = () => {}
const BPM = 112
const BEAT = 60 / BPM // 0.5357s
const BAR = BEAT * 4
const FRAMES = Math.round(BAR * 8 * 44100) // 8-bar loop

function stem(stage: StageId, gain: number): StageStem {
  return { stage, gain, stem: new Float32Array(FRAMES), notes: [], peak: 1, rms: 0.5 }
}

function makeRender(): SongRender {
  const voices: VoiceRender[] = [
    { id: 'lead', label: 'lead', color: '#fff', stages: [stem('title', 1), stem('arena', 0.9), stem('final', 0.8)] },
    { id: 'bass', label: 'bass', color: '#fff', stages: [stem('title', 1), stem('arena', 0.95), stem('final', 0.85)] },
  ]
  return {
    songId: 'test', sampleRate: 44100, frames: FRAMES, seconds: FRAMES / 44100, bpm: BPM, swing: 0,
    steps: 128, stepFrames: FRAMES / 128, stepsPerBeat: 4, beatsPerBar: 4, bars: 8, tailSeconds: 0.5,
    stages: ['title', 'arena', 'final'], voices, mixPeak: 1, stagePeak: [1, 1, 1], headroom: 0.88,
  } as SongRender
}

interface Harness {
  player: ChipMusic
  ctx: FakeAudioContext
  sources: FakeSource[]
  advance(ms: number): void
}

function harness(): Harness {
  FakeAudioContext.now = 0
  timers = []
  const ctx = new FakeAudioContext()
  const sources: FakeSource[] = []
  const realCreate = ctx.createBufferSource.bind(ctx)
  ;(ctx as unknown as { createBufferSource: () => FakeSource }).createBufferSource = () => {
    const s = realCreate()
    sources.push(s)
    return s
  }
  const player = new ChipMusic()
  player.prepare(ctx as unknown as AudioContext)
  player.setRender(makeRender(), { restart: false })
  return {
    player, ctx, sources,
    advance(ms: number) {
      const target = FakeAudioContext.now + ms / 1000
      while (timers.length && timers[0]!.at <= target) {
        const next = timers.shift()!
        FakeAudioContext.now = next.at
        ctx.currentTime = next.at
        next.fn()
      }
      FakeAudioContext.now = target
      ctx.currentTime = target
    },
  }
}

/** Value of a part's stage gain at virtual time `t`, from its automation events. */
function gainAt(source: FakeSource, t: number): number {
  const param = source.gain!.gain as FakeParam
  const events = param.events
  if (events.length === 0) return param.value
  let v = events[0]!.value
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    if (e.time > t) break
    if (e.type === 'setValue') v = e.value
    else {
      const prev = events[i - 1]
      const span = e.time - (prev?.time ?? e.time)
      const frac = span > 0 ? Math.min(1, (t - (prev?.time ?? e.time)) / span) : 1
      v = (prev?.value ?? v) + (e.value - (prev?.value ?? v)) * frac
    }
  }
  return v
}

beforeEach(() => {
  FakeAudioContext.now = 0
  timers = []
  w.setTimeout = ((fn: () => void, ms: number) => {
    timers.push({ at: FakeAudioContext.now + ms / 1000, fn })
    return timers.length
  }) as typeof setTimeout
})
afterAll(() => {
  w.setTimeout = realSetTimeout
  w.clearTimeout = realClearTimeout
})

describe('quantized stage switching', () => {
  it('starts playing and opens only the selected stage', () => {
    const h = harness()
    h.player.play(0.02)
    h.advance(50)
    expect(h.sources.length).toBe(6) // 2 voices x 3 stages, looping
    expect(h.sources.every(s => s.loop && s.started && !s.stopped)).toBe(true)
    // title stems open, others silent
    const titleGains = h.sources.filter(s => (s.buffer as { length: number }).length > 0).map(s => gainAt(s, FakeAudioContext.now))
    expect(titleGains.filter(v => v > 0.5).length).toBeGreaterThanOrEqual(2)
  })

  it('schedules the fade centred on the next beat at least half a beat out', () => {
    const h = harness()
    h.player.play(0.02)
    h.advance(100) // now = 0.1, loop origin ~0.02; beat grid at 0.02+n*BEAT
    const origin = 0.02
    const expectedBeat = origin + Math.ceil((0.1 + 0.05 - origin) / BEAT - 1e-9) * BEAT
    // ensure >= half beat away
    const at = expectedBeat >= 0.1 + BEAT / 2 ? expectedBeat : expectedBeat + BEAT
    const fade = 0.09
    const delay = h.player.setStage('arena', { fade })
    expect(delay).toBeGreaterThan(0)
    // Fade midpoint must be the beat boundary: ramp start/end straddle it.
    const arenaSources = h.sources.filter(s => s.gain)
    const ramps = arenaSources.map(s => s.gain!.gain.events.filter(e => e.type === 'ramp'))
    const target = ramps.at(-1)
    expect(target).toBeDefined()
    const lastRamp = target!.at(-1)!
    expect(Math.abs((lastRamp.time - fade / 2) - at)).toBeLessThan(1e-6)
    // wait bound: 1.5 beats max
    expect(delay).toBeLessThanOrEqual((1.5 * BEAT + fade) * 1000 + 1)
  })

  it('bounds the wait under one bar and keeps sources looping (no restart)', () => {
    const h = harness()
    h.player.play(0.02)
    h.advance(200)
    const delay = h.player.setStage('final')
    expect(delay).toBeLessThanOrEqual((1.5 * BEAT + 0.06) * 1000)
    expect(h.sources.every(s => s.loop && !s.stopped)).toBe(true)
    h.advance(delay + 10)
    expect(h.player.stage).toBe('final')
    expect(h.sources.every(s => s.started)).toBe(true)
    expect(h.sources.filter(s => s.stopped).length).toBe(0)
  })

  it('replaces a pending switch with the latest scene only', () => {
    const h = harness()
    const settled: StageId[] = []
    h.player.onStage = s => settled.push(s)
    h.player.play(0.02)
    h.advance(100)
    h.player.setStage('arena')
    h.advance(50)
    const d2 = h.player.setStage('final')
    h.advance(d2 + 20)
    expect(settled).toEqual(['final']) // 'arena' superseded, never reported
    expect(h.player.stage).toBe('final')
    expect(h.player.pendingStage).toBeNull()
  })

  it('does not play stale scenes after mute/stop cycles', () => {
    const h = harness()
    const settled: StageId[] = []
    h.player.onStage = s => settled.push(s)
    h.player.play(0.02)
    h.advance(100)
    h.player.setStage('arena')
    h.advance(200)
    h.player.stop(0.02) // mute path
    // While parked, a scene change must adopt immediately, not schedule.
    h.player.setStage('title')
    expect(h.player.stage).toBe('title')
    expect(settled).toContain('title')
    expect(h.player.pendingStage).toBeNull()
    h.player.play(0.02)
    h.advance(100)
    expect(h.player.stage).toBe('title') // resumed at title, not stale arena
  })

  it('quantize:false still works for immediate switches', () => {
    const h = harness()
    h.player.play(0.02)
    h.advance(100)
    const delay = h.player.setStage('arena', { fade: 0.03, quantize: false })
    expect(delay).toBeLessThanOrEqual(60)
    h.advance(delay + 5)
    expect(h.player.stage).toBe('arena')
  })

  it('bar mode targets bar boundaries', () => {
    const h = harness()
    h.player.play(0.02)
    h.advance(300)
    const origin = 0.02
    const delay = h.player.setStage('arena', { quantize: 'bar', fade: 0.09 })
    // Next bar line >= 20ms lead from now=0.3
    let at = origin + Math.ceil((0.3 + 0.02 - origin) / BAR - 1e-9) * BAR
    if (at < 0.3 + 0.02) at += BAR
    const expectedDelay = (at + 0.045 - 0.3) * 1000
    expect(Math.abs(delay - expectedDelay)).toBeLessThan(1.5)
  })
})

// Restore the real timer after the module's tests.
