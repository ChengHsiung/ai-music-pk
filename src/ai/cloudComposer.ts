// Cloud composer: asks Claude to turn the child's three to five notes into a short song with chords.
// The API key is typed in on the event computer and kept in that browser only; it is never
// part of the code.
//
// Claude writes the melody in ABC notation (one string per bar), the way tunes are usually
// written down, and the chords first, so it composes with harmony in mind instead of
// juggling numbers. The left hand is then built from the chords in code (accompaniment.ts).

import Anthropic from '@anthropic-ai/sdk';
import { abcKey, abcNote, parseAbcBars } from '../music/abc';
import { keyLabel, solfege } from '../music/theory';
import { ChordSpan, Feel, FEELS } from './accompaniment';
import { ComposeRequest, FEEL_BPM, finishMelody, Melody, suggestFeels, validateMelody } from './melody';

export const CLOUD_MODEL = 'claude-opus-5-5';
/** Give up on the cloud after this long; the offline composer takes over. */
const DEADLINE_MS = 110_000;

const FEEL_TEXT: Record<Feel, string> = {
  gentle: 'gentle: a lullaby, tender and calm, long notes and soft rocking',
  flowing: 'flowing: a warm pop ballad, a singing line over rolling eighth notes',
  bright: 'bright: playful and bouncy, dotted or short-short-long rhythms, light and happy',
  march: 'march: brave and proud, strong downbeats, dotted rhythms, a confident tune',
  mysterious: 'mysterious: curious and a little secret, quiet, a minor colour or one surprising turn',
  farewell: 'farewell: a tender goodbye song, bittersweet but warm, like waving to a friend at graduation; long singing notes, gently falling phrases that sigh, a vi or a borrowed iv to colour the harmony, and a hopeful last phrase',
};

const SCHEMA = {
  type: 'object',
  properties: {
    feel: { type: 'string', enum: [...FEELS], description: 'Character of the piece; it also picks the accompaniment pattern' },
    tempo: { type: 'integer', description: 'Beats per minute, inside the band for the chosen feel' },
    chords: {
      type: 'array',
      description: 'One entry per bar, in order. Each entry is one chord for the whole bar or two chords (one per half bar), e.g. ["C"] or ["F", "G7"]',
      items: { type: 'array', items: { type: 'string' } },
    },
    melody: {
      type: 'array',
      description: 'One ABC string per bar, in order, with L:1/8 and the given key; each bar adds up to exactly 8 eighths',
      items: { type: 'string' },
    },
    title: { type: 'string', description: 'Song title in Traditional Chinese, at most 10 characters' },
    idea: { type: 'string', description: 'One sentence in Traditional Chinese for the audience, at most 30 characters' },
  },
  required: ['feel', 'tempo', 'chords', 'melody', 'title', 'idea'],
  additionalProperties: false,
};

