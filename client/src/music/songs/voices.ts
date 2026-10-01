/** Ten complementary roles for v3.1. Harmony stays explicit in the score. */
import { bass, hat, kick, pad, pulse, snare } from '../instruments';
import type { InstrumentSpec, StageId, VoicePart, VoiceSpec } from '../types';

export const VOICE_COLORS = { lead: '#e0452b', riff: '#c85b9e', harmony: '#dfa32b', pad: '#6f9de0', bass: '#46a3b4', kick: '#b07a4a', snare: '#bdb6a6', hat: '#8fae3e', chord: '#ad88d6', perc: '#5ab993' } as const;
export type Parts = Partial<Record<StageId, VoicePart>>;
export function shared(pattern: string[], gain: number): Parts {
  return { title: { gain, pattern }, arena: { gain, pattern }, final: { gain, pattern } };
}
export function parts(spec: Partial<Record<StageId, [string[], number]>>): Parts {
  const out: Parts = {};
  for (const [stage, value] of Object.entries(spec) as [StageId, [string[], number]][]) {
    out[stage] = { pattern: value[0], gain: value[1] };
  }
  return out;
}
interface Options { instrument?: Partial<InstrumentSpec>; pan?: number; space?: number; echo?: number }

export function leadVoice(spec: Parts, options: Options = {}): VoiceSpec {
  return { id: 'lead', label: 'PULSE 1', color: VOICE_COLORS.lead, parts: spec,
    instrument: pulse({ duty: 0.5, volume: 0.19, attack: 0.008, decay: 0.14, sustain: 0.42, release: 0.075, vibrato: { rate: 4.5, depth: 4 }, ...options.instrument }),
    pan: options.pan ?? 0, space: options.space ?? 0.12, echo: options.echo ?? 0.28 };
}
export function riffVoice(spec: Parts, options: Options = {}): VoiceSpec {
  return { id: 'riff', label: 'RIFF', color: VOICE_COLORS.riff, parts: spec,
    instrument: pulse({ duty: 0.25, volume: 0.15, attack: 0.004, decay: 0.085, sustain: 0.07, release: 0.04, ...options.instrument }),
    pan: options.pan ?? 0.46, space: options.space ?? 0.1, echo: options.echo ?? 0.1 };
}
export function harmonyVoice(spec: Parts, options: Options = {}): VoiceSpec {
  return { id: 'harmony', label: 'SHIMMER', color: VOICE_COLORS.harmony, parts: spec,
    instrument: pulse({ duty: 0.25, volume: 0.115, attack: 0.004, decay: 0.09, sustain: 0.03, release: 0.11, ...options.instrument }),
    pan: options.pan ?? -0.5, space: options.space ?? 0.22, echo: options.echo ?? 0.3 };
}
export function padVoice(spec: Parts, options: Options = {}): VoiceSpec {
  return { id: 'pad', label: 'PAD', color: VOICE_COLORS.pad, parts: spec,
    // Two open notes, with a full beat of breathing room before each change.
    instrument: pad({ volume: 0.115, attack: 0.1, decay: 0.35, sustain: 0.56, release: 0.18, chord: [0, 7], unison: 2, detune: 7, vibrato: { rate: 0.2, depth: 3 }, ...options.instrument }),
    pan: options.pan ?? 0.12, space: options.space ?? 0.18, echo: options.echo ?? 0.015 };
}
export function bassVoice(spec: Parts, options: Options = {}): VoiceSpec {
  return { id: 'bass', label: 'TRIANGLE', color: VOICE_COLORS.bass, parts: spec,
    instrument: bass({ volume: 0.4, attack: 0.005, decay: 0.08, sustain: 0.82, release: 0.035, ...options.instrument }),
    pan: options.pan ?? 0, space: options.space ?? 0, echo: options.echo ?? 0 };
}
export function kickVoice(spec: Parts, options: Options = {}): VoiceSpec {
  return { id: 'kick', label: 'KICK', color: VOICE_COLORS.kick, parts: spec,
    instrument: kick({ volume: 0.87, decay: 0.09, release: 0.025, ...options.instrument }),
    pan: options.pan ?? 0, space: options.space ?? 0, echo: options.echo ?? 0 };
}
export function snareVoice(spec: Parts, options: Options = {}): VoiceSpec {
  return { id: 'snare', label: 'SNARE', color: VOICE_COLORS.snare, parts: spec,
    instrument: snare({ volume: 0.23, noiseMode: 'white', decay: 0.065, release: 0.025, ...options.instrument }),
    pan: options.pan ?? 0.12, space: options.space ?? 0.06, echo: options.echo ?? 0 };
}
export function hatVoice(spec: Parts, options: Options = {}): VoiceSpec {
  return { id: 'hat', label: 'HAT', color: VOICE_COLORS.hat, parts: spec,
    instrument: hat({ volume: 0.16, decay: 0.019, release: 0.014, ...options.instrument }),
    pan: options.pan ?? 0.5, space: options.space ?? 0.08, echo: options.echo ?? 0 };
}

/** A quiet third/seventh voice: pad supplies the root/fifth, not another pad. */
export function chordVoice(spec: Parts, options: Options = {}): VoiceSpec {
  return { id: 'chord', label: 'HARMONY', color: VOICE_COLORS.chord, parts: spec,
    instrument: pulse({ duty: 0.5, volume: 0.13, attack: 0.016, decay: 0.16, sustain: 0.3, release: 0.075, ...options.instrument }),
    pan: options.pan ?? -0.34, space: options.space ?? 0.13, echo: options.echo ?? 0.08 };
}

/** Short, low-level rim/noise taps, separate from the main snare backbeat. */
export function percVoice(spec: Parts, options: Options = {}): VoiceSpec {
  return { id: 'perc', label: 'PERC', color: VOICE_COLORS.perc, parts: spec,
    instrument: snare({ volume: 0.13, noiseMode: 'metal', noiseScale: 8, attack: 0.001, decay: 0.028, sustain: 0, release: 0.016, slide: { semitones: -4, time: 0.018 }, ...options.instrument }),
    pan: options.pan ?? -0.42, space: options.space ?? 0.04, echo: options.echo ?? 0.025 };
}
