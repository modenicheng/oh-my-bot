// WebAudio 合成音效：无外部素材，短促提示音由振荡器 + 滤波噪声构成，Uplink 近距为持续低鸣、
// 破解为门控蜂鸣 + 信息噪声流。AudioContext 只在可信指针/按键时懒创建；静音、切后台、离开对局
// 时持续声部立即断开，不排队过期声音。样式令牌见 client/STYLE.md；HUD 提供 #audio-mute / #audio-volume。
import { iconButton } from './icons'

export type SoundCue =
  | 'shot' | 'hit' | 'shieldHit' | 'wallHit' | 'dash' | 'shieldOn' | 'shieldOff'
  | 'coreSpawn' | 'corePickup' | 'uplinkEnter' | 'uplinkStart' | 'uplinkCancel' | 'uplinkSuccess'
  | 'matchStart' | 'matchEnd' | 'phase' | 'innerOpen' | 'countdownWarning' | 'countdownTick'
  | 'respawn' | 'death' | 'assist' | 'deny' | 'hover' | 'click'

type UplinkMode = 'off' | 'near' | 'hacking'

/** 单个发声单元：t 省略时为滤波噪声；filter 同时适用于两种声源。 */
interface Note {
  t?: OscillatorType
  f: number
  to?: number
  d: number
  g: number
  at?: number
  filter?: { type: BiquadFilterType; f: number; to?: number; q?: number }
}

// 克制的提示音调色板：能量动作用方波/锯齿，系统与拾取用正弦/三角，噪声只做冲击与气流。
const CUE: Record<SoundCue, Note[]> = {
  shot: [{ t: 'square', f: 900, to: 320, d: 0.07, g: 0.3 }],
  hit: [{ t: 'sawtooth', f: 240, to: 90, d: 0.09, g: 0.34, filter: { type: 'lowpass', f: 1600 } }],
  shieldHit: [{ t: 'triangle', f: 1250, to: 720, d: 0.12, g: 0.3 }, { t: 'sine', f: 626, d: 0.12, g: 0.14 }],
  wallHit: [{ f: 400, d: 0.11, g: 0.32, filter: { type: 'lowpass', f: 500, to: 160 } }],
  dash: [{ f: 350, d: 0.2, g: 0.3, filter: { type: 'bandpass', f: 350, to: 2600, q: 1.2 } }],
  shieldOn: [{ t: 'sine', f: 440, to: 880, d: 0.12, g: 0.26 }],
  shieldOff: [{ t: 'sine', f: 880, to: 440, d: 0.12, g: 0.22 }],
  coreSpawn: [
    { t: 'triangle', f: 392, d: 0.1, g: 0.25 }, { t: 'triangle', f: 587, d: 0.1, g: 0.25, at: 0.1 },
    { t: 'sine', f: 880, d: 0.2, g: 0.28, at: 0.2 },
  ],
  corePickup: [{ t: 'square', f: 784, d: 0.06, g: 0.19 }, { t: 'triangle', f: 1047, d: 0.1, g: 0.27, at: 0.05 }],
  uplinkEnter: [{ t: 'sine', f: 220, to: 262, d: 0.16, g: 0.24 }],
  uplinkStart: [{ t: 'square', f: 980, to: 1245, d: 0.09, g: 0.2 }],
  uplinkCancel: [{ t: 'square', f: 620, to: 300, d: 0.14, g: 0.2 }],
  uplinkSuccess: [
    { t: 'sine', f: 523, d: 0.09, g: 0.24 }, { t: 'sine', f: 659, d: 0.09, g: 0.24, at: 0.09 },
    { t: 'sine', f: 784, d: 0.16, g: 0.26, at: 0.18 },
  ],
  matchStart: [{ t: 'triangle', f: 392, d: 0.12, g: 0.3 }, { t: 'triangle', f: 587, d: 0.24, g: 0.32, at: 0.14 }],
  matchEnd: [
    { t: 'triangle', f: 587, d: 0.12, g: 0.28 }, { t: 'triangle', f: 440, d: 0.12, g: 0.26, at: 0.14 },
    { t: 'triangle', f: 294, d: 0.28, g: 0.28, at: 0.28 },
  ],
  phase: [{ t: 'sine', f: 700, d: 0.08, g: 0.18 }],
  innerOpen: [
    { t: 'sine', f: 98, to: 196, d: 0.6, g: 0.28 },
    { t: 'square', f: 196, d: 0.07, g: 0.15, filter: { type: 'lowpass', f: 1600 } },
    { t: 'square', f: 294, d: 0.07, g: 0.16, at: 0.1, filter: { type: 'lowpass', f: 2100 } },
    { t: 'square', f: 392, d: 0.08, g: 0.17, at: 0.2, filter: { type: 'lowpass', f: 2600 } },
    { t: 'triangle', f: 784, d: 0.28, g: 0.24, at: 0.32 },
    { t: 'triangle', f: 988, d: 0.26, g: 0.16, at: 0.34 },
    { t: 'sine', f: 1175, d: 0.24, g: 0.18, at: 0.36 },
  ],
  countdownWarning: [{ t: 'square', f: 880, d: 0.09, g: 0.25 }, { t: 'square', f: 1175, d: 0.1, g: 0.25, at: 0.16 }],
  countdownTick: [{ t: 'square', f: 1320, d: 0.055, g: 0.23 }],
  respawn: [{ t: 'triangle', f: 330, to: 660, d: 0.18, g: 0.24 }],
  death: [
    { t: 'sawtooth', f: 300, to: 60, d: 0.32, g: 0.3, filter: { type: 'lowpass', f: 900, to: 200 } },
    { f: 800, d: 0.3, g: 0.24, filter: { type: 'lowpass', f: 800, to: 150 } },
  ],
  assist: [{ t: 'sine', f: 660, d: 0.06, g: 0.16 }, { t: 'sine', f: 880, d: 0.08, g: 0.16, at: 0.07 }],
  deny: [{ t: 'square', f: 160, to: 140, d: 0.12, g: 0.22, filter: { type: 'lowpass', f: 600 } }],
  hover: [{ t: 'sine', f: 1200, d: 0.03, g: 0.06 }],
  click: [{ t: 'sine', f: 720, to: 660, d: 0.05, g: 0.14 }],
}