const SYSTEM = `You are a songwriter for children's TV and Mandopop, playing the AI side of a live "human musician vs AI" contest at a family event in Taiwan. A child (5 to 10 years old) has just played a few notes (three to five) on a digital piano. While a human musician improvises from the same notes, you turn them into a short song: a melody with its chords. The app plays it on the same piano, with a left-hand accompaniment built from your chords, and draws it note by note on a projector. The audience then votes by raising hands.

What makes it good for this audience:
- A hook. Give the child's notes a memorable rhythm. They open the tune and come back at least twice (as they are, moved to another pitch, or with the rhythm varied, never upside down), so the audience recognises "their" notes. When the child played four or five notes, a return may use just the first three or four of them.
- A real song form with repetition, for example a a' b a (two-bar units: statement, answer ending on the dominant, contrast with the high point, return and close) or a b a c (bars 5 to 6 bring back bars 1 to 2, then bars 7 to 8 reach the peak and close). A pattern moved up or down may appear at most twice; the third time breaks it.
- Phrases that breathe. Each two-bar idea ends on a longer note or a short rest, and the middle of the song (the end of bar 4) has a clear breath: a long note and a rest, or a rest and a pickup into the next phrase. Leave at least two rests in the song.
- A rhythmic identity. One signature rhythm (a dotted note, a syncopation or a pickup) that returns, and one contrasting rhythm. Not a stream of equal eighth notes: aim for about 3 to 4 notes per bar on average, with long notes at phrase ends. Repeated notes are welcome; children's songs are full of them.
- Harmony that carries the tune. Notes on beats 1 and 3 are mostly chord tones; a non-chord tone on a strong beat resolves by step. Simple, strong progressions (I, IV, V, vi, ii; in minor i, iv, V, VI, III) suit children. Never outline a diminished chord in the melody.
- One emotional peak. The highest note of the song comes once, after the middle, on a strong beat, held at least a quarter note, reached by an expressive leap (a 4th to a 6th) and left by step. Then a satisfying way home to the tonic.
- Shape, not exercises: no stepwise run of more than four notes in one direction, mostly comfortable intervals, a range a child can sing.
- Original: do not quote or closely imitate an existing song (no "Happy Birthday", no "Twinkle Twinkle").

How to work: in your head, choose the feel and tempo and write the chord progression first. It helps to imagine a short Chinese lyric line for each two-bar phrase and let the rhythm follow how the words are spoken. Sketch two or three different hooks for the child's notes (different rhythm, with or without a pickup), sing each through as a child in the audience would hear it, and keep the most memorable one. Then polish it and check the requirements.`;

function melodyRange(motif: number[]): [number, number] {
  const lo = Math.max(50, Math.min(Math.min(...motif), 60) - 3);
  const hi = Math.min(84, Math.max(Math.max(...motif) + 5, lo + 17, 74));
  return [lo, hi];
}

export function buildPrompt(req: ComposeRequest): string {
  const minor = req.key.mode === 'minor';
  const { fifths } = req.key;
  const k = abcKey(req.key.tonic, fifths, minor);
  const abc = req.motif.map((m) => abcNote(m, fifths, minor)).join(' ');
  const solf = req.motif.map((m) => solfege(m, fifths, minor)).join(' ');
  const [lo, hi] = melodyRange(req.motif);
  const tonic = abcNote(60 + req.key.tonic, fifths, minor).replace(/[,']/g, '');
  const phrases = req.bars / 4;
  const feelLine = req.feel
    ? `Feel: ${FEEL_TEXT[req.feel]} (${FEEL_BPM[req.feel].join('–')} BPM).`
    : `Feel: your choice. Pick what suits these notes (rising lines can be bright or brave, falling ones gentle, flowing or a farewell, repeated notes playful, a minor sound flowing, mysterious or a farewell)${
        req.avoidFeel ? `, but not "${req.avoidFeel}", which the previous tune used` : ''
      }. The feels and their tempo bands:\n${FEELS.map((f) => `- ${FEEL_TEXT[f]} (${FEEL_BPM[f].join('–')} BPM)`).join('\n')}`;

  return `The child played: ${abc} (solfège ${solf}).
Key: ${keyLabel(req.key)} (ABC K:${k}). Time: 4/4. Length: exactly ${req.bars} bars in ${phrases} four-bar phrases.
${feelLine}

Write the melody in ABC notation, one string per bar, with unit length L:1/8 and key signature K:${k}:
- Pitch: C, = C3, C = C4 (middle C), c = C5, c' = C6. ^ sharp, _ flat, = natural; an accidental lasts to the end of its bar. Write the raised 7th of a minor key with its accidental.
- Length: C = eighth, C2 = quarter, C3 = dotted quarter, C4 = half, C6 = dotted half, C8 = whole, C/ = sixteenth, C3/2 = dotted eighth. z is a rest with the same lengths. A trailing - ties a note to the next one of the same pitch, also across the barline.
- Every bar adds up to exactly 8 eighths. One note at a time: no chords, grace notes or triplets in the melody.
Example of the format, and of a simple shape with repetition and long notes (the start of 小蜜蜂; do not reuse it): ["G2 E2 E4", "F2 D2 D4", "C2 D2 E2 F2", "G2 G2 G4"].

The app needs:
- The melody opens with the child's ${req.motif.length} notes ${abc}, in this order and octave, not tied together. Any rhythm; they may start after a rest, but no later than beat 3 of bar 1${req.motif.length > 3 ? ', and may run on into bar 2' : ''}.
- The melody stays between ${abcNote(lo, fifths, minor)} and ${abcNote(hi, fifths, minor)}.
- The end of bar 4 is a half cadence on the dominant, and the last bar lands on the tonic ${tonic} on beat 1 (or beat 3), held at least a half note.
- Chords: one or two per bar, as symbols like C, Am, F, G7, Dm, E7, F/A, Bb. Write the chords first, then fit the melody to them.

Finally a title and one sentence for the audience, both in Traditional Chinese, warm and fun for children. The sentence paints the picture or feeling of the tune (像…), not the techniques used. Be fresh: avoid 爬樓梯, 回家, 旅行 and other clichés.${
    req.avoidTitles?.length ? `\nEarlier tunes at this event were called ${req.avoidTitles.map((t) => `「${t}」`).join('')}; choose a different picture.` : ''
  }`;
}

/** Calls Claude and returns a checked melody; throws if the call fails or the answer is unusable. */
export async function composeCloud(req: ComposeRequest, apiKey: string, signal?: AbortSignal): Promise<Melody> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: DEADLINE_MS, maxRetries: 1 });
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const stream = client.beta.messages.stream(
    {
      model: CLOUD_MODEL,
      max_tokens: 16000,
      // If the model declines, the API retries on a fallback model within the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // Composing well takes some thought; the answer is still back while the musician plays.
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(req) }],
    },
    { signal: signal ? AbortSignal.any([signal, deadline]) : deadline },
  );
  const response = await stream.finalMessage();
  if (response.stop_reason === 'refusal') throw new Error('雲端 AI 拒絕了這次請求');
  if (response.stop_reason === 'max_tokens') throw new Error('雲端 AI 的回答被截斷');
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return parseCloudMelody(text, req);
}

