// Web MIDI wrapper: listens to every connected keyboard and sends to one output.

export type NoteHandler = (midi: number, velocity: number, time: number) => void;
export type PedalHandler = (down: boolean, time: number) => void;
export type StatusHandler = (status: MidiStatus) => void;

export interface MidiStatus {
  supported: boolean;
  inputs: string[];
  output: string | null;
  error?: string;
}

const PREFERRED_OUTPUT = /digital piano|p-1\d\d|yamaha/i;

export class MidiIO {
  private access: MIDIAccess | null = null;
  private output: MIDIOutput | null = null;
  private noteOn: NoteHandler[] = [];
  private noteOff: NoteHandler[] = [];
  private pedal: PedalHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private status: MidiStatus = { supported: false, inputs: [], output: null };

  onNoteOn(h: NoteHandler) { this.noteOn.push(h); }
  onNoteOff(h: NoteHandler) { this.noteOff.push(h); }
  /** The musician's sustain pedal (when one is plugged into the keyboard) */
  onPedal(h: PedalHandler) { this.pedal.push(h); }
  onStatus(h: StatusHandler) {
    this.statusHandlers.push(h);
    h(this.status);
  }

  async start(): Promise<MidiStatus> {
    if (!('requestMIDIAccess' in navigator)) {
      this.setStatus({ supported: false, inputs: [], output: null, error: '這個瀏覽器不支援 MIDI，請改用 Chrome 或 Edge。' });
      return this.status;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      this.setStatus({ supported: false, inputs: [], output: null, error: '瀏覽器拒絕存取 MIDI，請在網址列允許 MIDI 裝置。' });
      return this.status;
    }
    this.access.onstatechange = () => this.bind();
    this.bind();
    return this.status;
  }

  /** (Re)attach listeners after any plug/unplug. */
  private bind() {
    if (!this.access) return;
    const inputs: string[] = [];
    this.access.inputs.forEach((input) => {
      input.onmidimessage = (e) => this.handle(e);
      if (input.state === 'connected') inputs.push(input.name ?? '未命名裝置');
    });
    const outputs = [...this.access.outputs.values()].filter((o) => o.state === 'connected');
    this.output = outputs.find((o) => PREFERRED_OUTPUT.test(o.name ?? '')) ?? outputs[0] ?? null;
    this.setStatus({ supported: true, inputs, output: this.output?.name ?? null });
  }

  private handle(e: MIDIMessageEvent) {
    const data = e.data;
    if (!data || data.length < 3) return;
    const type = data[0] & 0xf0;
    const note = data[1];
    const velocity = data[2];
    const time = e.timeStamp || performance.now();
    if (type === 0x90 && velocity > 0) this.noteOn.forEach((h) => h(note, velocity, time));
    else if (type === 0x80 || (type === 0x90 && velocity === 0)) this.noteOff.forEach((h) => h(note, velocity, time));
    else if (type === 0xb0 && note === 64) this.pedal.forEach((h) => h(velocity >= 64, time));
  }

  private setStatus(s: MidiStatus) {
    this.status = s;
    this.statusHandlers.forEach((h) => h(s));
  }

  get canSend(): boolean {
    return this.output !== null;
  }

  /** Sends a note to the keyboard; `at` is a performance.now() time. */
  send(midi: number, velocity: number, durationMs: number, at = performance.now()) {
    if (!this.output) return;
    this.output.send([0x90, midi, velocity], at);
    this.output.send([0x80, midi, 0], at + durationMs);
  }

  /** Sends a control change (e.g. 64 = sustain pedal) at a performance.now() time. */
  control(controller: number, value: number, at = performance.now()) {
    this.output?.send([0xb0, controller, value], at);
  }

  allNotesOff() {
    if (!this.output) return;
    (this.output as MIDIOutput & { clear?: () => void }).clear?.(); // drop notes scheduled ahead
    this.output.send([0xb0, 64, 0]); // lift the pedal
    this.output.send([0xb0, 123, 0]);
  }
}
