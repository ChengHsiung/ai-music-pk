import './styles.css';
import { cloudEnabled, compose, ComposeSettings, describeError, Engine, offline } from './ai/composer';
import { composeCloud } from './ai/cloudComposer';
import { Feel, FEEL_LABEL, FEELS } from './ai/accompaniment';
import { AI_ID_BASE, AI_LEFT_ID, ComposeRequest, Melody, scoreFromMelody } from './ai/melody';
import { PianoOutput } from './ai/piano';
import { eventsTrack, LEFT_ID, leftVelocity, melodyTrack, MidiOutput, Player, SpeakerOutput, velocity } from './ai/player';
import { MidiIO, MidiStatus } from './io/midi';
import { VirtualKeyboard } from './io/virtualKeyboard';
import { MidiFileControl, PPQ, writeMidiFile } from './music/midiFile';
import { clusterOnsets, NoteEvent, quantize, QuantizedScore } from './music/quantize';
import { C_MAJOR, detectKey, Key, keyLabel, noteName, pitchClass, solfege } from './music/theory';
import { LiveGroup, renderLive, renderScore, ScoreView } from './render/notation';
import { ConsoleButton, feelOptions, HostConsole } from './ui/hostConsole';

type Stage = 'title' | 'free' | 'motif' | 'ready' | 'performing' | 'review' | 'ai' | 'compare';
type AiStatus = 'composing' | 'playing' | 'paused' | 'done';

const STAGE_TEXT: Record<Stage, { label: string; prompt: string }> = {
  title: { label: '開場', prompt: '' },
  free: { label: '自由彈奏', prompt: '彈任何音，五線譜會即時顯示' },
  motif: { label: '小朋友出題', prompt: '請小朋友彈 3 個音' },
  ready: { label: '動機完成', prompt: '音樂家準備好就開始彈，第一個音會自動開始記錄' },
  performing: { label: '真人音樂家演奏中', prompt: '' },
  review: { label: '真人音樂家的作品', prompt: '' },
  ai: { label: 'AI 創作', prompt: '' },
  compare: { label: '請大家投票', prompt: '你比較喜歡哪一首？請舉手！' },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  stage: 'title' as Stage,
  nextId: 1,
  /** Notes shown in free play (not recorded) */
  freeEvents: [] as NoteEvent[],
  motif: [] as NoteEvent[],
  motifKey: C_MAJOR as Key,
  performance: [] as NoteEvent[],
  /** The musician's sustain pedal during the performance */
  pedalEvents: [] as PedalRecord[],
  held: new Map<number, NoteEvent>(),
  score: null as QuantizedScore | null,
  showSolfege: true,
  dirty: true,
  round: 1,
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
    /** The character of the tune "compose again" replaced, so the next one differs */
    avoidFeel: undefined as Feel | undefined,
    /** Titles of the tunes "compose again" replaced in this round */
    replacedTitles: [] as string[],
  },
  /** What the player is playing, and the ids sounding now (for highlighting) */
  playback: null as null | 'ai' | 'human',
  playIds: [] as number[],
};

// ---------------------------------------------------------------- settings

interface Settings extends ComposeSettings {
  bars: number;
  /** The AI's character: the host's choice, or 'auto' to let the composer pick one that suits the notes */
  feel: Feel | 'auto';
  /** The AI's tempo; null plays each tune at the tempo its composer chose */
  aiBpm: number | null;
  output: 'auto' | 'speaker';
}

