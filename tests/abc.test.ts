import { describe, expect, it } from 'vitest';
import { abcKey, abcNote, parseAbcBars } from '../src/music/abc';

const pitches = (r: ReturnType<typeof parseAbcBars>) => r.notes.map((n) => n.midi);
const durs = (r: ReturnType<typeof parseAbcBars>) => r.notes.map((n) => n.dur);

describe('parseAbcBars', () => {
  it('reads pitches, octaves and lengths in eighth-note units', () => {
    const r = parseAbcBars(['C2 E2 G3 c', "c'4 C,4"], 0);
    expect(pitches(r)).toEqual([60, 64, 67, 72, 84, 48]);
    expect(durs(r)).toEqual([4, 4, 6, 2, 8, 8]);
    expect(r.notes.map((n) => n.start)).toEqual([0, 4, 8, 14, 16, 24]);
    expect(r.repaired).toEqual([]);
  });

  it('follows the key signature and bar-long accidentals', () => {
    // F major: B is flat; ^F lasts to the end of the bar, the next bar is back to the key.
    const r = parseAbcBars(['B2 ^F2 F2 =B2', 'F8'], -1);
    expect(pitches(r)).toEqual([70, 66, 66, 71, 65]);
  });

  it('reads rests, ties across the barline, and fractions', () => {
    const r = parseAbcBars(['z2 E3/2 F/ G4-', 'G4 z4'], 0);
    expect(r.notes).toEqual([
      { midi: null, start: 0, dur: 4 },
      { midi: 64, start: 4, dur: 3 },
      { midi: 65, start: 7, dur: 1 },
      { midi: 67, start: 8, dur: 16 },
      { midi: null, start: 24, dur: 8 },
    ]);
  });

  it('handles broken rhythm, triplets and chords', () => {
    const r = parseAbcBars(['A>B c<d (3cde f2', '[CEG]8'], 0);
    expect(durs(r)).toEqual([3, 1, 1, 3, 1, 2, 1, 4, 16]); // the triplet rounds to 1+2+1 sixteenths
    expect(pitches(r).at(-1)).toBe(67);
  });

  it('skips chord names, decorations and grace notes', () => {
    const r = parseAbcBars(['"C" !p! {g}C2 .E2 "G7" ~G4'], 0);
    expect(pitches(r)).toEqual([60, 64, 67]);
  });

  it('pads short bars with a rest and trims long ones', () => {
    const r = parseAbcBars(['C2 E2', 'G4 A4 B4 c4'], 0);
    expect(r.notes).toEqual([
      { midi: 60, start: 0, dur: 4 },
      { midi: 64, start: 4, dur: 4 },
      { midi: null, start: 8, dur: 8 },
      { midi: 67, start: 16, dur: 8 },
      { midi: 69, start: 24, dur: 8 },
    ]);
    expect(r.repaired).toEqual([1, 2]);
  });

  it('rejects text that is not music', () => {
    expect(() => parseAbcBars(['hello'], 0)).toThrow();
  });
});

describe('abcNote and abcKey', () => {
  it('spells notes for the given key', () => {
    expect(abcNote(60, 0)).toBe('C');
    expect(abcNote(72, 0)).toBe('c');
    expect(abcNote(84, 0)).toBe("c'");
    expect(abcNote(48, 0)).toBe('C,');
    expect(abcNote(66, 0)).toBe('^F');
    expect(abcNote(70, -1)).toBe('B');
    expect(abcNote(71, -1)).toBe('=B');
    expect(abcNote(68, 0, true)).toBe('^G'); // a minor's leading tone
  });

  it('names keys', () => {
    expect(abcKey(0, 0, false)).toBe('C');
    expect(abcKey(9, 0, true)).toBe('Am');
    expect(abcKey(2, -1, true)).toBe('Dm');
    expect(abcKey(10, -2, false)).toBe('Bb');
  });
});
