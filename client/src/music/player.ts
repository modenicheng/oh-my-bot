/**
 * Playback and the ambience bus, built around a gain matrix.
 *
 * Every (voice, stage) pair owns one looping source, and all of them start
 * together on the same sample. Nothing is ever restarted when the stage
 * changes: `setStage` only ramps gains, keeping the sources phase-aligned and
 * avoiding abrupt gain steps (very short fades can still be audible). The
 * stages interlock because the loop is one continuous performance with eight
 * faders per stage, not three separate songs.
 *
 *   source -> stageGain -> startFade -> level -> panner -> bus
 *
 * Sends tap `level` (pre-pan, mono), so panning a voice never drags its
 * reverb or echo with it:
 *   bus(space)  -> highpass -> convolver -> lowpass -> return
 *   bus(echo)   -> highpass -> ping-pong delay pair -> return
 *
 *   bus -> trim(headroom) -> soft ceiling -> volume -> destination
 *
 * Because the sources loop continuously, the reverb and echo tails carry across
 * the loop point rather than resetting. Feedback settles over successive passes;
 * it is not necessarily periodic after the first pass.
 */

import type { StageId } from './types.ts';
import type { VoiceMix } from './tune.ts';
import type { SongRender } from './render.ts';

interface PartNodes {
  stage: StageId | null;
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Design level of this part, remembered so ramps have a target. */
  level: number;
  /** Last envelope, also used where cancelAndHoldAtTime is unavailable. */
  ramp: { from: number; to: number; start: number; end: number };
}

interface VoiceNodes {
  parts: PartNodes[];
  startFade: GainNode;
  level: GainNode;
  panner: StereoPannerNode;
  space: GainNode;
  echo: GainNode;
  drift: GainNode;
  lfo: OscillatorNode;
}

export interface StageSwitch {
  /** Seconds for the fade. <= 0.005 uses a 5ms cut starting on the grid line. */
  fade?: number;
  /**
   * Quantize the switch onto the musical grid using AudioContext.currentTime
   * and the tune's tempo (default). The fade centres on the next beat line at
   * least half a beat away — scheduled early so the boundary is never missed —
   * which keeps the wait under 1.5 beats, well inside one bar. `'bar'` targets
   * bar lines instead; `false` starts after a short scheduling lead.
   */
  quantize?: boolean | 'bar';
}

const SPACE_SECONDS = 1.7;
const ECHO_FEEDBACK = 0.3;
/** Echo repeats land on a dotted eighth. */
const ECHO_DIVISION = 0.75;
/**
 * Voices that sit far away drift slowly across the field. The movement has a
 * floor of its own so it survives having the reverb pulled back: drifting is
 * free width, where reverb width costs clarity.
 */
const DRIFT_BASE = 0.22;
const DRIFT_PER_SPACE = 0.35;
/** Minimum de-click ramp; cuts start at the boundary rather than straddling it. */
const CUT_SECONDS = 0.005;
/** Hard floor for scheduling anything into the audio future. */
const SCHEDULE_LEAD = 0.02;
/** Timer handles work in the browser and under Node test runners alike. */
const timers: Window = typeof window !== 'undefined'
    ? window
    : (globalThis as unknown as Window);
const setTimer = (fn: () => void, ms: number): number => timers.setTimeout(fn, ms) as unknown as number;
const clearTimer = (id: number): void => { timers.clearTimeout(id as unknown as ReturnType<typeof setTimeout>) };

export class ChipMusic {
  private ctx: AudioContext | null = null;
  /** oh-my-bot 修改：context 是否由本类自建（自建才允许 close，共享时归宿主）。 */
  private ownsContext = false;
  private bus: GainNode | null = null;
  private trim: GainNode | null = null;
  private master: GainNode | null = null;
  private spaceIn: GainNode | null = null;
  private echoIn: GainNode | null = null;
  private spaceReturn: GainNode | null = null;
  private echoReturn: GainNode | null = null;
  private delays: DelayNode[] = [];
  private nodes: VoiceNodes[] = [];
  private buffers = new WeakMap<SongRender, AudioBuffer[][]>();
  private stemBuffers = new WeakMap<Float32Array, AudioBuffer>();
  private render: SongRender | null = null;
  private mix: VoiceMix[] = [];
  private stageIndex = 0;
  private volumeValue = 0.8;
  private spaceValue = 0.85;
  private echoValue = 0.7;
  private bpm = 120;
  private playing = false;
  private startedAt = 0;
  private pausedFrame = 0;
  private switchTimer: number | null = null;
  /** Target of the in-flight quantized switch; the latest request wins. */
  private pending: StageId | null = null;
  /** Absolute audio time at which the pending switch settles. */
  private switchEnd = 0;
  /** Notified once the switch settles; paused selections settle immediately. */
  onStage: ((stage: StageId) => void) | null = null;