/** Kept in this browser only (the API key never leaves the event computer except to call Claude). */
function loadSettings(): Settings {
  const defaults: Settings = { engine: 'auto', apiKey: '', bars: 8, feel: 'auto', aiBpm: null, output: 'auto' };
  try {
    // Older versions kept a fixed tempo in `bpm`; tempo now follows each tune unless the host sets one.
    const { bpm: _old, ...saved } = JSON.parse(localStorage.getItem('ai-music-pk.settings') ?? '{}');
    const s: Settings = { ...defaults, ...saved };
    if (s.feel !== 'auto' && !FEELS.includes(s.feel)) s.feel = 'auto';
    if (typeof s.aiBpm !== 'number') s.aiBpm = null;
    return s;
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

/** The tempo the AI's tune is played and drawn at. */
function aiBpm(m: Melody): number {
  return settings.aiBpm ?? m.bpm ?? 96;
}

// ---------------------------------------------------------------- rounds

interface PedalRecord {
  time: number;
  down: boolean;
}

interface RoundRecord {
  n: number;
  at: string;
  motif: number[];
  key: Key;
  human: { notes: { midi: number; start: number; end: number; velocity: number }[]; pedals?: PedalRecord[]; bpm: number } | null;
  ai: { melody: Melody; bpm: number } | null;
}

function loadRounds(): RoundRecord[] {
  try {
    const rounds = JSON.parse(localStorage.getItem('ai-music-pk.rounds') ?? '[]');
    return Array.isArray(rounds) ? rounds : [];
  } catch {
    return [];
  }
}

const rounds = loadRounds();
state.round = Math.max(0, ...rounds.map((r) => r.n)) + 1;

function storeRounds() {
  try {
    localStorage.setItem('ai-music-pk.rounds', JSON.stringify(rounds));
  } catch {
    // Storage full or blocked: the records stay available until the page closes.
  }
}

/** Writes what this round has so far: the motif, the musician's performance and the AI melody. */
function saveRound() {
  if (state.motif.length < 3) return;
  let r = rounds.find((x) => x.n === state.round);
  if (!r) {
    r = { n: state.round, at: new Date().toISOString(), motif: [], key: state.motifKey, human: null, ai: null };
    rounds.push(r);
  }
  r.motif = state.motif.map((e) => e.midi);
  r.key = state.motifKey;
  const played = state.performance.filter((e) => e.end !== null);
  r.human = played.length && state.score
    ? {
        notes: played.map((e) => ({ midi: e.midi, start: e.start, end: e.end!, velocity: e.velocity })),
        pedals: state.pedalEvents.length ? [...state.pedalEvents] : undefined,
        bpm: state.score.bpm,
      }
    : null;
  r.ai = state.ai.melody ? { melody: state.ai.melody, bpm: aiBpm(state.ai.melody) } : null;
  storeRounds();
  updateChrome();
}

function roundHasContent() {
  const r = rounds.find((x) => x.n === state.round);
  return !!r && (!!r.human || !!r.ai);
}

function downloadMidi(n: number, which: 'human' | 'ai') {
  const r = rounds.find((x) => x.n === n);
  let bytes: Uint8Array | null = null;
  const pedal = (tick: number, down: boolean): MidiFileControl => ({ tick, controller: 64, value: down ? 127 : 0 });
  if (which === 'human' && r?.human) {
    const { notes, bpm } = r.human;
    const t0 = Math.min(...notes.map((x) => x.start));
    const ticksPerMs = PPQ / (60000 / bpm);
    bytes = writeMidiFile(
      notes.map((x) => ({ midi: x.midi, tick: (x.start - t0) * ticksPerMs, dur: (x.end - x.start) * ticksPerMs, velocity: x.velocity })),
      bpm,
      `第 ${n} 局・真人音樂家`,
      (r.human.pedals ?? []).map((p) => pedal(Math.max(0, p.time - t0) * ticksPerMs, p.down)),
    );
  } else if (which === 'ai' && r?.ai) {
    const { melody, bpm } = r.ai;
    const perStep = PPQ / 4;
    bytes = writeMidiFile(
      [
        ...melody.notes.map((x, i) => ({ midi: x.midi, tick: x.start * perStep, dur: x.dur * perStep, velocity: velocity(melody, i) })),
        ...(melody.left ?? []).map((x) => ({ midi: x.midi, tick: x.start * perStep, dur: x.dur * perStep, velocity: leftVelocity(melody, x) })),
      ],
      bpm,
      `第 ${n} 局・AI${melody.title ? `《${melody.title}》` : ''}`,
      // The pedal changes with each chord: up as it ends, down just after the next begins.
      (melody.pedals ?? []).flatMap((p) => [pedal(p.start * perStep + PPQ / 16, true), pedal(p.end * perStep - 1, false)]),
    );
  }
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/midi' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-music-pk-round${n}-${which}.mid`; // ASCII: some browsers drop non-ASCII download names
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

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
    default:
      // Title, review, AI and compare ignore the keyboard (and any echo of the AI's own notes).
      break;
  }
  state.dirty = true;
}

function closeHeld(midi: number, time: number) {
  const ev = state.held.get(midi);
  if (ev && ev.end === null) ev.end = Math.max(time, ev.start + 1);
  state.held.delete(midi);
}

/** The musician's sustain pedal is recorded with the performance, so the replay sounds as played. */
function pedalChange(down: boolean, time: number) {
  if (state.stage !== 'ready' && state.stage !== 'performing') return;
  if (state.pedalEvents.at(-1)?.down === down) return; // a half-pedal sends many values; keep the changes
  state.pedalEvents.push({ time, down });
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
      saveRound();
      // The AI starts composing now, while the musician plays, so nobody waits for it later.
      ensureJob();
    }, 400);
  }
}

