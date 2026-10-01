/** 星灯航线 v3.1 — original themes with wider harmony and restrained percussion. */
import { parts, shared, bassVoice, hatVoice, harmonyVoice, kickVoice, leadVoice, padVoice, riffVoice, snareVoice, chordVoice, percVoice } from './voices';
import type { SongSpec, StageSpec } from '../types';

export const STAGES: StageSpec[] = [
  { id: 'title', label: 'TITLE SCREEN', tag: '星灯', color: '#6f9de0',
    blurb: '保留舒展主题，左侧轻和声托住句尾，少量边击回应；低音与轻鼓保留脉搏。' },
  { id: 'arena', label: 'ARENA', tag: '巡航', color: '#dfa32b',
    blurb: '右侧 RIFF 与左侧三／七度和声交错，短边击补节奏空隙；仍每两小节收束。' },
  { id: 'final', label: 'SUDDEN DEATH', tag: '突围', color: '#e0452b',
    blurb: '保留第七小节高点，补轻鼓与句尾小加花；和声在左右展开，不把所有声部一起加倍。' },
];

/** Used by verification as well as the score: the dominant really contains D#. */
export const HARMONY = [
  { label: 'Em(add9)', root: 'e2', chord: ['e', 'g', 'b', 'f#'], scale: ['e', 'f#', 'g', 'a', 'b', 'c', 'd'] },
  { label: 'Cmaj7', root: 'c3', chord: ['c', 'e', 'g', 'b'], scale: ['e', 'f#', 'g', 'a', 'b', 'c', 'd'] },
  { label: 'G6/D', root: 'd3', chord: ['g', 'b', 'd', 'e'], scale: ['e', 'f#', 'g', 'a', 'b', 'c', 'd'] },
  { label: 'B7', root: 'b2', chord: ['b', 'd#', 'f#', 'a'], scale: ['e', 'f#', 'g', 'a', 'b', 'c', 'd#'] },
  { label: 'Em(add9)', root: 'e2', chord: ['e', 'g', 'b', 'f#'], scale: ['e', 'f#', 'g', 'a', 'b', 'c', 'd'] },
  { label: 'Cmaj7', root: 'c3', chord: ['c', 'e', 'g', 'b'], scale: ['e', 'f#', 'g', 'a', 'b', 'c', 'd'] },
  { label: 'Am7', root: 'a2', chord: ['a', 'c', 'e', 'g'], scale: ['e', 'f#', 'g', 'a', 'b', 'c', 'd'] },
  { label: 'B7', root: 'b2', chord: ['b', 'd#', 'f#', 'a'], scale: ['e', 'f#', 'g', 'a', 'b', 'c', 'd#'] },
] as const;

export const HOOK = ['b4', 'e5', 'g5', 'f#5'] as const;
const REST = '. . . .  . . . .  . . . .  . . . .';
// All three arrangements breathe together here; the next downbeat is Em.
const GATE = {
  lead: 'b4 - . .  d#5 - f#5 -  b4 - - -  - . . .',
  harmony: '. . . .  . . . .  . . . .  f#5 . . .',
  bass: 'b2 - - -  - - . .  f#3 - - -  . . . .',
  kick: 'c4 . . .  . . . .  c4 . . .  . . . .',
};

