// Offline composer: builds a melody from the motif with a classical phrase plan,
// so the game still works when the network or the cloud AI is unavailable.
//
// The plan is a period: an antecedent (motif, continuation, motif in sequence,
// half cadence on the dominant) answered by a consequent (motif again, motif in
// sequence over IV, approach, authentic cadence on the tonic). 12 and 16 bars add
// a development phrase built on the inverted motif.

import { degreeChord } from '../music/chords';
import type { Key } from '../music/theory';
import type { ChordSpan } from './accompaniment';
import type { ComposeRequest, Melody, MelodyNote } from './melody';

type Chord = 'I' | 'ii' | 'IV' | 'V' | 'vi';

interface BarPlan {
  chord: Chord;
  cell?: 'orig' | 'seq' | 'inv';
  cadence?: 'half' | 'final';
}

const CHORD_ROOT: Record<Chord, number> = { I: 0, ii: 1, IV: 3, V: 4, vi: 5 };

const CHORD_DEGREES: Record<Chord, number[]> = {
  I: [0, 2, 4],
  ii: [1, 3, 5],
  IV: [3, 5, 0],
  V: [4, 6, 1],
  vi: [5, 0, 2],
};

const ANTECEDENT: BarPlan[] = [
  { chord: 'I', cell: 'orig' },
  { chord: 'V' },
  { chord: 'I', cell: 'seq' },
  { chord: 'V', cadence: 'half' },
];
const CONSEQUENT: BarPlan[] = [
  { chord: 'I', cell: 'orig' },
  { chord: 'IV', cell: 'seq' },
  { chord: 'V' },
  { chord: 'I', cadence: 'final' },
];
const DEVELOPMENT: BarPlan[] = [
  { chord: 'vi', cell: 'inv' },
  { chord: 'IV' },
  { chord: 'ii', cell: 'seq' },
  { chord: 'V', cadence: 'half' },
];

export function phrasePlan(bars: number): BarPlan[] {
  if (bars >= 16) return [...ANTECEDENT, ...DEVELOPMENT, ...ANTECEDENT, ...CONSEQUENT];
  if (bars >= 12) return [...ANTECEDENT, ...DEVELOPMENT, ...CONSEQUENT];
  return [...ANTECEDENT, ...CONSEQUENT];
}

// One-bar rhythms in sixteenth notes (4/4). Motif bars need at least three notes;
// cadence bars end on a long note.
const CELL_RHYTHMS = [[4, 4, 8], [4, 4, 4, 4], [2, 2, 4, 8], [4, 2, 2, 4, 4], [6, 2, 4, 4], [4, 4, 2, 2, 4], [2, 2, 4, 4, 4]];
const FREE_RHYTHMS = [[4, 4, 4, 4], [4, 2, 2, 4, 4], [2, 2, 2, 2, 4, 4], [4, 4, 2, 2, 4], [6, 2, 4, 4], [8, 4, 4], [2, 2, 4, 2, 2, 4]];
const HALF_RHYTHMS = [[4, 4, 8], [2, 2, 4, 8], [4, 2, 2, 8], [6, 2, 8]];
const FINAL_RHYTHMS = [[4, 4, 8], [2, 2, 4, 8], [8, 8], [16]];

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Small deterministic PRNG so a seed always gives the same tune. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scale degrees as integers: 0 = tonic near middle C, 7 = an octave higher. */
export class Scale {
  private steps: number[];
  private base: number;
  readonly minor: boolean;

  constructor(key: Key) {
    this.minor = key.mode === 'minor';
    this.steps = this.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    this.base = 60 + key.tonic;
  }

  /** MIDI note of a degree; `raise` sharpens the minor seventh into a leading tone. */
  midi(d: number, raise = false): number {
    const i = mod(d, 7);
    let m = this.base + 12 * Math.floor(d / 7) + this.steps[i];
    if (raise && this.minor && i === 6) m += 1;
    return m;
  }

  /** The degree a note belongs to; chromatic notes map to the degree below. */
  degreeOf(midi: number): number {
    let d = Math.floor((midi - this.base) / 12) * 7 - 7;
    while (this.midi(d + 1) <= midi) d++;
    return d;
  }
}

interface Slot {
  start: number;
  dur: number;
  bar: number;
  chord: Chord;
  strong: boolean;
  /** Fixed degree (or exact MIDI note for the original motif) */
  degree?: number;
  midi?: number;
}

