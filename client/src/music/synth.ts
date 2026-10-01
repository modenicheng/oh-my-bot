/**
 * Software chip synth: renders one scheduled note into a float buffer.
 *
 * Everything is done by hand (no Web Audio nodes) for three reasons:
 *  - the same code path runs in the browser, in a worker and in Node
 *  - the loop length is exact to the sample, so it never drifts
 *  - NES-ish waveform quirks (16-step triangle, LFSR noise) are easy to keep
 */

import { clamp, midiToFreq } from './music.ts';
import type { InstrumentSpec } from './types.ts';

const TAU = Math.PI * 2;

export interface ScheduledNote {
  /** Frame offset from the loop start. */
  startFrame: number;
  /** Frames the note is held open. */
  gateFrames: number;
  midi: number;
}

/** Seconds of tail a voice needs after its last note (release, pitch sweep). */
export function voiceTailSeconds(inst: InstrumentSpec): number {
  return (inst.release ?? 0.02) + (inst.slide?.time ?? 0) + 0.05;
}

/**
 * Additively render `note` into `out` (mono, `sampleRate`). Notes may run past
 * the loop point and into the tail region; the caller folds that tail back.
 */
export function renderVoice(
  out: Float32Array,
  sampleRate: number,
  inst: InstrumentSpec,
  note: ScheduledNote,
): void {
  const start = note.startFrame;
  const volume = inst.volume ?? 0.25;
  if (volume <= 0 || start >= out.length || start < 0) return;

  const sr = sampleRate;
  const attackF = Math.max(1, Math.round((inst.attack ?? 0.002) * sr));
  const decayF = Math.max(0, Math.round((inst.decay ?? 0.06) * sr));
  const releaseF = Math.max(1, Math.round((inst.release ?? 0.02) * sr));
  const sustain = clamp(inst.sustain ?? 0, 0, 1);
  const gate = Math.max(1, note.gateFrames);
  const end = Math.min(out.length - start, gate + releaseF + 1);
  if (end <= 0) return;

  const arp = inst.arp && inst.arp.length > 0 ? inst.arp : null;
  const arpFrames = arp ? Math.max(1, Math.round((inst.arpRate ?? 1 / 60) * sr)) : gate;
  const segments = arp ? Math.max(1, Math.ceil(gate / arpFrames)) : 1;
  const declickF = Math.max(1, Math.round(sr * 0.0008));

  const vibDepth = inst.vibrato?.depth ?? 0;
  const vibRate = inst.vibrato?.rate ?? 5;
  const slideTarget = inst.slide ? Math.pow(2, inst.slide.semitones / 12) : 1;
  const slideFrames = inst.slide ? Math.max(1, Math.round(inst.slide.time * sr)) : 1;
  const slideStep = inst.slide ? Math.pow(slideTarget, 1 / slideFrames) : 1;

  const noise = inst.wave === 'noise';
  const metal = inst.noiseMode === 'metal';
  const noiseScale = inst.noiseScale ?? 16;
  const duty = clamp(inst.duty ?? 0.5, 0.0625, 0.9375);
  const tap = metal ? 6 : 1;

  let slideMul = 1;
  let gateLevel = -1;
  let lfsr = 0x7fff;
  let noiseAcc = 0;
  let noiseBit = 1;
  // Vibrato is a slow LFO: recomputing sin/pow every sample is pure waste, so
  // it steps every VIBRATO_STEP samples (inaudible at these rates and depths).
  const VIBRATO_STEP = 15;
  let vibratoMul = vibDepth !== 0 ? Math.pow(2, (vibDepth * Math.sin(0)) / 1200) : 1;

  // Unison: stack detuned copies of the same note. Detuning beats against itself,
  // which is what gives pads their width and slow movement. Noise stays single.
  const copies = noise ? 1 : Math.max(1, Math.min(4, Math.round(inst.unison ?? 1)));
  const spread = copies > 1 ? (inst.detune ?? 12) : 0;
  const phases = new Float32Array(copies);
  const detunes = new Float32Array(copies);
  for (let c = 0; c < copies; c++) {
    detunes[c] = copies > 1 ? Math.pow(2, (spread * (c / (copies - 1) - 0.5)) / 1200) : 1;
    phases[c] = c * 0.37; // decorrelated start, so the stack blooms instead of stacking
  }
  const copyGain = copies > 1 ? 1 / Math.sqrt(copies) : 1;
  const isPulse = inst.wave === 'pulse';

  for (let s = 0; s < segments; s++) {
    const t0 = s * arpFrames;
    if (t0 >= end) break;
    const t1 = s === segments - 1 ? end : Math.min(end, t0 + arpFrames);
    const baseFreq = midiToFreq(note.midi + (arp ? arp[s % arp.length] : 0));
    const first = s === 0;

    for (let i = 0, n = t1 - t0; i < n; i++) {
      const t = t0 + i;

      let level: number;
      if (t < attackF) {
        level = t / attackF;
      } else if (decayF > 0 && t < attackF + decayF) {
        level = 1 - (1 - sustain) * ((t - attackF) / decayF);
      } else {
        level = sustain;
      }
      if (t >= gate) {
        if (gateLevel < 0) gateLevel = level;
        const rt = t - gate;
        level = rt >= releaseF ? 0 : gateLevel * (1 - rt / releaseF);
      }
      if (first && i < declickF) level *= i / declickF;

      if (level > 0) {
        let freq = baseFreq * slideMul;
        if (vibDepth !== 0) {
          if ((t & VIBRATO_STEP) === 0) {
            vibratoMul = Math.pow(2, (vibDepth * Math.sin(TAU * vibRate * (t / sr))) / 1200);
          }
          freq *= vibratoMul;
        }

        let sample = 0;
        if (noise) {
          noiseAcc += (freq * noiseScale) / sr;
          while (noiseAcc >= 1) {
            noiseAcc -= 1;
            const bit = ((lfsr >> 0) ^ (lfsr >> tap)) & 1;
            lfsr = (lfsr >> 1) | (bit << 14);
            noiseBit = bit;
          }
          sample = noiseBit ? 1 : -1;
        } else {
          for (let c = 0; c < copies; c++) {
            let p = phases[c] + (freq * detunes[c]) / sr;
            if (p >= 1) p -= Math.floor(p);
            phases[c] = p;
            if (isPulse) {
              sample += p < duty ? 1 : -1;
            } else {
              // 32-step, 16-level triangle, like the NES APU
              const q = p * 32;
              sample += ((q < 16 ? q : 32 - q) / 16) * 2 - 1;
            }
          }
          sample *= copyGain;
        }

        out[start + t] += sample * level * volume;
      }

      if (slideMul !== slideTarget) {
        slideMul *= slideStep;
        if (slideTarget >= 1 ? slideMul >= slideTarget : slideMul <= slideTarget) slideMul = slideTarget;
      }
    }
  }
}
