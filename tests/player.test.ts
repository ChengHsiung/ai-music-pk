import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offline } from '../src/ai/composer';
import { Melody } from '../src/ai/melody';
import { eventsTrack, LEFT_ID, melodyTrack, Output, Player, velocity } from '../src/ai/player';
import { C_MAJOR } from '../src/music/theory';

/** Within a few ms: the playing has a small human wobble. */
const near = (actual: number, expected: number, tolerance = 4) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

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
  pedals: { down: boolean; at: number }[] = [];
  silenced = 0;
  play(midi: number, vel: number, dur: number, at: number) {
    this.played.push({ midi, at, dur, vel });
  }
  pedal(down: boolean, at: number) {
    this.pedals.push({ down, at });
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
    player.play(melodyTrack(melody, 120), out);
    vi.advanceTimersByTime(6000);

    expect(out.played.map((p) => p.midi)).toEqual([60, 64, 67, 65, 62, 60]);
    expect(heard).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ended).toBe(1);
    const t0 = out.played[0].at;
    near(out.played[1].at - t0, 500, 7);
    near(out.played[2].at - t0, 1030, 7); // the high point comes a touch late
    near(out.played[3].at - t0, 2000, 7);
    // Ritardando: later notes in the last bar come a little late.
    expect(out.played[4].at - t0).toBeGreaterThan(2500);
    expect(out.played[5].at - t0).toBeGreaterThan(3000);
    expect(out.played[5].at - t0).toBeLessThan(3400);
    // A leap is slightly detached, steps overlap a little, and the final note rings on.
    expect(out.played[0].dur).toBeCloseTo(485);
    expect(out.played[4].dur).toBeGreaterThan(out.played[5].at - out.played[4].at);
    expect(out.played[5].dur).toBeGreaterThan(1000);
  });

  it('pauses and resumes from the note that was sounding', () => {
    const out = new Recorder();
    const heard: number[] = [];
    const player = new Player({ onNote: (i) => heard.push(i), onEnd: () => {} });
    player.play(melodyTrack(melody, 120), out);
    vi.advanceTimersByTime(1100); // the third note has started
    player.pause();
    expect(player.paused).toBe(true);
    expect(out.silenced).toBeGreaterThan(0);
    const before = out.played.length;
    vi.advanceTimersByTime(3000);
    expect(out.played.length).toBe(before); // nothing plays while paused

    player.resume();
    vi.advanceTimersByTime(6000);
    expect(heard).toEqual([0, 1, 2, 2, 3, 4, 5]);
  });

  it('stops cleanly', () => {
    const out = new Recorder();
    let ended = 0;
    const player = new Player({ onNote: () => {}, onEnd: () => ended++ });
    player.play(melodyTrack(melody, 120), out);
    vi.advanceTimersByTime(600);
    player.stop();
    const n = out.played.length;
    vi.advanceTimersByTime(6000);
    expect(out.played.length).toBe(n);
    expect(ended).toBe(0);
    expect(player.playing).toBe(false);
  });
});

