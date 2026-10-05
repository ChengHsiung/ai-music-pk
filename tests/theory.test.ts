import { describe, expect, it } from 'vitest';
import { detectKey, keyLabel, noteName, solfege, spell, vexKey } from '../src/music/theory';

describe('spell', () => {
  it('spells naturals in C major', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(71)).toBe('B4');
    expect(noteName(48)).toBe('C3');
  });

  it('uses sharps in sharp keys and flats in flat keys', () => {
    expect(noteName(66, 1)).toBe('F♯4'); // G major
    expect(noteName(70, -1)).toBe('B♭4'); // F major
    expect(noteName(63, 0)).toBe('D♯4'); // chromatic in C defaults to sharp
    expect(noteName(63, -3)).toBe('E♭4'); // E-flat major
  });

  it('writes a natural when the key would alter the letter', () => {
    expect(spell(65, 1)).toEqual({ letter: 'f', alter: 0, octave: 4 }); // F natural in G major
  });

  it('keeps the octave right for C-flat in G-flat major', () => {
    expect(spell(71, -6)).toEqual({ letter: 'c', alter: -1, octave: 5 });
    expect(vexKey(spell(71, -6))).toBe('cb/5');
  });
});

describe('solfege', () => {
  it('uses fixed do', () => {
    expect([60, 62, 64, 65, 67, 69, 71].map((m) => solfege(m))).toEqual(['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Si']);
    expect(solfege(61)).toBe('Do♯');
    expect(solfege(70, -1)).toBe('Si♭');
  });
});

describe('detectKey', () => {
  const notes = (ms: number[]) => ms.map((midi) => ({ midi }));

  it('reads Do Mi Sol as C major', () => {
    expect(keyLabel(detectKey(notes([60, 64, 67])))).toBe('C 大調');
  });

  it('reads Sol Si Re as G major', () => {
    expect(detectKey(notes([67, 71, 74])).fifths).toBe(1);
  });

  it('reads La Do Mi with a long La as a minor', () => {
    const key = detectKey([{ midi: 69, weight: 4 }, { midi: 72, weight: 1 }, { midi: 76, weight: 2 }, { midi: 69, weight: 4 }, { midi: 68, weight: 1 }]);
    expect(key.mode).toBe('minor');
    expect(keyLabel(key)).toBe('a 小調');
  });

  it('reads an F major scale as F major', () => {
    expect(detectKey(notes([65, 67, 69, 70, 72, 74, 76, 77])).fifths).toBe(-1);
  });
});
