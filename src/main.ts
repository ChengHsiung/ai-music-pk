import './styles.css';
import { cloudEnabled, compose, ComposeSettings, describeError, Engine, offline } from './ai/composer';
import { composeCloud } from './ai/cloudComposer';
import { AI_ID_BASE, ComposeRequest, Melody, scoreFromMelody } from './ai/melody';
import { MidiOutput, Player, SpeakerOutput } from './ai/player';
import { MidiIO, MidiStatus } from './io/midi';
import { VirtualKeyboard } from './io/virtualKeyboard';
import { clusterOnsets, NoteEvent, quantize, QuantizedScore } from './music/quantize';
import { C_MAJOR, detectKey, Key, keyLabel, noteName, pitchClass, solfege } from './music/theory';
import { LiveGroup, renderLive, renderScore, ScoreView } from './render/notation';

type Stage = 'free' | 'motif' | 'ready' | 'performing' | 'review' | 'ai';
type AiStatus = 'composing' | 'playing' | 'paused' | 'done';

const STAGE_TEXT: Record<Stage, { label: string; prompt: string }> = {
  free: { label: '自由彈奏', prompt: '彈任何音，五線譜會即時顯示' },
  motif: { label: '小朋友出題', prompt: '請小朋友彈 3 個音' },
  ready: { label: '動機完成', prompt: '音樂家準備好就開始彈，第一個音會自動開始記錄' },
  performing: { label: '真人音樂家演奏中', prompt: '' },
  review: { label: '真人音樂家的作品', prompt: '' },
  ai: { label: 'AI 創作', prompt: '' },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  stage: 'free' as Stage,
  nextId: 1,
  /** Notes shown in free play (not recorded) */
  freeEvents: [] as NoteEvent[],
  motif: [] as NoteEvent[],
  motifKey: C_MAJOR as Key,
  performance: [] as NoteEvent[],
  held: new Map<number, NoteEvent>(),
  score: null as QuantizedScore | null,
  showSolfege: true,
  dirty: true,
  ai: {
    status: 'composing' as AiStatus,
    melody: null as Melody | null,
    /** Notes starting before this sixteenth are shown */
    step: Infinity,
    /** Event ids sounding now */
    nowIds: [] as number[],
    line: -1,
    seed: 1,
    composeStarted: 0,
  },
};

// ---------------------------------------------------------------- settings

interface Settings extends ComposeSettings {
  bars: number;
  bpm: number;
  output: 'auto' | 'speaker';
}

/** Kept in this browser only (the API key never leaves the event computer except to call Claude). */
function loadSettings(): Settings {
  const defaults: Settings = { engine: 'auto', apiKey: '', bars: 8, bpm: 96, output: 'auto' };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('ai-music-pk.settings') ?? '{}') };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem('ai-music-pk.settings', JSON.stringify(settings));
  } catch {
    // Private windows may block storage; the settings still apply until the page closes.
  }
}

const settings = loadSettings();

// ---------------------------------------------------------------- input

function noteOn(midi: number, velocity: number, time: number) {
  vk.highlight(midi, true);
  const ev: NoteEvent = { id: state.nextId++, midi, velocity, start: time, end: null };
  closeHeld(midi, time); // a repeated note-on without a note-off ends the previous one
  state.held.set(midi, ev);

  switch (state.stage) {
    case 'free':
      state.freeEvents.push(ev);
      if (state.freeEvents.length > 200) state.freeEvents.splice(0, 100);
      break;
    case 'motif':
      captureMotif(ev);
      break;
    case 'ready':
      setStage('performing');
      state.performance.push(ev);
      break;
    case 'performing':
      state.performance.push(ev);
      break;
    case 'review':
    case 'ai':
      break;
  }
  state.dirty = true;
}

function closeHeld(midi: number, time: number) {
  const ev = state.held.get(midi);
  if (ev && ev.end === null) ev.end = Math.max(time, ev.start + 1);
  state.held.delete(midi);
}

function noteOff(midi: number, _velocity: number, time: number) {
  vk.highlight(midi, false);
  closeHeld(midi, time);
  state.dirty = true;
}

