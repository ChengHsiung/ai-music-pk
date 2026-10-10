// A sampled piano for the laptop speakers, so the AI sounds like a piano even without the keyboard.
// Samples: one recording every three semitones (C, D#, F#, A) from C2 to C7, shifted to the
// notes in between. They are bundled into the page, so this works offline too.
// From tonejs-instruments, CC BY 3.0 (see the README).

import type { Output, Track } from './player';

const FILES = import.meta.glob('./piano/*.mp3', { eager: true, import: 'default' }) as Record<string, string>;
const PITCH: Record<string, number> = { C: 0, Ds: 3, Fs: 6, A: 9 };

/** MIDI number of a sample from its file name, e.g. "./piano/Ds4.mp3" → 63. */
export function sampleMidi(path: string): number | null {
  const m = /([A-Z]s?)(\d)\.mp3$/.exec(path);
  if (!m || !(m[1] in PITCH)) return null;
  return 12 * (Number(m[2]) + 1) + PITCH[m[1]];
}

/** The recorded note closest to `midi` (ties go to the lower one, which sounds more natural shifted up). */
export function nearestSample(midi: number, available: number[]): number {
  let best = available[0];
  for (const s of available) if (Math.abs(s - midi) < Math.abs(best - midi)) best = s;
  return best;
}

interface Voice {
  gain: GainNode;
  src: AudioBufferSourceNode;
}

/**
 * The output stage: a touch of room reverb (from a generated impulse, so nothing to download)
 * and gentle compression. Returns the node voices connect to.
 */
function roomChain(ctx: BaseAudioContext): GainNode {
  const input = ctx.createGain();
  input.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 3;
  comp.connect(ctx.destination);
  input.connect(comp);

  const seconds = 1.8;
  const impulse = ctx.createBuffer(2, Math.floor(seconds * ctx.sampleRate), ctx.sampleRate);
  const predelay = Math.floor(0.012 * ctx.sampleRate);
  let seed = 7;
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = predelay; i < data.length; i++) {
      seed = (seed * 16807) % 2147483647;
      const noise = (seed / 2147483647) * 2 - 1;
      data[i] = noise * Math.exp((-4.5 * (i - predelay)) / data.length);
    }
  }
  const reverb = ctx.createConvolver();
  reverb.buffer = impulse;
  const wet = ctx.createGain();
  wet.gain.value = 0.16;
  input.connect(reverb).connect(wet).connect(comp);
  return input;
}

export class PianoOutput implements Output {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private loading: Promise<void> | null = null;
  private voices = new Set<Voice>();

  /** Used for the first notes if the samples are still loading. */
  constructor(private fallback: Output) {}

  get ready(): boolean {
    return this.buffers.size > 0;
  }

  /** Decodes the samples; safe to call before any user gesture. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const decoder = new OfflineAudioContext(1, 1, 44100);
      await Promise.all(
        Object.entries(FILES).map(async ([path, url]) => {
          const midi = sampleMidi(path);
          if (midi === null) return;
          try {
            const data = await (await fetch(url)).arrayBuffer();
            this.buffers.set(midi, await decoder.decodeAudioData(data));
          } catch (err) {
            console.warn('Piano sample failed to load', path, err);
          }
        }),
      );
    })();
    return this.loading;
  }

  private audio() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = roomChain(this.ctx);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return { ctx: this.ctx, master: this.master! };
  }

  play(midi: number, velocity: number, durationMs: number, at: number, ringMs = durationMs) {
    if (!this.ready) {
      this.load();
      this.fallback.play(midi, velocity, durationMs, at, ringMs);
      return;
    }
    const { ctx, master } = this.audio();
    const t = ctx.currentTime + Math.max(0, (at - performance.now()) / 1000);
    const voice = this.strike(ctx, master, midi, velocity, t, t + Math.max(durationMs, ringMs) / 1000);
    this.voices.add(voice);
    voice.src.onended = () => this.voices.delete(voice);
  }

  private strike(ctx: BaseAudioContext, master: AudioNode, midi: number, velocity: number, t: number, end: number): Voice {
    const base = nearestSample(midi, [...this.buffers.keys()]);
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.get(base)!;
    src.playbackRate.value = 2 ** ((midi - base) / 12);
    // Softer notes are quieter and darker, as on a real piano.
    const v = Math.max(1, Math.min(127, velocity)) / 127;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200 + 9000 * v * v;
    const gain = ctx.createGain();
    gain.gain.value = 0.08 + 0.85 * v ** 1.7;
    gain.gain.setTargetAtTime(0, end, 0.09); // the damper falls when the key (or pedal) is released
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-0.4, Math.min(0.4, (midi - 62) / 60)); // low notes left, high notes right
    src.connect(filter).connect(gain).connect(pan).connect(master);
    src.start(t);
    src.stop(end + 0.6);
    return { gain, src };
  }

  /** Renders a whole track to audio (for listening tests); the samples must be loaded. */
  async render(track: Track, sampleRate = 44100): Promise<AudioBuffer> {
    await this.load();
    const seconds = track.end / 1000 + 2.5;
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const master = roomChain(ctx);
    for (const n of track.notes) {
      const t = 0.1 + n.at / 1000;
      this.strike(ctx, master, n.midi, n.velocity, t, t + Math.max(n.dur, n.ring) / 1000);
    }
    return ctx.startRendering();
  }

  silence() {
    this.fallback.silence();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setTargetAtTime(0, now, 0.03);
      v.src.stop(now + 0.2);
    }
    this.voices.clear();
  }
}
