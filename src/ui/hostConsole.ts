// The host's control panel: a separate small window on the laptop screen, so the projector
// shows only the music. It is an about:blank popup driven entirely from the main window.

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
  bpm: number;
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
  background: #0f1b33; color: #f1f3f5; }
h1 { margin: 0 0 4px; font-size: 22px; }
.prompt { color: #adb5bd; min-height: 1.4em; margin-bottom: 10px; }
.status { font-size: 13px; color: #adb5bd; margin: 0 0 12px; padding: 0; list-style: none; }
.status li { margin: 2px 0; }
button, select, input { font: inherit; }
button { font-size: 16px; padding: 10px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.25);
  background: rgba(255,255,255,0.1); color: #f1f3f5; cursor: pointer; }
button:hover:not(:disabled) { background: rgba(255,255,255,0.2); }
button:disabled { opacity: 0.35; cursor: default; }
.next { width: 100%; font-size: 22px; font-weight: 700; padding: 18px; background: #1c7ed6; border-color: #1c7ed6; margin-bottom: 12px; }
.buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.buttons .primary { background: #e8590c; border-color: #e8590c; }
.row { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 14px; font-size: 15px; }
.row input:disabled { opacity: 0.4; }
.row select, .row input { padding: 6px; border-radius: 6px; border: 0; width: 80px; }
h2 { font-size: 16px; margin: 18px 0 8px; color: #adb5bd; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
td { padding: 6px 4px; border-top: 1px solid rgba(255,255,255,0.12); }
td button { font-size: 13px; padding: 4px 8px; }
.empty { color: #868e96; font-size: 14px; }
.keys { font-size: 12px; color: #868e96; margin-top: 16px; }
`;

const BODY = `
<h1 id="title"></h1>
<div id="prompt" class="prompt"></div>
<ul id="status" class="status"></ul>
<div id="next"></div>
<div id="buttons" class="buttons"></div>
<div class="row">
  <label>AI 長度 <select data-action="bars">
    <option value="8">8 小節</option><option value="12">12 小節</option><option value="16">16 小節</option>
  </select></label>
  <label>AI 速度 <input data-action="bpm" type="number" min="50" max="160" /> BPM</label>
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
    doc.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>主持人控制台・真人 vs AI 音樂 PK</title><style>${STYLE}</style></head><body>${BODY}</body></html>`);
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
        ? '<div class="empty">還沒有紀錄。小朋友彈完 3 個音後會自動記錄。</div>'
        : `<table>${view.rounds
            .map(
              (r) => `<tr><td>第 ${r.n} 局</td><td>${esc(r.motif)}</td>
              <td><button data-action="dl-human" data-arg="${r.n}" ${r.human ? '' : 'disabled'}>真人 MIDI</button></td>
              <td><button data-action="dl-ai" data-arg="${r.n}" ${r.ai ? '' : 'disabled'} title="${esc(r.ai ?? '')}">AI MIDI</button></td></tr>`,
            )
            .join('')}</table><p><button data-action="clear-rounds">清除所有紀錄</button></p>`,
    );
    const bars = doc.querySelector<HTMLSelectElement>('select[data-action="bars"]')!;
    const bpm = doc.querySelector<HTMLInputElement>('input[data-action="bpm"]')!;
    if (doc.activeElement !== bars) bars.value = String(view.bars);
    if (doc.activeElement !== bpm) bpm.value = String(view.bpm);
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