/** Chord spans for one bar: one chord fills it, two split it in halves, more share it evenly. */
function barChords(symbols: unknown, bar: number, stepsPerBar: number): ChordSpan[] {
  const list = (Array.isArray(symbols) ? symbols : [symbols]).filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, 4);
  const each = list.length ? Math.max(4, Math.floor(stepsPerBar / list.length / 4) * 4) : 0;
  return list.map((symbol, i) => ({
    symbol: symbol.trim(),
    start: bar * stepsPerBar + i * each,
    dur: i === list.length - 1 ? stepsPerBar - i * each : each,
  }));
}

export function parseCloudMelody(text: string, req: ComposeRequest): Melody {
  const data = JSON.parse(text) as { feel?: unknown; tempo?: unknown; chords?: unknown; melody?: unknown; title?: unknown; idea?: unknown };
  const bars = Array.isArray(data.melody) ? data.melody.filter((b): b is string => typeof b === 'string') : [];
  if (bars.length < req.bars) throw new Error('雲端 AI 的旋律不完整');
  const stepsPerBar = 16;
  const { notes } = parseAbcBars(bars.slice(0, req.bars), req.key.fifths);
  const chords = Array.isArray(data.chords)
    ? data.chords.slice(0, req.bars).flatMap((c, b) => barChords(c, b, stepsPerBar))
    : [];
  const feel = FEELS.includes(data.feel as Feel) ? (data.feel as Feel) : undefined;
  const melody = validateMelody(
    {
      notes: notes.flatMap((n) => (n.midi === null ? [] : [{ midi: n.midi, start: n.start, dur: n.dur }])),
      bars: req.bars,
      beatsPerBar: 4,
      key: req.key,
      engine: 'cloud',
      title: typeof data.title === 'string' ? data.title.slice(0, 20) : undefined,
      idea: typeof data.idea === 'string' ? data.idea.slice(0, 80) : undefined,
      bpm: typeof data.tempo === 'number' ? data.tempo : undefined,
      chords,
      feel,
    },
    req.motif,
  );
  if (!melody) throw new Error('雲端 AI 的旋律不完整');
  return finishMelody(melody, req.feel ?? suggestFeels(req.motif, req.key)[0]);
}