/** Takes one note per onset: if a child presses several keys at once, the highest counts. */
function captureMotif(ev: NoteEvent) {
  const last = state.motif.at(-1);
  if (last && ev.start - last.start < 60) {
    if (ev.midi > last.midi) state.motif[state.motif.length - 1] = ev;
    flash('請一次彈一個音');
  } else if (state.motif.length < 3) {
    state.motif.push(ev);
  }
  if (state.motif.length === 3) {
    state.motifKey = detectKey(state.motif);
    setTimeout(() => {
      if (state.stage !== 'motif' || state.motif.length !== 3) return;
      setStage('ready');
      // The AI starts composing now, while the musician plays, so nobody waits for it later.
      ensureJob();
    }, 400);
  }
}

// ---------------------------------------------------------------- stages

function setStage(stage: Stage) {
  if (state.stage === 'ai' && stage !== 'ai') stopAi();
  state.stage = stage;
  if (stage === 'motif') {
    job?.controller.abort(); // a new motif needs a new tune
    job = null;
    state.motif = [];
    state.performance = [];
    state.score = null;
  }
  if (stage === 'performing') {
    state.performance = [];
    state.score = null;
  }
  if (stage === 'review') finishPerformance();
  state.dirty = true;
  updateChrome();
}

function finishPerformance() {
  // Close notes still held when the host pressed stop.
  const now = performance.now();
  for (const midi of [...state.held.keys()]) closeHeld(midi, now);
  if (state.performance.length === 0) {
    state.score = null;
    return;
  }
  const bpmInput = $<HTMLInputElement>('bpm');
  const bpm = Number(bpmInput.value) || undefined;
  state.score = quantize(state.performance, { bpm });
  if (!bpm) bpmInput.placeholder = String(state.score.bpm);
}

/** Ids of the opening performance notes that repeat the motif, for colouring. */
function motifIds(): Set<number> {
  const ids = new Set(state.motif.map((e) => e.id));
  if (state.motif.length === 3 && state.performance.length > 0) {
    const firsts = clusterOnsets(state.performance).slice(0, 3).map((c) => c.reduce((a, b) => (b.midi > a.midi ? b : a)));
    const match = firsts.length === 3 && firsts.every((e, i) => pitchClass(e.midi) === pitchClass(state.motif[i].midi));
    if (match) firsts.forEach((e) => ids.add(e.id));
  }
  return ids;
}

function liveGroups(events: NoteEvent[]): LiveGroup[] {
  return clusterOnsets(events).map((c) => ({ midis: [...new Set(c.map((e) => e.midi))].sort((a, b) => a - b), ids: c.map((e) => e.id) }));
}

// ---------------------------------------------------------------- AI

let job: { key: string; req: ComposeRequest; controller: AbortController; promise: Promise<Melody> } | null = null;
let aiToken = 0;
let aiView: ScoreView | null = null;

function aiRequest(): ComposeRequest {
  return { motif: state.motif.map((e) => e.midi), key: state.motifKey, bars: settings.bars, seed: state.ai.seed };
}

/** Starts composing for the current motif and settings, or reuses the job already running. */
function ensureJob() {
  const req = aiRequest();
  const key = JSON.stringify({ ...req, engine: settings.engine, cloud: cloudEnabled(settings) });
  if (job && job.key === key) return job;
  job?.controller.abort();
  const controller = new AbortController();
  const promise = compose(req, settings, controller.signal);
  promise.catch(() => {}); // an aborted job is simply dropped
  job = { key, req, controller, promise };
  return job;
}

async function startAi(again = false) {
  if (state.motif.length < 3) {
    flash('請先讓小朋友彈 3 個音');
    return;
  }
  player.stop();
  if (again) state.ai.seed++;
  setStage('ai');
  Object.assign(state.ai, { status: 'composing', melody: null, step: 0, nowIds: [], line: -1, composeStarted: performance.now() });
  updateChrome();
  const token = ++aiToken;
  const current = ensureJob();
  let melody: Melody;
  try {
    // Let the audience see the AI "think" for a moment even when the tune is ready.
    [melody] = await Promise.all([current.promise, new Promise((r) => setTimeout(r, 1200))]);
  } catch {
    if (token !== aiToken) return;
    melody = { ...offline(current.req), fallbackReason: '雲端 AI 沒有完成，改用離線 AI' };
  }
  if (token !== aiToken || state.stage !== 'ai') return;
  showAiMelody(melody);
}

/** Host gives up waiting for the cloud. */
function useOfflineNow() {
  if (state.stage !== 'ai' || state.ai.status !== 'composing') return;
  aiToken++;
  const req = job?.req ?? aiRequest();
  job?.controller.abort();
  job = null;
  showAiMelody({ ...offline(req), fallbackReason: '主持人改用離線 AI' });
}

