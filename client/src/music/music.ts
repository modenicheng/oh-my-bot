/** Note names, MIDI numbers and tuning. */

export const A4_HZ = 440;
export const A4_MIDI = 69;

const LETTER_OFFSET: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const SHARP_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'] as const;

const NOTE_RE = /^([a-g])([#b]?)(-?\d)$/;

export function midiToFreq(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** "c#4" / "db4" / "a3" -> MIDI number, or null when the token is not a note. */
export function parseNote(token: string): number | null {
  const m = NOTE_RE.exec(token.toLowerCase());
  if (!m) return null;
  const letter = m[1] as string;
  const offset = LETTER_OFFSET[letter];
  if (offset === undefined) return null;
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = Number(m[3]);
  const midi = (octave + 1) * 12 + offset + accidental;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** 60 -> "c4", 61 -> "c#4" */
export function midiToName(midi: number): string {
  const name = SHARP_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
