// The host's control panel: a separate small window on the laptop screen, so the projector
// shows only the music. It is an about:blank popup driven entirely from the main window.

import { FEEL_LABEL, FEELS } from '../ai/accompaniment';

/** Options for the AI's character, shared by the footer and the console. */
export function feelOptions(): string {
  return ['<option value="auto">AI 自己選</option>', ...FEELS.map((f) => `<option value="${f}">${FEEL_LABEL[f]}</option>`)].join('');
}

export interface ConsoleButton {
  id: string;
  label: string;
  enabled: boolean;
  primary?: boolean;
  hint?: string;
}

export interface ConsoleRound {
  n: number;
  motif: string;
  human: boolean;
  ai: string | null;
}

export interface ConsoleView {
  title: string;
  prompt: string;
  status: string[];
  next: ConsoleButton;
  buttons: ConsoleButton[];
  bars: number;
  /** The AI's character, or 'auto' */
  feel: string;
  /** The AI's tempo; an empty value follows each tune, and the placeholder says what that is */
  aiBpm: { value: string; placeholder: string };
  /** Tempo used to tidy the musician's performance; empty means detected automatically */
  humanBpm: { value: string; detected: string; enabled: boolean };
  rounds: ConsoleRound[];
}

export interface ConsoleHandlers {
  /** A button or control was used; `arg` is a value or a round number */
  action(id: string, arg?: string): void;
  key(e: KeyboardEvent): void;
  closed(): void;
}

const STYLE = `
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; font-family: 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif;
  background: #fff7ea; color: #3d2c4e; }
h1 { margin: 0 0 4px; font-size: 22px; font-weight: 400; color: #6741d9; }
.prompt { color: #7b6c8c; min-height: 1.4em; margin-bottom: 10px; }
.status { font-size: 13px; color: #7b6c8c; margin: 0 0 12px; padding: 0; list-style: none; }
.status li { margin: 2px 0; }
button, select, input { font: inherit; }
button { font-size: 16px; padding: 9px 16px; border-radius: 999px; border: 2px solid #ead8c6;
  background: #fff; color: #3d2c4e; cursor: pointer; }
button:hover:not(:disabled) { background: #fff3e4; }
button:disabled { opacity: 0.4; cursor: default; }
.next { width: 100%; font-size: 22px; padding: 16px; background: #ff5c8d; border-color: #ff5c8d; color: #fff; margin-bottom: 12px; box-shadow: 0 4px 0 #d6336c; }
.buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.next:hover:not(:disabled) { background: #e64980; }
.buttons .primary { background: #7c6cff; border-color: #7c6cff; color: #fff; }
.buttons .primary:hover:not(:disabled) { background: #6741d9; }
.row { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 14px; font-size: 15px; }
.row input:disabled { opacity: 0.4; }
.row select, .row input { padding: 6px 8px; border-radius: 10px; border: 2px solid #ead8c6; background: #fff; color: #3d2c4e; width: 80px; }
.row select.wide { width: 110px; }
.row input[type="number"] { width: 100px; }
h2 { font-size: 16px; font-weight: 400; margin: 18px 0 8px; color: #7b6c8c; }
table { width: 100%; border-collapse: collapse; font-size: 14px; background: #fff; border-radius: 14px; }
td { padding: 6px 6px; border-top: 1px solid #f4e6d8; }
tr:first-child td { border-top: 0; }
td button { font-size: 13px; padding: 4px 10px; }
.empty { color: #9a8fa8; font-size: 14px; }
.keys { font-size: 12px; color: #9a8fa8; margin-top: 16px; }
`;