const PRIORITY_CUES = new Set<SoundCue>([
  'innerOpen', 'countdownWarning', 'countdownTick', 'matchStart', 'matchEnd',
  'uplinkEnter', 'uplinkStart', 'uplinkCancel', 'uplinkSuccess', 'corePickup', 'respawn', 'assist', 'deny',
])
const AMBIENT_VOICES = 24
const MAX_VOICES = 32

interface Bus { ctx: BaseAudioContext; out: AudioNode; noise?: AudioBuffer }

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return buf
}

/** 在总线上搭建一个发声链并调度起止；返回节点表供停止后断开清理。 */
function buildNote(n: Note, bus: Bus, gain: number, pan: number): { src: AudioScheduledSourceNode; nodes: AudioNode[] } {
  const { ctx } = bus, t0 = ctx.currentTime + (n.at ?? 0)
  const nodes: AudioNode[] = []
  let src: AudioScheduledSourceNode
  if (n.t) {
    const osc = ctx.createOscillator()
    osc.type = n.t
    osc.frequency.setValueAtTime(n.f, t0)
    if (n.to) osc.frequency.exponentialRampToValueAtTime(Math.max(n.to, 1), t0 + n.d)
    src = osc
  } else {
    const buf = ctx.createBufferSource()
    buf.buffer = bus.noise ?? (bus.noise = noiseBuffer(ctx))
    buf.loop = true
    src = buf
  }
  let head: AudioNode = src
  if (n.filter) {
    const bq = ctx.createBiquadFilter()
    bq.type = n.filter.type
    bq.frequency.setValueAtTime(n.filter.f, t0)
    if (n.filter.to) bq.frequency.exponentialRampToValueAtTime(Math.max(n.filter.to, 10), t0 + n.d)
    bq.Q.value = n.filter.q ?? 0.8
    head.connect(bq); head = bq; nodes.push(bq)
  }
  const env = ctx.createGain()
  const peak = Math.max(n.g * gain, 0.001)
  env.gain.setValueAtTime(0, t0)
  env.gain.linearRampToValueAtTime(peak, t0 + 0.008)
  env.gain.exponentialRampToValueAtTime(0.0008, t0 + n.d)
  head.connect(env); nodes.push(env)
  let tail: AudioNode = env
  if (pan !== 0 && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner(); p.pan.value = pan
    env.connect(p); tail = p; nodes.push(p)
  }
  tail.connect(bus.out)
  src.start(t0); src.stop(t0 + n.d + 0.03)
  return { src, nodes }
}

interface Loop { mode: 'near' | 'hacking'; tune(progress: number): void; stop(): void }

