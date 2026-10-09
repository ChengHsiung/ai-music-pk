// The AI's left hand: turns the chord progression into a piano accompaniment in one of a few
// feels, voiced below the melody, with pedal marks for a singing, connected sound.

import { Chord, chordPitchClasses, degreeChord, parseChord } from '../music/chords';
import type { Key } from '../music/theory';
import type { MelodyNote } from './melody';

export const FEELS = ['gentle', 'flowing', 'bright', 'march', 'mysterious', 'farewell'] as const;
export type Feel = (typeof FEELS)[number];

export const FEEL_LABEL: Record<Feel, string> = {
  gentle: '溫柔',
  flowing: '抒情',
  bright: '輕快',
  march: '勇敢',
  mysterious: '神秘',
  farewell: '別離',
};

export interface ChordSpan {
  /** Onset and length in sixteenth-note steps */
  start: number;
  dur: number;
  symbol: string;
}

export interface LeftNote extends MelodyNote {
  /** 0..1, how strongly the note is played relative to the left hand's level */
  accent: number;
}

export interface PedalSpan {
  start: number;
  end: number;
}

export interface Accompaniment {
  notes: LeftNote[];
  pedals: PedalSpan[];
}

const BASS_LOW = 40; // E2
const BASS_HIGH = 52; // E3
const UPPER_LOW = 50; // D3
const UPPER_HIGH = 64; // E4

/** Lowest melody note sounding during [start, end), or Infinity. */
function melodyLow(melody: MelodyNote[], start: number, end: number): number {
  let low = Infinity;
  for (const n of melody) if (n.start < end && n.start + n.dur > start) low = Math.min(low, n.midi);
  return low;
}

function placeBass(pc: number, prev: number | null): number {
  const options: number[] = [];
  for (let m = BASS_LOW; m <= BASS_HIGH; m++) if (m % 12 === pc) options.push(m);
  const target = prev ?? 45;
  return options.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
}

/**
 * Three chord tones in close position between `low` and `high`, near the previous voicing;
 * two when three do not fit.
 */
function voiceUpper(pcs: number[], low: number, high: number, prev: number[] | null): number[] {
  const tones = [...new Set(pcs)];
  let candidates: number[][] = [];
  for (let size = Math.min(3, tones.length); size >= 2 && candidates.length === 0; size--) {
    for (let base = low; base <= high; base++) {
      if (!tones.includes(base % 12)) continue;
      const v = [base];
      for (let m = base + 1; m <= high && v.length < size; m++) {
        if (tones.includes(m % 12) && !v.some((x) => x % 12 === m % 12)) v.push(m);
      }
      if (v.length === size) candidates.push(v);
    }
  }
  if (candidates.length === 0) return [];
  const center = prev && prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : (low + high) / 2;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  return candidates.reduce((a, b) => (Math.abs(mean(b) - center) < Math.abs(mean(a) - center) ? b : a));
}

/** Reads the chord symbols; spans that cannot be read are left out (the caller harmonizes instead). */
export function readChords(spans: ChordSpan[]): { span: ChordSpan; chord: Chord }[] {
  return spans.flatMap((span) => {
    const chord = parseChord(span.symbol);
    return chord && span.dur > 0 ? [{ span, chord }] : [];
  });
}

/**
 * Lays out the left hand. `total` is the length of the piece in steps; the last bar always
 * ends on a held chord.
 */