const BODY = () => `
<h1 id="title"></h1>
<div id="prompt" class="prompt"></div>
<ul id="status" class="status"></ul>
<div id="next"></div>
<div id="buttons" class="buttons"></div>
<div class="row">
  <label>AI 長度 <select data-action="bars">
    <option value="8">8 小節</option><option value="12">12 小節</option><option value="16">16 小節</option>
  </select></label>
  <label title="AI 自己選時，會挑適合小朋友這幾個音的曲風">AI 曲風 <select data-action="feel" class="wide">${feelOptions()}</select></label>
  <label title="留空時用 AI 為這首曲子選的速度">AI 速度 <input data-action="bpm" type="number" min="50" max="160" placeholder="自動" /> BPM</label>
  <label title="真人演奏結束後，速度抓錯時輸入正確的 BPM，樂譜會重新整理；清空則自動判斷">真人速度 <input data-action="human-bpm" type="number" min="40" max="200" placeholder="自動" /> BPM</label>
</div>
<h2>每局紀錄</h2>
<div id="rounds"></div>
<div class="keys">快捷鍵：→ 下一步 ｜ 1 出題 ｜ 2 開始演奏 ｜ 3 結束演奏 ｜ 4 AI 創作 ｜ 5 暫停／繼續 ｜ 6 並列樂譜 ｜ 0 自由彈奏</div>
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function buttonHtml(b: ConsoleButton, cls = '') {
  const classes = [cls, b.primary ? 'primary' : ''].filter(Boolean).join(' ');
  return `<button data-action="${esc(b.id)}" class="${classes}" ${b.enabled ? '' : 'disabled'} ${b.hint ? `title="${esc(b.hint)}"` : ''}>${esc(b.label)}</button>`;
}

export class HostConsole {
  private win: Window | null = null;
  private watch = 0;
  /** Last HTML per section, so buttons are only rebuilt when they change (keeps clicks reliable). */
  private cache = new Map<string, string>();

  constructor(private handlers: ConsoleHandlers) {}

  get isOpen(): boolean {
    return !!this.win && !this.win.closed;
  }

  /** Opens (or focuses) the console window; returns false if the browser blocked the popup. */
  open(): boolean {
    if (this.isOpen) {
      this.win!.focus();
      return true;
    }
    const w = window.open('', 'ai-music-pk-console', 'popup,width=560,height=860');
    if (!w) return false;
    this.win = w;
    this.cache.clear();
    const doc = w.document;
    doc.open();
    doc.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>主持人控制台・可愛師父 vs 分身師父</title><style>${STYLE}</style></head><body>${BODY()}</body></html>`);
    doc.close();
    doc.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('button[data-action]');
      if (el && !(el as HTMLButtonElement).disabled) this.handlers.action(el.dataset.action!, el.dataset.arg);
    });
    doc.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement;
      if (el.dataset.action) this.handlers.action(el.dataset.action, el.value);
    });
    w.addEventListener('keydown', (e) => this.handlers.key(e));
    clearInterval(this.watch);
    this.watch = window.setInterval(() => {
      if (this.isOpen) return;
      clearInterval(this.watch);
      this.win = null;
      this.handlers.closed();
    }, 500);
    return true;
  }

  close() {
    this.win?.close();
  }

  update(view: ConsoleView) {
    if (!this.isOpen) return;
    const doc = this.win!.document;
    const set = (id: string, html: string) => {
      if (this.cache.get(id) === html) return;
      this.cache.set(id, html);
      const el = doc.getElementById(id);
      if (el) el.innerHTML = html;
    };
    doc.getElementById('title')!.textContent = view.title;
    doc.getElementById('prompt')!.textContent = view.prompt;
    set('status', view.status.map((s) => `<li>${esc(s)}</li>`).join(''));
    set('next', buttonHtml(view.next, 'next'));
    set('buttons', view.buttons.map((b) => buttonHtml(b)).join(''));
    set(
      'rounds',
      view.rounds.length === 0
        ? '<div class="empty">還沒有紀錄。小朋友出完題後會自動記錄。</div>'
        : `<table>${view.rounds
            .map(
              (r) => `<tr><td>第 ${r.n} 局</td><td>${esc(r.motif)}</td>
              <td><button data-action="dl-human" data-arg="${r.n}" ${r.human ? '' : 'disabled'}>真人 MIDI</button></td>
              <td><button data-action="dl-ai" data-arg="${r.n}" ${r.ai ? '' : 'disabled'} title="${esc(r.ai ?? '')}">AI MIDI</button></td></tr>`,
            )
            .join('')}</table><p><button data-action="clear-rounds">清除所有紀錄</button></p>`,
    );
    const bars = doc.querySelector<HTMLSelectElement>('select[data-action="bars"]')!;
    const feel = doc.querySelector<HTMLSelectElement>('select[data-action="feel"]')!;
    const bpm = doc.querySelector<HTMLInputElement>('input[data-action="bpm"]')!;
    if (doc.activeElement !== bars) bars.value = String(view.bars);
    if (doc.activeElement !== feel) feel.value = view.feel;
    if (doc.activeElement !== bpm) bpm.value = view.aiBpm.value;
    bpm.placeholder = view.aiBpm.placeholder;
    const human = doc.querySelector<HTMLInputElement>('input[data-action="human-bpm"]')!;
    if (doc.activeElement !== human) human.value = view.humanBpm.value;
    human.placeholder = view.humanBpm.detected ? `自動 ${view.humanBpm.detected}` : '自動';
    human.disabled = !view.humanBpm.enabled;
  }

  /** Asks on the console window when it is open (the projector must not show dialogs). */
  confirm(text: string): boolean {
    return (this.isOpen ? this.win! : window).confirm(text);
  }
}
