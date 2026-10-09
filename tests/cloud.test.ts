import { describe, expect, it } from 'vitest';
import { buildPrompt, parseCloudMelody } from '../src/ai/cloudComposer';
import { FEEL_BPM } from '../src/ai/melody';
import { C_MAJOR } from '../src/music/theory';

const req = { motif: [60, 64, 67], key: C_MAJOR, bars: 8 };

const answer = {
  feel: 'flowing',
  tempo: 84,
  chords: [['C'], ['F', 'C'], ['Dm', 'G'], ['G7'], ['C'], ['Am', 'Em'], ['Dm', 'G7'], ['C']],
  melody: ['C2 E2 G3 z', 'A2 G2 E4', 'F2 F2 E2 D2', 'D6 z2', 'C2 E2 G3 z', 'c2 B2 A2 G2', 'F2 E2 D2 B,2', 'C6 z2'],
  title: '小雲朵',
  idea: '像雲朵在天上慢慢飄',
};
const reply = (changes: Partial<Record<keyof typeof answer, unknown>> = {}) => JSON.stringify({ ...answer, ...changes });

describe('buildPrompt', () => {
  it('states the motif, key, length and range in ABC', () => {
    const p = buildPrompt(req);
    expect(p).toContain('The child played: C E G (solfège Do Mi Sol)');
    expect(p).toContain('K:C');
    expect(p).toContain('exactly 8 bars in 2 four-bar phrases');
    expect(p).toContain('between A, and d');
  });

  it('passes on the host\'s feel, or asks for a different one than last time', () => {
    expect(buildPrompt({ ...req, feel: 'march' })).toContain('Feel: march: brave and proud');
    const p = buildPrompt({ ...req, avoidFeel: 'bright' });
    expect(p).toContain('Feel: your choice');
    expect(p).toContain('but not "bright"');
  });
});

describe('parseCloudMelody', () => {
  it('reads the melody, chords, feel and tempo, and builds the left hand', () => {
    const m = parseCloudMelody(reply(), req);
    expect(m.engine).toBe('cloud');
    expect(m.title).toBe('小雲朵');
    expect(m.feel).toBe('flowing');
    expect(m.bpm).toBe(84);
    expect(m.notes.slice(0, 4).map((n) => n.midi)).toEqual([60, 64, 67, 69]);
    expect(m.notes).toHaveLength(23); // rests are kept as breaths
    expect(m.notes[2]).toEqual({ midi: 67, start: 8, dur: 6 });
    expect(m.notes[3].start).toBe(16);
    expect(m.chords).toHaveLength(12);
    expect(m.chords![1]).toEqual({ symbol: 'F', start: 16, dur: 8 });
    expect(m.left!.length).toBeGreaterThan(20);
    expect(m.pedals!.length).toBeGreaterThan(5);
  });

  it('repairs a motif that drifted and a tune written an octave too high', () => {
    const drift = parseCloudMelody(reply({ melody: ['D2 E2 G3 z', ...answer.melody.slice(1)] }), req);
    expect(drift.notes[0].midi).toBe(60);
    const high = parseCloudMelody(reply({ melody: ['c2 e2 g3 z', 'a2 g2 e4', ...answer.melody.slice(2).map((b) => b.toLowerCase())] }), req);
    expect(high.notes.slice(0, 5).map((n) => n.midi)).toEqual([60, 64, 67, 69, 67]);
  });

  it('works out chords itself when they cannot be read', () => {
    const m = parseCloudMelody(reply({ chords: answer.chords.map(() => ['H#13?']) }), req);
    expect(m.chords!.at(-1)!.symbol).toBe('C');
    expect(m.chords!.at(-2)!.symbol).toBe('G');
    expect(m.left!.length).toBeGreaterThan(0);
  });

  it('keeps the tempo near the feel and fills in a missing feel', () => {
    expect(parseCloudMelody(reply({ feel: 'gentle', tempo: 140 }), req).bpm).toBe(FEEL_BPM.gentle[1] + 8);
    expect(parseCloudMelody(reply({ feel: 'gentle', tempo: 'fast' }), req).bpm).toBe(73);
    const m = parseCloudMelody(reply({ feel: 'sad' }), { ...req, feel: 'march' });
    expect(m.feel).toBe('march');
  });

  it('rejects broken answers', () => {
    expect(() => parseCloudMelody('{"melody": [', req)).toThrow();
    expect(() => parseCloudMelody(reply({ melody: answer.melody.slice(0, 5) }), req)).toThrow('不完整');
    expect(() => parseCloudMelody(reply({ melody: answer.melody.map(() => 'hello') }), req)).toThrow();
  });
});
