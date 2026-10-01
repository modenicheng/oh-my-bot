import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { ChipMusic } from './player'
import type { SongRender, StageStem, VoiceRender } from './render'
import type { StageId } from './types'

/**
 * Fake WebAudio graph: records gain automation on a monotonic virtual clock
 * so quantized scheduling can be asserted sample-free but exactly in time.
 *
 * Timers run on Vitest fake timers, so clearTimeout really cancels: a
 * superseded settle callback must never fire. The audio clock
 * (FakeAudioContext.now / ctx.currentTime) is moved by `advance`, while
 * `advanceWall` fires timers with the audio clock frozen, the way a suspended
 * shared context freezes AudioContext.currentTime but not JS timers.
 */

class FakeParam {
  value = 1
  events: { type: string; time: number; value: number }[] = []
  private hold(): number {
    // Value at `now` following the recorded automation, interpolating a ramp
    // that `now` lands inside rather than jumping to its endpoint.
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
  delays: { delayTime: FakeParam }[]
  advance(ms: number): void
  advanceWall(ms: number): void
}

function harness(): Harness {
  FakeAudioContext.now = 0
  const ctx = new FakeAudioContext()
  const sources: FakeSource[] = []
  const delays: { delayTime: FakeParam }[] = []
  const realCreate = ctx.createBufferSource.bind(ctx)
  ;(ctx as unknown as { createBufferSource: () => FakeSource }).createBufferSource = () => {
    const s = realCreate()
    sources.push(s)
    return s
  }
  const realDelay = ctx.createDelay.bind(ctx)
  ;(ctx as unknown as { createDelay: () => { delayTime: FakeParam } }).createDelay = () => {
    const d = realDelay() as unknown as { delayTime: FakeParam }
    delays.push(d)
    return d
  }
  const player = new ChipMusic()
  player.prepare(ctx as unknown as AudioContext)
  player.setRender(makeRender(), { restart: false })
  const setNow = (t: number) => {
    FakeAudioContext.now = t
    ctx.currentTime = t
  }
  return {
    player, ctx, sources, delays,
    /** Move the audio clock, then run every timer due inside the window. */
    advance(ms: number) {
      setNow(FakeAudioContext.now + ms / 1000)
      vi.advanceTimersByTime(ms)
    },
    /** Run wall-clock timers while the audio clock stays frozen (suspended ctx). */
    advanceWall(ms: number) {
      vi.advanceTimersByTime(ms)
    },
  }
}

/**
 * Value of a part's stage gain at virtual time `t`, following the recorded
 * automation. Mid-ramp queries return the true linear interpolation, so a
 * mis-scheduled ramp cannot pass by hiding between its event times.
 */
function gainAt(source: FakeSource, t: number): number {
  const param = source.gain!.gain as FakeParam
  const events = param.events
  let value = param.value // before the first event: the startVoices initial
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    if (e.type === 'setValue') {
      if (e.time > t) break
      value = e.value
      continue
    }
    const prev = events[i - 1]
    const from = prev?.value ?? value
    const fromT = prev?.time ?? e.time
    if (t >= e.time) { value = e.value; continue }
    if (t > fromT) return from + (e.value - from) * ((t - fromT) / (e.time - fromT))
    break
  }
  return value
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeAudioContext.now = 0
})
afterEach(() => {
  vi.useRealTimers()
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

  it('treats a duplicate pending request as a no-op, keeping the original schedule', () => {
    const h = harness()
    const settled: StageId[] = []
    h.player.onStage = s => settled.push(s)
    h.player.play(0.02)
    h.advance(100)
    h.player.setStage('arena', { fade: 0.1, quantize: false }) // ramp 0.12 → 0.22
    h.advance(40) // now = 0.14, mid-ramp
    const d2 = h.player.setStage('arena', { fade: 0.3, quantize: false }) // same target again
    expect(d2).toBeCloseTo(80, 6) // remaining to the ORIGINAL settle, not a fresh 320ms ramp
    expect(settled).toEqual([]) // re-requesting must not report the stage early
    expect(h.player.pendingStage).toBe('arena')
    expect(h.player.switchEndsAt).toBeCloseTo(0.22, 6)
    // Gain automation unchanged: still the original 0.12 → 0.22 ramp.
    expect(gainAt(h.sources[1]!, 0.2)).toBeCloseTo(0.72, 6)
    h.advance(90) // past the original settle at 0.22
    expect(settled).toEqual(['arena']) // reported once, by the original schedule
    expect(h.player.pendingStage).toBeNull()
  })

  it('keeps one settle report and true ramp values across an A→B→A override', () => {
    const h = harness()
    const settled: StageId[] = []
    h.player.onStage = s => settled.push(s)
    h.player.play(0.02)
    h.advance(100) // now = 0.1
    // A: arena, ramp 0.12 → 0.52 (lead title 1→0, lead arena 0→0.9)
    const d1 = h.player.setStage('arena', { fade: 0.4, quantize: false })
    expect(d1).toBeCloseTo(420, 6)
    h.advance(220) // now = 0.32: halfway through A's ramp
    expect(gainAt(h.sources[1]!, 0.32)).toBeCloseTo(0.45, 6) // lead arena midpoint
    expect(gainAt(h.sources[0]!, 0.32)).toBeCloseTo(0.5, 6) // lead title midpoint
    // B: title supersedes A mid-fade; A's settle callback must be cancelled.
    h.player.setStage('title', { fade: 0.4, quantize: false })
    expect(h.player.pendingStage).toBe('title')
    expect(h.player.switchEndsAt).toBeCloseTo(0.74, 6)
    h.advance(100) // now = 0.42: B is 20% through, from the held values
    expect(gainAt(h.sources[1]!, 0.42)).toBeCloseTo(0.36, 6) // 0.45 easing back to 0
    expect(gainAt(h.sources[0]!, 0.42)).toBeCloseTo(0.6, 6) // 0.5 easing back to 1
    // A again: overrides B before it settles
    const d3 = h.player.setStage('arena', { fade: 0.2, quantize: false })
    expect(d3).toBeCloseTo(220, 6)
    expect(h.player.pendingStage).toBe('arena')
    h.advance(130) // now = 0.55: past both superseded ends, before the final settle
    expect(settled).toEqual([]) // cancelled switches never report, even early
    expect(h.player.pendingStage).toBe('arena')
    h.advance(100) // now = 0.65, past the final settle at 0.64
    expect(settled).toEqual(['arena']) // title was never the settled stage
    expect(h.player.pendingStage).toBeNull()
    expect(gainAt(h.sources[1]!, 0.65)).toBeCloseTo(0.9, 6) // lead arena
    expect(gainAt(h.sources[4]!, 0.65)).toBeCloseTo(0.95, 6) // bass arena
    expect(gainAt(h.sources[0]!, 0.65)).toBeCloseTo(0, 6) // lead title
    // Overrides were pure gain automation: no source restarted or stopped.
    expect(h.sources.length).toBe(6)
    expect(h.sources.every(s => s.loop && s.started && !s.stopped)).toBe(true)
  })

  it('cancels the pending switch on stop and resumes at the selected stage', () => {
    const h = harness()
    const settled: StageId[] = []
    h.player.onStage = s => settled.push(s)
    h.player.play(0.02)
    h.advance(100)
    h.player.setStage('arena', { fade: 0.4, quantize: false }) // settles at 0.52
    h.advance(100) // now = 0.2, fade in flight
    h.player.stop(0.02)
    h.advance(1000) // wall time passes, but the switch was cancelled with stop
    expect(settled).toEqual([])
    expect(h.player.pendingStage).toBeNull()
    expect(h.player.stage).toBe('arena') // the selection survives the park
    h.sources.forEach(s => expect(s.stopped).toBe(true))
    h.player.play(0.02)
    h.advance(50)
    expect(h.sources.length).toBe(12) // fresh voice set, arena open from frame one
    expect(gainAt(h.sources[7]!, FakeAudioContext.now)).toBeCloseTo(0.9, 6) // new lead arena
    expect(gainAt(h.sources[6]!, FakeAudioContext.now)).toBeCloseTo(0, 6) // new lead title
    expect(settled).toEqual([]) // starting voices is not a stage switch
  })

  it('re-checks the settle time after the audio clock resumes from suspend', () => {
    const h = harness()
    const settled: StageId[] = []
    h.player.onStage = s => settled.push(s)
    h.player.play(0.02)
    h.advance(100)
    const delay = h.player.setStage('arena', { fade: 0.1, quantize: false }) // end = 0.22
    expect(delay).toBeCloseTo(120, 6)
    // Shared context suspended: JS timers keep running, currentTime does not.
    h.advanceWall(500)
    expect(settled).toEqual([]) // clock frozen: not settled despite wall time
    expect(h.player.pendingStage).toBe('arena')
    expect(h.player.switchEndsAt).toBeCloseTo(0.22, 6)
    h.advance(150) // clock resumes past 0.22; the re-scheduled timer re-checks
    expect(settled).toEqual(['arena'])
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

  it('bounds the bar-quantized wait just over one bar for any phase', () => {
    for (const offsetMs of [0, 50, 100, 150, 200, 250, 300, 400, 500, 1000]) {
      vi.clearAllTimers()
      const h = harness()
      h.player.play(0.02)
      h.advance(offsetMs)
      const fade = 0.09
      const delay = h.player.setStage('arena', { quantize: 'bar', fade })
      expect(delay).toBeGreaterThan(0)
      // One bar plus the grid lead and the fade, never more.
      expect(delay).toBeLessThanOrEqual((BAR + 0.05 + fade) * 1000 + 1)
    }
  })

  it('setTempo retunes echo delays but not the quantize grid', () => {
    const h = harness()
    h.player.play(0.02)
    h.advance(100)
    h.player.setTempo(140)
    const dotted = (60 / 140) * 0.75
    for (const d of h.delays) expect(d.delayTime.value).toBeCloseTo(dotted, 6)
    expect(h.player.current?.bpm).toBe(BPM) // the render's tempo is untouched
    // A bar-quantized switch still targets BPM-112 bar lines, not 140's.
    const delay = h.player.setStage('final', { quantize: 'bar', fade: 0.09 })
    const at = 0.02 + Math.ceil((0.1 + 0.05 - 0.02) / BAR - 1e-9) * BAR
    expect(delay).toBeCloseTo((at + 0.045 - 0.1) * 1000, 1)
  })
})
