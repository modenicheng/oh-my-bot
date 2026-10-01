/**
 * Live tuning: the knobs the UI exposes, and how they map onto a song.
 *
 * Two tiers, on purpose:
 *  - `mix` knobs (gain, pan, mute, solo) only touch playback nodes, so they are
 *    instant and never interrupt the loop.
 *  - `synth` knobs (bpm, swing, transpose, duty, decay, sustain, arp) change the
 *    rendered audio, so they trigger a re-render in the worker.
 */

import type { SongSpec, VoiceSpec } from './types.ts';

export interface VoiceTune {
  gain: number;
  pan: number;
  /** Reverb send. */
  space: number;
  /** Ping-pong echo send. */
  echo: number;
  mute: boolean;
  solo: boolean;
  transpose: number;
  duty: number;
  decay: number;
  sustain: number;
  arp: boolean;
  noiseMode: 'white' | 'metal';
  noiseScale: number;
}

export interface Tune {
  bpm: number;
  swing: number;
  volume: number;
  /** Reverb return. */
  space: number;
  /** Echo return. */
  echo: number;
  voices: VoiceTune[];
}

export interface VoiceMix {
  gain: number;
  pan: number;
  space: number;
  echo: number;
}

export interface Range {
  min: number;
  max: number;
  step: number;
}

export const RANGES = {
  bpm: { min: 60, max: 220, step: 1 },
  swing: { min: 0, max: 0.4, step: 0.005 },
  volume: { min: 0, max: 1, step: 0.01 },
  gain: { min: 0, max: 1.4, step: 0.01 },
  pan: { min: -1, max: 1, step: 0.02 },
  space: { min: 0, max: 1, step: 0.01 },
  echo: { min: 0, max: 1, step: 0.01 },
  spaceReturn: { min: 0, max: 1.4, step: 0.01 },
  echoReturn: { min: 0, max: 1.4, step: 0.01 },
  transpose: { min: -24, max: 24, step: 1 },
  duty: { min: 0.125, max: 0.75, step: 0.125 },
  decay: { min: 0.01, max: 0.6, step: 0.005 },
  sustain: { min: 0, max: 1, step: 0.01 },
  noiseScale: { min: 4, max: 40, step: 1 },
} as const satisfies Record<string, Range>;

export function defaultTune(song: SongSpec): Tune {
  return {
    bpm: song.bpm,
    swing: song.swing ?? 0,
    volume: 0.8,
    space: 1,
    echo: 0.8,
    voices: song.voices.map((voice) => ({
      // The design level now lives per stage in `voice.parts`; this is the user's
      // trim on top of it, so 1 means "exactly as arranged".
      gain: 1,
      pan: voice.pan ?? 0,
      space: voice.space ?? 0,
      echo: voice.echo ?? 0,
      mute: false,
      solo: false,
      transpose: voice.transpose ?? 0,
      duty: voice.instrument.duty ?? 0.5,
      decay: voice.instrument.decay ?? 0.06,
      sustain: voice.instrument.sustain ?? 0,
      arp: (voice.instrument.arp?.length ?? 0) > 0,
      noiseMode: voice.instrument.noiseMode ?? 'white',
      noiseScale: voice.instrument.noiseScale ?? 16,
    })),
  };
}

/** Bake the synth-tier knobs into a song the renderer can just play. */
export function resolveSong(song: SongSpec, tune: Tune): SongSpec {
  const voices: VoiceSpec[] = song.voices.map((voice, index) => {
    const t = tune.voices[index];
    if (!t) return voice;
    return {
      ...voice,
      transpose: t.transpose,
      instrument: {
        ...voice.instrument,
        duty: voice.instrument.wave === 'pulse' ? t.duty : voice.instrument.duty,
        decay: t.decay,
        sustain: t.sustain,
        arp: t.arp ? (voice.instrument.arp ?? DEFAULT_ARP) : undefined,
        noiseMode: voice.instrument.wave === 'noise' ? t.noiseMode : voice.instrument.noiseMode,
        noiseScale: voice.instrument.wave === 'noise' ? t.noiseScale : voice.instrument.noiseScale,
      },
    };
  });
  return { ...song, bpm: tune.bpm, swing: tune.swing, voices };
}

const DEFAULT_ARP = [0, 4, 7];

/** Everything that forces a re-render, as a stable string. */
export function synthKey(tune: Tune): string {
  return [
    tune.bpm.toFixed(3),
    tune.swing.toFixed(4),
    ...tune.voices.map(
      (v) => `${v.transpose}/${v.duty}/${v.decay}/${v.sustain}/${v.arp ? 1 : 0}/${v.noiseMode}${v.noiseScale}`,
    ),
  ].join('|');
}

/** Effective playback gain, pan and sends per voice, after solo/mute. */
export function voiceMix(tune: Tune): VoiceMix[] {
  const anySolo = tune.voices.some((v) => v.solo);
  return tune.voices.map((v) => {
    const silent = v.mute || (anySolo && !v.solo);
    return {
      gain: silent ? 0 : v.gain,
      pan: v.pan,
      space: silent ? 0 : v.space,
      echo: silent ? 0 : v.echo,
    };
  });
}
