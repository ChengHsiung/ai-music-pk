// On-screen piano and computer-keyboard input, for rehearsing without the Yamaha.

import type { NoteHandler } from './midi';
import { solfege } from '../music/theory';

/** Computer keys mapped to MIDI notes, starting at C4 (A = Do). */
const KEYMAP: Record<string, number> = {
  KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65, KeyT: 66, KeyG: 67,
  KeyY: 68, KeyH: 69, KeyU: 70, KeyJ: 71, KeyK: 72, KeyO: 73, KeyL: 74, KeyP: 75, Semicolon: 76,
};

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

export class VirtualKeyboard {
  private down = new Set<number>();
  private byCode = new Map<string, number>();
  private keyEls = new Map<number, HTMLElement>();
  octaveShift = 0;

  constructor(
    private container: HTMLElement,
    private onNoteOn: NoteHandler,
    private onNoteOff: NoteHandler,
    private low = 48,
    private high = 84,
  ) {
    this.render();
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keyUp(e));
  }

  /** Lights up a key, used when notes come from the real keyboard too. */
  highlight(midi: number, on: boolean) {
    this.keyEls.get(midi)?.classList.toggle('active', on);
  }

  private render() {
    this.container.innerHTML = '';
    const whites = document.createElement('div');
    whites.className = 'vk-keys';
    for (let m = this.low; m <= this.high; m++) {
      const el = document.createElement('div');
      const black = BLACK_PCS.has(m % 12);
      el.className = black ? 'vk-key black' : 'vk-key white';
      el.dataset.midi = String(m);
      if (!black) {
        const label = document.createElement('span');
        label.textContent = solfege(m);
        el.appendChild(label);
      }
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.press(m);
      });
      el.addEventListener('pointerup', () => this.release(m));
      el.addEventListener('pointercancel', () => this.release(m));
      this.keyEls.set(m, el);
      whites.appendChild(el);
    }
    this.container.appendChild(whites);
  }

  private press(m: number) {
    if (this.down.has(m)) return;
    this.down.add(m);
    this.highlight(m, true);
    this.onNoteOn(m, 90, performance.now());
  }

  private release(m: number) {
    if (!this.down.delete(m)) return;
    this.highlight(m, false);
    this.onNoteOff(m, 0, performance.now());
  }

  private isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    return !!t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);
  }

  private keyDown(e: KeyboardEvent) {
    if (this.isTyping(e) || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyZ') { this.octaveShift = Math.max(-2, this.octaveShift - 1); return; }
    if (e.code === 'KeyX') { this.octaveShift = Math.min(2, this.octaveShift + 1); return; }
    const base = KEYMAP[e.code];
    if (base === undefined) return;
    e.preventDefault();
    const m = base + 12 * this.octaveShift;
    this.byCode.set(e.code, m);
    this.press(m);
  }

  private keyUp(e: KeyboardEvent) {
    const m = this.byCode.get(e.code);
    if (m === undefined) return;
    this.byCode.delete(e.code);
    this.release(m);
  }
}
