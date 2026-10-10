// Writes a standard MIDI file (format 0) so each round's melodies can be kept and opened later.

export interface MidiFileNote {
  midi: number;
  /** Onset and length in ticks */
  tick: number;
  dur: number;
  velocity: number;
}

/** A control change such as the sustain pedal (64) */
export interface MidiFileControl {
  tick: number;
  controller: number;
  value: number;
}

export const PPQ = 480;

function varLen(n: number): number[] {
  const bytes = [n & 0x7f];
  while ((n >>= 7) > 0) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function writeMidiFile(notes: MidiFileNote[], bpm: number, name = '', controls: MidiFileControl[] = []): Uint8Array {
  const events: { tick: number; order: number; bytes: number[] }[] = [];
  for (const c of controls) {
    events.push({ tick: Math.max(0, Math.round(c.tick)), order: 0.5, bytes: [0xb0, c.controller & 0x7f, Math.max(0, Math.min(127, Math.round(c.value)))] });
  }
  for (const n of notes) {
    const midi = Math.max(0, Math.min(127, Math.round(n.midi)));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity)));
    const on = Math.max(0, Math.round(n.tick));
    const off = on + Math.max(1, Math.round(n.dur));
    events.push({ tick: on, order: 1, bytes: [0x90, midi, vel] });
    events.push({ tick: off, order: 0, bytes: [0x80, midi, 0] }); // note-offs first at the same tick
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const usPerQuarter = Math.round(60_000_000 / bpm);
  const track: number[] = [];
  if (name) {
    const text = [...new TextEncoder().encode(name)];
    track.push(0x00, 0xff, 0x03, ...varLen(text.length), ...text);
  }
  track.push(0x00, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
  track.push(0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08); // 4/4
  let last = 0;
  for (const e of events) {
    track.push(...varLen(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);

  return new Uint8Array([
    ...ascii('MThd'), ...u32(6), 0x00, 0x00, 0x00, 0x01, (PPQ >> 8) & 0xff, PPQ & 0xff,
    ...ascii('MTrk'), ...u32(track.length), ...track,
  ]);
}
