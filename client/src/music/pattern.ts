/**
 * Pattern grammar.
 *
 *   c4 d#4 eb5     note on (scientific pitch notation, octave included)
 *   -              tie: hold the previous note one more step
 *   .  (or r)      rest: silence, and it ends any held note
 *   |              ignored, use it as a visual bar line
 *
 * One token = one step. A pattern block is the concatenation of a voice's
 * blocks; its token count must divide the song's step count.
 */

import { parseNote } from './music.ts';

export type TokenKind = 'note' | 'tie' | 'rest';

export interface PatternToken {
  kind: TokenKind;
  /** MIDI number for notes, -1 otherwise. */
  midi: number;
}

export function tokenizePattern(src: string, where = 'pattern'): PatternToken[] {
  const out: PatternToken[] = [];
  for (const raw of src.split(/[\s|]+/)) {
    if (raw.length === 0) continue;
    if (raw === '.' || raw === 'r') {
      out.push({ kind: 'rest', midi: -1 });
      continue;
    }
    if (raw === '-' || raw === '=') {
      out.push({ kind: 'tie', midi: -1 });
      continue;
    }
    const midi = parseNote(raw);
    if (midi === null) throw new Error(`${where}: unknown pattern token "${raw}"`);
    out.push({ kind: 'note', midi });
  }
  if (out.length === 0) throw new Error(`${where}: empty pattern`);
  return out;
}

export interface PatternNote {
  /** Step index of the note start inside the token list. */
  start: number;
  /** Step index just past the last held step (exclusive). */
  end: number;
  midi: number;
}

/**
 * Turn a token list into notes with explicit gate lengths. A note is released
 * by the next rest, retriggered by the next note, and otherwise held to the
 * end of the block (where the next repetition picks it up or releases it).
 */
export function notesFromTokens(tokens: PatternToken[]): PatternNote[] {
  const notes: PatternNote[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'note') continue;
    let end = tokens.length;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].kind !== 'tie') {
        end = j;
        break;
      }
    }
    notes.push({ start: i, end, midi: token.midi });
  }
  return notes;
}
