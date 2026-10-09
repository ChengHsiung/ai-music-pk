// A small reader for ABC music notation, one string per bar, so the cloud AI can write
// melodies the way tunes are usually written down (e.g. "E2 G2 c3 B") instead of numbers.
//
// Supported: notes A–G/a–g with ' and , octave marks, accidentals ^ ^^ _ __ = (lasting to the
// end of the bar), lengths (2, 3/2, /2, /, //), rests z/x, ties (-), broken rhythm (> <),
// triplets ((3), chords [CEG] (the top note is kept), and it skips chord names "C",
// decorations !p! and grace notes {g}.

import { pitchClass, signatureAlters, spell } from './theory';

type Letter = 'c' | 'd' | 'e' | 'f' | 'g' | 'a' | 'b';
const NATURAL_PC: Record<Letter, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export interface AbcNote {
  /** MIDI number, or null for a rest */
  midi: number | null;
  /** Onset and length in sixteenth-note steps from the start of the piece */
  start: number;
  dur: number;
}

export interface AbcResult {
  notes: AbcNote[];
  /** Bars whose length was wrong and had to be padded or trimmed (1-based) */
  repaired: number[];
}

interface Token {
  midi: number | null;
  /** Length in units of the default note length */
  len: number;
  tie: boolean;
}

