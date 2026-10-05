import { describe, expect, it } from 'vitest';
import { composeOffline, phrasePlan, Scale } from '../src/ai/offlineComposer';
import { AI_ID_BASE, Melody, melodySplit, scoreFromMelody, validateMelody } from '../src/ai/melody';
import { C_MAJOR, detectKey, Key } from '../src/music/theory';

const A_MINOR: Key = { fifths: 0, mode: 'minor', tonic: 9 };
const sumDur = (ticks: { dur: number }[]) => ticks.reduce((s, t) => s + t.dur, 0);

/** Checks the rules every composed tune must keep. */
function expectWellFormed(m: Melody, motif: number[], bars: number) {
  expect(m.bars).toBe(bars);
  const total = bars * 16;
  // Opens with the exact motif from the first beat.
  expect(m.notes.slice(0, motif.length).map((n) => n.midi)).toEqual(motif);
  expect(m.notes[0].start).toBe(0);
  // Back to back, no gaps or overlaps, fills every bar.
  for (let i = 0; i < m.notes.length; i++) {
    const n = m.notes[i];
    expect(n.dur).toBeGreaterThan(0);
    expect(n.start + n.dur).toBe(i + 1 < m.notes.length ? m.notes[i + 1].start : total);
    expect(n.midi).toBeGreaterThanOrEqual(36);
    expect(n.midi).toBeLessThanOrEqual(96);
  }
  // Ends on the tonic with a long note.
  const last = m.notes.at(-1)!;
  expect(((last.midi % 12) + 12) % 12).toBe(m.key.tonic);
  expect(last.dur).toBeGreaterThanOrEqual(4);
}

/** The offline composer also reaches the final tonic by step. */
function expectCadence(m: Melody) {
  const [a, b] = m.notes.slice(-2).map((n) => n.midi);
  expect(Math.abs(a - b)).toBeGreaterThan(0);
  expect(Math.abs(a - b)).toBeLessThanOrEqual(2);
}

describe('Scale', () => {
  it('maps degrees to notes and back', () => {
    const s = new Scale(C_MAJOR);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((d) => s.midi(d))).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(s.midi(-1)).toBe(59);
    expect(s.degreeOf(67)).toBe(4);
    expect(s.degreeOf(55)).toBe(-3);
    expect(s.degreeOf(61)).toBe(0); // C# maps to the degree below
  });
  it('raises the leading tone in minor only when asked', () => {
    const s = new Scale(A_MINOR);
    expect(s.midi(6)).toBe(67 + 12); // G above the A tonic at 69
    expect(s.midi(6, true)).toBe(68 + 12);
  });
});

describe('phrasePlan', () => {
  it('builds 8, 12 and 16 bar tunes ending on the tonic', () => {
    for (const bars of [8, 12, 16]) {
      const plan = phrasePlan(bars);
      expect(plan).toHaveLength(bars);
      expect(plan.at(-1)).toMatchObject({ chord: 'I', cadence: 'final' });
      expect(plan[0]).toMatchObject({ cell: 'orig' });
    }
  });
});

describe('composeOffline', () => {
  it('continues Do Mi Sol into 8 bars', () => {
    const motif = [60, 64, 67];
    const m = composeOffline({ motif, key: C_MAJOR, bars: 8, seed: 1 });
    expect(m.engine).toBe('offline');
    expectWellFormed(m, motif, 8);
  });

  it('gives the same tune for the same seed and a new one for a new seed', () => {
    const req = { motif: [64, 62, 60], key: C_MAJOR, bars: 8 };
    const a = composeOffline({ ...req, seed: 7 });
    const b = composeOffline({ ...req, seed: 7 });
    expect(a.notes).toEqual(b.notes);
    const others = [8, 9, 10, 11].map((seed) => JSON.stringify(composeOffline({ ...req, seed }).notes));
    expect(others.some((o) => o !== JSON.stringify(a.notes))).toBe(true);
  });

  it('keeps every rule for random motifs, keys and lengths', () => {
    let seed = 12345;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let t = 0; t < 150; t++) {
      const motif = [0, 1, 2].map(() => 48 + Math.floor(rand() * 37));
      const key = detectKey(motif.map((midi) => ({ midi })));
      const bars = [8, 12, 16][t % 3];
      const m = composeOffline({ motif, key, bars, seed: t });
      expectWellFormed(m, motif, bars);
      expectCadence(m);
    }
  });

  it('works in minor keys and with the motif in the bass', () => {
    const motif = [45, 48, 52];
    const m = composeOffline({ motif, key: A_MINOR, bars: 8, seed: 3 });
    expectWellFormed(m, motif, 8);
  });

  it('mostly moves by step', () => {
    const m = composeOffline({ motif: [60, 62, 64], key: C_MAJOR, bars: 16, seed: 5 });
    const steps = m.notes.slice(1).map((n, i) => Math.abs(n.midi - m.notes[i].midi));
    expect(steps.filter((s) => s <= 4).length / steps.length).toBeGreaterThan(0.7);
    expect(Math.max(...steps)).toBeLessThanOrEqual(12);
  });
});

