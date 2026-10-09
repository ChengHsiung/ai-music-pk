// Chord symbols ("C", "Am", "G7", "F/A", "Bdim") to pitch classes, for the left-hand accompaniment.

import type { Key } from './theory';

export interface Chord {
  /** The symbol as written, e.g. "G7" */
  symbol: string;
  /** Pitch class of the root, 0 = C */
  root: number;
  /** Pitch class of the bass note (differs from the root in a slash chord) */
  bass: number;
  /** Chord tones as intervals above the root, root first */
  intervals: number[];
}

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Suffix after the root (matched exactly) → chord tones as intervals above the root.
const QUALITIES: [string, number[]][] = [
  ['maj7', [0, 4, 7, 11]],
  ['mM7', [0, 3, 7, 11]],
  ['M7', [0, 4, 7, 11]],
  ['m7b5', [0, 3, 6, 10]],
  ['min7', [0, 3, 7, 10]],
  ['dim7', [0, 3, 6, 9]],
  ['sus4', [0, 5, 7]],
  ['sus2', [0, 2, 7]],
  ['add9', [0, 4, 7, 14]],
  ['madd9', [0, 3, 7, 14]],
  ['min', [0, 3, 7]],
  ['dim', [0, 3, 6]],
  ['aug', [0, 4, 8]],
  ['m7', [0, 3, 7, 10]],
  ['m6', [0, 3, 7, 9]],
  ['m9', [0, 3, 7, 10, 14]],
  ['maj', [0, 4, 7]],
  ['sus', [0, 5, 7]],
  ['m', [0, 3, 7]],
  ['°', [0, 3, 6]],
  ['ø', [0, 3, 6, 10]],
  ['+', [0, 4, 8]],
  ['7', [0, 4, 7, 10]],
  ['6', [0, 4, 7, 9]],
  ['9', [0, 4, 7, 10, 14]],
  ['', [0, 4, 7]],
];

function parseNote(s: string): { pc: number; rest: string } | null {
  const m = /^([A-Ga-g])([#♯b♭]*)(.*)$/.exec(s.trim());
  if (!m) return null;
  let pc = LETTER_PC[m[1].toUpperCase()];
  for (const c of m[2]) pc += c === '#' || c === '♯' ? 1 : -1;
  return { pc: ((pc % 12) + 12) % 12, rest: m[3] };
}

/** Reads a chord symbol; returns null when it cannot be understood. */
export function parseChord(symbol: string): Chord | null {
  const [main, slash] = symbol.replace(/\s+/g, '').split('/');
  const root = parseNote(main);
  if (!root) return null;
  const q = QUALITIES.find(([suffix]) => root.rest === suffix);
  if (!q) return null;
  let bass = root.pc;
  if (slash) {
    const b = parseNote(slash);
    if (!b || b.rest) return null;
    bass = b.pc;
  }
  return { symbol, root: root.pc, bass, intervals: q[1] };
}

export function chordPitchClasses(c: Chord): number[] {
  return c.intervals.map((i) => (c.root + i) % 12);
}

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

/**
 * A diatonic triad on scale degree `degree` (0 = tonic). In minor the dominant
 * (and the chord on the 7th degree) use the raised leading tone, as in classical harmony.
 */
export function degreeChord(key: Key, degree: number, seventh = false): Chord {
  const minor = key.mode === 'minor';
  const steps = minor ? MINOR_STEPS : MAJOR_STEPS;
  const pcAt = (d: number) => {
    const i = ((d % 7) + 7) % 7;
    let pc = key.tonic + steps[i];
    if (minor && i === 6 && (degree % 7 === 4 || degree % 7 === 6)) pc += 1; // leading tone
    return ((pc % 12) + 12) % 12;
  };
  const root = pcAt(degree);
  const tones = [degree, degree + 2, degree + 4, ...(seventh ? [degree + 6] : [])].map(pcAt);
  const intervals = tones.map((pc) => (((pc - root) % 12) + 12) % 12);
  return { symbol: chordName(root, intervals, key), root, bass: root, intervals };
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function chordName(root: number, intervals: number[], key: Key): string {
  const name = (key.fifths < 0 ? FLAT_NAMES : SHARP_NAMES)[root];
  const third = intervals[1];
  const fifth = intervals[2];
  let suffix = third === 3 ? (fifth === 6 ? 'dim' : 'm') : fifth === 8 ? 'aug' : '';
  if (intervals[3] === 10) suffix = suffix === 'dim' ? 'm7b5' : `${suffix}7`;
  if (intervals[3] === 11) suffix = suffix === 'm' ? 'mM7' : 'maj7';
  return name + suffix;
}