const lead = parts({
  title: [[
    'b4 - - -  e5 - - -  g5 - f#5 -  e5 - - -',
    '. . g5 -  e5 - d5 -  e5 - - -  - - . .',
    'd5 - - -  g5 - - .  a5 - g5 -  e5 - - .',
    'f#5 - e5 -  d#5 - - .  f#5 - - -  - - . .',
    'b4 - - -  e5 - - -  g5 - f#5 -  e5 - - -',
    'g5 - - -  e5 - d5 -  c5 - - -  - - . .',
    'e5 - - -  a5 - g5 -  e5 - c5 -  e5 - - .',
    GATE.lead,
  ], 0.96],
  arena: [[
    'b4 . e5 -  . . g5 .  f#5 - e5 -  b4 - . .',
    'g5 - e5 .  d5 - c5 .  e5 - - -  - - . .',
    'd5 . g5 -  b5 . a5 .  g5 - e5 -  d5 - . .',
    'f#5 - a5 .  f#5 . e5 .  d#5 - - -  - - . .',
    'b4 . e5 -  . . g5 .  b5 - a5 -  g5 - . .',
    'g5 . e5 .  d5 - c5 .  e5 - - -  - - . .',
    'a4 . c5 .  e5 - g5 .  a5 - g5 -  e5 - . .',
    GATE.lead,
  ], 0.96],
  final: [[
    'b4 . e5 .  . . g5 -  f#5 . e5 g5  b5 - - .',
    'g5 . e5 .  g5 - b5 .  g5 - - -  - - . .',
    'd5 . g5 .  b5 - a5 .  g5 a5 b5 a5  g5 - . .',
    'a5 . f#5 .  e5 - d#5 .  f#5 - - -  - - . .',
    'b4 . e5 .  g5 - b5 .  a5 . g5 .  e5 - - .',
    'g5 . e5 .  b5 - g5 .  e5 - - -  - - . .',
    'a5 . e5 .  c6 - b5 .  a5 g5 e5 d5  c5 - - .',
    GATE.lead,
  ], 0.96],
});

// Offbeat chord tones, not a second lead running underneath every syllable.
const riff = parts({
  arena: [[
    '. . e4 .  . . b4 .  . . g4 .  . . b4 .',
    '. . e4 .  . . g4 .  . . b4 .  . . g4 .',
    '. . d4 .  . . g4 .  . . b4 .  . . e4 .',
    '. . d#4 .  . . f#4 .  . . a4 .  . . f#4 .',
    '. . e4 .  . . b4 .  . . g4 .  . . b4 .',
    '. . c4 .  . . g4 .  . . e4 .  . . b4 .',
    '. . c4 .  . . e4 .  . . g4 .  . . e4 .',
    REST,
  ], 0.86],
  final: [[
    'e4 . . .  b4 . g4 .  . . b4 .  g4 . b4 .',
    'e4 . . .  g4 . b4 .  . . g4 .  e4 . g4 .',
    'd4 . . .  g4 . b4 .  . . e4 .  b4 . g4 .',
    'd#4 . . .  f#4 . a4 .  . . f#4 .  d#4 . f#4 .',
    'e4 . . .  b4 . g4 .  . . b4 .  g4 . b4 .',
    'c4 . . .  g4 . e4 .  . . b4 .  g4 . e4 .',
    'c4 . . .  e4 . g4 .  . . e4 .  c4 . e4 .',
    REST,
  ], 0.9],
});

// Explicit pitches: no hidden major-triad arpeggiator on a minor-key note.
const shimmer = parts({
  title: [[
    '. . . .  . . . .  . . . .  . . b5 .',
    '. . . .  . . . .  . . . .  . . g5 .',
    '. . . .  . . . .  . . . .  . . b5 .',
    '. . . .  . . . .  . . . .  . . f#5 .',
    '. . . .  . . . .  . . . .  . . b5 .',
    '. . . .  . . . .  . . . .  . . e5 .',
    '. . . .  . . . .  . . . .  . . a5 .',
    GATE.harmony,
  ], 0.75],
  arena: [[
    '. . . .  . . . .  . . . .  . . b5 .',
    '. . . .  . . . .  . . . .  e6 . g5 .',
    '. . . .  . . . .  . . . .  . . b5 .',
    '. . . .  . . . .  . . . .  a5 . f#5 .',
    '. . . .  . . . .  . . . .  . . b5 .',
    '. . . .  . . . .  . . . .  g5 . e5 .',
    '. . . .  . . . .  . . . .  . . a5 .',
    GATE.harmony,
  ], 0.75],
  final: [[
    '. . . .  . . . .  . . . .  . . e6 .',
    '. . . .  . . . .  . . b5 .  . . g5 .',
    '. . . .  . . . .  . . . .  . . b5 .',
    '. . . .  . . . .  . . a5 .  . . f#5 .',
    '. . . .  . . . .  . . . .  . . e6 .',
    '. . . .  . . . .  . . g5 .  . . e5 .',
    '. . . .  . . . .  . . . .  . . e5 .',
    GATE.harmony,
  ], 0.75],
});

