// Pitch spelling, key detection and solfège helpers.

export type Letter = 'c' | 'd' | 'e' | 'f' | 'g' | 'a' | 'b';

export interface SpelledPitch {
  letter: Letter;
  /** -2..2 semitones relative to the natural letter */
  alter: number;
  octave: number;
}

export interface Key {
  /** Number of sharps (positive) or flats (negative) in the signature, -6..6 */
  fifths: number;
  mode: 'major' | 'minor';
  /** Pitch class of the tonic, 0 = C */
  tonic: number;
}

const LETTERS: Letter[] = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
const NATURAL_PC: Record<Letter, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const SHARP_ORDER: Letter[] = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
const FLAT_ORDER: Letter[] = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];

/** Fixed-do syllables, as taught on the piano in Taiwan. */
const SOLFEGE: Record<Letter, string> = { c: 'Do', d: 'Re', e: 'Mi', f: 'Fa', g: 'Sol', a: 'La', b: 'Si' };

/** Major-key signature for each tonic pitch class. */
const MAJOR_FIFTHS: Record<number, number> = {
  0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5,
};

const MAJOR_KEY_NAMES: Record<number, string> = {
  [-6]: 'Gb', [-5]: 'Db', [-4]: 'Ab', [-3]: 'Eb', [-2]: 'Bb', [-1]: 'F',
  0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#',
};

export const C_MAJOR: Key = { fifths: 0, mode: 'major', tonic: 0 };

export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

/** Alteration each letter carries in the key signature. */
export function signatureAlters(fifths: number): Record<Letter, number> {
  const alters: Record<Letter, number> = { c: 0, d: 0, e: 0, f: 0, g: 0, a: 0, b: 0 };
  const order = fifths >= 0 ? SHARP_ORDER : FLAT_ORDER;
  for (let i = 0; i < Math.abs(fifths); i++) alters[order[i]] = fifths >= 0 ? 1 : -1;
  return alters;
}

/** Spell a MIDI note in the given key: diatonic notes follow the signature, others use sharps in sharp keys and flats in flat keys. */
export function spell(midi: number, fifths = 0): SpelledPitch {
  const pc = pitchClass(midi);
  const sig = signatureAlters(fifths);

  let best: { letter: Letter; alter: number; rank: number } | null = null;
  for (const letter of LETTERS) {
    for (const alter of [-1, 0, 1]) {
      if (pitchClass(NATURAL_PC[letter] + alter) !== pc) continue;
      let rank: number;
      if (alter === sig[letter]) rank = 0; // diatonic in this key
      else if (alter === 0) rank = 1; // a natural
      else if (alter === (fifths >= 0 ? 1 : -1)) rank = 2; // accidental in the key's direction
      else rank = 3;
      if (!best || rank < best.rank) best = { letter, alter, rank };
    }
  }
  const { letter, alter } = best!;
  const octave = Math.floor((midi - alter) / 12) - 1;
  return { letter, alter, octave };
}

export function accidentalSymbol(alter: number): string {
  return alter > 0 ? '♯'.repeat(alter) : alter < 0 ? '♭'.repeat(-alter) : '';
}

/** Fixed-do syllable, e.g. 60 → "Do", 61 → "Do♯". */
export function solfege(midi: number, fifths = 0): string {
  const p = spell(midi, fifths);
  return SOLFEGE[p.letter] + accidentalSymbol(p.alter);
}

/** Scientific name, e.g. 60 → "C4", 70 in F major → "B♭4". */
export function noteName(midi: number, fifths = 0): string {
  const p = spell(midi, fifths);
  return p.letter.toUpperCase() + accidentalSymbol(p.alter) + p.octave;
}

/** VexFlow key string, e.g. "f#/4". */
export function vexKey(p: SpelledPitch): string {
  const acc = p.alter > 0 ? '#'.repeat(p.alter) : 'b'.repeat(-p.alter);
  return `${p.letter}${acc}/${p.octave}`;
}

/** VexFlow key-signature spec (relative major), e.g. "Bb". */
export function vexKeySignature(fifths: number): string {
  return MAJOR_KEY_NAMES[fifths] ?? 'C';
}

const TONIC_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Chinese display name, e.g. "C 大調" / "a 小調". */
export function keyLabel(key: Key): string {
  const name = spell(60 + key.tonic, key.fifths);
  const tonic = name.letter.toUpperCase() + accidentalSymbol(name.alter);
  return key.mode === 'major' ? `${tonic} 大調` : `${tonic.toLowerCase()} 小調`;
}

export function tonicName(pc: number): string {
  return TONIC_NAMES[pitchClass(pc)];
}

// Krumhansl–Kessler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/**
 * Estimate the key from notes weighted by duration. With only a few notes the
 * answer is ambiguous, so ties favour major keys with fewer accidentals and a
 * tonic equal to the first note.
 */
export function detectKey(notes: { midi: number; weight?: number }[]): Key {
  if (notes.length === 0) return C_MAJOR;
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[pitchClass(n.midi)] += n.weight ?? 1;
  const first = pitchClass(notes[0].midi);

  let best: Key = C_MAJOR;
  let bestScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      const rotated = profile.map((_, i) => profile[pitchClass(i - tonic)]);
      const fifths = MAJOR_FIFTHS[mode === 'major' ? tonic : pitchClass(tonic + 3)];
      let score = correlation(hist, rotated);
      score -= 0.01 * Math.abs(fifths);
      if (mode === 'minor') score -= 0.02;
      if (tonic === first) score += 0.02;
      if (score > bestScore) {
        bestScore = score;
        best = { fifths, mode, tonic };
      }
    }
  }
  return best;
}
