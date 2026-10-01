/**
 * Tune -> per-(voice, stage) float stems.
 *
 * The render is sample-exact: steps are laid out across the loop length with a
 * single division, so there is no tempo drift and no rounding gap at the loop
 * point. Three extra tricks keep the loop seamless:
 *
 *  1. every part is rendered into a buffer that is `tail` frames longer than the
 *     loop; that tail is then folded back onto the head, so releases, pitch
 *     sweeps and percussion decays that run past the loop point reappear at the
 *     start of the next iteration instead of being cut off.
 *  2. a DC blocker runs before the fold, so the loop never carries an offset
 *     into the game's mixer.
 *  3. because every stage shares one sample grid, a stem from any stage lines up
 *     with a stem from any other stage, sample for sample. That is what makes
 *     the six cross-stage transitions possible: the player never re-schedules
 *     anything, it only changes gains.
 */

import { notesFromTokens, tokenizePattern } from './pattern';
import { renderVoice, voiceTailSeconds, type ScheduledNote } from './synth';
import { clamp } from './music';
import { loopSeconds, loopSteps, type SongSpec, type StageId } from './types';

/** Corner frequency of the DC blocker, in Hz. */
const DC_BLOCK_HZ = 8;

export interface StageStem {
  stage: StageId;
  /** Design level of this part inside its stage. */
  gain: number;
  /** Mono stem, exactly `frames` long. */
  stem: Float32Array;
  notes: ScheduledNote[];
  peak: number;
  rms: number;
}

export interface VoiceRender {
  id: string;
  label: string;
  color: string;
  /** Aligned to `SongSpec.stages`; null where the voice rests. */
  stages: (StageStem | null)[];
}

/**
 * Peak headroom for the dry mix. Kept below the soft ceiling's knee so the
 * reverb and echo returns have room to add without hitting it.
 */
const DRY_HEADROOM = 0.88;

export interface SongRender {
  songId: string;
  sampleRate: number;
  frames: number;
  seconds: number;
  bpm: number;
  swing: number;
  steps: number;
  stepFrames: number;
  stepsPerBeat: number;
  beatsPerBar: number;
  bars: number;
  tailSeconds: number;
  stages: StageId[];
  voices: VoiceRender[];
  /** Peak of the loudest stage, summed at its design gains. */
  mixPeak: number;
  /** Per-stage peaks, for the arrangement readout. */
  stagePeak: number[];
  /** Fixed safety trim so no stage clips the output bus. */
  headroom: number;
}

export interface RenderOptions {
  tailSeconds?: number;
}

/** Lay one pattern out on the loop grid. Shared by every voice and stage. */
function layoutPattern(
  pattern: string[],
  where: string,
  steps: number,
  frameAt: (step: number) => number,
  chord: number[],
): ScheduledNote[] {
  const blocks = pattern.map((block) => {
    const tokens = tokenizePattern(block, where);
    if (tokens.length === 0) throw new Error(`${where}: empty pattern block`);
    return tokens;
  });
  // Every block of one part must be the same length, or a bar would silently
  // straddle two lines and the whole grid would drift.
  const width = blocks[0]?.length ?? 0;
  const ragged = blocks.findIndex((tokens) => tokens.length !== width);
  if (ragged >= 0) {
    throw new Error(
      `${where}: block ${ragged + 1} has ${blocks[ragged]?.length} tokens, but block 1 has ${width}`,
    );
  }
  const flat = blocks.flat();
  if (steps % flat.length !== 0) {
    throw new Error(`${where}: pattern has ${flat.length} steps, which does not divide the loop's ${steps}`);
  }
  const notes = notesFromTokens(flat);
  const reps = steps / flat.length;
  const out: ScheduledNote[] = [];
  for (let rep = 0; rep < reps; rep++) {
    const base = rep * flat.length;
    for (const note of notes) {
      const startFrame = Math.round(frameAt(base + note.start));
      const endFrame = Math.round(frameAt(base + note.end));
      const gateFrames = Math.max(1, endFrame - startFrame);
      // Chords are expanded here rather than in the synth, so the notes exist as
      // real pitches for the roll, the labels and the tail calculation.
      for (const offset of chord) out.push({ startFrame, gateFrames, midi: note.midi + offset });
    }
  }
  return out;
}

/** Score as [voice][stage], null where the voice rests in that stage. */
export function buildScore(song: SongSpec, loopFrames: number): (ScheduledNote[] | null)[][] {
  const steps = loopSteps(song);
  const stepFrames = loopFrames / steps;
  const swing = clamp(song.swing ?? 0, 0, 0.6);
  const frameAt = (step: number) =>
    Math.min(loopFrames, step * stepFrames + (step % 2 === 1 ? swing * stepFrames : 0));

  return song.voices.map((voice) => {
    const chord = voice.instrument.chord?.length ? voice.instrument.chord : [0];
    return song.stages.map((stage) => {
      const part = voice.parts[stage.id];
      if (!part) return null;
      const pitches = chord.map((offset) => offset + (voice.transpose ?? 0));
      return layoutPattern(part.pattern, `${song.id}/${voice.id}/${stage.id}`, steps, frameAt, pitches);
    });
  });
}

