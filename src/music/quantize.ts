// Turns a free-time performance into a 4/4 score on a sixteenth-note grid.

import { detectKey, Key } from './theory';

export interface NoteEvent {
  id: number;
  midi: number;
  velocity: number;
  /** ms, performance.now() clock */
  start: number;
  /** ms; null while the key is still held */
  end: number | null;
}

export type StaffName = 'treble' | 'bass';

export interface Tick {
  rest: boolean;
  midis: number[];
  /** Length in sixteenth notes: one of 16, 12, 8, 6, 4, 3, 2, 1 */
  dur: number;
  /** Tied to the next tick in the same staff */
  tieToNext: boolean;
  /** Continuation of a tied note (no new attack) */
  tiedFromPrev: boolean;
  /** Source event ids */
  ids: number[];
}

export interface Bar {
  treble: Tick[];
  bass: Tick[];
}

export interface QuantizedScore {
  bpm: number;
  beatsPerBar: number;
  key: Key;
  bars: Bar[];
}

export interface QuantizeOptions {
  /** Force a tempo instead of estimating it */
  bpm?: number;
  beatsPerBar?: number;
  key?: Key;
  /** Notes starting within this many ms are one chord */
  chordWindowMs?: number;
  /** Notes at or above this MIDI number go on the treble staff */
  splitMidi?: number;
}

export const SPLIT_MIDI = 60;
const DURATIONS = [16, 12, 8, 6, 4, 3, 2, 1];

/** Groups note starts that are closer than `windowMs` into one onset. */
export function clusterOnsets<T extends { start: number }>(events: T[], windowMs = 60): T[][] {
  const sorted = [...events].sort((a, b) => a.start - b.start);
  const clusters: T[][] = [];
  for (const e of sorted) {
    const last = clusters.at(-1);
    if (last && e.start - last[0].start < windowMs) last.push(e);
    else clusters.push([e]);
  }
  return clusters;
}

/**
 * Picks the beat length (ms) whose eighth-note grid best fits the onsets,
 * with a mild preference for tempos near 100 BPM.
 */
export function estimateBeatMs(onsets: number[]): number {
  if (onsets.length < 4) return 600;
  const t0 = onsets[0];
  let best = 600;
  let bestScore = Infinity;
  for (let beat = 400; beat <= 1000; beat += 5) {
    const grid = beat / 2;
    let err = 0;
    for (const t of onsets) {
      const x = (t - t0) / grid;
      err += Math.abs(x - Math.round(x));
    }
    const score = err / onsets.length + 0.05 * Math.abs(Math.log2(beat / 600));
    if (score < bestScore) {
      bestScore = score;
      best = beat;
    }
  }
  return best;
}

/** Splits a length into representable note values without crossing the bar line. */
export function splitDuration(length: number, posInBar: number, stepsPerBar: number): number[] {
  const pieces: number[] = [];
  let pos = posInBar;
  let left = length;
  while (left > 0) {
    const room = Math.min(left, stepsPerBar - (pos % stepsPerBar));
    const d = DURATIONS.find((x) => x <= room)!;
    pieces.push(d);
    pos += d;
    left -= d;
  }
  return pieces;
}

interface Segment {
  start: number;
  end: number;
  midis: number[];
  ids: number[];
}

export function quantize(events: NoteEvent[], opts: QuantizeOptions = {}): QuantizedScore {
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const stepsPerBar = beatsPerBar * 4;
  const split = opts.splitMidi ?? SPLIT_MIDI;
  const done = events.filter((e) => e.end !== null);
  const clusters = clusterOnsets(done, opts.chordWindowMs ?? 60);

  if (clusters.length === 0) {
    return {
      bpm: opts.bpm ?? 100,
      beatsPerBar,
      key: opts.key ?? detectKey([]),
      bars: [{ treble: [restTick(stepsPerBar)], bass: [restTick(stepsPerBar)] }],
    };
  }

  const beatMs = opts.bpm ? 60000 / opts.bpm : estimateBeatMs(clusters.map((c) => c[0].start));
  const step = beatMs / 4;
  const t0 = clusters[0][0].start;

  // Snap every note to the grid; chord members share their cluster's onset.
  const snapped: GridNote[] = [];
  for (const cluster of clusters) {
    const on = Math.round((cluster[0].start - t0) / step);
    for (const e of cluster) {
      const off = Math.max(on + 1, Math.round((e.end! - t0) / step));
      snapped.push({ midi: e.midi, id: e.id, on, off });
    }
  }

  const bars = buildBars(snapped, { stepsPerBar, splitMidi: split, tidy: true });

  const key =
    opts.key ?? detectKey(snapped.map((n) => ({ midi: n.midi, weight: n.off - n.on })));

  return { bpm: Math.round(60000 / beatMs), beatsPerBar, key, bars };
}

