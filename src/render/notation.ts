// Draws the live grand staff and the tidied score with VexFlow.

import {
  Accidental,
  Annotation,
  BarlineType,
  Beam,
  Dot,
  Formatter,
  GhostNote,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Voice,
  type RenderContext,
  type Tickable,
} from 'vexflow/bravura';
import { QuantizedScore, SPLIT_MIDI, StaffName, Tick } from '../music/quantize';
import { signatureAlters, spell, solfege, vexKey, vexKeySignature } from '../music/theory';

export const COLORS = {
  ink: '#1f1830',
  /** The child's notes */
  motif: '#f76707',
  /** The note just played in the live view: the musician (可愛師父) is playing */
  current: '#e64980',
  accompaniment: '#9a93a8',
  label: '#5f5470',
};

/** Solfège labels use the page's rounded font when it has loaded. */
const LABEL_FONT = 'Huninn, Arial';

const VEX_DURATION: Record<number, string> = {
  16: 'w', 12: 'h', 8: 'h', 6: 'q', 4: 'q', 3: '8', 2: '8', 1: '16',
};
const DOTTED = new Set([12, 6, 3]);
const WIDTH = 1200;
const MARGIN = 16;

export interface LiveGroup {
  midis: number[];
  ids: number[];
}

export interface DrawOptions {
  fifths: number;
  /** Minor key: spell the raised 6th and 7th with sharps */
  minor?: boolean;
  showSolfege: boolean;
  /** Event ids drawn in the motif colour */
  motifIds?: Set<number>;
  /** Event ids of an accompaniment, drawn in grey without solfège so the melody stands out */
  accompaniment?: (id: number) => boolean;
}

