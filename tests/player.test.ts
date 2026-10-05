import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Melody } from '../src/ai/melody';
import { Output, Player, velocity } from '../src/ai/player';
import { C_MAJOR } from '../src/music/theory';

// Two bars at 120 BPM: a sixteenth is 125 ms.
const melody: Melody = {
  bars: 2,
  beatsPerBar: 4,
  key: C_MAJOR,
  engine: 'offline',
  notes: [
    { midi: 60, start: 0, dur: 4 },
    { midi: 64, start: 4, dur: 4 },
    { midi: 67, start: 8, dur: 8 },
    { midi: 65, start: 16, dur: 4 },
    { midi: 62, start: 20, dur: 4 },
    { midi: 60, start: 24, dur: 8 },
  ],
};

class Recorder implements Output {
  played: { midi: number; at: number; dur: number; vel: number }[] = [];
  silenced = 0;
  play(midi: number, vel: number, dur: number, at: number) {
    this.played.push({ midi, at, dur, vel });
  }
  silence() {
    this.silenced++;
  }
}

describe('Player', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  it('plays every note in time and slows down in the last bar', () => {
    const out = new Recorder();
    const heard: number[] = [];
    let ended = 0;
    const player = new Player({ onNote: (i) => heard.push(i), onEnd: () => ended++ });
    player.play(melody, 120, out);
    vi.advanceTimersByTime(6000);

    expect(out.played.map((p) => p.midi)).toEqual([60, 64, 67, 65, 62, 60]);
    expect(heard).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ended).toBe(1);
    const t0 = out.played[0].at;
    expect(out.played[1].at - t0).toBeCloseTo(500);
    expect(out.played[2].at - t0).toBeCloseTo(1000);
    expect(out.played[3].at - t0).toBeCloseTo(2000);
    // Ritardando: later notes in the last bar come a little late.
    expect(out.played[4].at - t0).toBeGreaterThan(2500);
    expect(out.played[5].at - t0).toBeGreaterThan(3000);
    expect(out.played[5].at - t0).toBeLessThan(3400);
    // Notes are slightly detached except the final one, which rings on.
    expect(out.played[0].dur).toBeCloseTo(460);
    expect(out.played[5].dur).toBeGreaterThan(1000);
  });

  it('pauses and resumes from the note that was sounding', () => {
    const out = new Recorder();
    const heard: number[] = [];
    const player = new Player({ onNote: (i) => heard.push(i), onEnd: () => {} });
    player.play(melody, 120, out);
    vi.advanceTimersByTime(1100); // the third note has started
    player.pause();
    expect(player.paused).toBe(true);
    expect(out.silenced).toBeGreaterThan(0);
    const before = out.played.length;
    vi.advanceTimersByTime(3000);
    expect(out.played.length).toBe(before); // nothing plays while paused

    player.resume(120);
    vi.advanceTimersByTime(6000);
    expect(heard).toEqual([0, 1, 2, 2, 3, 4, 5]);
  });

  it('stops cleanly', () => {
    const out = new Recorder();
    let ended = 0;
    const player = new Player({ onNote: () => {}, onEnd: () => ended++ });
    player.play(melody, 120, out);
    vi.advanceTimersByTime(600);
    player.stop();
    const n = out.played.length;
    vi.advanceTimersByTime(6000);
    expect(out.played.length).toBe(n);
    expect(ended).toBe(0);
    expect(player.playing).toBe(false);
  });
});

describe('velocity', () => {
  it('accents the downbeat and ends softly', () => {
    const v = melody.notes.map((_, i) => velocity(melody, i));
    expect(v[0]).toBeGreaterThan(v[1]);
    expect(v[3]).toBeGreaterThan(v[4]);
    expect(v[5]).toBe(64);
    v.forEach((x) => expect(x).toBeGreaterThanOrEqual(40));
  });
});