// Thirds and sevenths complete the open-fifth pad. One note at a time,
// in the space beneath the lead; no automatic parallel-major chords.
const chord = parts({
  title: [[
    '. . . .  g4 - - -  . . . .  . . b4 .',
    '. . . .  . . . .  g4 - - -  b4 - . .',
    '. . . .  b4 - - -  . . . .  . . e4 .',
    '. . . .  . . . .  a4 - - -  f#4 - . .',
    '. . . .  g4 - - -  . . . .  . . b4 .',
    '. . . .  . . . .  e4 - - -  g4 - . .',
    '. . . .  c5 - - -  . . . .  . . g4 .',
    REST,
  ], 0.68],
  arena: [[
    '. . . .  g4 - . .  . . b4 -  . . g4 .',
    '. . . .  e4 - . .  g4 - - -  b4 - . .',
    '. . . .  b4 - . .  . . e4 -  . . b4 .',
    '. . . .  a4 - . .  f#4 - - -  a4 - . .',
    '. . . .  g4 - . .  . . b4 -  . . g4 .',
    '. . . .  e4 - . .  g4 - - -  b4 - . .',
    '. . . .  c5 - . .  . . g4 -  . . c5 .',
    REST,
  ], 0.76],
  // Final only: lower thirds/sixths follow selected lead accents and phrase
  // endings. Skip the fast passing runs and leave the shared handoff empty.
  final: [[
    '. . g4 .  . . e5 -  . . . .  g5 - - .',
    '. . . .  e5 - g5 .  e5 - - -  - - . .',
    '. . b4 .  g5 - . .  . . . .  b4 - . .',
    '. . d#5 .  . . b4 .  d#5 - - -  - - . .',
    '. . g4 .  e5 - g5 .  . . . .  g4 - - .',
    '. . . .  g5 - e5 .  c5 - - -  - - . .',
    'c5 . . .  a5 - . .  . . . .  a4 - - .',
    REST,
  ], 0.8],
});

const pad = [
  'e4 - - -  - - - -  - - - -  . . . .',
  'c4 - - -  - - - -  - - - -  . . . .',
  'g3 - - -  - - - -  - - - -  . . . .',
  'b3 - - -  - - - -  - - - -  . . . .',
  'e4 - - -  - - - -  - - - -  . . . .',
  'c4 - - -  - - - -  - - - -  . . . .',
  'a3 - - -  - - - -  - - - -  . . . .',
  'b3 - - -  - - - -  - - - -  . . . .',
];

const bassLine = parts({
  title: [[
    'e2 - - -  - - . .  b2 - - -  . . . .',
    'c3 - - -  - - . .  g2 - - -  . . . .',
    'd3 - - -  - - . .  g2 - - -  . . . .',
    'b2 - - -  - - . .  f#3 - - -  . . . .',
    'e2 - - -  - - . .  b2 - - -  . . . .',
    'c3 - - -  - - . .  g2 - - -  . . . .',
    'a2 - - -  - - . .  e3 - - -  . . . .',
    GATE.bass,
  ], 0.88],
  arena: [[
    'e2 - - .  . . b2 .  e3 - - .  b2 - . .',
    'c3 - - .  . . g2 .  c3 - - .  e3 - . .',
    'd3 - - .  . . a2 .  g2 - - .  d3 - . .',
    'b2 - - .  . . f#3 .  b2 - - .  d#3 - . .',
    'e2 - - .  . . b2 .  e3 - - .  b2 - . .',
    'c3 - - .  . . g2 .  c3 - - .  e3 - . .',
    'a2 - - .  . . e3 .  a2 - - .  c3 - . .',
    GATE.bass,
  ], 0.88],
  final: [[
    'e2 - . .  e3 . b2 -  . . e2 .  b2 - e3 .',
    'c3 - . .  c3 . g2 -  . . c3 .  g2 - e3 .',
    'd3 - . .  d3 . g2 -  . . d3 .  b2 - d3 .',
    'b2 - . .  b2 . f#3 -  . . b2 .  f#3 - d#3 .',
    'e2 - . .  e3 . b2 -  . . e2 .  b2 - e3 .',
    'c3 - . .  c3 . g2 -  . . c3 .  g2 - e3 .',
    'a2 - . .  a2 . e3 -  . . a2 .  e3 - c3 .',
    GATE.bass,
  ], 0.88],
});