function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function isChordTone(d: number, chord: Chord) {
  return CHORD_DEGREES[chord].includes(mod(d, 7));
}

/** Nearest degree to `near` (within range) whose scale step is in `allowed`. */
function nearestDegree(near: number, allowed: number[], lo: number, hi: number, prefer = 0): number {
  let best = near;
  let bestCost = Infinity;
  for (let d = lo; d <= hi; d++) {
    if (!allowed.includes(mod(d, 7))) continue;
    const cost = Math.abs(d - near) + (d < near ? prefer : -prefer) * 0.1;
    if (cost < bestCost) {
      bestCost = cost;
      best = d;
    }
  }
  return best;
}

function composeOnce(req: ComposeRequest, rng: () => number): MelodyNote[] {
  const scale = new Scale(req.key);
  const plan = phrasePlan(req.bars);
  const motifDeg = req.motif.map((m) => scale.degreeOf(m));
  const lo = scale.degreeOf(Math.max(36, Math.min(...req.motif) - 5)) + 1;
  const hi = scale.degreeOf(Math.min(96, Math.max(...req.motif) + 9));
  const center = Math.round(motifDeg.reduce((a, b) => a + b, 0) / motifDeg.length);
  const inRange = (ds: number[]) => ds.every((d) => d >= lo && d <= hi);

  const cellRhythm = pick(rng, CELL_RHYTHMS);
  const freeRhythms = [pick(rng, FREE_RHYTHMS), pick(rng, FREE_RHYTHMS)];

  // Lay out every note slot with its fixed pitches.
  const slots: Slot[] = [];
  let freeCount = 0;
  plan.forEach((bar, b) => {
    const rhythm = bar.cadence === 'half' ? pick(rng, HALF_RHYTHMS)
      : bar.cadence === 'final' ? pick(rng, FINAL_RHYTHMS)
      : bar.cell ? cellRhythm
      : freeRhythms[freeCount++ % 2];
    const barSlots: Slot[] = [];
    let pos = 0;
    for (const dur of rhythm) {
      barSlots.push({ start: b * 16 + pos, dur, bar: b, chord: bar.chord, strong: pos % 8 === 0 });
      pos += dur;
    }

    if (bar.cell === 'orig') {
      req.motif.forEach((m, i) => {
        barSlots[i].midi = m;
        barSlots[i].degree = motifDeg[i];
      });
    } else if (bar.cell === 'seq') {
      // Move the motif so its first note lands on a chord tone; rising sequences first.
      const shifts = [2, 1, -1, -2, 3, -3, 4, -4];
      const t = shifts.find((s) => isChordTone(motifDeg[0] + s, bar.chord) && inRange(motifDeg.map((d) => d + s))) ?? 1;
      motifDeg.forEach((d, i) => (barSlots[i].degree = d + t));
    } else if (bar.cell === 'inv') {
      const first = nearestDegree(motifDeg[0], CHORD_DEGREES[bar.chord], lo, hi);
      let inv = motifDeg.map((d) => first - (d - motifDeg[0]));
      if (!inRange(inv)) inv = inv.map((d) => d + (Math.min(...inv) < lo ? 7 : -7));
      if (inRange(inv)) inv.forEach((d, i) => (barSlots[i].degree = d));
    }

    const last = barSlots[barSlots.length - 1];
    if (bar.cadence === 'half') {
      last.degree = nearestDegree(center, rng() < 0.6 ? [4] : [1, 4], lo, hi);
    } else if (bar.cadence === 'final') {
      last.degree = nearestDegree(center, [0], lo, hi);
      // Approach the final tonic by step (from the bar before when the tonic fills the whole bar).
      const before = barSlots[barSlots.length - 2] ?? slots.at(-1);
      if (before && before.midi === undefined) before.degree = last.degree + (rng() < 0.6 ? 1 : -1);
    }
    slots.push(...barSlots);
  });

  // Fill the free slots left to right, walking toward the next fixed note.
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.degree !== undefined) continue;
    const prev = slots[i - 1].degree!;
    const prev2 = slots[i - 2]?.degree;
    const j = slots.findIndex((x, k) => k > i && x.degree !== undefined);
    const target = j >= 0 ? slots[j].degree! : center;
    const reach = j >= 0 ? j - i : 4;
    const lastLeap = prev2 === undefined ? 0 : prev - prev2;

    const options: { d: number; w: number }[] = [];
    for (let d = prev - 4; d <= prev + 4; d++) {
      if (d < lo || d > hi) continue;
      const step = Math.abs(d - prev);
      let w = [0.25, 1, 0.6, 0.25, 0.1][step];
      const chordTone = isChordTone(d, s.chord);
      w *= s.strong ? (chordTone ? 3 : 0.35) : chordTone ? 1.2 : 1;
      if (Math.abs(target - d) > reach * 2) w *= 0.05; // could not reach the next fixed note
      if (Math.abs(target - d) < Math.abs(target - prev)) w *= 1.5;
      if (Math.abs(lastLeap) >= 3 && Math.sign(d - prev) === -Math.sign(lastLeap) && step <= 2) w *= 2.5; // recover after a leap
      if (d === prev && d === prev2) w *= 0.1;
      options.push({ d, w });
    }
    let r = rng() * options.reduce((sum, o) => sum + o.w, 0);
    s.degree = options.find((o) => (r -= o.w) <= 0)?.d ?? prev;
  }

  return slots.map((s, i) => {
    const raise = s.chord === 'V' || (plan[s.bar].cadence === 'final' && i === slots.length - 2);
    return { midi: s.midi ?? scale.midi(s.degree!, raise), start: s.start, dur: s.dur };
  });
}