function showAiMelody(melody: Melody) {
  state.ai.melody = melody;
  if (melody.fallbackReason) flash(melody.fallbackReason);
  playAi(0, 900);
}

function playAi(from: number, delayMs = 300) {
  const m = state.ai.melody;
  if (!m) return;
  const out = settings.output === 'speaker' || !midi.canSend ? speaker : midiOut;
  if (from === 0) Object.assign(state.ai, { step: 0, nowIds: [], line: -1 });
  state.ai.status = 'playing';
  state.dirty = true;
  updateChrome();
  player.play(m, settings.bpm, out, from, delayMs);
}

function togglePause() {
  if (state.stage !== 'ai') return;
  if (state.ai.status === 'playing') {
    player.pause();
    state.ai.status = 'paused';
  } else if (state.ai.status === 'paused') {
    player.resume(settings.bpm);
    state.ai.status = 'playing';
  } else if (state.ai.status === 'done') {
    playAi(0);
    return;
  }
  updateChrome();
}

function stopAi() {
  aiToken++;
  player.stop();
  vkAiNote(null);
  state.ai.status = 'done';
}

let vkLit: number | null = null;
function vkAiNote(midi: number | null) {
  if (vkLit !== null) vk.highlight(vkLit, false);
  if (midi !== null) vk.highlight(midi, true);
  vkLit = midi;
}

/** Shows the AI score up to the note now playing and scrolls its line into view. */
function applyAiView(scroll: boolean) {
  if (!aiView) return;
  aiView.reveal(state.ai.step);
  aiView.highlight(state.ai.nowIds);
  const m = state.ai.melody;
  if (!scroll || !m || !Number.isFinite(state.ai.step)) return;
  const line = Math.floor(Math.max(0, state.ai.step - 1) / (m.beatsPerBar * 4) / 4);
  if (line === state.ai.line) return;
  state.ai.line = line;
  const svg = $('score').querySelector('svg');
  if (!svg) return;
  const scale = svg.clientWidth / 1200;
  const sheet = $('score').parentElement!;
  sheet.scrollTo({ top: Math.max(0, $('score').offsetTop + line * 290 * scale - 12), behavior: 'smooth' });
}

const player = new Player({
  onNote(i, n) {
    state.ai.step = n.start + 1;
    state.ai.nowIds = [AI_ID_BASE + i];
    applyAiView(true);
    vkAiNote(n.midi);
  },
  onEnd() {
    Object.assign(state.ai, { status: 'done', step: Infinity, nowIds: [] });
    applyAiView(false);
    vkAiNote(null);
    updateChrome();
  },
});

// ---------------------------------------------------------------- drawing

function draw() {
  if (state.dirty) {
    state.dirty = false;
    try {
      drawMotif();
      drawSheet();
    } catch (err) {
      console.error(err);
    }
  }
  requestAnimationFrame(draw);
}

function drawMotif() {
  const slots = $('motif-notes').children;
  const { fifths, mode } = state.motifKey;
  const minor = mode === 'minor';
  for (let i = 0; i < 3; i++) {
    const slot = slots[i] as HTMLElement;
    const ev = state.motif[i];
    slot.classList.toggle('filled', !!ev);
    slot.querySelector('.syl')!.textContent = ev ? solfege(ev.midi, fifths, minor) : '?';
    slot.querySelector('.name')!.textContent = ev ? noteName(ev.midi, fifths, minor) : '';
  }
  $('key-label').textContent = state.motif.length === 3 ? `建議調性：${keyLabel(state.motifKey)}` : '';
}