export function arrange(
  melody: MelodyNote[],
  spans: ChordSpan[],
  feel: Feel,
  total: number,
  stepsPerBar = 16,
): Accompaniment {
  const chords = readChords(spans).sort((a, b) => a.span.start - b.span.start);
  const notes: LeftNote[] = [];
  const pedals: PedalSpan[] = [];
  let prevBass: number | null = null;
  let prevUpper: number[] | null = null;
  const lastBar = total - stepsPerBar;

  chords.forEach(({ span, chord }, i) => {
    // The left hand comes in on beat 3 of the first bar, so the child's notes are heard alone first.
    const start = Math.max(span.start, stepsPerBar / 2);
    const end = Math.min(total, chords[i + 1]?.span.start ?? total, span.start + span.dur);
    if (end <= start) return;
    const len = end - start;
    const pcs = chordPitchClasses(chord);
    const under = melodyLow(melody, start, end);
    let bass = placeBass(chord.bass, prevBass);
    while (bass >= under - 2 && bass - 12 >= 28) bass -= 12; // a low melody pushes the bass down
    const top = Math.min(UPPER_HIGH, under - 2);
    const low = Math.max(UPPER_LOW, bass + 3);
    const upper = top - low >= 6 ? voiceUpper(pcs, low, top, prevUpper) : [];
    const fifthPc = (chord.root + (chord.intervals[2] ?? 7)) % 12;
    const fifth = bass + ((fifthPc - (bass % 12) + 12) % 12 || 12);
    // When no full chord fits under the melody, the fifth and the octave fill in (if they fit).
    const spare = [fifth, bass + 12].filter((m) => m <= top);
    prevBass = bass;
    if (upper.length) prevUpper = upper;

    const add = (at: number, midis: number[], dur: number, accent: number) => {
      if (at >= end) return;
      for (const midi of midis) notes.push({ midi, start: start + at, dur: Math.min(dur, len - at), accent });
    };
    const ladder = [bass, ...(upper.length ? upper : spare)];
    const fill = upper.length ? upper : spare.slice(0, 1);

    // The final bar: one warm, held chord, opened up with the bass an octave lower.
    if (start >= lastBar || (i === chords.length - 1 && end === total && len <= stepsPerBar)) {
      const deep = bass - 12 >= 36 ? bass - 12 : bass; // no lower than C2, where the piano gets muddy
      const above = voiceUpper(pcs, deep + 7, top, prevUpper);
      add(0, [...new Set([deep, ...(above.length >= 3 ? above : [bass, ...spare, ...above].filter((m) => m > deep && m <= top))])], len, 1);
      pedals.push({ start, end: total });
      return;
    }

    switch (feel) {
      case 'gentle':
        add(0, [bass, ...upper], Math.min(8, len), 1);
        if (len > 8) add(8, fill, len - 8, 0.7);
        pedals.push({ start, end });
        break;
      case 'flowing': {
        const order = len >= 16 ? [0, 1, 2, 3, 2, 1, 2, 1] : [0, 1, 2, 3];
        for (let k = 0; k * 2 < len; k++) add(k * 2, [ladder[order[k % order.length] % ladder.length]], 2, k === 0 ? 1 : 0.65);
        pedals.push({ start, end });
        break;
      }
      case 'bright': {
        // Alberti bass: low, high, middle, high in eighth notes.
        const [a, b, c] = upper.length >= 3 ? upper : [bass, spare[0] ?? bass, spare[1] ?? spare[0] ?? bass];
        const cell = [a, c, b, c];
        add(0, [bass], 2, 1);
        for (let k = 1; k * 2 < len; k++) add(k * 2, [cell[k % 4]], 2, k % 2 === 0 ? 0.7 : 0.55);
        pedals.push({ start, end });
        break;
      }
      case 'march':
        // Oom-pah in quarter notes (the player keeps them short and crisp).
        for (let k = 0; k * 4 < len; k++) {
          const strong = k % 2 === 0;
          add(k * 4, strong ? [k % 4 === 2 && spare.includes(fifth) ? fifth : bass] : fill, 4, strong ? 1 : 0.6);
        }
        break;
      case 'mysterious': {
        add(0, [bass], len, 1);
        for (let k = 1; k * 4 < len && fill.length; k++) add(k * 4, [fill[(k - 1) % fill.length]], 4, 0.5);
        pedals.push({ start, end });
        break;
      }
      case 'farewell':
        // A slow, legato bass and chord on alternate beats, like an old goodbye song.
        for (let k = 0; k * 4 < len; k++) {
          const strong = k % 2 === 0;
          add(k * 4, strong ? [k % 4 === 2 && spare.includes(fifth) ? fifth : bass] : fill, 4, strong ? 0.9 : 0.5);
        }
        pedals.push({ start, end });
        break;
    }
  });

  return { notes: notes.sort((a, b) => a.start - b.start || a.midi - b.midi), pedals };
}

// ------------------------------------------------------------- harmonizing

const NO_CHORD = -1;

/**
 * Chooses a chord for every half bar from the key's main triads, fitting the melody notes
 * (long and on-the-beat notes count most) and ending with a dominant → tonic cadence.
 * Used for the offline composer and whenever the cloud's chords cannot be read.
 */
export function harmonize(melody: MelodyNote[], key: Key, bars: number, stepsPerBar = 16): ChordSpan[] {
  const half = stepsPerBar / 2;
  const slots = bars * 2;
  const degrees = [0, 3, 4, 5, 1]; // I IV V vi ii
  const chordOf = (d: number) => degreeChord(key, d, false);
  const fit = (slot: number, d: number) => {
    const pcs = chordPitchClasses(chordOf(d));
    let score = 0;
    for (const n of melody) {
      const s = Math.max(n.start, slot * half);
      const e = Math.min(n.start + n.dur, (slot + 1) * half);
      if (e <= s) continue;
      const weight = (e - s) * (n.start % 4 === 0 ? 1.5 : 1) * (n.start === slot * half ? 1.5 : 1);
      score += pcs.includes(((n.midi % 12) + 12) % 12) ? weight : -weight * 0.8;
    }
    return score;
  };
  // Prefer moving to a chord a 4th up/5th down, staying a full bar, and the tonic at phrase starts.
  const move = (from: number, to: number, slot: number) => {
    if (from === NO_CHORD) return to === 0 ? 2 : 0;
    let s = 0;
    if (from === to) s += slot % 2 === 1 ? 1.2 : -0.6; // hold through the bar, change at the barline
    if ((to - from + 7) % 7 === 3) s += 1; // strong root motion
    if (from === 4 && to === 3) s -= 1.5; // V → IV sounds weak
    if (slot % 8 === 0 && to === 0) s += 1;
    return s;
  };
  // Dynamic programming over the slots.
  let best = degrees.map((d) => ({ score: fit(0, d) + move(NO_CHORD, d, 0), path: [d] }));
  for (let slot = 1; slot < slots; slot++) {
    best = degrees.map((d) => {
      const prev = best.reduce((a, b) =>
        b.score + move(b.path.at(-1)!, d, slot) > a.score + move(a.path.at(-1)!, d, slot) ? b : a,
      );
      let score = prev.score + move(prev.path.at(-1)!, d, slot) + fit(slot, d);
      if (slot === slots - 1 && d !== 0) score -= 100; // end on the tonic
      if (slot === slots - 2 && d !== 4 && d !== 0) score -= 4; // approach from the dominant
      if (slot === slots / 2 - 1 && d === 4) score += 2; // half cadence in the middle
      return { score, path: [...prev.path, d] };
    });
  }
  const path = best.reduce((a, b) => (b.score > a.score ? b : a)).path;
  // Merge equal neighbours into longer spans.
  const spans: ChordSpan[] = [];
  path.forEach((d, slot) => {
    const last = spans.at(-1);
    const symbol = chordOf(d).symbol;
    if (last && last.symbol === symbol && slot % 2 === 1) last.dur += half;
    else spans.push({ start: slot * half, dur: half, symbol });
  });
  return spans;
}
