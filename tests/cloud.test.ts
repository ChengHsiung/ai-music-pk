import { describe, expect, it } from 'vitest';
import { buildPrompt, melodyRange, parseCloudMelody } from '../src/ai/cloudComposer';
import { C_MAJOR } from '../src/music/theory';

const req = { motif: [60, 64, 67], key: C_MAJOR, bars: 8 };

describe('buildPrompt', () => {
  it('states the motif, key and length', () => {
    const p = buildPrompt(req);
    expect(p).toContain('60 (C4), 64 (E4), 67 (G4)');
    expect(p).toContain('C 大調');
    expect(p).toContain('exactly 8 bars');
    expect(p).toContain('step 128');
  });
  it('keeps the range around the motif', () => {
    expect(melodyRange([60, 64, 67])).toEqual([55, 76]);
    expect(melodyRange([40, 41, 43])).toEqual([48, 64]);
  });
});

describe('parseCloudMelody', () => {
  it('accepts a good answer', () => {
    const notes = [60, 64, 67, 65, 64, 62, 64, 60].map((midi, i) => ({ midi, start: i * 16, dur: 16 }));
    const m = parseCloudMelody(JSON.stringify({ title: '小星星', idea: '從 Do Mi Sol 出發', notes }), req);
    expect(m.engine).toBe('cloud');
    expect(m.title).toBe('小星星');
    expect(m.notes).toHaveLength(8);
  });
  it('repairs a motif that drifted', () => {
    const notes = [62, 64, 67, 65, 64, 62, 64, 60].map((midi, i) => ({ midi, start: i * 16, dur: 16 }));
    const m = parseCloudMelody(JSON.stringify({ title: '', idea: '', notes }), req);
    expect(m.notes[0].midi).toBe(60);
  });
  it('rejects broken answers', () => {
    expect(() => parseCloudMelody('{"notes": [', req)).toThrow();
    expect(() => parseCloudMelody('{"title":"x","idea":"y","notes":[]}', req)).toThrow('不完整');
  });
});