/** Higher is better: smooth lines, one clear high point late in the tune, a sensible range. */
export function scoreMelody(notes: MelodyNote[]): number {
  const ms = notes.map((n) => n.midi);
  let score = 0;
  for (let i = 1; i < ms.length; i++) {
    const iv = Math.abs(ms[i] - ms[i - 1]);
    if (iv > 7) score -= 3;
    else if (iv > 4) score -= 0.6;
    if (iv === 6) score -= 2;
    if (iv === 0) score -= 0.3;
    if (i >= 2 && ms[i] === ms[i - 1] && ms[i] === ms[i - 2]) score -= 1;
  }
  const max = Math.max(...ms);
  const min = Math.min(...ms);
  if (ms.filter((m) => m === max).length === 1) score += 1.5;
  const peak = ms.indexOf(max) / ms.length;
  if (peak > 0.4 && peak < 0.85) score += 1.5;
  const span = max - min;
  if (span > 16) score -= span - 16;
  if (span < 7) score -= 1;
  return score;
}

/** The plan's chords as symbols, with a dominant seventh before the final tonic. */
export function planChords(key: Key, bars: number): ChordSpan[] {
  const plan = phrasePlan(bars);
  return plan.map((bar, b) => {
    const seventh = bar.chord === 'V' && plan[b + 1]?.cadence === 'final';
    return { start: b * 16, dur: 16, symbol: degreeChord(key, CHORD_ROOT[bar.chord], seventh).symbol };
  });
}

/**
 * Makes the tune breathe and repeat like a song: the consequent opens with the antecedent's
 * first bar again, and each half cadence lets go of its last note a little early.
 */
function shape(notes: MelodyNote[], bars: number): MelodyNote[] {
  const plan = phrasePlan(bars);
  const answer = plan.length - 4; // first bar of the consequent
  const first = notes.filter((n) => n.start < 16);
  const out = notes.filter((n) => n.start < answer * 16 || n.start >= (answer + 1) * 16);
  out.push(...first.map((n) => ({ ...n, start: n.start + answer * 16 })));
  out.sort((a, b) => a.start - b.start);
  plan.forEach((bar, b) => {
    if (bar.cadence !== 'half') return;
    const last = out.filter((n) => n.start >= b * 16 && n.start < (b + 1) * 16).at(-1);
    if (last && last.dur >= 6) last.dur -= 2;
  });
  return out;
}

export function composeOffline(req: ComposeRequest): Melody {
  const seed = req.seed ?? Date.now();
  let best: MelodyNote[] = [];
  let bestScore = -Infinity;
  for (let i = 0; i < 40; i++) {
    const notes = composeOnce(req, mulberry32(seed * 7919 + i));
    const score = scoreMelody(notes);
    if (score > bestScore) {
      bestScore = score;
      best = notes;
    }
  }
  const bars = phrasePlan(req.bars).length;
  return {
    notes: shape(best, bars),
    bars,
    beatsPerBar: 4,
    key: req.key,
    engine: 'offline',
    chords: planChords(req.key, bars),
  };
}