class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private voices = new Set<{ priority: boolean; stop(): void }>()
  private noise: AudioBuffer | undefined
  private lastAt = new Map<string, number>()
  private desired: UplinkMode = 'off'
  private loop: Loop | null = null
  private ui = false
  private vol: number
  private mute: boolean

  constructor() {
    let vol = 0.45, mute = false
    try {
      const raw = localStorage.getItem('omb.audio')
      if (raw) {
        const s = JSON.parse(raw) as { v?: unknown; m?: unknown }
        if (typeof s.v === 'number' && Number.isFinite(s.v)) vol = Math.min(1, Math.max(0, s.v))
        if (typeof s.m === 'boolean') mute = s.m
      }
    } catch { /* 隐私模式或存储被禁用时保持默认 */ }
    this.vol = vol; this.mute = mute
  }

  get muted(): boolean { return this.mute }
  get volume(): number { return this.vol }

  play(cue: SoundCue, gain = 1, pan = 0, priority = PRIORITY_CUES.has(cue)): void {
    if (this.mute || document.hidden || gain <= 0.01) return
    if (!this.ctx || this.ctx.state !== 'running') return
    const now = performance.now()
    // A distant cue cannot throttle a confirmed self cue of the same kind.
    const rateKey = `${cue}:${priority}`
    if (now - (this.lastAt.get(rateKey) ?? -1e9) < (cue === 'hover' ? 90 : 45)) return
    const notes = CUE[cue], limit = priority ? MAX_VOICES : AMBIENT_VOICES
    if (this.voices.size + notes.length > limit) {
      if (!priority) return
      const required = this.voices.size + notes.length - limit
      const expendable = [...this.voices].filter(v => !v.priority)
      if (expendable.length < required) return
      for (const voice of expendable.slice(0, required)) voice.stop()
    }
    this.lastAt.set(rateKey, now)
    const bus: Bus = { ctx: this.ctx, out: this.master!, noise: this.noise }
    for (const n of notes) {
      const { src, nodes } = buildNote(n, bus, gain, pan)
      this.noise = bus.noise
      const clean = () => { this.voices.delete(voice); for (const nd of nodes) nd.disconnect(); src.disconnect() }
      const voice = { priority, stop: () => { src.onended = null; src.stop(); clean() } }
      this.voices.add(voice)
      src.onended = clean
    }
  }

  /** 每帧快照都会调用：模式不变时只调参，不重建声部。 */
  setUplink(mode: UplinkMode, progress = 0): void {
    this.desired = mode
    const p = Math.min(1, Math.max(0, progress))
    if (mode === 'off' || this.mute || document.hidden || !this.ctx || this.ctx.state !== 'running') { this.stopLoop(); return }
    if (!this.loop || this.loop.mode !== mode) { this.stopLoop(); this.startLoop(mode, p) }
    else this.loop.tune(p)
  }

  stopGame(): void {
    this.desired = 'off'; this.stopLoop()
    for (const voice of this.voices) voice.stop()
    this.lastAt.clear()
  }

  setMuted(muted: boolean): void {
    if (this.mute === muted) return
    this.mute = muted
    if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : this.vol, this.ctx!.currentTime, 0.01)
    if (muted) this.stopLoop()
    else if (this.desired !== 'off' && !document.hidden && this.ctx?.state === 'running') this.startLoop(this.desired, 0)
    this.persist(); this.reflectUI()
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return
    const v = Math.min(1, Math.max(0, volume))
    if (Math.abs(v - this.vol) < 1e-3) return
    this.vol = v
    if (this.master && !this.mute) this.master.gain.setTargetAtTime(v, this.ctx!.currentTime, 0.01)
    this.persist(); this.reflectUI()
  }

  /** 必须从用户手势中同步调用；不支持 WebAudio 时仍允许进入。 */
  unlock(): boolean { return this.ensure() }

  /** 一次性安装：手势解锁监听 + 委托式 UI 提示音 + HUD 控件绑定。 */
  installUI(): void {
    if (this.ui) return
    this.ui = true
    const wake = (e: Event) => { if (e.isTrusted) this.ensure() }
    document.addEventListener('pointerdown', wake, true)
    document.addEventListener('keydown', wake, true)
    const pick = (t: EventTarget | null): HTMLElement | null =>
      t instanceof Element ? t.closest<HTMLElement>('button, a, summary') : null
    const off = (el: HTMLElement): boolean =>
      (el instanceof HTMLButtonElement && el.disabled) || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
    document.addEventListener('pointerover', e => {
      if (e.pointerType !== 'mouse') return
      const el = pick(e.target)
      if (!el || off(el)) return
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return // 元素内部过渡不重复触发
      this.play('hover', 0.8)
    })
    document.addEventListener('focusin', e => {
      const el = pick(e.target)
      if (el && !off(el) && el.matches(':focus-visible')) this.play('hover', 0.6)
    })
    document.addEventListener('click', e => {
      const el = pick(e.target)
      if (el && !off(el)) this.play('click')
    })
    const muteBtn = document.getElementById('audio-mute')
    if (muteBtn) muteBtn.addEventListener('click', () => this.setMuted(!this.mute))
    const range = document.getElementById('audio-volume') as HTMLInputElement | null
    if (range) range.addEventListener('input', () => this.setVolume(Number(range.value) / 100))
    this.reflectUI()
  }

  private ensure(): boolean {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined)
      return true
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return false
      const ctx = new Ctor()
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = -12; comp.ratio.value = 6
      const master = ctx.createGain()
      master.gain.value = this.mute ? 0 : this.vol
      master.connect(comp); comp.connect(ctx.destination)
      this.ctx = ctx; this.master = master
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.stopLoop()
        else if (this.desired !== 'off' && !this.mute && this.ctx?.state === 'running') this.startLoop(this.desired, 0)
      })
      return true
    } catch { return false }
  }

  private startLoop(mode: 'near' | 'hacking', progress: number): void {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const nodes: AudioNode[] = []
    const sources: AudioScheduledSourceNode[] = []
    const g = ctx.createGain()
    g.gain.value = 0
    g.connect(this.master); nodes.push(g)
    const osc = (type: OscillatorType, freq: number): OscillatorNode => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq
      o.connect(g); o.start(); sources.push(o); nodes.push(o); return o
    }
    // 近距：双振荡器差拍低鸣，慢 LFO 呼吸。
    const a = osc('sine', 108), b = osc('sine', 112)
    const breath = ctx.createOscillator(), breathAmt = ctx.createGain()
    breath.frequency.value = 0.4; breathAmt.gain.value = 0.012
    breath.connect(breathAmt); breathAmt.connect(g.gain); breath.start()
    sources.push(breath); nodes.push(breath, breathAmt)
    let carrier: OscillatorNode | null = null, gate: OscillatorNode | null = null
    let gateAmt: GainNode | null = null, band: BiquadFilterNode | null = null
    if (mode === 'hacking') {
      // 破解：方波门控蜂鸣 + 带通噪声"信息流"，进度推进节奏与滤波中心。
      a.frequency.value = 96; b.frequency.value = 99
      carrier = ctx.createOscillator(); carrier.type = 'square'; carrier.frequency.value = 620
      gateAmt = ctx.createGain(); gateAmt.gain.value = 0.03
      gate = ctx.createOscillator(); gate.type = 'square'; gate.frequency.value = 8 + 10 * progress
      gate.connect(gateAmt); gateAmt.connect(g.gain)
      carrier.connect(g); carrier.start(); gate.start()
      sources.push(carrier, gate); nodes.push(carrier, gate, gateAmt)
      const noise = ctx.createBufferSource()
      noise.buffer = this.noise ?? (this.noise = noiseBuffer(ctx)); noise.loop = true
      band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.Q.value = 1.5
      band.frequency.value = 500 + 2400 * progress
      const whoosh = ctx.createGain(); whoosh.gain.value = 0.05
      const sweep = ctx.createOscillator(), sweepAmt = ctx.createGain()
      sweep.frequency.value = 0.5; sweepAmt.gain.value = 250
      sweep.connect(sweepAmt); sweepAmt.connect(band.frequency)
      noise.connect(band); band.connect(whoosh); whoosh.connect(this.master)
      noise.start(); sweep.start()
      sources.push(noise, sweep); nodes.push(noise, band, whoosh, sweep, sweepAmt)
    }
    g.gain.setTargetAtTime(mode === 'hacking' ? 0.04 : 0.05, ctx.currentTime, 0.05)
    const base = mode
    this.loop = {
      mode: base,
      tune: p => {
        if (gate) gate.frequency.setTargetAtTime(8 + 10 * p, ctx.currentTime, 0.1)
        if (band) band.frequency.setTargetAtTime(500 + 2400 * p, ctx.currentTime, 0.1)
        if (carrier) carrier.frequency.setTargetAtTime(620 + 80 * p, ctx.currentTime, 0.1)
        g.gain.setTargetAtTime((base === 'hacking' ? 0.04 : 0.05) + 0.02 * p, ctx.currentTime, 0.1)
      },
      stop: () => {
        g.gain.setTargetAtTime(0, ctx.currentTime, 0.02)
        const end = ctx.currentTime + 0.08
        for (const s of sources) { s.onended = null; try { s.stop(end) } catch { /* 已停止 */ } }
        setTimeout(() => { for (const nd of nodes) nd.disconnect() }, 140)
      },
    }
    this.loop.tune(progress)
  }

  private stopLoop(): void {
    this.loop?.stop()
    this.loop = null
  }

  private persist(): void {
    try { localStorage.setItem('omb.audio', JSON.stringify({ v: this.vol, m: this.mute })) } catch { /* 忽略存储失败 */ }
  }

  private reflectUI(): void {
    const muteBtn = document.getElementById('audio-mute')
    if (muteBtn) {
      iconButton(muteBtn, this.mute ? 'soundOff' : 'sound', this.mute ? '取消静音' : '静音')
      muteBtn.setAttribute('aria-pressed', String(this.mute))
    }
    const range = document.getElementById('audio-volume') as HTMLInputElement | null
    if (range) {
      range.value = String(Math.round(this.vol * 100))
      range.setAttribute('aria-label', '音量')
    }
  }
}

export const audio = new AudioEngine()
