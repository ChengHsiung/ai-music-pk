// Cloud composer: asks Claude to continue the motif. The API key is typed in on the
// event computer and kept in that browser only; it is never part of the code.

import Anthropic from '@anthropic-ai/sdk';
import { keyLabel, noteName } from '../music/theory';
import { ComposeRequest, Melody, validateMelody } from './melody';

export const CLOUD_MODEL = 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short song title in Traditional Chinese' },
    idea: { type: 'string', description: 'One sentence in Traditional Chinese for the audience' },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          midi: { type: 'integer', description: 'MIDI note number, 60 = middle C' },
          start: { type: 'integer', description: 'Onset in sixteenth-note steps from the beginning' },
          dur: { type: 'integer', description: 'Length in sixteenth-note steps' },
        },
        required: ['midi', 'start', 'dur'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'idea', 'notes'],
  additionalProperties: false,
};

const SYSTEM = `You are the AI composer in a live "human musician vs AI" melody contest at a family event in Taiwan.
A child has just played three notes on a Yamaha digital piano. You continue those three notes into a complete,
singable melody. It is played back on the same piano and drawn note by note as staff notation on a projector,
so children and parents can follow it. Write music that is memorable, warm and clearly built from the child's notes.`;

/** Lowest and highest notes the melody may use, around where the child played. */
export function melodyRange(motif: number[]): [number, number] {
  const lo = Math.max(48, Math.min(Math.min(...motif) - 5, 64));
  const hi = Math.min(88, Math.max(Math.max(...motif) + 9, lo + 16));
  return [lo, hi];
}

export function buildPrompt(req: ComposeRequest): string {
  const minor = req.key.mode === 'minor';
  const names = req.motif.map((m) => `${m} (${noteName(m, req.key.fifths, minor)})`).join(', ');
  const total = req.bars * 16;
  const [lo, hi] = melodyRange(req.motif);
  return `The child played: ${names}.
Key: ${keyLabel(req.key)} (${minor ? 'minor' : 'major'}, tonic pitch class ${req.key.tonic}). Time: 4/4. Length: exactly ${req.bars} bars.

Rules:
- Time is counted in sixteenth-note steps; one bar is 16 steps, so the melody covers steps 0 to ${total}.
- The first three notes are exactly the child's notes, in order (MIDI ${req.motif.join(', ')}), and the first starts at step 0. You choose their rhythm.
- One note at a time, no chords and no rests: every note starts where the previous one ends, and the last note ends at step ${total}.
- Durations are 1, 2, 3, 4, 6, 8, 12 or 16 steps, mostly 2 and 4, with longer notes at the ends of phrases. Keep a note inside its bar unless it is a deliberate tie.
- Stay between MIDI ${lo} and ${hi}. Use the key's notes; in minor, raise the 7th degree at cadences.
- Build ${req.bars / 4} four-bar phrases: develop the opening three notes through repetition, sequence, inversion and rhythmic variation; mostly stepwise motion, and a leap is followed by a step back; a half cadence in the middle, one clear high point about two thirds of the way through, and end on the tonic with a note of at least 8 steps.

Also give a short song title (at most 10 Chinese characters) and one sentence (at most 40 Chinese characters) telling the audience how the melody grows from the child's three notes. Both in Traditional Chinese, friendly for children.`;
}

/** Calls Claude and returns a checked melody; throws if the call fails or the answer is unusable. */
export async function composeCloud(req: ComposeRequest, apiKey: string, signal?: AbortSignal): Promise<Melody> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 90_000, maxRetries: 1 });
  const response = await client.beta.messages.create(
    {
      model: CLOUD_MODEL,
      max_tokens: 16000,
      // If the model declines, the API retries on a fallback model within the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(req) }],
    },
    { signal },
  );
  if (response.stop_reason === 'refusal') throw new Error('雲端 AI 拒絕了這次請求');
  if (response.stop_reason === 'max_tokens') throw new Error('雲端 AI 的回答被截斷');
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return parseCloudMelody(text, req);
}

export function parseCloudMelody(text: string, req: ComposeRequest): Melody {
  const data = JSON.parse(text) as { title?: unknown; idea?: unknown; notes?: unknown };
  const notes = Array.isArray(data.notes) ? data.notes : [];
  const melody = validateMelody(
    {
      notes: notes.map((n: { midi?: unknown; start?: unknown; dur?: unknown }) => ({
        midi: Number(n.midi),
        start: Number(n.start),
        dur: Number(n.dur),
      })),
      bars: req.bars,
      beatsPerBar: 4,
      key: req.key,
      engine: 'cloud',
      title: typeof data.title === 'string' ? data.title.slice(0, 20) : undefined,
      idea: typeof data.idea === 'string' ? data.idea.slice(0, 80) : undefined,
    },
    req.motif,
  );
  if (!melody) throw new Error('雲端 AI 的旋律不完整');
  return melody;
}