const K = 'c4 . . .  . . . .  c4 . . .  . . . .';
const K1 = 'c4 . . .  . . c4 .  c4 . . .  . . . .';
const K2 = 'c4 . . .  . . . .  c4 . . .  . . c4 .';
const K3 = 'c4 . . .  . . c4 .  c4 . . .  . . c4 .';
const K4 = 'c4 . . .  c4 . . .  . . c4 .  c4 . . .';
const S = '. . . .  c4 . . .  . . . .  c4 . . .';
const SF = '. . . .  c4 . . .  . . . .  c4 . c4 c4';
const H = '. . c4 .  . . c4 .  . . c4 .  . . c4 .';
const HF = 'c4 . c4 .  . . c4 .  c4 . c4 .  . . c4 .';
const HT = '. . c4 .  . . c4 .  . . c4 .  c4 c4 c4 .';
const K5 = 'c4 . . .  . . c4 .  c4 . . .  c4 . . .';
const S2 = '. . . .  c4 . . .  . . . .  c4 . c4 .';
const H2 = '. . c4 .  c4 . c4 .  . . c4 .  . . c4 .';
const P0 = '. . . .  . . . .  . . . .  c4 . . .';
const P1 = '. . . .  . . c4 .  . . . .  . . c4 .';
const P2 = '. . c4 .  . . . .  . . c4 .  . . . .';
const P3 = '. . c4 .  . . . .  . . c4 .  . . c4 c4';
const percussion = parts({
  title: [[REST, P0, REST, P0, REST, P0, P2, REST], 0.54],
  arena: [[P1, P2, P1, P2, P1, P2, P3, REST], 0.58],
  final: [[P2, P1, P3, P1, P2, P1, P3, REST], 0.64],
});

export const stages: SongSpec = {
  id: 'starlit-circuit-v3-1', title: '星灯航线 / STARLIT CIRCUIT · v3.1',
  blurb: '保留星灯、巡航、突围主题，补三／七度和声与轻鼓。八小节一个呼吸，三段任意对接。',
  key: 'E 小调 · B7 属和弦使用 D♯', grid: HARMONY.map((bar) => bar.label).join(' – '),
  bpm: 112, stepsPerBeat: 4, beatsPerBar: 4, bars: 8, swing: 0, stages: STAGES,
  voices: [
    leadVoice(lead), riffVoice(riff), harmonyVoice(shimmer),
    padVoice(shared(pad, 0.9)), bassVoice(bassLine),
    kickVoice(parts({ title: [[K, K, K, K, K, K, K, GATE.kick], 0.82], arena: [[K1, K2, K1, K2, K1, K2, K3, GATE.kick], 0.82], final: [[K3, K4, K5, K4, K3, K4, K5, GATE.kick], 0.82] })),
    snareVoice(parts({ arena: [[S, S, S, S2, S, S, SF, REST], 0.78], final: [[S, S2, SF, S, S, S2, SF, REST], 0.86] })),
    hatVoice(parts({ arena: [[H, H2, H, H, H, H2, HT, REST], 0.6], final: [[HF, H2, HF, HT, HF, H2, HT, REST], 0.64] })),
    chordVoice(chord), percVoice(percussion),
  ],
};