/** Draws into a fresh SVG that scales to the container width. */
function makeRenderer(el: HTMLElement, height: number, width = WIDTH): RenderContext {
  el.innerHTML = '';
  const renderer = new Renderer(el as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(width, height);
  const ctx = renderer.getContext();
  const svg = el.querySelector('svg')!;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.style.width = '100%';
  svg.style.height = 'auto';
  return ctx;
}

/** Keys, display accidentals and labels for one chord, tracking accidentals already shown in the bar. */
function chordNote(
  midis: number[],
  staff: StaffName,
  duration: string,
  opts: DrawOptions,
  barState: Map<string, number> | null,
  isContinuation = false,
): StaveNote {
  const pitches = midis.map((m) => spell(m, opts.fifths, opts.minor));
  const note = new StaveNote({
    keys: pitches.map(vexKey),
    duration,
    clef: staff,
    autoStem: true,
  });
  const sig = signatureAlters(opts.fifths);
  pitches.forEach((p, i) => {
    const slot = `${p.letter}${p.octave}`;
    const current = barState?.get(slot) ?? sig[p.letter];
    if (p.alter !== current) {
      if (!isContinuation) {
        const sym = p.alter === 0 ? 'n' : p.alter > 0 ? '#'.repeat(p.alter) : 'b'.repeat(-p.alter);
        note.addModifier(new Accidental(sym), i);
      }
      barState?.set(slot, p.alter);
    }
  });
  if (opts.showSolfege && !isContinuation) {
    const top = midis[midis.length - 1];
    const label = new Annotation(solfege(top, opts.fifths, opts.minor))
      .setFont(LABEL_FONT, staff === 'treble' ? 16 : 15)
      .setVerticalJustification(Annotation.VerticalJustify.BOTTOM);
    label.setStyle({ fillStyle: COLORS.label });
    note.addModifier(label, midis.length - 1);
  }
  return note;
}

function isAccompaniment(ids: number[], opts: DrawOptions): boolean {
  return !!opts.accompaniment && ids.length > 0 && ids.every(opts.accompaniment);
}

const painted = new WeakMap<StaveNote, string>();

function paint(note: StaveNote, color: string) {
  const style = { fillStyle: color, strokeStyle: color };
  note.setStyle(style);
  note.setStemStyle(style);
  note.setLedgerLineStyle(style);
  if (note.hasFlag()) note.setFlagStyle(style);
  painted.set(note, color);
}

function drawGrandStaff(ctx: RenderContext, x: number, y: number, width: number, gap: number, opts: {
  fifths: number;
  clef: boolean;
  time?: string;
}) {
  const treble = new Stave(x, y, width);
  const bass = new Stave(x, y + gap, width);
  if (opts.clef) {
    treble.addClef('treble').addKeySignature(vexKeySignature(opts.fifths));
    bass.addClef('bass').addKeySignature(vexKeySignature(opts.fifths));
  }
  if (opts.time) {
    treble.addTimeSignature(opts.time);
    bass.addTimeSignature(opts.time);
  }
  const startX = Math.max(treble.getNoteStartX(), bass.getNoteStartX());
  treble.setNoteStartX(startX);
  bass.setNoteStartX(startX);
  treble.setContext(ctx);
  bass.setContext(ctx);
  return { treble, bass };
}

function connect(ctx: RenderContext, treble: Stave, bass: Stave, types: Parameters<StaveConnector['setType']>[0][]) {
  for (const t of types) new StaveConnector(treble, bass).setType(t).setContext(ctx).draw();
}

// ---------------------------------------------------------------- live view

/** Shows the most recent notes as equal-length heads: pitch is exact, rhythm is not. */
export function renderLive(el: HTMLElement, groups: LiveGroup[], opts: DrawOptions & { maxNotes?: number }) {
  // A narrower canvas than the score, so the live notes appear larger on the projector.
  const width = 960;
  const gap = 130;
  const height = 320;
  const ctx = makeRenderer(el, height, width);
  const { treble, bass } = drawGrandStaff(ctx, MARGIN, 30, width - 2 * MARGIN, gap, { fifths: opts.fifths, clef: true });
  treble.draw();
  bass.draw();
  connect(ctx, treble, bass, ['brace', 'singleLeft', 'singleRight']);

  const shown = groups.slice(-(opts.maxNotes ?? 12));
  if (shown.length === 0) return;

  const trebleNotes: Tickable[] = [];
  const bassNotes: Tickable[] = [];
  shown.forEach((g, i) => {
    const isLast = i === shown.length - 1;
    const isMotif = g.ids.some((id) => opts.motifIds?.has(id));
    const color = isMotif ? COLORS.motif : isLast ? COLORS.current : COLORS.ink;
    for (const staff of ['treble', 'bass'] as const) {
      const midis = g.midis.filter((m) => (staff === 'treble' ? m >= SPLIT_MIDI : m < SPLIT_MIDI));
      const list = staff === 'treble' ? trebleNotes : bassNotes;
      if (midis.length === 0) {
        list.push(new GhostNote('q'));
      } else {
        const n = chordNote(midis, staff, 'q', opts, null);
        paint(n, color);
        list.push(n);
      }
    }
  });

  const tv = new Voice({ numBeats: shown.length, beatValue: 4 }).setMode(Voice.Mode.SOFT).addTickables(trebleNotes);
  const bv = new Voice({ numBeats: shown.length, beatValue: 4 }).setMode(Voice.Mode.SOFT).addTickables(bassNotes);
  const available = treble.getNoteEndX() - treble.getNoteStartX() - 40;
  const slots = Math.max(shown.length, 8); // keep a few notes from spreading across the whole staff
  new Formatter().joinVoices([tv]).joinVoices([bv]).format([tv, bv], (available * shown.length) / slots);
  tv.draw(ctx, treble);
  bv.draw(ctx, bass);
}

// ---------------------------------------------------------------- full score

export interface ScoreOptions extends DrawOptions {
  barsPerLine?: number;
  /** Drawing width in score units; narrower draws larger in the same space */
  width?: number;
}

/** Lets a drawn score appear note by note while it is played, and follow the playing. */
export interface ScoreView {
  /** Shows everything that starts before `step` (sixteenths); Infinity shows the whole score. */
  reveal(step: number): void;
  /** Marks the notes of these event ids as sounding now; returns the first one. */
  highlight(ids: number[]): SVGElement | null;
  /**
   * Scrolls `scroller` (an ancestor that scrolls) so the line holding `step` is at the top,
   * once each time the playing moves to another line.
   */
  follow(step: number, scroller: HTMLElement): void;
}

/** The sixteenth-note step a drawn note starts on, as tagged by renderScore. */
export function stepOf(node: Element | null): number {
  return Number((node as SVGElement | null)?.dataset.step ?? NaN);
}

interface Mark {
  element: { getAttribute(name: string): unknown };
  step: number;
  ids: number[];
}

export function renderScore(el: HTMLElement, score: QuantizedScore, opts: ScoreOptions): ScoreView {
  const barsPerLine = opts.barsPerLine ?? 4;
  const stepsPerBar = score.beatsPerBar * 4;
  const gap = 120;
  const lineHeight = 290;
  const lines = Math.ceil(score.bars.length / barsPerLine);
  const pageWidth = opts.width ?? WIDTH;
  const ctx = makeRenderer(el, lines * lineHeight + 20, pageWidth);
  const drawOpts: DrawOptions = { ...opts, fifths: score.key.fifths, minor: score.key.mode === 'minor' };
  const time = `${score.beatsPerBar}/4`;

  // Width of clef + key (+ time) at the start of a line.
  const probe = new Stave(0, 0, 500).addClef('treble').addKeySignature(vexKeySignature(score.key.fifths));
  const header = probe.getNoteStartX();
  const probeTime = new Stave(0, 0, 500)
    .addClef('treble').addKeySignature(vexKeySignature(score.key.fifths)).addTimeSignature(time);
  const headerFirst = probeTime.getNoteStartX();

  const pendingTie: Record<StaffName, { note: StaveNote; line: number } | null> = { treble: null, bass: null };
  const ties: StaveTie[] = [];
  const marks: Mark[] = [];
  const noteStep = new Map<StaveNote, number>();

  score.bars.forEach((bar, b) => {
    const line = Math.floor(b / barsPerLine);
    const col = b % barsPerLine;
    const head = line === 0 ? headerFirst : header;
    const barWidth = (pageWidth - 2 * MARGIN - head) / barsPerLine;
    const x = col === 0 ? MARGIN : MARGIN + head + col * barWidth;
    const width = col === 0 ? barWidth + head : barWidth;
    const y = 30 + line * lineHeight;

    const { treble, bass } = drawGrandStaff(ctx, x, y, width, gap, {
      fifths: score.key.fifths,
      clef: col === 0,
      time: b === 0 ? time : undefined,
    });
    treble.setMeasure(b + 1);
    const isLast = b === score.bars.length - 1;
    if (isLast) {
      treble.setEndBarType(BarlineType.END);
      bass.setEndBarType(BarlineType.END);
    }
    treble.draw();
    bass.draw();
    if (col === 0) connect(ctx, treble, bass, ['brace', 'singleLeft']);
    connect(ctx, treble, bass, [isLast ? 'boldDoubleRight' : 'singleRight']);

    const voices: Voice[] = [];
    const beams: Beam[] = [];
    for (const staff of ['treble', 'bass'] as const) {
      const barState = new Map<string, number>();
      const notes = bar[staff].map((t) => tickToNote(t, staff, drawOpts, barState));
      let step = b * stepsPerBar;
      bar[staff].forEach((t, i) => {
        const note = notes[i];
        noteStep.set(note, step);
        marks.push({ element: note, step, ids: t.ids });
        const prev = pendingTie[staff];
        if (t.tiedFromPrev && prev) {
          const idx = t.midis.map((_, k) => k);
          const tieMarks = (tie: StaveTie) => {
            ties.push(tie);
            marks.push({ element: tie, step, ids: [] });
          };
          if (prev.line === line) {
            tieMarks(new StaveTie({ firstNote: prev.note, lastNote: note, firstIndexes: idx, lastIndexes: idx }));
          } else {
            tieMarks(new StaveTie({ firstNote: prev.note, lastNote: null, firstIndexes: idx, lastIndexes: idx }));
            tieMarks(new StaveTie({ firstNote: null, lastNote: note, firstIndexes: idx, lastIndexes: idx }));
          }
        }
        pendingTie[staff] = t.tieToNext ? { note, line } : null;
        step += t.dur;
      });
      const voice = new Voice({ numBeats: score.beatsPerBar, beatValue: 4 }).setMode(Voice.Mode.SOFT).addTickables(notes);
      voices.push(voice);
      const barBeams = Beam.generateBeams(notes.filter((n) => !n.isRest()) as StaveNote[], { maintainStemDirections: false });
      // Beaming rebuilds the stems, so coloured notes are painted again.
      notes.forEach((n) => painted.has(n) && paint(n, painted.get(n)!));
      for (const beam of barBeams) {
        const ids = beam.getNotes().flatMap((n) => bar[staff][notes.indexOf(n as StaveNote)]?.ids ?? []);
        if (isAccompaniment(ids, drawOpts)) beam.setStyle({ fillStyle: COLORS.accompaniment, strokeStyle: COLORS.accompaniment });
      }
      beams.push(...barBeams);
    }

    const available = treble.getNoteEndX() - treble.getNoteStartX() - 16;
    new Formatter().joinVoices([voices[0]]).joinVoices([voices[1]]).format(voices, available);
    voices[0].draw(ctx, treble);
    voices[1].draw(ctx, bass);
    beams.forEach((beam) => {
      beam.setContext(ctx).drawWithStyle();
      // A beam appears with its first note.
      const step = Math.min(...beam.getNotes().map((n) => noteStep.get(n as StaveNote) ?? 0));
      marks.push({ element: beam, step, ids: [] });
    });
  });

  ties.forEach((t) => t.setContext(ctx).draw());

  // Tag the SVG groups VexFlow drew so they can be shown and coloured later without redrawing.
  const tagged: SVGElement[] = [];
  for (const m of marks) {
    const node = el.querySelector<SVGElement>(`[id="vf-${m.element.getAttribute('id')}"]`);
    if (!node) continue;
    node.dataset.step = String(m.step);
    if (m.ids.length) node.dataset.ids = m.ids.join(' ');
    tagged.push(node);
  }

  let shownLine = -1;
  return {
    reveal(step: number) {
      for (const node of tagged) node.classList.toggle('pending', Number(node.dataset.step) >= step);
    },
    highlight(ids: number[]) {
      let first: SVGElement | null = null;
      for (const node of tagged) {
        const on = !!node.dataset.ids && node.dataset.ids.split(' ').some((id) => ids.includes(Number(id)));
        node.classList.toggle('now', on);
        if (on && !first) first = node;
      }
      return first;
    },
    follow(step: number, scroller: HTMLElement) {
      if (!Number.isFinite(step)) return;
      const line = Math.min(lines - 1, Math.floor(Math.max(0, step) / stepsPerBar / barsPerLine));
      const svg = el.querySelector('svg');
      if (line === shownLine || !svg) return;
      shownLine = line;
      const scale = svg.getBoundingClientRect().width / pageWidth;
      const top = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + line * lineHeight * scale;
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scroller.scrollTo({ top: Math.max(0, top - 6), behavior: smooth ? 'smooth' : 'auto' });
    },
  };
}

function tickToNote(t: Tick, staff: StaffName, opts: DrawOptions, barState: Map<string, number>): StaveNote {
  const duration = VEX_DURATION[t.dur];
  let note: StaveNote;
  if (t.rest) {
    note = new StaveNote({ keys: [staff === 'treble' ? 'b/4' : 'd/3'], duration: duration + 'r', clef: staff });
    if (t.dur === 16) note.setCenterAlignment(true); // whole-bar rest sits in the middle of the bar
  } else if (isAccompaniment(t.ids, opts)) {
    note = chordNote(t.midis, staff, duration, { ...opts, showSolfege: false }, barState, t.tiedFromPrev);
    paint(note, COLORS.accompaniment);
  } else {
    note = chordNote(t.midis, staff, duration, opts, barState, t.tiedFromPrev);
    if (t.ids.some((id) => opts.motifIds?.has(id))) paint(note, COLORS.motif);
  }
  if (DOTTED.has(t.dur)) Dot.buildAndAttach([note], { all: true });
  return note;
}