function drawSheet() {
  const live = $('live');
  const scoreEl = $('score');
  const reviewing = state.stage === 'review' && state.score;
  live.hidden = !!reviewing;
  scoreEl.hidden = !reviewing;
  const common = { showSolfege: state.showSolfege, motifIds: motifIds() };
  aiView = null;

  if (state.stage === 'ai' && state.ai.melody) {
    const m = state.ai.melody;
    live.hidden = true;
    scoreEl.hidden = false;
    const aiMotif = new Set(state.motif.map((_, i) => AI_ID_BASE + i));
    aiView = renderScore(scoreEl, scoreFromMelody(m, settings.bpm), { ...common, motifIds: aiMotif, fifths: m.key.fifths });
    applyAiView(false);
    $('score-meta').textContent =
      `${keyLabel(m.key)}・4/4 拍・每分鐘 ${settings.bpm} 拍・共 ${m.bars} 小節・${m.engine === 'cloud' ? '雲端 AI（Claude）' : '離線 AI'}`;
    return;
  }

  if (reviewing) {
    renderScore(scoreEl, state.score!, { ...common, fifths: state.score!.key.fifths });
    $('score-meta').textContent =
      `${keyLabel(state.score!.key)}・4/4 拍・每分鐘 ${state.score!.bpm} 拍・共 ${state.score!.bars.length} 小節`;
    return;
  }
  $('score-meta').textContent = '';
  const fifths = state.stage === 'free' ? 0 : state.motifKey.fifths;
  const minor = state.stage !== 'free' && state.motifKey.mode === 'minor';
  const events =
    state.stage === 'free' ? state.freeEvents
    : state.stage === 'motif' ? state.motif
    : state.stage === 'ready' || state.stage === 'ai' ? state.motif
    : state.performance;
  renderLive(live, liveGroups(events), { ...common, fifths, minor });
}

let flashTimer = 0;
function flash(text: string) {
  const el = $('flash');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => el.classList.remove('show'), 1600);
}

function updateChrome() {
  const t = STAGE_TEXT[state.stage];
  const ai = state.stage === 'ai' ? state.ai : null;
  $('stage-label').textContent = ai ? AI_LABEL[ai.status] : t.label;
  $('prompt').textContent = ai ? aiPrompt() : t.prompt;
  $('prompt').hidden = !$('prompt').textContent;
  $('idea').textContent = ai?.melody?.idea ?? '';
  document.body.dataset.stage = state.stage;
  $<HTMLButtonElement>('btn-stop').disabled = state.stage !== 'performing';
  $<HTMLButtonElement>('btn-retake').disabled = !['motif', 'ready'].includes(state.stage);
  $<HTMLButtonElement>('btn-requantize').disabled = state.stage !== 'review';
  $<HTMLButtonElement>('btn-ai').disabled = state.motif.length < 3;
  $<HTMLButtonElement>('btn-ai-pause').disabled = !ai || ai.status === 'composing';
  $('btn-ai-pause').textContent = ai?.status === 'playing' ? '⏸ 暫停' : ai?.status === 'paused' ? '▶ 繼續' : '▶ 再聽一次';
  $<HTMLButtonElement>('btn-ai-again').disabled = !ai || ai.status === 'composing';
  $('btn-ai-offline').hidden = !(ai?.status === 'composing' && cloudEnabled(settings));
}

const AI_LABEL: Record<AiStatus, string> = {
  composing: 'AI 創作中',
  playing: 'AI 演奏中',
  paused: 'AI 暫停',
  done: 'AI 的作品',
};

function aiPrompt(): string {
  const { status, melody, composeStarted } = state.ai;
  if (status === 'composing') {
    const secs = Math.floor((performance.now() - composeStarted) / 1000);
    return `AI 正在用這 3 個音創作…${secs >= 3 ? `（${secs} 秒）` : ''}`;
  }
  return melody?.title ? `《${melody.title}》` : '';
}

function showMidiStatus(s: MidiStatus) {
  const el = $('midi-status');
  el.classList.toggle('ok', s.inputs.length > 0);
  if (!s.supported) el.textContent = s.error ?? '不支援 MIDI';
  else if (s.inputs.length === 0) el.textContent = '未偵測到鍵盤，請接上 USB 線（可先用螢幕鍵盤）';
  else el.textContent = `鍵盤已連接：${s.inputs.join('、')}`;
  $<HTMLButtonElement>('btn-test').disabled = !midi.canSend;
  $('ai-output-status').textContent = midi.canSend ? `目前會從「${s.output}」發聲` : '目前沒有鍵盤，AI 會從電腦喇叭發聲';
}

// ---------------------------------------------------------------- wiring

const midi = new MidiIO();
const midiOut = new MidiOutput(midi);
const speaker = new SpeakerOutput();
const vk = new VirtualKeyboard($('vk'), noteOn, noteOff);
midi.onNoteOn(noteOn);
midi.onNoteOff(noteOff);
midi.onStatus(showMidiStatus);