export interface GridNote {
  midi: number;
  id: number;
  /** Onset and release in sixteenth-note steps from the start */
  on: number;
  off: number;
  /** Staff chosen by voice (e.g. the AI's left hand); otherwise by pitch */
  staff?: 'treble' | 'bass';
}

/**
 * Lays grid notes out as complete bars on a grand staff. `tidy` applies the
 * clean-ups a live performance needs (legato gaps, stray rests, the closing note).
 */
export function buildBars(
  snapped: GridNote[],
  opts: { stepsPerBar: number; splitMidi?: number; tidy: boolean; barCount?: number },
): Bar[] {
  const { stepsPerBar, tidy } = opts;
  const split = opts.splitMidi ?? SPLIT_MIDI;
  const totalSteps = Math.max(0, ...snapped.map((n) => n.off));
  const barCount = Math.max(1, opts.barCount ?? 0, Math.ceil(totalSteps / stepsPerBar));
  const bars: Bar[] = Array.from({ length: barCount }, () => ({ treble: [], bass: [] }));

  for (const staff of ['treble', 'bass'] as const) {
    const notes = snapped.filter((n) => (n.staff ?? (n.midi >= split ? 'treble' : 'bass')) === staff);
    // One chord per onset; a chord ends at its shortest note or the next onset.
    const byOnset = new Map<number, Segment>();
    for (const n of notes) {
      const seg = byOnset.get(n.on);
      if (seg) {
        if (!seg.midis.includes(n.midi)) seg.midis.push(n.midi);
        seg.ids.push(n.id);
        seg.end = Math.min(seg.end, n.off);
      } else {
        byOnset.set(n.on, { start: n.on, end: n.off, midis: [n.midi], ids: [n.id] });
      }
    }
    const chords = [...byOnset.values()].sort((a, b) => a.start - b.start);
    chords.forEach((c, i) => {
      c.midis.sort((a, b) => a - b);
      const next = chords[i + 1];
      if (next) c.end = Math.min(c.end, next.start);
      if (!tidy) return;
      if (next) {
        // Players lift a little before the next note; a short gap is still legato, not a rest.
        const gap = next.start - c.end;
        if (gap <= Math.max(1, 0.35 * (next.start - c.start))) c.end = next.start;
      }
      // A note followed by a rest ends on the eighth-note grid, so no stray sixteenth rests.
      if (c.end % 2 === 1) c.end += 1;
      if (next) c.end = Math.min(c.end, next.start);
      // The closing note usually rings to the end of its bar.
      if (!next) {
        const barEnd = Math.ceil(c.end / stepsPerBar) * stepsPerBar;
        if (barEnd - c.end <= 4) c.end = barEnd;
      }
    });

    // Fill the gaps with rests so every bar is complete.
    const segments: Segment[] = [];
    let cursor = 0;
    for (const c of chords) {
      if (c.start > cursor) segments.push({ start: cursor, end: c.start, midis: [], ids: [] });
      segments.push(c);
      cursor = c.end;
    }
    if (cursor < barCount * stepsPerBar) {
      segments.push({ start: cursor, end: barCount * stepsPerBar, midis: [], ids: [] });
    }

    for (const seg of segments) {
      const pieces = splitDuration(seg.end - seg.start, seg.start, stepsPerBar);
      let pos = seg.start;
      pieces.forEach((dur, i) => {
        const rest = seg.midis.length === 0;
        bars[Math.floor(pos / stepsPerBar)][staff].push({
          rest,
          midis: seg.midis,
          dur,
          tieToNext: !rest && i < pieces.length - 1,
          tiedFromPrev: !rest && i > 0,
          ids: seg.ids,
        });
        pos += dur;
      });
    }
  }

  return bars;
}

function restTick(dur: number): Tick {
  return { rest: true, midis: [], dur, tieToNext: false, tiedFromPrev: false, ids: [] };
}