/** Parses one bar into tokens; throws on text that is not ABC. */
function tokenize(bar: string, keyAlters: Record<Letter, number>): Token[] {
  const tokens: Token[] = [];
  const barAlters = new Map<string, number>(); // "c5" → alteration for the rest of the bar
  let i = 0;
  let tuplet: { left: number; factor: number } | null = null;
  let broken: { factor: number } | null = null;

  const readLength = (): number => {
    const m = /^(\d*)(\/*)(\d*)/.exec(bar.slice(i))!;
    i += m[0].length;
    const num = m[1] ? Number(m[1]) : 1;
    if (!m[2]) return num;
    const den = m[3] ? Number(m[3]) : 2 ** m[2].length;
    return num / den;
  };

  const readNote = (): number | null => {
    let accidental: number | null = null;
    const acc = /^(\^\^|\^|__|_|=)/.exec(bar.slice(i));
    if (acc) {
      accidental = { '^^': 2, '^': 1, __: -2, _: -1, '=': 0 }[acc[1]]!;
      i += acc[1].length;
    }
    const ch = bar[i];
    if (ch === 'z' || ch === 'x') {
      i++;
      return null;
    }
    if (!/[A-Ga-g]/.test(ch ?? '')) throw new Error(`Not ABC near "${bar.slice(i, i + 6)}"`);
    i++;
    const letter = ch.toLowerCase() as Letter;
    let octave = ch === ch.toUpperCase() ? 4 : 5;
    while (bar[i] === "'" || bar[i] === ',') octave += bar[i++] === "'" ? 1 : -1;
    const keyName = `${letter}${octave}`;
    if (accidental !== null) barAlters.set(keyName, accidental);
    const alter = barAlters.get(keyName) ?? keyAlters[letter];
    return 12 * (octave + 1) + NATURAL_PC[letter] + alter;
  };

  while (i < bar.length) {
    const ch = bar[i];
    if (/\s|\|/.test(ch)) {
      i++;
    } else if (ch === '"') {
      const end = bar.indexOf('"', i + 1); // chord name or annotation
      i = end < 0 ? bar.length : end + 1;
    } else if (ch === '!' || ch === '+') {
      const end = bar.indexOf(ch, i + 1); // decoration
      i = end < 0 ? bar.length : end + 1;
    } else if (ch === '{') {
      const end = bar.indexOf('}', i + 1); // grace notes
      i = end < 0 ? bar.length : end + 1;
    } else if ('.~HLMOPSTuv'.includes(ch)) {
      i++; // short decorations
    } else if (ch === '(' && /\d/.test(bar[i + 1] ?? '')) {
      const n = Number(bar[i + 1]);
      i += 2;
      tuplet = { left: n, factor: n === 3 ? 2 / 3 : n === 2 ? 3 / 2 : (n - 1) / n };
    } else if (ch === '(' || ch === ')') {
      i++; // slurs
    } else if (ch === '>' || ch === '<') {
      // a>b: the first is dotted and the second halved (and the reverse for <).
      let count = 0;
      while (bar[i] === ch) {
        count++;
        i++;
      }
      const prev = tokens.at(-1);
      const shift = 1 - 0.5 ** count;
      if (prev) prev.len *= ch === '>' ? 1 + shift : 1 - shift;
      broken = { factor: ch === '>' ? 1 - shift : 1 + shift };
    } else {
      let midi: number | null;
      if (ch === '[') {
        // A chord: keep the top note, the melody.
        i++;
        const notes: (number | null)[] = [];
        while (i < bar.length && bar[i] !== ']') {
          if (/\s/.test(bar[i])) i++;
          else {
            notes.push(readNote());
            readLength();
          }
        }
        i++;
        const pitched = notes.filter((n): n is number => n !== null);
        midi = pitched.length ? Math.max(...pitched) : null;
      } else {
        midi = readNote();
      }
      let len = readLength();
      if (tuplet) {
        len *= tuplet.factor;
        if (--tuplet.left <= 0) tuplet = null;
      }
      if (broken) {
        len *= broken.factor;
        broken = null;
      }
      let tie = false;
      if (bar[i] === '-') {
        tie = true;
        i++;
      }
      tokens.push({ midi, len, tie });
    }
  }
  return tokens;
}

/**
 * Rounds lengths to whole sixteenths while keeping their running total, so a triplet
 * becomes e.g. 2+1+1 rather than three notes that no longer fit the bar.
 */
function toSteps(lens: number[], stepsPerUnit: number): number[] {
  let exact = 0;
  let placed = 0;
  return lens.map((len) => {
    exact += len * stepsPerUnit;
    const end = Math.round(exact);
    const dur = Math.max(end - placed, 0);
    placed = end;
    return dur;
  });
}

/**
 * Reads a melody written as one ABC string per bar. Each bar is made exactly `stepsPerBar`
 * long: a short bar is filled with a rest, a long one has its end cut off.
 */
export function parseAbcBars(bars: string[], fifths: number, unit = 1 / 8, stepsPerBar = 16): AbcResult {
  const keyAlters = signatureAlters(fifths) as Record<Letter, number>;
  const stepsPerUnit = unit * 16;
  const notes: AbcNote[] = [];
  const repaired: number[] = [];
  let tieOpen = false;

  bars.forEach((text, b) => {
    const tokens = tokenize(text, keyAlters);
    const steps = toSteps(
      tokens.map((t) => t.len),
      stepsPerUnit,
    );
    const barStart = b * stepsPerBar;
    let pos = 0;
    let fixed = false;
    tokens.forEach((t, k) => {
      let dur = steps[k];
      if (dur <= 0) return;
      if (pos + dur > stepsPerBar) {
        dur = stepsPerBar - pos;
        fixed = true;
      }
      if (dur <= 0) return;
      const last = notes.at(-1);
      if (tieOpen && last && last.midi !== null && last.midi === t.midi && last.start + last.dur === barStart + pos) {
        last.dur += dur;
      } else {
        notes.push({ midi: t.midi, start: barStart + pos, dur });
      }
      tieOpen = t.tie && t.midi !== null;
      pos += dur;
    });
    if (pos < stepsPerBar) {
      if (pos > 0 || tokens.length > 0) fixed = true;
      notes.push({ midi: null, start: barStart + pos, dur: stepsPerBar - pos });
      tieOpen = false;
    }
    if (fixed) repaired.push(b + 1);
  });

  // Join neighbouring rests.
  const merged: AbcNote[] = [];
  for (const n of notes) {
    const last = merged.at(-1);
    if (last && last.midi === null && n.midi === null) last.dur += n.dur;
    else merged.push({ ...n });
  }
  return { notes: merged, repaired };
}

/** ABC spelling of a MIDI note in a key, e.g. 60 → "C", 72 → "c", 66 in C → "^F". */
export function abcNote(midi: number, fifths: number, minor = false): string {
  const p = spell(midi, fifths, minor);
  const keyAlter = (signatureAlters(fifths) as Record<Letter, number>)[p.letter as Letter];
  const acc = p.alter === keyAlter ? '' : p.alter === 0 ? '=' : p.alter > 0 ? '^'.repeat(p.alter) : '_'.repeat(-p.alter);
  let name = p.octave >= 5 ? p.letter : p.letter.toUpperCase();
  if (p.octave >= 5) name += "'".repeat(p.octave - 5);
  else name += ','.repeat(4 - p.octave);
  return acc + name;
}

/** ABC key field for a key, e.g. "C", "Am", "Bb", "F#m". */
export function abcKey(tonicPc: number, fifths: number, minor: boolean): string {
  const names = fifths < 0
    ? ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
    : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return names[pitchClass(tonicPc)] + (minor ? 'm' : '');
}