$('btn-motif').addEventListener('click', () => setStage('motif'));
$('btn-retake').addEventListener('click', () => setStage('motif'));
$('btn-start').addEventListener('click', () => setStage('performing'));
$('btn-stop').addEventListener('click', () => setStage('review'));
$('btn-free').addEventListener('click', () => {
  state.freeEvents = [];
  setStage('free');
});
$('btn-requantize').addEventListener('click', () => setStage('review'));
$<HTMLInputElement>('opt-solfege').addEventListener('change', (e) => {
  state.showSolfege = (e.target as HTMLInputElement).checked;
  state.dirty = true;
});
$<HTMLInputElement>('opt-vk').addEventListener('change', (e) => {
  $('vk').hidden = !(e.target as HTMLInputElement).checked;
});
$('btn-test').addEventListener('click', () => {
  const t = performance.now() + 50;
  [60, 64, 67, 72].forEach((m, i) => midi.send(m, 80, 380, t + i * 400));
});
$('btn-ai').addEventListener('click', () => startAi());
$('btn-ai-pause').addEventListener('click', togglePause);
$('btn-ai-again').addEventListener('click', () => startAi(true));
$('btn-ai-offline').addEventListener('click', useOfflineNow);

// AI settings: length and tempo in the footer, the rest in a dialog.
const barsSelect = $<HTMLSelectElement>('ai-bars');
const bpmInput = $<HTMLInputElement>('ai-bpm');
const engineSelect = $<HTMLSelectElement>('ai-engine');
const keyInput = $<HTMLInputElement>('ai-key');
const outputSelect = $<HTMLSelectElement>('ai-output');
barsSelect.value = String(settings.bars);
bpmInput.value = String(settings.bpm);
engineSelect.value = settings.engine;
keyInput.value = settings.apiKey;
outputSelect.value = settings.output;
barsSelect.addEventListener('change', () => {
  settings.bars = Number(barsSelect.value);
  saveSettings();
  if (state.stage === 'ready' || state.stage === 'performing' || state.stage === 'review') ensureJob();
});
bpmInput.addEventListener('change', () => {
  settings.bpm = Math.min(160, Math.max(50, Number(bpmInput.value) || 96));
  bpmInput.value = String(settings.bpm);
  saveSettings();
  state.dirty = true;
});
engineSelect.addEventListener('change', () => {
  settings.engine = engineSelect.value as Engine;
  saveSettings();
  updateChrome();
});
keyInput.addEventListener('change', () => {
  settings.apiKey = keyInput.value.trim();
  saveSettings();
  updateChrome();
});
outputSelect.addEventListener('change', () => {
  settings.output = outputSelect.value as Settings['output'];
  saveSettings();
});
$('btn-settings').addEventListener('click', () => $<HTMLDialogElement>('settings').showModal());
$('btn-clear-key').addEventListener('click', () => {
  keyInput.value = '';
  settings.apiKey = '';
  saveSettings();
  $('test-cloud-result').textContent = '金鑰已清除';
  updateChrome();
});
$('btn-test-cloud').addEventListener('click', async () => {
  const out = $('test-cloud-result');
  const key = keyInput.value.trim();
  if (!key) {
    out.textContent = '請先輸入金鑰';
    return;
  }
  out.textContent = '測試中，雲端 AI 正在寫一段 8 小節旋律…';
  const t0 = performance.now();
  try {
    const m = await composeCloud({ motif: [60, 64, 67], key: C_MAJOR, bars: 8 }, key);
    out.textContent = `成功：${((performance.now() - t0) / 1000).toFixed(0)} 秒寫好《${m.title ?? ''}》，共 ${m.notes.length} 個音`;
  } catch (err) {
    out.textContent = `失敗：${describeError(err)}`;
  }
});

$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('projector', !!document.fullscreenElement);
});

// Host shortcuts on the number row (letters belong to the computer piano).
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
  if ($<HTMLDialogElement>('settings').open) return;
  const actions: Record<string, () => void> = {
    Digit1: () => setStage('motif'),
    Digit2: () => setStage('performing'),
    Digit3: () => state.stage === 'performing' && setStage('review'),
    Digit4: () => state.motif.length === 3 && startAi(),
    Digit5: togglePause,
    Digit0: () => $('btn-free').click(),
  };
  actions[e.code]?.();
});

// Keep the "composing … seconds" counter moving.
setInterval(() => state.stage === 'ai' && state.ai.status === 'composing' && updateChrome(), 500);

updateChrome();
document.fonts.load('30px Bravura').finally(() => {
  state.dirty = true;
  requestAnimationFrame(draw);
});
midi.start();
