/** Instrument presets, so song files stay about music instead of numbers. */

import type { InstrumentSpec } from './types.ts';

/** Square lead / harmony. */
export function pulse(overrides: Partial<InstrumentSpec> = {}): InstrumentSpec {
  return {
    wave: 'pulse',
    duty: 0.5,
    volume: 0.3,
    attack: 0.004,
    decay: 0.1,
    sustain: 0.5,
    release: 0.05,
    ...overrides,
  };
}

/** Pulse with a fast arpeggio, the classic 8-bit "chord" voice. */
export function arpPulse(arp: number[] = [0, 4, 7], overrides: Partial<InstrumentSpec> = {}): InstrumentSpec {
  return pulse({
    duty: 0.25,
    volume: 0.3,
    decay: 0.05,
    sustain: 0.22,
    release: 0.04,
    arp,
    arpRate: 1 / 60,
    ...overrides,
  });
}

/** Sustain-only triangle, the bass voice. */
export function bass(overrides: Partial<InstrumentSpec> = {}): InstrumentSpec {
  return {
    wave: 'triangle',
    volume: 0.5,
    attack: 0.006,
    decay: 0,
    sustain: 1,
    release: 0.02,
    ...overrides,
  };
}

/** Triangle with a fast downward pitch sweep: the kick drum. */
export function kick(overrides: Partial<InstrumentSpec> = {}): InstrumentSpec {
  return {
    wave: 'triangle',
    volume: 1,
    attack: 0.001,
    decay: 0.075,
    sustain: 0,
    release: 0.04,
    // Notes are written an octave up (c4) so the sweep starts with a click.
    slide: { semitones: -24, time: 0.05 },
    ...overrides,
  };
}

/**
 * Detuned pulse stack with a slow swell: the chord bed. The long release is what
 * makes it hang over the loop point instead of stopping at the bar line.
 * The default voicing is root / fifth / octave / ninth — open enough to sit
 * under any diatonic chord, so one pad voice can carry a whole progression.
 */
export function pad(overrides: Partial<InstrumentSpec> = {}): InstrumentSpec {
  return {
    wave: 'pulse',
    duty: 0.5,
    volume: 0.13,
    attack: 0.32,
    decay: 1.3,
    sustain: 0.58,
    release: 0.85,
    unison: 2,
    detune: 14,
    vibrato: { rate: 0.18, depth: 7 },
    // Root / octave / twelfth: two octaves of open fifth, no thirds. Everything
    // harmonically specific is left to the riff, which is what keeps the low
    // middle clear and the top of the chord wide open.
    chord: [0, 7, 12],
    ...overrides,
  };
}

/** 6-bit LFSR noise, longer and softer: a snare lost in a big room. */
export function snare(overrides: Partial<InstrumentSpec> = {}): InstrumentSpec {
  return {
    wave: 'noise',
    noiseMode: 'metal',
    noiseScale: 10,
    volume: 0.34,
    attack: 0.0008,
    decay: 0.085,
    sustain: 0,
    release: 0.04,
    slide: { semitones: -9, time: 0.04 },
    ...overrides,
  };
}

/** 15-bit LFSR noise, short decay: hi-hat / shaker. */
export function hat(overrides: Partial<InstrumentSpec> = {}): InstrumentSpec {
  return {
    wave: 'noise',
    noiseMode: 'white',
    noiseScale: 22,
    volume: 0.27,
    attack: 0.002,
    decay: 0.028,
    sustain: 0,
    release: 0.02,
    ...overrides,
  };
}