// ---------------------------------------------------------------- stages

function setStage(stage: Stage) {
  stopPlayback();
  if (state.stage === 'ai' && stage !== 'ai') aiToken++; // drop a pending "show the tune"
  const previous = state.stage;
  state.stage = stage;
  if (stage === 'motif') {
    job?.controller.abort(); // a new motif needs a new tune
    job = null;
    state.motif = [];
    state.performance = [];
    state.score = null;
    state.ai.melody = null;
    state.ai.seed = 1;
    state.ai.avoidFeel = undefined;
    state.ai.replacedTitles = [];
  }
  if (stage === 'ready' || stage === 'performing') {
    state.performance = [];
    state.score = null;
    // A pedal pressed while waiting for the first note belongs to the performance.
    if (stage === 'ready' || previous !== 'ready') state.pedalEvents = [];
  }
  if (stage === 'ready' && state.motif.length === 3) saveRound();
  if (stage === 'review') finishPerformance();
  if (stage === 'compare') prepareCompare();
  state.dirty = true;
  updateChrome();
}

/** ① starts a new round when this one already has music in it; otherwise it re-asks the same round. */
function startMotif() {
  if (roundHasContent()) {
    state.round = Math.max(...rounds.map((r) => r.n)) + 1;
    const bpmInput = $<HTMLInputElement>('bpm');
    bpmInput.value = ''; // each musician's tempo is detected afresh
    bpmInput.placeholder = '自動';
  }
  setStage('motif');
}

