import { describe, expect, it } from 'vitest';
import { PPQ, writeMidiFile } from '../src/music/midiFile';

/** Minimal reader for the parts we write. */
function read(bytes: Uint8Array) {
  const text = (i: number, n: number) => String.fromCharCode(...bytes.slice(i, i + n));
  const u32 = (i: number) => (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
  expect(text(0, 4)).toBe('MThd');
  const ppq = (bytes[12] << 8) | bytes[13];
  expect(text(14, 4)).toBe('MTrk');
  const len = u32(18);
  const end = 22 + len;
  expect(end).toBe(bytes.length);
  let i = 22;
  let tick = 0;
  const notes: { type: string; tick: number; midi: number; vel: number }[] = [];
  let tempo = 0;
  while (i < end) {
    let delta = 0;
    let b: number;
    do {
      b = bytes[i++];
      delta = (delta << 7) | (b & 0x7f);
    } while (b & 0x80);
    tick += delta;
    const status = bytes[i++];
    if (status === 0xff) {
      const type = bytes[i++];
      const n = bytes[i++];
      if (type === 0x51) tempo = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      i += n;
    } else {
      notes.push({ type: status === 0x90 ? 'on' : status === 0xb0 ? 'cc' : 'off', tick, midi: bytes[i], vel: bytes[i + 1] });
      i += 2;
    }
  }
  return { ppq, tempo, notes };
}

describe('writeMidiFile', () => {
  it('writes notes, tempo and a valid track length', () => {
    const f = read(
      writeMidiFile(
        [
          { midi: 60, tick: 0, dur: PPQ, velocity: 80 },
          { midi: 64, tick: PPQ, dur: PPQ, velocity: 70 },
          { midi: 67, tick: 2 * PPQ, dur: 300 * PPQ, velocity: 90 }, // long delta needs several bytes
        ],
        120,
        'AI 的旋律',
      ),
    );
    expect(f.ppq).toBe(PPQ);
    expect(f.tempo).toBe(500000);
    expect(f.notes).toEqual([
      { type: 'on', tick: 0, midi: 60, vel: 80 },
      { type: 'off', tick: PPQ, midi: 60, vel: 0 },
      { type: 'on', tick: PPQ, midi: 64, vel: 70 },
      { type: 'off', tick: 2 * PPQ, midi: 64, vel: 0 },
      { type: 'on', tick: 2 * PPQ, midi: 67, vel: 90 },
      { type: 'off', tick: 302 * PPQ, midi: 67, vel: 0 },
    ]);
  });

  it('writes the sustain pedal between note-offs and note-ons at the same tick', () => {
    const f = read(
      writeMidiFile(
        [
          { midi: 48, tick: 0, dur: PPQ, velocity: 60 },
          { midi: 50, tick: PPQ, dur: PPQ, velocity: 60 },
        ],
        100,
        '',
        [
          { tick: 30, controller: 64, value: 127 },
          { tick: PPQ, controller: 64, value: 0 },
        ],
      ),
    );
    expect(f.notes).toEqual([
      { type: 'on', tick: 0, midi: 48, vel: 60 },
      { type: 'cc', tick: 30, midi: 64, vel: 127 },
      { type: 'off', tick: PPQ, midi: 48, vel: 0 },
      { type: 'cc', tick: PPQ, midi: 64, vel: 0 },
      { type: 'on', tick: PPQ, midi: 50, vel: 60 },
      { type: 'off', tick: 2 * PPQ, midi: 50, vel: 0 },
    ]);
  });
});
