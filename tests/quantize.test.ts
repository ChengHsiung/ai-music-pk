import { describe, expect, it } from 'vitest';
import { clusterOnsets, estimateBeatMs, NoteEvent, quantize, splitDuration } from '../src/music/quantize';

/** Builds events from [midi, startBeat, lengthBeats] at a tempo, with optional timing jitter. */
function play(notes: [number, number, number][], bpm: number, jitterMs = 0): NoteEvent[] {
  const beat = 60000 / bpm;
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * jitterMs;
  return notes.map(([midi, at, len], i) => {
    const start = 1000 + at * beat + rand();
    return { id: i + 1, midi, velocity: 80, start, end: start + len * beat * 0.9 + rand() };
  });
}

const sumDur = (ticks: { dur: number }[]) => ticks.reduce((s, t) => s + t.dur, 0);

describe('splitDuration', () => {
  it('keeps representable values whole', () => {
    expect(splitDuration(12, 0, 16)).toEqual([12]);
    expect(splitDuration(4, 4, 16)).toEqual([4]);
  });
  it('splits at the bar line', () => {
    expect(splitDuration(8, 12, 16)).toEqual([4, 4]);
  });
  it('splits awkward lengths into tied values', () => {
    expect(splitDuration(5, 0, 16)).toEqual([4, 1]);
    expect(splitDuration(20, 0, 16)).toEqual([16, 4]);
  });
});

describe('clusterOnsets', () => {
  it('groups notes struck together', () => {
    const ev = play([[60, 0, 1], [64, 0, 1], [67, 1, 1]], 100);
    ev[1].start += 20;
    expect(clusterOnsets(ev).map((c) => c.length)).toEqual([2, 1]);
  });
});

describe('estimateBeatMs', () => {
  it('finds a steady quarter-note pulse', () => {
    const onsets = Array.from({ length: 16 }, (_, i) => i * 600);
    expect(Math.abs(estimateBeatMs(onsets) - 600)).toBeLessThan(15);
  });

  it('finds 90 BPM in a melody with eighth notes and some jitter', () => {
    const melody: [number, number, number][] = [
      [60, 0, 1], [64, 1, 1], [67, 2, 0.5], [65, 2.5, 0.5], [64, 3, 1],
      [62, 4, 1], [64, 5, 0.5], [65, 5.5, 0.5], [67, 6, 2],
      [69, 8, 1], [67, 9, 1], [65, 10, 0.5], [64, 10.5, 0.5], [62, 11, 1], [60, 12, 4],
    ];
    const beat = estimateBeatMs(play(melody, 90, 15).map((e) => e.start));
    expect(Math.abs(60000 / beat - 90)).toBeLessThan(4);
  });
});

describe('quantize', () => {
  const melody: [number, number, number][] = [
    [60, 0, 1], [64, 1, 1], [67, 2, 2],
    [65, 4, 0.5], [64, 4.5, 0.5], [62, 5, 1], [60, 6, 2],
  ];

  it('rebuilds note values at a known tempo', () => {
    const score = quantize(play(melody, 100, 10), { bpm: 100 });
    expect(score.bars).toHaveLength(2);
    expect(score.bars[0].treble.map((t) => t.dur)).toEqual([4, 4, 8]);
    expect(score.bars[1].treble.map((t) => t.dur)).toEqual([2, 2, 4, 8]);
    expect(score.bars[1].treble.map((t) => t.midis[0])).toEqual([65, 64, 62, 60]);
    expect(score.bars[0].bass).toEqual([expect.objectContaining({ rest: true, dur: 16 })]);
  });

  it('fills every bar exactly in both staves', () => {
    const score = quantize(play([...melody, [48, 0, 4], [43, 4, 3]], 100, 25));
    for (const bar of score.bars) {
      expect(sumDur(bar.treble)).toBe(16);
      expect(sumDur(bar.bass)).toBe(16);
    }
  });

  it('ties a note across the bar line', () => {
    const score = quantize(play([[60, 0, 3], [62, 3, 2], [64, 5, 3]], 100), { bpm: 100 });
    const lastOfBar1 = score.bars[0].treble.at(-1)!;
    const firstOfBar2 = score.bars[1].treble[0];
    expect(lastOfBar1).toMatchObject({ midis: [62], dur: 4, tieToNext: true });
    expect(firstOfBar2).toMatchObject({ midis: [62], dur: 4, tiedFromPrev: true });
  });

  it('puts low notes on the bass staff and chords together', () => {
    const score = quantize(play([[48, 0, 4], [55, 0, 4], [64, 0, 4]], 100), { bpm: 100 });
    expect(score.bars[0].bass[0].midis).toEqual([48, 55]);
    expect(score.bars[0].treble[0].midis).toEqual([64]);
  });

  it('detects the key from the performance', () => {
    const g: [number, number, number][] = [[67, 0, 1], [71, 1, 1], [74, 2, 1], [72, 3, 1], [71, 4, 1], [69, 5, 1], [66, 6, 1], [67, 7, 1]];
    expect(quantize(play(g, 100), { bpm: 100 }).key.fifths).toBe(1);
  });

  it('returns one empty bar for no notes', () => {
    const score = quantize([]);
    expect(score.bars).toHaveLength(1);
    expect(score.bars[0].treble[0].rest).toBe(true);
  });
});

describe('closing note', () => {
  it('rings to the end of the bar when released a little early', () => {
    const score = quantize(play([[60, 0, 1], [64, 1, 1], [67, 2, 1], [72, 3, 1], [60, 4, 3.3]], 100), { bpm: 100 });
    expect(score.bars).toHaveLength(2);
    expect(score.bars[1].treble).toEqual([expect.objectContaining({ midis: [60], dur: 16 })]);
  });
});
