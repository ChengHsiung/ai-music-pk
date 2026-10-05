// Plays melodies on the keyboard (MIDI out) or, without one, on the computer speakers.

import type { MidiIO } from '../io/midi';
import type { NoteEvent } from '../music/quantize';
import type { Melody } from './melody';

/** Where the notes sound. `at` is a performance.now() time. */
export interface Output {
  play(midi: number, velocity: number, durationMs: number, at: number): void;
  silence(): void;
}

export class MidiOutput implements Output {
  constructor(private midi: MidiIO) {}
  play(midi: number, velocity: number, durationMs: number, at: number) {
    this.midi.send(midi, velocity, durationMs, at);
  }
  silence() {
    this.midi.allNotesOff();
  }
}

/** A small piano-like synth for when no keyboard is connected. */
export class SpeakerOutput implements Output {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Set<{ gain: GainNode; oscs: OscillatorNode[] }>();

  private audio() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return { ctx: this.ctx, master: this.master! };
  }

  play(midi: number, velocity: number, durationMs: number, at: number) {
    const { ctx, master } = this.audio();
    const t = ctx.currentTime + Math.max(0, (at - performance.now()) / 1000);
    const end = t + durationMs / 1000;
    const f = 440 * 2 ** ((midi - 69) / 12);
    const peak = 0.12 + 0.28 * (velocity / 127);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.006);
    gain.gain.setTargetAtTime(peak * 0.3, t + 0.006, 0.45); // piano-like decay while held
    gain.gain.setTargetAtTime(0, end, 0.07); // release
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(9000, f * 6);
    gain.connect(filter).connect(master);

    const oscs = ([['triangle', 1, 1], ['sine', 2, 0.35], ['sine', 3, 0.12]] as const).map(([type, mult, level]) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(gain);
      osc.start(t);
      osc.stop(end + 0.5);
      return osc;
    });
    const voice = { gain, oscs };
    this.voices.add(voice);
    oscs[0].onended = () => this.voices.delete(voice);
  }

  silence() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setTargetAtTime(0, now, 0.03);
      v.oscs.forEach((o) => o.stop(now + 0.2));
    }
    this.voices.clear();
  }
}

/** A note with its time in ms from the start of the track. */
export interface TimedNote {
  midi: number;
  at: number;
  dur: number;
  velocity: number;
  /** Melody note index, or the event id of a recorded note */
  id: number;
}

export interface Track {
  notes: TimedNote[];
  /** ms from the start until the track is over */
  end: number;
}

/** The last bar slows down by up to this fraction, like a player closing a piece. */
const RITARDANDO = 0.3;

/** Times the AI melody: steady tempo, slightly detached notes, a ritardando in the last bar. */
export function melodyTrack(m: Melody, bpm: number): Track {
  const stepMs = 60000 / bpm / 4;
  const len = m.beatsPerBar * 4;
  const total = m.bars * len;
  const ritStart = total - len;
  const warp = (step: number) => {
    if (step <= ritStart) return step * stepMs;
    const x = step - ritStart;
    return (ritStart + x + (RITARDANDO * x * x) / (2 * len)) * stepMs;
  };
  const notes = m.notes.map((n, i) => {
    const at = warp(n.start);
    const length = warp(n.start + n.dur) - at;
    const last = i === m.notes.length - 1;
    return { midi: n.midi, at, dur: last ? length + 400 : length * 0.92, velocity: velocity(m, i), id: i };
  });
  return { notes, end: warp(total) };
}

/** Times a recorded performance exactly as it was played. */
export function eventsTrack(events: NoteEvent[]): Track {
  const done = events.filter((e) => e.end !== null).sort((a, b) => a.start - b.start);
  if (done.length === 0) return { notes: [], end: 0 };
  const t0 = done[0].start;
  const notes = done.map((e) => ({ midi: e.midi, at: e.start - t0, dur: Math.max(30, e.end! - e.start), velocity: e.velocity, id: e.id }));
  return { notes, end: Math.max(...notes.map((n) => n.at + n.dur)) };
}

export interface PlayerEvents {
  /** A note starts sounding (index into track.notes) */
  onNote(index: number, note: TimedNote): void;
  onEnd(): void;
}

const LOOKAHEAD_MS = 150;

/** Schedules notes slightly ahead of time so the rhythm stays steady. */
export class Player {
  private track: Track | null = null;
  private output: Output | null = null;
  private t0 = 0;
  private next = 0;
  private timer = 0;
  private uiTimers: number[] = [];
  private current = -1;
  playing = false;
  paused = false;

  constructor(private events: PlayerEvents) {}

  /** Starts from note `from` after `delayMs`. */
  play(track: Track, output: Output, from = 0, delayMs = 0) {
    this.stop();
    this.track = track;
    this.output = output;
    this.next = from;
    this.t0 = performance.now() + delayMs + 60 - (track.notes[from]?.at ?? 0);
    this.playing = true;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  pause() {
    if (!this.playing || !this.track) return;
    // Resume from the note sounding now (with the rest of its chord), or from the start.
    const notes = this.track.notes;
    const at = this.current >= 0 ? notes[this.current].at : -Infinity;
    const resumeAt = Math.max(0, notes.findIndex((n) => n.at >= at - 1));
    this.halt();
    this.next = resumeAt;
    this.paused = true;
  }

  resume() {
    if (!this.paused || !this.track || !this.output) return;
    this.play(this.track, this.output, this.next);
  }

  stop() {
    this.halt();
    this.paused = false;
    this.next = 0;
    this.current = -1;
  }

  private halt() {
    this.playing = false;
    clearInterval(this.timer);
    this.uiTimers.forEach((t) => clearTimeout(t));
    this.uiTimers = [];
    this.output?.silence();
  }

  private schedule() {
    const { notes, end } = this.track!;
    const now = performance.now();
    while (this.next < notes.length && this.t0 + notes[this.next].at < now + LOOKAHEAD_MS) {
      const i = this.next++;
      const n = notes[i];
      const at = this.t0 + n.at;
      this.output!.play(n.midi, n.velocity, n.dur, at);
      this.uiTimers.push(
        setTimeout(() => {
          this.current = i;
          this.events.onNote(i, n);
        }, Math.max(0, at - now)),
      );
    }
    if (this.next >= notes.length && now >= this.t0 + end) {
      this.halt();
      this.next = 0;
      this.current = -1;
      this.events.onEnd();
    }
  }
}

/** Accents on strong beats, a gentle swell toward the high point, a soft ending. */
export function velocity(m: Melody, i: number): number {
  const n = m.notes[i];
  const stepsPerBar = m.beatsPerBar * 4;
  const pos = n.start % stepsPerBar;
  let v = 68;
  if (pos === 0) v += 14;
  else if (pos === stepsPerBar / 2) v += 8;
  else if (pos % 4 === 0) v += 4;
  const highest = Math.max(...m.notes.map((x) => x.midi));
  if (n.midi === highest) v += 6;
  v += Math.round(8 * Math.sin((Math.PI * n.start) / (m.bars * stepsPerBar)));
  if (i === m.notes.length - 1) v = 64;
  return Math.max(40, Math.min(110, v));
}