function finishPerformance() {
  // Close notes still held when the host pressed stop.
  const now = performance.now();
  for (const midi of [...state.held.keys()]) closeHeld(midi, now);
  if (state.performance.length === 0) {
    state.score = null;
  } else {
    const bpmInput = $<HTMLInputElement>('bpm');
    const bpm = Number(bpmInput.value) || undefined;
    state.score = quantize(state.performance, { bpm });
    if (!bpm) bpmInput.placeholder = String(state.score.bpm);
  }
  saveRound();
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

const NEXT_LABEL: Record<Stage, () => string> = {
  title: () => `開始第 ${state.round} 局：小朋友出題`,
  free: () => `開始第 ${state.round} 局：小朋友出題`,
  motif: () => `等小朋友彈完 3 個音（還差 ${3 - state.motif.length} 個）`,
  ready: () => '開始記錄真人演奏',
  performing: () => '結束真人演奏',
  review: () => '換 AI 創作',
  ai: () => '並列兩份樂譜，請大家投票',
  compare: () => '下一局',
};

function nextStep() {
  switch (state.stage) {
    case 'title':
    case 'free':
    case 'compare':
      return startMotif();
    case 'motif':
      return flash(`還差 ${3 - state.motif.length} 個音`);
    case 'ready':
      return setStage('performing');
    case 'performing':
      return setStage('review');
    case 'review':
      return startAi();
    case 'ai':
      return setStage('compare');
  }
}

// ---------------------------------------------------------------- AI

let job: {
  key: string;
  req: ComposeRequest;
  controller: AbortController;
  promise: Promise<Melody>;
  result: Melody | null;
} | null = null;
let aiToken = 0;
let aiView: ScoreView | null = null;

function aiRequest(): ComposeRequest {
  return {
    motif: state.motif.map((e) => e.midi),
    key: state.motifKey,
    bars: settings.bars,
    seed: state.ai.seed,
    feel: settings.feel === 'auto' ? undefined : settings.feel,
    avoidFeel: settings.feel === 'auto' ? state.ai.avoidFeel : undefined,
    avoidTitles: usedTitles(),
  };
}

/** Titles from earlier rounds and replaced tunes, newest last, so a new tune gets a new picture. */
function usedTitles(): string[] | undefined {
  const earlier = rounds.filter((r) => r.n !== state.round).flatMap((r) => (r.ai?.melody.title ? [r.ai.melody.title] : []));
  const titles = [...new Set([...earlier, ...state.ai.replacedTitles])].slice(-8);
  return titles.length ? titles : undefined;
}

/** Starts composing for the current motif and settings, or reuses the job already running. */
function ensureJob() {
  const req = aiRequest();
  const key = JSON.stringify({ ...req, engine: settings.engine, cloud: cloudEnabled(settings) });
  if (job && job.key === key) return job;
  job?.controller.abort();
  const controller = new AbortController();
  const promise = compose(req, settings, controller.signal);
  const current = { key, req, controller, promise, result: null as Melody | null };
  promise.then(
    (m) => {
      current.result = m;
      updateChrome();
    },
    () => {}, // an aborted job is simply dropped
  );
  job = current;
  updateChrome();
  return current;
}

async function startAi(again = false) {
  if (state.motif.length < 3) {
    flash('請先讓小朋友彈 3 個音');
    return;
  }
  if (again) {
    state.ai.seed++;
    state.ai.avoidFeel = state.ai.melody?.feel;
    if (state.ai.melody?.title) state.ai.replacedTitles.push(state.ai.melody.title);
  }
  setStage('ai');
  Object.assign(state.ai, { status: 'composing', melody: null, step: 0, nowIds: [], line: -1, composeStarted: performance.now() });
  updateChrome();
  const token = ++aiToken;
  const current = ensureJob();
  let melody: Melody;
  try {
    // Let the audience see the AI "think" for a moment even when the tune is ready.
    [melody] = await Promise.all([current.promise, new Promise((r) => setTimeout(r, 1500))]);
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
  saveRound();
  playAi(900);
}

function output() {
  return settings.output === 'speaker' || !midi.canSend ? speaker : midiOut;
}

function playAi(delayMs = 300) {
  const m = state.ai.melody;
  if (!m) return;
  stopPlayback();
  Object.assign(state.ai, { status: 'playing', step: 0, nowIds: [], line: -1 });
  state.playback = 'ai';
  state.dirty = true;
  updateChrome();
  player.play(melodyTrack(m, aiBpm(m)), output(), 0, delayMs);
}

function togglePause() {
  if (state.stage !== 'ai') return;
  if (state.ai.status === 'playing') {
    player.pause();
    state.ai.status = 'paused';
  } else if (state.ai.status === 'paused') {
    player.resume();
    state.ai.status = 'playing';
  } else if (state.ai.status === 'done') {
    playAi(0);
    return;
  }
  updateChrome();
}

/** Stops whatever is playing; the AI view then shows the whole tune. */
function stopPlayback() {
  player.stop();
  vkLight(null);
  state.playback = null;
  state.playIds = [];
  if (state.ai.status === 'playing' || state.ai.status === 'paused') {
    Object.assign(state.ai, { status: 'done', step: Infinity, nowIds: [] });
  }
  applyViews(false);
}

let vkLit: number | null = null;
function vkLight(midi: number | null) {
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

function applyViews(scroll: boolean) {
  applyAiView(scroll);
  cmpViews.human?.highlight(state.playback === 'human' ? state.playIds : []);
  cmpViews.ai?.highlight(state.playback === 'ai' ? state.playIds : []);
}

const player = new Player({
  onNote(_i, n) {
    const m = state.playback === 'ai' ? state.ai.melody : null;
    if (n.part === 'left') {
      // The left hand only uncovers its notes; the light and the colour follow the melody.
      const note = m?.left?.[n.id - LEFT_ID];
      if (note && state.stage === 'ai') {
        state.ai.step = Math.max(state.ai.step, note.start + 1);
        applyAiView(true);
      }
      return;
    }
    vkLight(n.midi);
    if (m) {
      const note = m.notes[n.id];
      state.ai.step = state.stage === 'ai' ? Math.max(state.ai.step, note.start + 1) : Infinity;
      state.ai.nowIds = [AI_ID_BASE + n.id];
      state.playIds = state.ai.nowIds;
    } else {
      state.playIds = [n.id];
    }
    applyViews(true);
  },
  onEnd() {
    vkLight(null);
    if (state.playback === 'ai') Object.assign(state.ai, { status: 'done', step: Infinity, nowIds: [] });
    state.playback = null;
    state.playIds = [];
    applyViews(false);
    updateChrome();
  },
});

// ---------------------------------------------------------------- compare

const cmpViews: { human: ScoreView | null; ai: ScoreView | null } = { human: null, ai: null };
/** Half-width columns draw on a narrower page so the notes stay large. */
const COMPARE_WIDTH = 1000;

/** The AI may still be composing when the host skips ahead; show its tune once it is ready. */
function prepareCompare() {
  if (state.ai.melody || state.motif.length < 3) return;
  const current = ensureJob();
  const token = aiToken;
  current.promise.then(
    (m) => {
      if (token !== aiToken || state.stage !== 'compare' || state.ai.melody) return;
      state.ai.melody = m;
      saveRound();
      state.dirty = true;
    },
    () => {},
  );
}

function toggleReplay(which: 'human' | 'ai') {
  if (state.playback === which) {
    stopPlayback();
    updateChrome();
    return;
  }
  stopPlayback();
  if (which === 'ai' && state.ai.melody) {
    state.playback = 'ai';
    player.play(melodyTrack(state.ai.melody, aiBpm(state.ai.melody)), output(), 0, 200);
  } else if (which === 'human' && state.performance.length) {
    state.playback = 'human';
    player.play(eventsTrack(state.performance, state.pedalEvents), output(), 0, 200);
  }
  updateChrome();
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

function scoreMeta(score: QuantizedScore) {
  return `${keyLabel(score.key)}・4/4 拍・每分鐘 ${score.bpm} 拍・共 ${score.bars.length} 小節`;
}

function aiMeta(m: Melody) {
  const feel = m.feel ? `${FEEL_LABEL[m.feel]}・` : '';
  return `${keyLabel(m.key)}・${feel}每分鐘 ${aiBpm(m)} 拍・共 ${m.bars} 小節・${m.engine === 'cloud' ? '雲端 AI（Claude）' : '離線 AI'}`;
}

/** The AI's left hand is drawn in grey so the melody stands out. */
const isAiLeft = (id: number) => id >= AI_LEFT_ID;

function drawSheet() {
  const live = $('live');
  const scoreEl = $('score');
  const compare = $('compare');
  const common = { showSolfege: state.showSolfege, motifIds: motifIds() };
  const aiMotif = new Set(state.motif.map((_, i) => AI_ID_BASE + i));
  aiView = null;
  cmpViews.human = cmpViews.ai = null;
  $('title-card').hidden = state.stage !== 'title';
  compare.hidden = state.stage !== 'compare';
  live.hidden = true;
  scoreEl.hidden = true;
  $('score-meta').textContent = '';

  if (state.stage === 'compare') {
    if (state.score) {
      cmpViews.human = renderScore($('cmp-human'), state.score, { ...common, fifths: state.score.key.fifths, width: COMPARE_WIDTH });
      $('cmp-human-meta').textContent = scoreMeta(state.score);
    } else {
      $('cmp-human').innerHTML = '<p class="placeholder">（這一局沒有真人演奏）</p>';
      $('cmp-human-meta').textContent = '';
    }
    const m = state.ai.melody;
    if (m) {
      cmpViews.ai = renderScore($('cmp-ai'), scoreFromMelody(m, aiBpm(m)), {
        ...common,
        motifIds: aiMotif,
        accompaniment: isAiLeft,
        fifths: m.key.fifths,
        width: COMPARE_WIDTH,
      });
      $('cmp-ai-meta').textContent = `${m.title ? `《${m.title}》・` : ''}${aiMeta(m)}`;
    } else {
      $('cmp-ai').innerHTML = `<p class="placeholder">${state.motif.length === 3 ? 'AI 還在創作…' : '（這一局還沒有 AI 作品）'}</p>`;
      $('cmp-ai-meta').textContent = '';
    }
    applyViews(false);
    return;
  }

  if (state.stage === 'ai' && state.ai.melody) {
    const m = state.ai.melody;
    scoreEl.hidden = false;
    aiView = renderScore(scoreEl, scoreFromMelody(m, aiBpm(m)), { ...common, motifIds: aiMotif, accompaniment: isAiLeft, fifths: m.key.fifths });
    applyAiView(false);
    $('score-meta').textContent = aiMeta(m);
    return;
  }

  if (state.stage === 'review' && state.score) {
    scoreEl.hidden = false;
    renderScore(scoreEl, state.score, { ...common, fifths: state.score.key.fifths });
    $('score-meta').textContent = scoreMeta(state.score);
    return;
  }

  live.hidden = false;
  const keyless = state.stage === 'free' || state.stage === 'title';
  const fifths = keyless ? 0 : state.motifKey.fifths;
  const minor = !keyless && state.motifKey.mode === 'minor';
  const events =
    state.stage === 'title' ? []
    : state.stage === 'free' ? state.freeEvents
    : state.stage === 'performing' || state.stage === 'review' ? state.performance
    : state.motif;
  renderLive(live, liveGroups(events), { ...common, fifths, minor });
}

let flashTimer = 0;
function flash(text: string) {
  const el = $('flash');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => el.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------- host actions

interface Action {
  id: string;
  label: () => string;
  /** Stages where the button shows; all stages when left out */
  stages?: Stage[];
  visible?: () => boolean;
  enabled?: () => boolean;
  primary?: boolean;
  key?: string;
  run: () => void;
}

const ACTIONS: Action[] = [
  { id: 'motif', label: () => '① 小朋友出題', key: 'Digit1', stages: ['title', 'free', 'compare', 'review', 'ai'], run: startMotif },
  { id: 'retake', label: () => '重彈 3 個音', stages: ['motif', 'ready'], run: () => setStage('motif') },
  { id: 'start', label: () => '② 開始演奏', key: 'Digit2', stages: ['ready'], run: () => setStage('performing') },
  { id: 'stop', label: () => '③ 結束演奏', key: 'Digit3', stages: ['performing'], run: () => setStage('review') },
  { id: 'human-redo', label: () => '真人重來', stages: ['performing', 'review'], run: () => setStage('ready') },
  {
    id: 'ai',
    label: () => '④ AI 創作',
    key: 'Digit4',
    stages: ['ready', 'performing', 'review', 'compare'],
    enabled: () => state.motif.length === 3,
    primary: true,
    run: () => startAi(),
  },
  {
    id: 'ai-pause',
    label: () => (state.ai.status === 'playing' ? '⏸ 暫停' : state.ai.status === 'paused' ? '▶ 繼續' : '▶ 再聽一次'),
    key: 'Digit5',
    stages: ['ai'],
    enabled: () => state.ai.status !== 'composing',
    run: togglePause,
  },
  { id: 'ai-again', label: () => '換一首', stages: ['ai'], enabled: () => state.ai.status !== 'composing', run: () => startAi(true) },
  {
    id: 'ai-offline',
    label: () => '不等了，改用離線 AI',
    stages: ['ai'],
    visible: () => state.ai.status === 'composing' && cloudEnabled(settings),
    run: useOfflineNow,
  },
  { id: 'compare', label: () => '⑥ 並列兩份樂譜', key: 'Digit6', stages: ['review', 'ai'], run: () => setStage('compare') },
  {
    id: 'play-human',
    label: () => (state.playback === 'human' ? '■ 停止播放' : '▶ 播放真人'),
    stages: ['compare'],
    enabled: () => state.performance.length > 0,
    run: () => toggleReplay('human'),
  },
  {
    id: 'play-ai',
    label: () => (state.playback === 'ai' ? '■ 停止播放' : '▶ 播放 AI'),
    stages: ['compare'],
    enabled: () => !!state.ai.melody,
    run: () => toggleReplay('ai'),
  },
  { id: 'free', label: () => '自由彈奏', key: 'Digit0', stages: ['title', 'free', 'compare'], run: freePlay },
  { id: 'title', label: () => '開場畫面', stages: ['free', 'compare', 'motif'], run: () => setStage('title') },
];

const NEXT: Action = {
  id: 'next',
  label: () => `下一步：${NEXT_LABEL[state.stage]()}`,
  key: 'ArrowRight',
  enabled: () => state.stage !== 'motif',
  run: nextStep,
};

function freePlay() {
  state.freeEvents = [];
  setStage('free');
}

const isVisible = (a: Action) => (!a.stages || a.stages.includes(state.stage)) && (a.visible?.() ?? true);
const asButton = (a: Action): ConsoleButton => ({
  id: a.id,
  label: a.label(),
  enabled: a.enabled?.() ?? true,
  primary: a.primary,
  hint: a.key ? `快捷鍵 ${a.key === 'ArrowRight' ? '→' : a.key.replace('Digit', '')}` : undefined,
});

function runAction(id: string, arg?: string) {
  if (id === 'next') return NEXT.run();
  if (id === 'dl-human' || id === 'dl-ai') return downloadMidi(Number(arg), id === 'dl-human' ? 'human' : 'ai');
  if (id === 'clear-rounds') {
    if (!hostConsole.confirm('確定要清除所有局的紀錄嗎？')) return;
    rounds.length = 0;
    storeRounds();
    state.round = 1;
    return updateChrome();
  }
  if (id === 'bars') return setBars(Number(arg));
  if (id === 'feel') return setFeel(arg ?? 'auto');
  if (id === 'bpm') return setAiBpm(arg ?? '');
  if (id === 'human-bpm') {
    $<HTMLInputElement>('bpm').value = arg ?? '';
    if (state.stage === 'review') setStage('review');
    return updateChrome();
  }
  const a = ACTIONS.find((x) => x.id === id);
  if (a && isVisible(a) && (a.enabled?.() ?? true)) a.run();
}

/** Host shortcuts on the number row and the arrow key (letters belong to the computer piano). */
function onHostKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
  if ($<HTMLDialogElement>('settings').open) return;
  if (e.code === NEXT.key) {
    e.preventDefault();
    if (NEXT.enabled!()) NEXT.run();
    return;
  }
  const a = ACTIONS.find((x) => x.key === e.code);
  if (a && isVisible(a) && (a.enabled?.() ?? true)) a.run();
}

// ---------------------------------------------------------------- chrome

const AI_LABEL: Record<AiStatus, string> = {
  composing: 'AI 創作中',
  playing: 'AI 演奏中',
  paused: 'AI 暫停',
  done: 'AI 的作品',
};

function stageLabel() {
  return state.stage === 'ai' ? AI_LABEL[state.ai.status] : STAGE_TEXT[state.stage].label;
}

function promptText(): string {
  if (state.stage !== 'ai') return STAGE_TEXT[state.stage].prompt;
  const { status, melody, composeStarted } = state.ai;
  if (status === 'composing') {
    const secs = Math.floor((performance.now() - composeStarted) / 1000);
    return `AI 正在用這 3 個音創作${secs >= 3 ? `（${secs} 秒）` : ''}`;
  }
  return melody?.title ? `《${melody.title}》` : '';
}

function aiStatusLine(): string {
  const engine = cloudEnabled(settings) ? '雲端 AI（Claude），失敗時改用離線' : '離線 AI';
  let progress = '';
  if (state.ai.melody) progress = `已完成（${state.ai.melody.engine === 'cloud' ? '雲端' : '離線'}）`;
  else if (job?.result) progress = `已寫好，等待播放（${job.result.engine === 'cloud' ? '雲端' : '離線'}）`;
  else if (job) progress = '背景創作中…';
  return `AI：${engine}${progress ? `・${progress}` : ''}`;
}

let footerHtml = '';
function updateChrome() {
  const label = stageLabel();
  $('stage-label').textContent = label;
  $('round-label').textContent = state.stage === 'title' ? '' : `第 ${state.round} 局`;
  const prompt = promptText();
  $('prompt').textContent = prompt;
  $('prompt').hidden = !prompt;
  $('prompt').classList.toggle('thinking', state.stage === 'ai' && state.ai.status === 'composing');
  $('idea').textContent = state.stage === 'ai' ? (state.ai.melody?.idea ?? '') : '';
  document.body.dataset.stage = state.stage;
  $<HTMLButtonElement>('btn-requantize').disabled = state.stage !== 'review';
  $<HTMLInputElement>('ai-bpm').placeholder = aiBpmPlaceholder();

  // The same actions drive the footer (fallback) and the console window.
  const buttons = [NEXT, ...ACTIONS.filter(isVisible)].map(asButton);
  const html = buttons
    .map((b, i) => `<button data-action="${b.id}" class="${i === 0 ? 'next' : b.primary ? 'ai' : ''}" ${b.enabled ? '' : 'disabled'} ${b.hint ? `title="${b.hint}"` : ''}>${b.label}</button>`)
    .join('');
  if (html !== footerHtml) {
    footerHtml = html;
    $('flow').innerHTML = html;
  }

  hostConsole.update({
    title: `第 ${state.round} 局・${label}`,
    prompt: prompt || '',
    status: [midiLine, aiStatusLine(), `AI 發聲：${output() === speaker ? '電腦喇叭' : '鍵盤'}`],
    next: asButton(NEXT),
    buttons: buttons.slice(1),
    bars: settings.bars,
    feel: settings.feel,
    aiBpm: { value: settings.aiBpm === null ? '' : String(settings.aiBpm), placeholder: aiBpmPlaceholder() },
    humanBpm: {
      value: $<HTMLInputElement>('bpm').value,
      detected: state.score ? String(state.score.bpm) : '',
      enabled: state.stage === 'review',
    },
    rounds: [...rounds].reverse().map((r) => ({
      n: r.n,
      motif: r.motif.map((m) => solfege(m, r.key.fifths, r.key.mode === 'minor')).join(' '),
      human: !!r.human,
      ai: r.ai ? (r.ai.melody.engine === 'cloud' ? `雲端 AI${r.ai.melody.title ? `《${r.ai.melody.title}》` : ''}` : '離線 AI') : null,
    })),
  });
}

let midiLine = '鍵盤：尋找中…';
function showMidiStatus(s: MidiStatus) {
  const el = $('midi-status');
  el.classList.toggle('ok', s.inputs.length > 0);
  if (!s.supported) el.textContent = s.error ?? '不支援 MIDI';
  else if (s.inputs.length === 0) el.textContent = '未偵測到鍵盤，請接上 USB 線（可先用螢幕鍵盤）';
  else el.textContent = `鍵盤已連接：${s.inputs.join('、')}`;
  midiLine = `鍵盤：${el.textContent}`;
  $<HTMLButtonElement>('btn-test').disabled = !midi.canSend;
  $('ai-output-status').textContent = midi.canSend ? `目前會從「${s.output}」發聲` : '目前沒有鍵盤，AI 會從電腦喇叭發聲';
  updateChrome();
}

// ---------------------------------------------------------------- wiring

const midi = new MidiIO();
const midiOut = new MidiOutput(midi);
// The sampled piano, with the small synth standing in while the samples load.
const speaker = new PianoOutput(new SpeakerOutput());
speaker.load();
const vk = new VirtualKeyboard($('vk'), noteOn, noteOff);
const hostConsole = new HostConsole({
  action: runAction,
  key: onHostKey,
  closed: () => {
    document.body.classList.remove('has-console');
    updateChrome();
  },
});

$('flow').addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (el && !el.disabled) runAction(el.dataset.action!);
});
$('btn-console').addEventListener('click', () => {
  if (!hostConsole.open()) {
    flash('瀏覽器擋住了彈出視窗，請在網址列允許彈出視窗');
    return;
  }
  document.body.classList.add('has-console');
  updateChrome();
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

// AI settings: length, character and tempo in the footer and the console, the rest in a dialog.
const barsSelect = $<HTMLSelectElement>('ai-bars');
const feelSelect = $<HTMLSelectElement>('ai-feel');
const bpmInput = $<HTMLInputElement>('ai-bpm');
const engineSelect = $<HTMLSelectElement>('ai-engine');
const keyInput = $<HTMLInputElement>('ai-key');
const outputSelect = $<HTMLSelectElement>('ai-output');
barsSelect.value = String(settings.bars);
feelSelect.innerHTML = feelOptions();
feelSelect.value = settings.feel;
bpmInput.value = settings.aiBpm === null ? '' : String(settings.aiBpm);
engineSelect.value = settings.engine;
keyInput.value = settings.apiKey;
outputSelect.value = settings.output;

function setBars(bars: number) {
  if (![8, 12, 16].includes(bars)) return;
  settings.bars = bars;
  barsSelect.value = String(bars);
  saveSettings();
  if (['ready', 'performing', 'review'].includes(state.stage)) ensureJob();
  updateChrome();
}

function setFeel(feel: string) {
  settings.feel = (FEELS as readonly string[]).includes(feel) ? (feel as Feel) : 'auto';
  feelSelect.value = settings.feel;
  saveSettings();
  if (['ready', 'performing', 'review'].includes(state.stage)) ensureJob();
  updateChrome();
}

/** Empty means each tune keeps the tempo its composer chose. */
function setAiBpm(text: string) {
  const bpm = Math.round(Number(text));
  settings.aiBpm = text.trim() === '' || !bpm ? null : Math.min(160, Math.max(50, bpm));
  bpmInput.value = settings.aiBpm === null ? '' : String(settings.aiBpm);
  saveSettings();
  state.dirty = true;
  updateChrome();
}

function aiBpmPlaceholder(): string {
  const m = state.ai.melody;
  return m?.bpm ? `自動 ${m.bpm}` : '自動';
}

barsSelect.addEventListener('change', () => setBars(Number(barsSelect.value)));
feelSelect.addEventListener('change', () => setFeel(feelSelect.value));
bpmInput.addEventListener('change', () => setAiBpm(bpmInput.value));
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
  updateChrome();
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
    const feel = m.feel ? `${FEEL_LABEL[m.feel]}、` : '';
    out.textContent = `成功：${((performance.now() - t0) / 1000).toFixed(0)} 秒寫好《${m.title ?? ''}》（${feel}每分鐘 ${m.bpm} 拍），共 ${m.notes.length} 個音`;
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
window.addEventListener('keydown', onHostKey);
window.addEventListener('beforeunload', () => hostConsole.close());

// Keep the "composing … seconds" counter moving.
setInterval(() => state.stage === 'ai' && state.ai.status === 'composing' && updateChrome(), 500);

midi.onNoteOn(noteOn);
midi.onNoteOff(noteOff);
midi.onPedal(pedalChange);
midi.onStatus(showMidiStatus);
updateChrome();
document.fonts.load('30px Bravura').finally(() => {
  state.dirty = true;
  requestAnimationFrame(draw);
});
midi.start();
