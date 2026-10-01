/**
 * Stage-layer + voice data model.
 *
 * A tune is *one* 8-bar loop. It is not three songs: it is a single harmonic
 * grid with three stages stacked on it. Every voice may carry a different part
 * per stage (`parts`), and the stage you hear is chosen purely by gain — all
 * parts play all the time, so any stage can become any other at a bar line with
 * nothing to restart and nothing to lose phase with.
 *
 * Patterns are written as token strings, one token per step (default: a 16th
 * note). See pattern.ts for the token grammar.
 */

export type Waveform = 'pulse' | 'triangle' | 'noise';

export type StageId = 'title' | 'arena' | 'final';

export interface StageSpec {
  id: StageId;
  label: string;
  /** One phrase for the stage button. */
  tag: string;
  /** One line for the stage panel. */
  blurb: string;
  /** UI accent for this stage. */
  color: string;
}

export interface VibratoSpec {
  /** LFO rate in Hz. */
  rate: number;
  /** Peak deviation in cents. */
  depth: number;
}

export interface SlideSpec {
  /** Target offset in semitones, reached over `time`. */
  semitones: number;
  /** Seconds to reach the target. */
  time: number;
}

export interface InstrumentSpec {
  wave: Waveform;
  /** Pulse only: fraction of the period spent high (0.125 .. 0.75 on real hardware). */
  duty?: number;
  /** Linear gain, roughly 0..1. */
  volume?: number;
  /** Envelope, in seconds; sustain is a level 0..1. */
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
  /** Fast pitch cycling, in semitones, to fake chords on one voice. */
  arp?: number[];
  /** Seconds per arpeggio step. */
  arpRate?: number;
  vibrato?: VibratoSpec;
  slide?: SlideSpec;
  /** Stacked detuned copies of the same note; 1 = off. */
  unison?: number;
  /** Total detune spread across the unison copies, in cents. */
  detune?: number;
  /** Semitone offsets stacked on every note, so one token plays a chord. */
  chord?: number[];
  /** Noise only: 15-bit (hiss) or 6-bit (metallic) LFSR. */
  noiseMode?: 'white' | 'metal';
  /** Noise only: LFSR clock = note frequency * noiseScale. */
  noiseScale?: number;
}

/** One voice's contribution to one stage. */
export interface VoicePart {
  /** Design level of this part inside this stage. */
  gain: number;
  /** Pattern blocks for this stage, concatenated in order. */
  pattern: string[];
}

export interface VoiceSpec {
  id: string;
  label: string;
  /** Hex color used by the scope and the mixer strips. */
  color: string;
  instrument: InstrumentSpec;
  /**
   * Parts by stage. A voice with no entry for a stage rests for that whole
   * stage — that is how the arrangement thickens: the title stays lighter,
   * while the later stages use the full arrangement.
   */
  parts: Partial<Record<StageId, VoicePart>>;
  pan?: number;
  /** Reverb send, 0..1. */
  space?: number;
  /** Ping-pong echo send, 0..1. */
  echo?: number;
  /** Semitone offset for the whole voice (a tracker's channel transpose). */
  transpose?: number;
}

export interface SongSpec {
  id: string;
  title: string;
  /** One line describing the set. */
  blurb: string;
  /** Musical key, for display only. */
  key: string;
  /** The harmonic grid every stage is written on, for display. */
  grid: string;
  bpm: number;
  /** Steps per beat and beats per bar define the grid. */
  stepsPerBeat: number;
  beatsPerBar: number;
  bars: number;
  /** 0 = straight, 0.5 = fully swung 16ths. */
  swing?: number;
  stages: StageSpec[];
  voices: VoiceSpec[];
}

export function loopSteps(song: SongSpec): number {
  return song.bars * song.beatsPerBar * song.stepsPerBeat;
}

export function loopSeconds(song: SongSpec): number {
  return (loopSteps(song) * 60) / (song.bpm * song.stepsPerBeat);
}

/** Frames in one bar: the grain every stage switch is quantized to. */
export function barFrames(song: SongSpec, loopFrames: number): number {
  return loopFrames / song.bars;
}

export function stageById(song: SongSpec, id: StageId): StageSpec {
  const stage = song.stages.find((s) => s.id === id);
  if (!stage) throw new Error(`${song.id}: unknown stage "${id}"`);
  return stage;
}

/** Layers active in a stage: what the arrangement report counts. */
export function stageLayers(voice: VoiceSpec, stage: StageId): boolean {
  const part = voice.parts[stage];
  return part !== undefined && part.gain > 0;
}
