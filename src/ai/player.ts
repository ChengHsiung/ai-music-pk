// Plays melodies on the keyboard (MIDI out) or, without one, on the computer speakers.

import type { MidiIO } from '../io/midi';
import type { NoteEvent } from '../music/quantize';
import type { LeftNote } from './accompaniment';
import type { Melody } from './melody';

/** Where the notes sound. `at` is a performance.now() time. */
export interface Output {
  /**
   * `durationMs` is how long the key is held; `ringMs` how long the note sounds when the
   * sustain pedal keeps it ringing (outputs without a real pedal use it instead).
   */
  play(midi: number, velocity: number, durationMs: number, at: number, ringMs?: number): void;
  /** Sustain pedal, for outputs that have one */
  pedal?(down: boolean, at: number): void;
  silence(): void;
}

export class MidiOutput implements Output {
  constructor(private midi: MidiIO) {}
  play(midi: number, velocity: number, durationMs: number, at: number) {
    this.midi.send(midi, velocity, durationMs, at);
  }
  pedal(down: boolean, at: number) {
    this.midi.control(64, down ? 127 : 0, at);
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

  play(midi: number, velocity: number, durationMs: number, at: number, ringMs = durationMs) {
    const { ctx, master } = this.audio();
    const t = ctx.currentTime + Math.max(0, (at - performance.now()) / 1000);
    const end = t + Math.max(durationMs, ringMs) / 1000;
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
  /** How long the key is held */
  dur: number;
  /** How long it sounds, counting the sustain pedal */
  ring: number;
  velocity: number;
  /** Melody note index, left-hand note index + LEFT_ID, or the event id of a recorded note */
  id: number;
  part: 'melody' | 'left';
}

export interface PedalEvent {
  at: number;
  down: boolean;
}

export interface Track {
  notes: TimedNote[];
  pedals: PedalEvent[];
  /** ms from the start until the track is over, including the pedal's final lift */
  end: number;
}

/** Ids of left-hand notes in a track start here, after the melody's. */
export const LEFT_ID = 100_000;

/** The last bar slows down by up to this fraction, like a player closing a piece. */
const RITARDANDO = 0.3;
/** The last beat before a phrase ends takes a little longer: the player breathes. */
const PHRASE_BREATH = 0.12;

/** Milliseconds from the start for every sixteenth step, with the breaths and the closing ritardando. */
export function timeline(m: Melody, bpm: number): (step: number) => number {
  const stepMs = 60000 / bpm / 4;
  const len = m.beatsPerBar * 4;
  const total = m.bars * len;
  const ritStart = total - len;
  const phrase = 4 * len;
  const at = [0];
  for (let s = 0; s < total; s++) {
    let factor = 1;
    if (s >= ritStart) factor += (RITARDANDO * (s - ritStart + 0.5)) / len;
    else if ((s + 1) % phrase > phrase - 4 || (s + 1) % phrase === 0) factor += PHRASE_BREATH;
    at.push(at[s] + stepMs * factor);
  }
  return (step) => {
    const i = Math.max(0, Math.min(total, step));
    const lo = Math.floor(i);
    return lo >= total ? at[total] + (step - total) * stepMs * (1 + RITARDANDO) : at[lo] + (i - lo) * (at[lo + 1] - at[lo]);
  };
}

/** Is the pedal down at `ms`, and if so when does it come up? */
function pedalUpAfter(pedals: PedalEvent[], ms: number): number | null {
  let down = false;
  for (const p of pedals) {
    if (p.at > ms) return down ? p.at : null;
    down = p.down;
  }
  return down ? Infinity : null;
}

function withRing(notes: Omit<TimedNote, 'ring'>[], pedals: PedalEvent[], end: number): TimedNote[] {
  return notes.map((n) => {
    const up = pedalUpAfter(pedals, n.at + n.dur);
    const ring = up === null ? n.dur : Math.min(up, end + 1500) - n.at;
    return { ...n, ring: Math.max(n.dur, ring) };
  });
}

/**
 * Plays the AI's piece like a pianist would: the melody sings over a softer left hand,
 * connected notes overlap a little, each phrase swells toward its high point, and the
 * pedal is changed with every chord.
 */
export function melodyTrack(m: Melody, bpm: number): Track {
  const time = timeline(m, bpm);
  const stepsPerBar = m.beatsPerBar * 4;
  const total = m.bars * stepsPerBar;
  const phrase = 4 * stepsPerBar;
  const highest = Math.max(...m.notes.map((n) => n.midi));
  const peak = m.notes.findIndex((n) => n.midi === highest);

  const notes: Omit<TimedNote, 'ring'>[] = m.notes.map((n, i) => {
    let at = time(n.start) + jitter(i, 3);
    const length = time(n.start + n.dur) - time(n.start);
    const next = m.notes[i + 1];
    const end = n.start + n.dur;
    let dur: number;
    if (!next) dur = length + 600; // the last note rings on
    else if (next.start > end) dur = length * 0.9; // a rest follows: lift for the breath
    else if (end % phrase === 0) dur = length * 0.85; // breathe between phrases
    else if (next.midi === n.midi) dur = length * 0.82; // repeated notes need a gap
    else if (Math.abs(next.midi - n.midi) <= 2) dur = length + 25; // stepwise: legato overlap
    else dur = length * 0.97;
    if (i === peak) {
      at += 30; // lean into the high point
      dur *= 1.1;
    }
    return { midi: n.midi, at, dur, velocity: velocity(m, i), id: i, part: 'melody' as const };
  });

  const left = m.left ?? [];
  const detach = m.feel === 'march' ? 0.55 : 0.92; // a march's left hand is crisp, the others connected
  const finalStart = Math.min(...left.filter((n) => n.start >= total - stepsPerBar).map((n) => n.start));
  const finalChord = left.filter((n) => n.start === finalStart).map((n) => n.midi).sort((a, b) => a - b);
  left.forEach((n, j) => {
    // The melody leads a hair ahead, as pianists play; the closing chord is rolled from the bottom.
    let at = time(n.start) + 12 + jitter(j + 500, 5);
    if (n.start === finalStart) at += 25 * finalChord.indexOf(n.midi);
    const length = time(n.start + n.dur) - time(n.start);
    notes.push({
      midi: n.midi,
      at,
      dur: Math.max(60, length * detach),
      velocity: leftVelocity(m, n),
      id: LEFT_ID + j,
      part: 'left',
    });
  });

  const pedals: PedalEvent[] = [];
  for (const p of m.pedals ?? []) {
    pedals.push({ at: Math.max(0, time(p.start) - 15), down: false }); // lift just before the new chord
    pedals.push({ at: time(p.start) + 70, down: true }); // and press right after it (legato pedal)
    pedals.push({ at: p.end >= total ? time(total) + 1500 : time(p.end) - 20, down: false });
  }
  pedals.sort((a, b) => a.at - b.at || Number(a.down) - Number(b.down));

  notes.sort((a, b) => a.at - b.at || (a.part === 'melody' ? -1 : 1));
  const end = Math.max(time(total), ...notes.map((n) => n.at + n.dur));
  // The track lasts until the closing chord has rung out under the pedal.
  return { notes: withRing(notes, pedals, end), pedals, end: Math.max(end, pedals.at(-1)?.at ?? 0) };
}

/** A small, repeatable timing wobble (±amp ms), so the playing is not machine-exact. */
function jitter(i: number, amp: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amp;
}

/** Times a recorded performance exactly as it was played, with the musician's pedal. */
export function eventsTrack(events: NoteEvent[], pedalEvents: { time: number; down: boolean }[] = []): Track {
  const done = events.filter((e) => e.end !== null).sort((a, b) => a.start - b.start);
  if (done.length === 0) return { notes: [], pedals: [], end: 0 };
  const t0 = done[0].start;
  const notes = done.map((e) => ({
    midi: e.midi,
    at: e.start - t0,
    dur: Math.max(30, e.end! - e.start),
    velocity: e.velocity,
    id: e.id,
    part: 'melody' as const,
  }));
  const end = Math.max(...notes.map((n) => n.at + n.dur));
  const pedals = pedalEvents
    .map((p) => ({ at: Math.max(0, p.time - t0), down: p.down }))
    .filter((p) => p.at <= end + 1500) // ignore the pedal long after the last note
    .sort((a, b) => a.at - b.at);
  const last = pedals.at(-1);
  if (last?.down) pedals.push({ at: Math.max(end, last.at) + 300, down: false });
  return { notes: withRing(notes, pedals, end), pedals, end: Math.max(end, pedals.at(-1)?.at ?? 0) };
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
  private nextPedal = 0;
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
    const startAt = track.notes[from]?.at ?? 0;
    this.t0 = performance.now() + delayMs + 60 - startAt;
    // Pick the pedal up where it was when starting mid-piece.
    this.nextPedal = track.pedals.findIndex((p) => p.at >= startAt);
    if (this.nextPedal < 0) this.nextPedal = track.pedals.length;
    if (this.nextPedal > 0 && track.pedals[this.nextPedal - 1].down) output.pedal?.(true, this.t0 + startAt - 1);
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
    const { notes, pedals, end } = this.track!;
    const now = performance.now();
    const horizon = now + LOOKAHEAD_MS;
    while (this.nextPedal < pedals.length && this.t0 + pedals[this.nextPedal].at < horizon) {
      const p = pedals[this.nextPedal++];
      this.output!.pedal?.(p.down, this.t0 + p.at);
    }
    while (this.next < notes.length && this.t0 + notes[this.next].at < horizon) {
      const i = this.next++;
      const n = notes[i];
      const at = this.t0 + n.at;
      this.output!.play(n.midi, n.velocity, n.dur, at, n.ring);
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

/** How strongly the music is being played at `step`: each four-bar phrase swells toward its middle. */
export function phraseLevel(m: Melody, step: number): number {
  const stepsPerBar = m.beatsPerBar * 4;
  const phrase = 4 * stepsPerBar;
  const total = m.bars * stepsPerBar;
  const p = (step % phrase) / phrase;
  // Later phrases are a little stronger, until the last one settles down.
  const lastPhrase = step >= total - phrase;
  const base = lastPhrase ? 66 : 68 + 4 * Math.min(2, Math.floor(step / phrase));
  return base + 10 * Math.sin(Math.PI * Math.min(1, p * 1.15));
}

/** The left hand stays under the melody, a little stronger on its accented notes. */
export function leftVelocity(m: Melody, n: LeftNote): number {
  return Math.round(Math.max(28, Math.min(84, phraseLevel(m, n.start) - 20 + 14 * (n.accent - 0.7))));
}

/** The melody's touch: phrase swell, higher notes sung out, light accents, a soft ending. */
export function velocity(m: Melody, i: number): number {
  const n = m.notes[i];
  const stepsPerBar = m.beatsPerBar * 4;
  const phrase = 4 * stepsPerBar;
  const pos = n.start % stepsPerBar;
  let v = phraseLevel(m, n.start);
  // Follow the contour: higher than the phrase's average is a little louder.
  const inPhrase = m.notes.filter((x) => Math.floor(x.start / phrase) === Math.floor(n.start / phrase));
  const avg = inPhrase.reduce((sum, x) => sum + x.midi, 0) / inPhrase.length;
  v += Math.max(-10, Math.min(10, (n.midi - avg) * 1.2));
  if (pos === 0) v += 5;
  else if (pos === stepsPerBar / 2) v += 2;
  else if (pos % 4 !== 0) v -= 3; // off-beat notes lighter
  const highest = Math.max(...m.notes.map((x) => x.midi));
  if (n.midi === highest) v += 6;
  const next = m.notes[i + 1];
  if (next && (next.start > n.start + n.dur || (n.start + n.dur) % phrase === 0)) v -= 6; // phrase endings taper
  if (i === m.notes.length - 1) v = 62;
  return Math.round(Math.max(40, Math.min(108, v)));
}