describe('validateMelody', () => {
  const base = { bars: 2, beatsPerBar: 4, key: C_MAJOR, engine: 'cloud' as const };

  it('restores the motif and closes gaps and overlaps', () => {
    const v = validateMelody(
      {
        ...base,
        notes: [
          { midi: 61, start: 0, dur: 4 },
          { midi: 64, start: 4, dur: 2 }, // gap until 8
          { midi: 67, start: 8, dur: 8 }, // overlaps the next note
          { midi: 65, start: 12, dur: 4 },
          { midi: 64, start: 16, dur: 4 },
          { midi: 62, start: 20, dur: 4 },
          { midi: 60, start: 24, dur: 8 },
        ],
      },
      [60, 64, 67],
    )!;
    expectWellFormed(v, [60, 64, 67], 2);
    expect(v.notes[1]).toEqual({ midi: 64, start: 4, dur: 4 });
    expect(v.notes[2]).toEqual({ midi: 67, start: 8, dur: 4 });
  });

  it('drops notes past the end and clamps the range', () => {
    const v = validateMelody(
      {
        ...base,
        notes: [
          { midi: 60, start: 0, dur: 4 },
          { midi: 64, start: 4, dur: 4 },
          { midi: 67, start: 8, dur: 4 },
          { midi: 120, start: 12, dur: 4 },
          { midi: 64, start: 16, dur: 4 },
          { midi: 62, start: 20, dur: 4 },
          { midi: 60, start: 24, dur: 8 },
          { midi: 72, start: 40, dur: 4 },
        ],
      },
      [60, 64, 67],
    )!;
    expect(v.notes).toHaveLength(7);
    expect(v.notes[3].midi).toBe(96);
  });

  it('rejects a melody that is too short', () => {
    expect(validateMelody({ ...base, notes: [{ midi: 60, start: 0, dur: 32 }] }, [60, 64, 67])).toBeNull();
  });
});

describe('melodySplit', () => {
  const line = (...midis: number[]) => midis.map((midi, i) => ({ midi, start: i * 4, dur: 4 }));
  it('keeps one staff for a melody that fits it', () => {
    expect(melodySplit(line(60, 57, 72))).toBe(0);
    expect(melodySplit(line(48, 55, 62))).toBe(128);
    expect(melodySplit(line(45, 60, 76))).toBe(60);
  });
});

describe('scoreFromMelody', () => {
  it('lays the tune out as full bars on the grand staff', () => {
    const m = composeOffline({ motif: [55, 60, 64], key: C_MAJOR, bars: 12, seed: 2 });
    const score = scoreFromMelody(m, 96);
    expect(score.bpm).toBe(96);
    expect(score.bars).toHaveLength(12);
    for (const bar of score.bars) {
      expect(sumDur(bar.treble)).toBe(16);
      expect(sumDur(bar.bass)).toBe(16);
    }
    const ids = score.bars.flatMap((b) => [...b.treble, ...b.bass]).flatMap((t) => t.ids);
    expect(Math.min(...ids)).toBe(AI_ID_BASE);
    expect(new Set(ids).size).toBe(m.notes.length);
  });
});
