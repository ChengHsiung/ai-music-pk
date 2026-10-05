// Plays the AI melody on the keyboard (MIDI out) or, without one, on the computer speakers.

import type { MidiIO } from '../io/midi';
import type { Melody, MelodyNote } from './melody';

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

export interface PlayerEvents {
  /** A note starts sounding (index into melody.notes) */
  onNote(index: number, note: MelodyNote): void;
  onEnd(): void;
}

const LOOKAHEAD_MS = 150;
/** The last bar slows down by up to this fraction, like a player closing a piece. */
const RITARDANDO = 0.3;

/** Schedules the melody slightly ahead of time so the rhythm stays steady. */
export class Player {
  private melody: Melody | null = null;
  private output: Output | null = null;
  private stepMs = 150;
  private t0 = 0;
  private next = 0;
  private timer = 0;
  private uiTimers: number[] = [];
  private current = -1;
  playing = false;
  paused = false;

  constructor(private events: PlayerEvents) {}

  /** Starts from note `from` after `delayMs`. */
  play(melody: Melody, bpm: number, output: Output, from = 0, delayMs = 0) {
    this.stop();
    this.paused = false;
    this.melody = melody;
    this.output = output;
    this.stepMs = 60000 / bpm / 4;
    this.next = from;
    this.t0 = performance.now() + delayMs + 60 - this.warp(melody.notes[from]?.start ?? 0);
    this.playing = true;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  pause() {
    if (!this.playing) return;
    // Resume from the note that is sounding now (or the next one if none has started).
    const resumeAt = Math.max(0, this.current);
    this.halt();
    this.next = resumeAt;
    this.paused = true;
  }

  resume(bpm: number) {
    if (!this.paused || !this.melody || !this.output) return;
    this.play(this.melody, bpm, this.output, this.next);
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

  /** Time in ms from the start of the tune to a step, with a ritardando in the last bar. */
  private warp(step: number): number {
    const total = this.melody ? this.melody.bars * this.melody.beatsPerBar * 4 : 0;
    const len = this.melody ? this.melody.beatsPerBar * 4 : 16;
    const ritStart = total - len;
    if (step <= ritStart || total === 0) return step * this.stepMs;
    const x = step - ritStart;
    return (ritStart + x + (RITARDANDO * x * x) / (2 * len)) * this.stepMs;
  }

  private schedule() {
    const m = this.melody!;
    const now = performance.now();
    while (this.next < m.notes.length && this.t0 + this.warp(m.notes[this.next].start) < now + LOOKAHEAD_MS) {
      const i = this.next++;
      const n = m.notes[i];
      const at = this.t0 + this.warp(n.start);
      const length = this.warp(n.start + n.dur) - this.warp(n.start);
      const last = i === m.notes.length - 1;
      this.output!.play(n.midi, velocity(m, i), last ? length + 400 : length * 0.92, at);
      this.uiTimers.push(
        setTimeout(() => {
          this.current = i;
          this.events.onNote(i, n);
        }, Math.max(0, at - now)),
      );
    }
    if (this.next >= m.notes.length) {
      const end = this.t0 + this.warp(m.bars * m.beatsPerBar * 4);
      if (now >= end) {
        this.halt();
        this.next = 0;
        this.current = -1;
        this.events.onEnd();
      }
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
