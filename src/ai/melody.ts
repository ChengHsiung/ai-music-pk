// The AI's melody: notes on a sixteenth-note grid (gaps are rests), its harmony and left hand,
// plus helpers to draw and play it.

import { buildBars, QuantizedScore, SPLIT_MIDI } from '../music/quantize';
import { pitchClass, type Key } from '../music/theory';
import { arrange, ChordSpan, Feel, harmonize, LeftNote, PedalSpan, readChords } from './accompaniment';

export interface MelodyNote {
  midi: number;
  /** Onset in sixteenth-note steps from the start */
  start: number;
  /** Length in sixteenth-note steps */
  dur: number;
}

export interface Melody {
  notes: MelodyNote[];
  bars: number;
  beatsPerBar: number;
  key: Key;
  engine: 'cloud' | 'offline';
  /** Song title and a sentence for the audience, in Traditional Chinese */
  title?: string;
  idea?: string;
  /** Why the offline composer stood in for the cloud, for the host */
  fallbackReason?: string;
  /** Tempo the composer chose for this tune */
  bpm?: number;
  /** Harmony under the melody, the accompaniment's character, and the left hand built from them */
  chords?: ChordSpan[];
  feel?: Feel;
  left?: LeftNote[];
  pedals?: PedalSpan[];
}

export interface ComposeRequest {
  motif: number[];
  key: Key;
  bars: number;
  /** Seeds the offline composer so "compose again" gives a new tune */
  seed?: number;
  /** The host's choice of character, or undefined to let the composer choose */
  feel?: Feel;
  /** The previous tune's character, so "compose again" sounds different */
  avoidFeel?: Feel;
  /** Titles already used at this event, so each tune gets its own picture */
  avoidTitles?: string[];
}

/** Note ids for drawing; offset so they never collide with performance events. */
export const AI_ID_BASE = 1_000_000;
/** Left-hand note ids follow the melody's. */
export const AI_LEFT_ID = AI_ID_BASE + 100_000;

/** A single melody line stays on one staff unless it really spans both. */
export function melodySplit(notes: MelodyNote[]): number {
  const midis = notes.map((n) => n.midi);
  if (Math.min(...midis) >= 53) return 0; // all treble, down to F3 on ledger lines
  if (Math.max(...midis) <= 64) return 128; // all bass, up to E4 on ledger lines
  return SPLIT_MIDI;
}

export function scoreFromMelody(m: Melody, bpm: number): QuantizedScore {
  const stepsPerBar = m.beatsPerBar * 4;
  const melodyStaff: 'treble' | undefined = m.left?.length ? 'treble' : undefined; // with a left hand, the melody keeps the treble staff
  const grid = [
    ...m.notes.map((n, i) => ({ midi: n.midi, id: AI_ID_BASE + i, on: n.start, off: n.start + n.dur, staff: melodyStaff })),
    ...(m.left ?? []).map((n, j) => ({ midi: n.midi, id: AI_LEFT_ID + j, on: n.start, off: n.start + n.dur, staff: 'bass' as const })),
  ];
  const bars = buildBars(grid, { stepsPerBar, tidy: false, barCount: m.bars, splitMidi: melodySplit(m.notes) });
  return { bpm, beatsPerBar: m.beatsPerBar, key: m.key, bars };
}

/**
 * Checks the rules every AI melody must follow and repairs what it can: the motif opens the
 * tune, notes do not overlap, everything fits in the bars and a sensible range. Rests (gaps
 * between notes) are kept: they are the breaths between phrases.
 * Returns null when the melody is unusable.
 */
export function validateMelody(m: Melody, motif: number[]): Melody | null {
  const stepsPerBar = m.beatsPerBar * 4;
  const total = m.bars * stepsPerBar;
  let notes = m.notes
    .filter((n) => Number.isFinite(n.midi) && Number.isFinite(n.start) && n.dur > 0 && n.start >= 0 && n.start < total)
    .map((n) => ({ midi: Math.round(n.midi), start: Math.round(n.start), dur: Math.max(1, Math.round(n.dur)) }))
    .sort((a, b) => a.start - b.start);
  // One note at a time.
  notes = notes.filter((n, i) => i === 0 || n.start > notes[i - 1].start);
  if (notes.length < motif.length + 4) return null;
  for (let i = 0; i < notes.length; i++) {
    const end = notes[i + 1]?.start ?? total;
    notes[i].dur = Math.min(notes[i].dur, end - notes[i].start);
  }
  // The tune starts within the first bar (a short rest before the child's notes is fine).
  if (notes[0].start >= stepsPerBar) return null;

  // The child's notes open the tune. An octave slip is moved back as a whole; otherwise the
  // notes are put back in place.
  const shift = motif[0] - notes[0].midi;
  if (shift !== 0 && pitchClass(shift) === 0 && motif.every((mm, i) => notes[i].midi + shift === mm)) {
    notes = notes.map((n) => ({ ...n, midi: n.midi + shift }));
  }
  motif.forEach((midi, i) => (notes[i].midi = midi));

  // Far-out notes are folded back by octaves.
  const lo = Math.min(...motif) - 7;
  const hi = Math.max(...motif) + 16;
  for (const n of notes.slice(motif.length)) {
    while (n.midi < lo) n.midi += 12;
    while (n.midi > hi) n.midi -= 12;
    n.midi = Math.min(96, Math.max(36, n.midi));
  }
  return { ...m, notes };
}

/** Feels that suit a motif, used when nobody chose one. */
export function suggestFeels(motif: number[], key: Key): Feel[] {
  const rise = motif[motif.length - 1] - motif[0];
  const repeated = motif.some((m, i) => i > 0 && m === motif[i - 1]);
  if (key.mode === 'minor') return ['flowing', 'mysterious', 'farewell', 'gentle'];
  if (repeated) return ['bright', 'march', 'flowing'];
  if (rise > 0) return ['bright', 'march', 'flowing'];
  return ['gentle', 'flowing', 'farewell', 'bright'];
}

export const FEEL_BPM: Record<Feel, [number, number]> = {
  gentle: [66, 80],
  flowing: [76, 92],
  bright: [104, 124],
  march: [100, 116],
  mysterious: [70, 88],
  farewell: [60, 76],
};

/**
 * Completes a melody for playing and drawing: readable chords (worked out from the melody
 * when missing or unreadable), a feel and tempo, and the left hand with its pedalling.
 */
export function finishMelody(m: Melody, fallbackFeel: Feel): Melody {
  const total = m.bars * m.beatsPerBar * 4;
  const readable = readChords(m.chords ?? []).filter((c) => c.span.start < total);
  const covered = readable.reduce((sum, c) => sum + Math.min(c.span.dur, total - c.span.start), 0);
  const chords = covered >= total * 0.75 ? readable.map((c) => c.span) : harmonize(m.notes, m.key, m.bars, m.beatsPerBar * 4);
  const feel = m.feel ?? fallbackFeel;
  const [slow, fast] = FEEL_BPM[feel];
  const bpm = m.bpm && m.bpm >= 50 && m.bpm <= 160 ? Math.round(Math.min(fast + 8, Math.max(slow - 8, m.bpm))) : Math.round((slow + fast) / 2);
  const { notes: left, pedals } = arrange(m.notes, chords, feel, total, m.beatsPerBar * 4);
  return { ...m, chords, feel, bpm, left, pedals };
}
