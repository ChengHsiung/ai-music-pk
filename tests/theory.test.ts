import { describe, expect, it } from 'vitest';
import { detectKey, keyLabel, motifKey, noteName, solfege, spell, vexKey } from '../src/music/theory';

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

  it('keeps the letters of the raised 6th and 7th in minor keys', () => {
    expect(noteName(73, -1, true)).toBe('C♯5'); // leading tone of d minor
    expect(noteName(71, -1, true)).toBe('B4'); // raised 6th of d minor
    expect(noteName(73, -1)).toBe('D♭5'); // same note in F major
    expect(noteName(68, 0, true)).toBe('G♯4'); // a minor
    expect(noteName(62, -3, true)).toBe('D4'); // c minor: D stays diatonic
    expect(noteName(71, -3, true)).toBe('B4');
    expect(noteName(66, -2, true)).toBe('F♯4'); // g minor
    expect(noteName(64, -2, true)).toBe('E4');
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

describe('motifKey', () => {
  const key = (ms: number[]) => keyLabel(motifKey(ms));

  it('hears familiar children\'s openings in the key a teacher would', () => {
    expect(key([64, 64, 65, 67, 67])).toBe('C 大調'); // Mi Mi Fa Sol Sol
    expect(key([64, 62, 60, 62, 64])).toBe('C 大調'); // Mi Re Do Re Mi
    expect(key([60, 60, 67, 67, 69])).toBe('C 大調'); // Do Do Sol Sol La
    expect(key([67, 67, 69, 67, 72])).toBe('C 大調'); // Sol Sol La Sol Do
    expect(key([62, 62, 64, 62, 67])).toBe('G 大調'); // Re Re Mi Re Sol
  });

  it('reads three notes like before', () => {
    expect(key([60, 64, 67])).toBe('C 大調');
    expect(key([67, 71, 74])).toBe('G 大調');
    expect(key([64, 62, 60])).toBe('C 大調');
    expect(key([64, 65, 67])).toBe('C 大調');
    expect(key([62, 64, 66])).toBe('D 大調');
    expect(key([65, 69, 72])).toBe('F 大調');
  });

  it('chooses minor only when the minor third is there', () => {
    expect(key([69, 72, 76])).toBe('a 小調'); // La Do Mi
    expect(key([69, 71, 72, 71, 69])).toBe('a 小調');
    expect(key([62, 65, 69])).toBe('d 小調');
    expect(key([60, 62, 63])).toBe('c 小調');
    expect(motifKey([64, 62, 60, 62]).mode).toBe('major'); // no G, so not e minor
  });
});
