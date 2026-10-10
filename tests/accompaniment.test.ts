import { describe, expect, it } from 'vitest';
import { arrange, FEELS, harmonize } from '../src/ai/accompaniment';
import { MelodyNote } from '../src/ai/melody';
import { chordPitchClasses, degreeChord, parseChord } from '../src/music/chords';
import { C_MAJOR, Key } from '../src/music/theory';

const A_MINOR: Key = { fifths: 0, mode: 'minor', tonic: 9 };

// Eight bars over C major: Do Mi Sol, an answer, a half cadence on Re, then a return to Do.
const tune: MelodyNote[] = [
  [60, 0, 4], [64, 4, 4], [67, 8, 8],
  [69, 16, 4], [67, 20, 4], [64, 24, 8],
  [65, 32, 4], [65, 36, 4], [64, 40, 4], [62, 44, 4],
  [62, 48, 12],
  [60, 64, 4], [64, 68, 4], [67, 72, 8],
  [72, 80, 4], [71, 84, 4], [69, 88, 4], [67, 92, 4],
  [65, 96, 4], [64, 100, 4], [62, 104, 4], [59, 108, 4],
  [60, 112, 12],
].map(([midi, start, dur]) => ({ midi, start, dur }));
const TOTAL = 128;

describe('parseChord', () => {
  it('reads common chord symbols', () => {
    expect(parseChord('C')).toMatchObject({ root: 0, bass: 0, intervals: [0, 4, 7] });
    expect(parseChord('Am')).toMatchObject({ root: 9, intervals: [0, 3, 7] });
    expect(parseChord('G7')).toMatchObject({ root: 7, intervals: [0, 4, 7, 10] });
    expect(parseChord('Bb')).toMatchObject({ root: 10, intervals: [0, 4, 7] });
    expect(parseChord('F#m7b5')).toMatchObject({ root: 6, intervals: [0, 3, 6, 10] });
    expect(parseChord('Cmaj7')).toMatchObject({ intervals: [0, 4, 7, 11] });
    expect(parseChord('F/A')).toMatchObject({ root: 5, bass: 9 });
  });

  it('refuses what it cannot read', () => {
    expect(parseChord('H')).toBeNull();
    expect(parseChord('Cfoo')).toBeNull();
    expect(parseChord('C/X')).toBeNull();
  });
});

describe('degreeChord', () => {
  it('builds diatonic chords, with the raised leading tone on the minor dominant', () => {
    expect(degreeChord(C_MAJOR, 4, true).symbol).toBe('G7');
    expect(degreeChord(C_MAJOR, 5).symbol).toBe('Am');
    const e = degreeChord(A_MINOR, 4);
    expect(e.symbol).toBe('E');
    expect(chordPitchClasses(e)).toContain(8); // G#
    expect(degreeChord(A_MINOR, 0).symbol).toBe('Am');
  });
});

describe('harmonize', () => {
  const spans = harmonize(tune, C_MAJOR, 8);

  it('covers every bar without gaps, at most two chords a bar', () => {
    let at = 0;
    for (const s of spans) {
      expect(s.start).toBe(at);
      expect([8, 16]).toContain(s.dur);
      if (s.dur === 16) expect(s.start % 16).toBe(0);
      at += s.dur;
    }
    expect(at).toBe(TOTAL);
  });

  it('fits the melody and ends with a dominant → tonic cadence', () => {
    expect(spans[0].symbol).toBe('C');
    expect(spans.at(-1)!.symbol).toBe('C');
    expect(spans.at(-2)!.symbol).toBe('G');
    // Half cadence: the chord under the long Re at the end of bar 4 is the dominant.
    expect(spans.find((s) => s.start <= 56 && s.start + s.dur > 56)!.symbol).toBe('G');
  });
});

describe('arrange', () => {
  const spans = harmonize(tune, C_MAJOR, 8);

  for (const feel of FEELS) {
    it(`plays a ${feel} left hand below the melody`, () => {
      const { notes, pedals } = arrange(tune, spans, feel, TOTAL);
      expect(notes.length).toBeGreaterThan(8);
      for (const n of notes) {
        expect(n.midi).toBeGreaterThanOrEqual(n.start >= TOTAL - 16 ? 36 : 40); // the closing chord reaches lower
        expect(n.midi).toBeLessThanOrEqual(64);
        expect(n.start + n.dur).toBeLessThanOrEqual(TOTAL);
        const above = tune.filter((m) => m.start < n.start + n.dur && m.start + m.dur > n.start);
        for (const m of above) expect(n.midi).toBeLessThan(m.midi);
      }
      // The child's notes are heard alone first: the left hand enters on beat 3.
      expect(Math.min(...notes.map((n) => n.start))).toBe(8);
      // The piece closes on one held chord.
      const final = notes.filter((n) => n.start >= TOTAL - 16);
      expect(new Set(final.map((n) => n.start)).size).toBe(1);
      final.forEach((n) => expect(n.start + n.dur).toBe(TOTAL));
      expect(pedals.at(-1)!.end).toBe(TOTAL);
      if (feel === 'march') expect(pedals).toHaveLength(1);
      else expect(pedals.length).toBeGreaterThan(5);
    });
  }

  it('skips chords it cannot read', () => {
    const { notes } = arrange(tune, [{ start: 0, dur: 64, symbol: '??' }, { start: 64, dur: 64, symbol: 'C' }], 'gentle', TOTAL);
    expect(notes.every((n) => n.start >= 64)).toBe(true);
  });
});
