import './styles.css';
import { MidiIO, MidiStatus } from './io/midi';
import { VirtualKeyboard } from './io/virtualKeyboard';
import { clusterOnsets, NoteEvent, quantize, QuantizedScore } from './music/quantize';
import { C_MAJOR, detectKey, Key, keyLabel, noteName, pitchClass, solfege } from './music/theory';
import { LiveGroup, renderLive, renderScore } from './render/notation';

type Stage = 'free' | 'motif' | 'ready' | 'performing' | 'review';

const STAGE_TEXT: Record<Stage, { label: string; prompt: string }> = {
  free: { label: '自由彈奏', prompt: '彈任何音，五線譜會即時顯示' },
  motif: { label: '小朋友出題', prompt: '請小朋友彈 3 個音' },
  ready: { label: '動機完成', prompt: '音樂家準備好就開始彈，第一個音會自動開始記錄' },
  performing: { label: '真人音樂家演奏中', prompt: '' },
  review: { label: '真人音樂家的作品', prompt: '' },
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
};

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
    setTimeout(() => state.stage === 'motif' && state.motif.length === 3 && setStage('ready'), 400);
  }
}

// ---------------------------------------------------------------- stages

function setStage(stage: Stage) {
  state.stage = stage;
  if (stage === 'motif') {
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
  const fifths = state.motifKey.fifths;
  for (let i = 0; i < 3; i++) {
    const slot = slots[i] as HTMLElement;
    const ev = state.motif[i];
    slot.classList.toggle('filled', !!ev);
    slot.querySelector('.syl')!.textContent = ev ? solfege(ev.midi, fifths) : '?';
    slot.querySelector('.name')!.textContent = ev ? noteName(ev.midi, fifths) : '';
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

  if (reviewing) {
    renderScore(scoreEl, state.score!, { ...common, fifths: state.score!.key.fifths });
    $('score-meta').textContent =
      `${keyLabel(state.score!.key)}・4/4 拍・每分鐘 ${state.score!.bpm} 拍・共 ${state.score!.bars.length} 小節`;
    return;
  }
  $('score-meta').textContent = '';
  const fifths = state.stage === 'free' ? 0 : state.motifKey.fifths;
  const events =
    state.stage === 'free' ? state.freeEvents
    : state.stage === 'motif' ? state.motif
    : state.stage === 'ready' ? state.motif
    : state.performance;
  renderLive(live, liveGroups(events), { ...common, fifths });
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
  $('stage-label').textContent = t.label;
  $('prompt').textContent = t.prompt;
  $('prompt').hidden = !t.prompt;
  document.body.dataset.stage = state.stage;
  $<HTMLButtonElement>('btn-stop').disabled = state.stage !== 'performing';
  $<HTMLButtonElement>('btn-retake').disabled = !['motif', 'ready'].includes(state.stage);
  $<HTMLButtonElement>('btn-requantize').disabled = state.stage !== 'review';
}

function showMidiStatus(s: MidiStatus) {
  const el = $('midi-status');
  el.classList.toggle('ok', s.inputs.length > 0);
  if (!s.supported) el.textContent = s.error ?? '不支援 MIDI';
  else if (s.inputs.length === 0) el.textContent = '未偵測到鍵盤，請接上 USB 線（可先用螢幕鍵盤）';
  else el.textContent = `鍵盤已連接：${s.inputs.join('、')}`;
  $<HTMLButtonElement>('btn-test').disabled = !midi.canSend;
}

// ---------------------------------------------------------------- wiring

const midi = new MidiIO();
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
$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('projector', !!document.fullscreenElement);
});

// Host shortcuts on the number row (letters belong to the computer piano).
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  const actions: Record<string, () => void> = {
    Digit1: () => setStage('motif'),
    Digit2: () => setStage('performing'),
    Digit3: () => state.stage === 'performing' && setStage('review'),
    Digit0: () => $('btn-free').click(),
  };
  actions[e.code]?.();
});

updateChrome();
document.fonts.load('30px Bravura').finally(() => {
  state.dirty = true;
  requestAnimationFrame(draw);
});
midi.start();