export function defaultTailSeconds(song: SongSpec): number {
  return Math.max(0.3, ...song.voices.map((v) => voiceTailSeconds(v.instrument)));
}

/** One-pole DC blocker; keeps long pulse runs from eating headroom in game mixers. */
function dcBlock(buf: Float32Array, sampleRate: number): void {
  const r = 1 - (DC_BLOCK_HZ * 2 * Math.PI) / sampleRate;
  let x1 = buf.length > 0 ? (buf[0] as number) : 0;
  let y1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i] as number;
    const y = x - x1 + r * y1;
    x1 = x;
    y1 = y;
    buf[i] = y;
  }
}

function stats(stem: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < stem.length; i++) {
    const v = stem[i] as number;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  return { peak, rms: Math.sqrt(sumSq / Math.max(1, stem.length)) };
}

export function renderSong(song: SongSpec, sampleRate: number, options: RenderOptions = {}): SongRender {
  const steps = loopSteps(song);
  const frames = Math.max(steps, Math.round(loopSeconds(song) * sampleRate));
  const tailSeconds = options.tailSeconds ?? defaultTailSeconds(song);
  const tailFrames = Math.max(1, Math.round(tailSeconds * sampleRate));
  const score = buildScore(song, frames);

  const voices: VoiceRender[] = song.voices.map((voice, voiceIndex) => {
    // A part repeated verbatim across stages (the pad) is one piece of audio:
    // render it once and let the stages share the stem.
    const rendered = new Map<string, StageStem>();
    return {
      id: voice.id,
      label: voice.label,
      color: voice.color,
      stages: song.stages.map((stage, stageIndex) => {
        const part = voice.parts[stage.id];
        const notes = score[voiceIndex]?.[stageIndex] ?? null;
        if (!part || !notes) return null;

        const key = `${part.gain}\u0000${part.pattern.join('\u0000')}`;
        const already = rendered.get(key);
        if (already) return { ...already, stage: stage.id };

        const buf = new Float32Array(frames + tailFrames);
        for (const note of notes) renderVoice(buf, sampleRate, voice.instrument, note);
        dcBlock(buf, sampleRate);
        // Fold the tail back onto the head: a release that runs past the loop
        // point reappears at the start of the next iteration instead of being cut.
        for (let f = 0; f < tailFrames; f++) {
          buf[f] = (buf[f] as number) + (buf[frames + f] as number);
        }
        const stem = buf.slice(0, frames);
        const built: StageStem = { stage: stage.id, gain: part.gain, stem, notes, ...stats(stem) };
        rendered.set(key, built);
        return built;
      }),
    };
  });

  // Worst case per stage: every voice of that stage at its design gain. Fixed per
  // render, so muting, fading or switching stages never makes the trim pump.
  // A normalized linear crossfade is a convex combination of stage mixes.
  // Its absolute dry peak cannot exceed the largest stage peak; effects and
  // user trims are separate and are not covered by this dry-mix bound.
  const stagePeak = song.stages.map((_stage, stageIndex) => {
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (const voice of voices) {
        const stem = voice.stages[stageIndex];
        if (stem) sum += (stem.stem[i] as number) * stem.gain;
      }
      const a = sum < 0 ? -sum : sum;
      if (a > peak) peak = a;
    }
    return peak;
  });
  const mixPeak = Math.max(0, ...stagePeak);

  return {
    songId: song.id,
    sampleRate,
    frames,
    seconds: frames / sampleRate,
    bpm: song.bpm,
    swing: song.swing ?? 0,
    steps,
    stepFrames: frames / steps,
    stepsPerBeat: song.stepsPerBeat,
    beatsPerBar: song.beatsPerBar,
    bars: song.bars,
    tailSeconds,
    stages: song.stages.map((s) => s.id),
    voices,
    mixPeak,
    stagePeak,
    headroom: mixPeak > 0 ? Math.min(2.2, DRY_HEADROOM / mixPeak) : 1,
  };
}

/** Find the note sounding at `frame` on one voice (notes are sorted by start). */
export function noteAt(notes: ScheduledNote[], frame: number): ScheduledNote | null {
  let best: ScheduledNote | null = null;
  for (const note of notes) {
    if (note.startFrame > frame) break;
    if (frame < note.startFrame + note.gateFrames) best = note;
  }
  return best;
}