describe('eventsTrack', () => {
  it('replays a recorded performance with its own timing', () => {
    const t = eventsTrack([
      { id: 7, midi: 64, velocity: 70, start: 1500, end: 1900 },
      { id: 5, midi: 60, velocity: 90, start: 1000, end: 1400 },
      { id: 9, midi: 67, velocity: 80, start: 2000, end: null }, // still held: skipped
    ]);
    expect(t.notes).toEqual([
      { midi: 60, at: 0, dur: 400, ring: 400, velocity: 90, id: 5, part: 'melody' },
      { midi: 64, at: 500, dur: 400, ring: 400, velocity: 70, id: 7, part: 'melody' },
    ]);
    expect(t.end).toBe(900);
  });

  it('replays the musician\'s pedal, which lets notes ring on', () => {
    const t = eventsTrack(
      [
        { id: 1, midi: 60, velocity: 80, start: 1000, end: 1200 },
        { id: 2, midi: 64, velocity: 80, start: 1500, end: 1700 },
      ],
      [
        { time: 900, down: true },
        { time: 1450, down: false },
        { time: 1600, down: true },
      ],
    );
    expect(t.pedals).toEqual([
      { at: 0, down: true },
      { at: 450, down: false },
      { at: 600, down: true },
      { at: 1000, down: false }, // lifted after the last note
    ]);
    expect(t.notes[0].ring).toBe(450);
    expect(t.notes[1].ring).toBe(500);
  });

  it('resumes a chord from its first note', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'performance'] });
    const out = new Recorder();
    const heard: number[] = [];
    const player = new Player({ onNote: (i) => heard.push(i), onEnd: () => {} });
    const chord = (start: number, ids: number[]) => ids.map((id) => ({ id, midi: 60 + id, velocity: 80, start, end: start + 300 }));
    player.play(eventsTrack([...chord(0, [1, 2]), ...chord(1000, [3, 4])]), out);
    vi.advanceTimersByTime(1200);
    player.pause();
    player.resume();
    vi.advanceTimersByTime(2000);
    expect(heard).toEqual([0, 1, 2, 3, 2, 3]);
    vi.useRealTimers();
  });
});

describe('velocity', () => {
  it('sings out the high point and ends softly', () => {
    const v = melody.notes.map((_, i) => velocity(melody, i));
    expect(Math.max(...v)).toBe(v[2]);
    expect(v[5]).toBe(62);
    v.forEach((x) => expect(x).toBeGreaterThanOrEqual(40));
  });

  it('accents a downbeat over the same note off the beat', () => {
    const m: Melody = { ...melody, notes: [64, 64, 64, 64, 62, 60].map((midi, i) => ({ midi, start: i * 2, dur: 2 })) };
    expect(velocity(m, 0)).toBeGreaterThan(velocity(m, 1));
  });
});

describe('melodyTrack with a left hand', () => {
  const m = offline({ motif: [60, 64, 67], key: C_MAJOR, bars: 8, seed: 1, feel: 'flowing' });
  const track = melodyTrack(m, m.bpm!);

  it('plays both hands, the melody above a softer left hand', () => {
    const melodyNotes = track.notes.filter((n) => n.part === 'melody');
    const left = track.notes.filter((n) => n.part === 'left');
    expect(melodyNotes).toHaveLength(m.notes.length);
    expect(left).toHaveLength(m.left!.length);
    expect(left.every((n) => n.id >= LEFT_ID)).toBe(true);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(melodyNotes.map((n) => n.velocity))).toBeGreaterThan(mean(left.map((n) => n.velocity)) + 10);
    // Sorted in time, and the pedal lets notes ring past their key release.
    track.notes.forEach((n, i) => i > 0 && expect(n.at).toBeGreaterThanOrEqual(track.notes[i - 1].at));
    expect(track.notes.every((n) => n.ring >= n.dur)).toBe(true);
    expect(left.some((n) => n.ring > n.dur + 50)).toBe(true);
  });

  it('changes the pedal with the harmony and lifts it at the end', () => {
    expect(track.pedals.length).toBeGreaterThan(4);
    track.pedals.forEach((p, i) => i > 0 && expect(p.at).toBeGreaterThanOrEqual(track.pedals[i - 1].at));
    expect(track.pedals.at(-1)!.down).toBe(false);
  });

  it('sends the pedal to outputs that have one', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'performance'] });
    const out = new Recorder();
    const player = new Player({ onNote: () => {}, onEnd: () => {} });
    player.play(track, out);
    vi.advanceTimersByTime(track.end + 3000);
    expect(out.pedals.map((p) => p.down)).toEqual(track.pedals.map((p) => p.down));
    expect(out.played).toHaveLength(track.notes.length);
    vi.useRealTimers();
  });
});
