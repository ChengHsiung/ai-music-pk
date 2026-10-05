// Picks the composer: Claude when a key is set and the network answers, otherwise the offline one.

import Anthropic from '@anthropic-ai/sdk';
import { solfege } from '../music/theory';
import { composeCloud } from './cloudComposer';
import type { ComposeRequest, Melody } from './melody';
import { composeOffline } from './offlineComposer';

export type Engine = 'auto' | 'offline';

export interface ComposeSettings {
  engine: Engine;
  apiKey: string;
}

export function cloudEnabled(settings: ComposeSettings): boolean {
  return settings.engine === 'auto' && settings.apiKey.trim() !== '';
}

export async function compose(req: ComposeRequest, settings: ComposeSettings, signal?: AbortSignal): Promise<Melody> {
  let fallbackReason: string | undefined;
  if (cloudEnabled(settings)) {
    if (!navigator.onLine) {
      fallbackReason = '沒有網路，改用離線 AI';
    } else {
      try {
        return await composeCloud(req, settings.apiKey.trim(), signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn('Cloud composer failed', err);
        fallbackReason = `雲端 AI 失敗（${describeError(err)}），改用離線 AI`;
      }
    }
  }
  return { ...offline(req), fallbackReason };
}

export function offline(req: ComposeRequest): Melody {
  const m = composeOffline(req);
  const minor = req.key.mode === 'minor';
  const motif = req.motif.map((n) => solfege(n, req.key.fifths, minor)).join(' ');
  const tonic = solfege(m.notes.at(-1)!.midi, req.key.fifths, minor);
  const steps = req.bars > 8 ? '重複、模進、倒影' : '重複和模進';
  return { ...m, title: 'AI 的旋律', idea: `以「${motif}」為主題，用${steps}發展，最後回到 ${tonic} 結束` };
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'API 金鑰不正確';
  if (err instanceof Anthropic.PermissionDeniedError) return '這組金鑰沒有權限';
  if (err instanceof Anthropic.RateLimitError) return '請求太多或額度用完';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return '等太久沒回應';
  if (err instanceof Anthropic.APIConnectionError) return '連不上網路';
  if (err instanceof Anthropic.InternalServerError) return '伺服器忙碌';
  if (err instanceof SyntaxError) return '回答格式不對';
  return err instanceof Error ? err.message : String(err);
}
