// The AI's melody: notes on a sixteenth-note grid, plus helpers to draw and play it.

import { buildBars, QuantizedScore, SPLIT_MIDI } from '../music/quantize';
import type { Key } from '../music/theory';

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
}

export interface ComposeRequest {
  motif: number[];
  key: Key;
  bars: number;
  /** Seeds the offline composer so "compose again" gives a new tune */
  seed?: number;
}

/** Note ids for drawing; offset so they never collide with performance events. */
export const AI_ID_BASE = 1_000_000;

/** A single melody line stays on one staff unless it really spans both. */
export function melodySplit(notes: MelodyNote[]): number {
  const midis = notes.map((n) => n.midi);
  if (Math.min(...midis) >= 53) return 0; // all treble, down to F3 on ledger lines
  if (Math.max(...midis) <= 64) return 128; // all bass, up to E4 on ledger lines
  return SPLIT_MIDI;
}

export function scoreFromMelody(m: Melody, bpm: number): QuantizedScore {
  const stepsPerBar = m.beatsPerBar * 4;
  const bars = buildBars(
    m.notes.map((n, i) => ({ midi: n.midi, id: AI_ID_BASE + i, on: n.start, off: n.start + n.dur })),
    { stepsPerBar, tidy: false, barCount: m.bars, splitMidi: melodySplit(m.notes) },
  );
  return { bpm, beatsPerBar: m.beatsPerBar, key: m.key, bars };
}

/**
 * Checks the rules every AI melody must follow and repairs what it can:
 * the motif opens the tune unchanged, bars are full, notes stay in range.
 * Returns null when the melody is unusable.
 */
export function validateMelody(m: Melody, motif: number[]): Melody | null {
  const stepsPerBar = m.beatsPerBar * 4;
  const total = m.bars * stepsPerBar;
  const notes = m.notes
    .filter((n) => Number.isFinite(n.midi) && n.dur > 0 && n.start >= 0 && n.start < total)
    .map((n) => ({ midi: Math.round(n.midi), start: Math.round(n.start), dur: Math.round(n.dur) }))
    .sort((a, b) => a.start - b.start);
  if (notes.length < motif.length + 4) return null;

  // No overlaps or gaps: each note lasts until the next one starts.
  for (let i = 0; i < notes.length; i++) {
    const next = notes[i + 1];
    notes[i].dur = Math.max(1, (next ? next.start : total) - notes[i].start);
  }
  if (notes[0].start !== 0) notes[0] = { ...notes[0], dur: notes[0].dur + notes[0].start, start: 0 };
  motif.forEach((midi, i) => (notes[i].midi = midi));
  for (const n of notes) n.midi = Math.min(96, Math.max(36, n.midi));
  return { ...m, notes };
}