  get ready(): boolean {
    return this.ctx !== null;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get current(): SongRender | null {
    return this.render;
  }

  /** Master output, for a game that wants to tap or process the music bus. */
  get output(): GainNode | null {
    return this.master;
  }

  get volume(): number {
    return this.volumeValue;
  }

  get stage(): StageId {
    return this.render?.stages[this.stageIndex] ?? 'title';
  }

  /** Stage a quantized switch is currently ramping towards, if any. */
  get pendingStage(): StageId | null {
    return this.pending;
  }

  /** Absolute audio time when the pending switch settles; null when none. */
  get switchEndsAt(): number | null {
    return this.pending === null ? null : this.switchEnd;
  }

  /** Frames into the loop, whether playing or parked. */
  get positionFrames(): number {
    const render = this.render;
    if (!render || !this.playing) return this.pausedFrame;
    const elapsed = this.ctx!.currentTime - this.startedAt;
    const frames = Math.floor(elapsed * render.sampleRate) % render.frames;
    return frames < 0 ? frames + render.frames : frames;
  }

  get positionStep(): number {
    const render = this.render;
    if (!render) return 0;
    return this.positionFrames / render.stepFrames;
  }

  /** Bars since the loop started, for the auto-advance display. */
  get positionBar(): number {
    const render = this.render;
    if (!render) return 0;
    return this.positionFrames / (render.frames / render.bars);
  }

  /**
   * Create the audio graph early: the context's sample rate decides the render rate.
   *
   * oh-my-bot 修改：宿主可注入共享 AudioContext（与音效引擎同源），此时不再自建、
   * 生命周期（suspend/resume/close）完全归宿主管理，本类只往 destination 上挂图。
   */
  prepare(shared?: AudioContext): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (shared) {
      if (shared.state === 'closed') return null;
      try {
        this.wire(shared);
      } catch {
        return null;
      }
      return this.ctx;
    }
    try {
      const scope = typeof window !== 'undefined'
        ? window
        : (globalThis as unknown as { AudioContext?: typeof AudioContext });
      const Ctor = scope?.AudioContext
        ?? (scope as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.wire(new Ctor({ latencyHint: 'interactive' }));
      this.ownsContext = true;
    } catch {
      return null;
    }
    return this.ctx;
  }

  /** 在给定 context 上搭建混音总线与空间效果；仅由 prepare 调用。 */
  private wire(ctx: AudioContext): void {
    const bus = ctx.createGain();
    const trim = ctx.createGain();
    const clip = ctx.createWaveShaper();
    clip.curve = softCeiling();
    clip.oversample = '4x';
    const master = ctx.createGain();
    master.gain.value = this.volumeValue;
    bus.connect(trim).connect(clip).connect(master).connect(ctx.destination);

    // --- space: a long, dark, decorrelated stereo tail
    const spaceIn = ctx.createGain();
    const spaceHp = ctx.createBiquadFilter();
    spaceHp.type = 'highpass';
    // Kept well above the mids: reverb should sit behind the music, not in it.
    spaceHp.frequency.value = 480;
    spaceHp.Q.value = 0.6;
    const convolver = ctx.createConvolver();
    convolver.normalize = false;
    convolver.buffer = createSpaceImpulse(ctx, SPACE_SECONDS);
    const spaceLp = ctx.createBiquadFilter();
    spaceLp.type = 'lowpass';
    spaceLp.frequency.value = 8200;
    const spaceReturn = ctx.createGain();
    spaceReturn.gain.value = this.spaceValue;
    spaceIn.connect(spaceHp).connect(convolver).connect(spaceLp).connect(spaceReturn).connect(bus);

    // --- echo: dotted-eighth ping-pong, darkened on every repeat
    const echoIn = ctx.createGain();
    const echoHp = ctx.createBiquadFilter();
    echoHp.type = 'highpass';
    echoHp.frequency.value = 320;
    const delayA = ctx.createDelay(2);
    const delayB = ctx.createDelay(2);
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 3400;
    const feedback = ctx.createGain();
    feedback.gain.value = ECHO_FEEDBACK;
    const panL = ctx.createStereoPanner();
    panL.pan.value = -0.85;
    const panR = ctx.createStereoPanner();
    panR.pan.value = 0.85;
    const echoReturn = ctx.createGain();
    echoReturn.gain.value = this.echoValue;

    echoIn.connect(echoHp).connect(delayA);
    delayA.connect(panL).connect(echoReturn);
    delayA.connect(delayB);
    delayB.connect(panR).connect(echoReturn);
    delayB.connect(damp).connect(feedback).connect(delayA);
    echoReturn.connect(bus);

    this.bus = bus;
    this.trim = trim;
    this.master = master;
    this.spaceIn = spaceIn;
    this.echoIn = echoIn;
    this.spaceReturn = spaceReturn;
    this.echoReturn = echoReturn;
    this.delays = [delayA, delayB];
    this.ctx = ctx;
    this.setTempo(this.bpm);
  }

  /**
   * Audio can only start from a user gesture, so playback is resumed here.
   * Call this from a click/keypress handler.
   *
   * oh-my-bot 修改：透传宿主 context（见 prepare）；共享时 resume 归宿主 unlock 生命周期。
   */
  unlock(shared?: AudioContext): AudioContext | null {
    const ctx = this.prepare(shared);
    if (ctx && ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }

  /** Hand the player a freshly rendered tune. Keeps playing if it already was. */
  setRender(render: SongRender, options: { restart?: boolean; fade?: number; stage?: StageId } = {}): void {
    this.cancelSwitchTimer();
    const wasPlaying = this.playing;
    const step = wasPlaying ? this.positionStep : this.pausedFrame / (this.render?.stepFrames ?? 1);
    const fade = options.fade ?? 0.03;
    this.render = render;
    if (options.stage) {
      const index = render.stages.indexOf(options.stage);
      if (index >= 0) this.stageIndex = index;
    } else if (this.stageIndex >= render.stages.length) {
      this.stageIndex = 0;
    }
    this.pausedFrame = Math.min(render.frames - 1, Math.max(0, Math.round(step * render.stepFrames)));
    if (this.trim) this.trim.gain.value = render.headroom;
    this.setTempo(render.bpm);
    if (wasPlaying || options.restart) this.startVoices(this.pausedFrame, fade);
  }

  setMix(mix: VoiceMix[]): void {
    this.mix = mix;
    this.applyMix();
  }

  setVolume(volume: number): void {
    this.volumeValue = Math.max(0, Math.min(1, volume));
    if (this.master) this.master.gain.value = this.volumeValue;
  }

  /** Master wet levels, 0..1.4. */
  setAmbience(space: number, echo: number): void {
    this.spaceValue = Math.max(0, Math.min(1.4, space));
    this.echoValue = Math.max(0, Math.min(1.4, echo));
    if (this.spaceReturn) this.spaceReturn.gain.value = this.spaceValue;
    if (this.echoReturn) this.echoReturn.gain.value = this.echoValue;
  }

  /** Echo repeats follow the tempo; call it whenever the tune's bpm changes. */
  setTempo(bpm: number): void {
    this.bpm = bpm;
    const seconds = (60 / Math.max(30, bpm)) * ECHO_DIVISION;
    for (const delay of this.delays) delay.delayTime.value = seconds;
  }

  /**
   * Change stage without restarting sources. Switches are quantized onto the
   * musical grid: the fade centres on the next beat (or bar) line at least
   * half a beat away, scheduled from AudioContext.currentTime and the tune's
   * tempo, so the boundary is never missed and the wait stays under one bar.
   * A request landing mid-fade replaces the pending one — only the latest
   * scene survives — and `onStage` reports what actually settled.
   * Unquantized fades start after a short scheduling lead. Returns milliseconds
   * until the scheduled end (assuming the audio clock keeps running).
   */
  setStage(stage: StageId, options: StageSwitch = {}): number {
    const render = this.render;
    const ctx = this.ctx;
    if (!render) return 0;
    const index = render.stages.indexOf(stage);
    if (index < 0) return 0;

    this.cancelSwitchTimer();
    if (!ctx || !this.playing || index === this.stageIndex) {
      // No live fade in flight: adopt the selection outright. A paused player
      // applies it the next time it plays, so stale scenes never surface after
      // suspend/resume or mute toggles.
      this.pending = null;
      this.stageIndex = index;
      this.onStage?.(stage);
      return 0;
    }

    const fade = Math.max(CUT_SECONDS, options.fade ?? 0.05);
    const active = ctx.currentTime;
    const earliest = active + SCHEDULE_LEAD;
    let start = earliest;
    if (options.quantize !== false) {
      const beat = 60 / render.bpm;
      const gridSeconds = options.quantize === 'bar' ? beat * render.beatsPerBar : beat;
      // Next grid line with enough lead: half a beat in beat mode (so the ramp
      // is fully inside the audio clock's future and never misses the
      // boundary, bounding the wait by 1.5 beats), the scheduling floor in
      // bar mode (bounding the wait by one bar).
      let at = this.gridTime(gridSeconds);
      if (at - active < (options.quantize === 'bar' ? SCHEDULE_LEAD : beat / 2)) at += gridSeconds;
      const shortfall = earliest + fade / 2 - at;
      if (shortfall > 0) at += Math.ceil(shortfall / gridSeconds) * gridSeconds;
      start = Math.max(active + CUT_SECONDS, at - fade / 2);
    }
    const end = start + fade;

    for (const node of this.nodes) {
      for (const part of node.parts) {
        const target = part.stage === stage ? part.level : 0;
        const gain = part.gain.gain;
        const ramp = part.ramp;
        const progress = ramp.end > ramp.start
          ? Math.max(0, Math.min(1, (active - ramp.start) / (ramp.end - ramp.start)))
          : 1;
        const held = ramp.from + (ramp.to - ramp.from) * progress;
        if (typeof gain.cancelAndHoldAtTime === 'function') {
          gain.cancelAndHoldAtTime(active);
        } else {
          gain.cancelScheduledValues(active);
          // Preserve the already-playing portion of a truncated linear ramp.
          if (active > ramp.start && active <= ramp.end) gain.linearRampToValueAtTime(held, active);
          else gain.setValueAtTime(held, active);
        }
        // Every part follows the same interpolation, so full-stage voices keep
        // unit-sum weights and identical shared stems do not dip or double.
        gain.setValueAtTime(held, start);
        gain.linearRampToValueAtTime(target, end);
        part.ramp = { from: held, to: target, start, end };
      }
    }

    this.stageIndex = index;
    this.pending = stage;
    this.switchEnd = end;
    const delay = Math.max(0, (end - active) * 1000);
    const settled = () => {
      const remaining = (end - ctx.currentTime) * 1000;
      if (remaining > 0) {
        // Timers keep running when the audio clock is suspended; re-check on wake.
        this.switchTimer = setTimer(settled, Math.max(10, remaining));
        return;
      }
      this.switchTimer = null;
      if (this.pending === stage) {
        this.pending = null;
        this.onStage?.(stage);
      }
    };
    this.switchTimer = setTimer(settled, delay);
    return delay;
  }

  play(fade = 0.08): void {
    if (!this.render || this.playing) return;
    if (!this.unlock()) return;
    this.startVoices(this.pausedFrame, fade);
  }

  stop(fade = 0.25): void {
    this.cancelSwitchTimer();
    if (!this.playing) return;
    const ctx = this.ctx!;
    const at = ctx.currentTime + fade;
    for (const node of this.nodes) {
      node.startFade.gain.cancelScheduledValues(ctx.currentTime);
      node.startFade.gain.setValueAtTime(node.startFade.gain.value, ctx.currentTime);
      node.startFade.gain.linearRampToValueAtTime(0, at);
      for (const part of node.parts) part.source.stop(at);
    }
    this.pausedFrame = this.positionFrames;
    this.nodes = [];
    this.playing = false;
  }

  seek(frame: number): void {
    this.cancelSwitchTimer();
    const render = this.render;
    if (!render) return;
    const target = Math.max(0, Math.min(render.frames - 1, frame));
    if (this.playing) {
      this.startVoices(target, 0.02);
    } else {
      this.pausedFrame = target;
    }
  }

  /**
   * oh-my-bot 修改：仅自建 context 才 close；共享 context 的生命周期归宿主（音效引擎），
   * 这里只断开自己的输出节点。
   */
  dispose(): void {
    this.stop(0.01);
    const ctx = this.ctx;
    this.ctx = null;
    if (!ctx) return;
    if (this.ownsContext) void ctx.close();
    else this.master?.disconnect();
  }

  /** Absolute audio-context time of the next bar, with at least 50ms lead. */
  nextBarTime(): number {
    const render = this.render;
    if (!render) return 0;
    return this.gridTime(render.frames / render.sampleRate / render.bars);
  }

  /**
   * Absolute audio-context time of the next grid line (beat/bar/step), with at
   * least 50ms of scheduling lead. Derived purely from `AudioContext.currentTime`,
   * the loop origin and the tempo, so it never drifts from the audio clock.
   */
  gridTime(gridSeconds: number): number {
    const render = this.render;
    const ctx = this.ctx;
    if (!render || !ctx) return 0;
    const origin = this.playing ? this.startedAt : ctx.currentTime - this.pausedFrame / render.sampleRate;
    const steps = Math.floor((ctx.currentTime + 0.05 - origin) / gridSeconds) + 1;
    return origin + steps * gridSeconds;
  }

  private cancelSwitchTimer(): void {
    if (this.switchTimer !== null) clearTimer(this.switchTimer);
    this.switchTimer = null;
    this.pending = null;
  }

  private startVoices(startFrame: number, fade: number): void {
    this.cancelSwitchTimer();
    const render = this.render;
    if (!render) return;
    const ctx = this.unlock();
    if (!ctx) return;
    const when = ctx.currentTime + 0.02;
    const offset = startFrame / render.sampleRate;

    // Retire whatever is currently sounding.
    for (const node of this.nodes) {
      node.startFade.gain.cancelScheduledValues(ctx.currentTime);
      node.startFade.gain.setValueAtTime(node.startFade.gain.value, ctx.currentTime);
      node.startFade.gain.linearRampToValueAtTime(0, when + fade);
      for (const part of node.parts) part.source.stop(when + fade);
    }

    const buffers = this.buffersFor(render);
    const nodes: VoiceNodes[] = [];
    const loopSeconds = render.frames / render.sampleRate;
    render.voices.forEach((voice, index) => {
      const parts: PartNodes[] = [];
      const startFade = ctx.createGain();
      startFade.gain.value = 0;
      startFade.gain.setValueAtTime(0, when);
      startFade.gain.linearRampToValueAtTime(1, when + fade);
      const level = ctx.createGain();
      const panner = ctx.createStereoPanner();
      const space = ctx.createGain();
      const echo = ctx.createGain();

      // Slow auto-pan, one cycle per loop so it never feels like a sweep effect.
      // Each voice gets a slightly different rate, so they never move together.
      const drift = ctx.createGain();
      drift.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = (1 / loopSeconds) * (1 + index * 0.07);
      lfo.connect(drift).connect(panner.pan);
      lfo.start(when);

      startFade.connect(level).connect(panner).connect(this.bus as GainNode);
      level.connect(space).connect(this.spaceIn as GainNode);
      level.connect(echo).connect(this.echoIn as GainNode);

      voice.stages.forEach((stem, stageIndex) => {
        const buffer = buffers[index]?.[stageIndex];
        if (!stem || !buffer) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.loopStart = 0;
        source.loopEnd = loopSeconds;
        const gain = ctx.createGain();
        // Only the selected stage is open; the rest are already running silently
        // so that a switch is a ramp and not a start.
        const initial = stem.stage === this.stage ? stem.gain : 0;
        gain.gain.value = initial;
        source.connect(gain).connect(startFade);
        source.start(when, offset);
        parts.push({
          stage: stem.stage, source, gain, level: stem.gain,
          ramp: { from: initial, to: initial, start: when, end: when },
        });
      });

      const cleanup = () => {
        lfo.stop();
        for (const node of [lfo, drift, startFade, level, panner, space, echo]) node.disconnect();
        for (const part of parts) part.gain.disconnect();
      };
      if (parts.length > 0) (parts[0] as PartNodes).source.onended = cleanup;

      nodes.push({ parts, startFade, level, panner, space, echo, drift, lfo });
    });

    this.nodes = nodes;
    this.startedAt = when - offset;
    this.pausedFrame = startFrame;
    this.playing = true;
    this.applyMix();
  }

  private applyMix(): void {
    this.nodes.forEach((node, index) => {
      const mix = this.mix[index];
      const lead = this.render?.voices[index]?.id === 'lead';
      node.level.gain.value = mix ? mix.gain : 1;
      node.panner.pan.value = lead ? 0 : mix ? mix.pan : 0;
      node.space.gain.value = mix ? mix.space : 0;
      node.echo.gain.value = mix ? mix.echo : 0;
      node.drift.gain.value = mix && !lead ? DRIFT_BASE * (mix.space > 0.02 ? 1 : 0) + mix.space * DRIFT_PER_SPACE : 0;
    });
  }

  private buffersFor(render: SongRender): AudioBuffer[][] {
    const cached = this.buffers.get(render);
    if (cached) return cached;
    const ctx = this.ctx as AudioContext;
    const buffers = render.voices.map((voice) =>
      voice.stages.map((stem) => {
        if (!stem) return null as unknown as AudioBuffer;
        let buffer = this.stemBuffers.get(stem.stem);
        if (!buffer || buffer.length !== render.frames || buffer.sampleRate !== render.sampleRate) {
          buffer = ctx.createBuffer(1, render.frames, render.sampleRate);
          buffer.getChannelData(0).set(stem.stem);
          this.stemBuffers.set(stem.stem, buffer);
        }
        return buffer;
      }),
    );
    this.buffers.set(render, buffers);
    return buffers;
  }
}

/**
 * Generated impulse response: two decorrelated noise tails with a soft build,
 * a gentle lowpass and a few early reflections for the metal of a station wall.
 * Normalized to unit energy, so a send of 1 is roughly as loud as the dry voice.
 */
function createSpaceImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const frames = Math.max(1, Math.floor(seconds * rate));
  const impulse = ctx.createBuffer(2, frames, rate);
  const early: [number, number][] = [
    [11, 0.5],
    [19, 0.38],
    [29, 0.3],
    [41, 0.24],
    [57, 0.18],
    [73, 0.12],
  ];

  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    let state = (0x9e3779b9 ^ (channel * 0x85ebca6b)) >>> 0;
    const noise = () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return (state / 0xffffffff) * 2 - 1;
    };
    const decay = channel === 0 ? 6.4 : 6.9;
    const build = Math.max(1, Math.round(0.018 * rate));
    let lowpassed = 0;
    for (let i = 0; i < frames; i++) {
      const t = i / frames;
      lowpassed += (noise() - lowpassed) * 0.4;
      const swell = i < build ? i / build : 1;
      data[i] = lowpassed * swell * Math.exp(-t * decay);
    }
    for (const [millis, gain] of early) {
      const index = Math.round(((millis + channel * 6) * rate) / 1000);
      if (index < frames) data[index]! += gain * (channel === 0 ? 1 : -1);
    }

    let energy = 0;
    for (let i = 0; i < frames; i++) energy += data[i]! * data[i]!;
    const scale = 1 / Math.sqrt(Math.max(1e-9, energy) * 2);
    for (let i = 0; i < frames; i++) data[i]! *= scale;
  }

  return impulse;
}

/** Identity below the knee, tanh above it: a ceiling that never clips. */
function softCeiling(knee = 0.85) {
  const size = 4096;
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    const magnitude = Math.abs(x);
    const y =
      magnitude <= knee ? magnitude : knee + (1 - knee) * Math.tanh((magnitude - knee) / (1 - knee));
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}
