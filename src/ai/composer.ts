// Picks the composer: Claude when a key is set and the network answers, otherwise the offline one.

import Anthropic from '@anthropic-ai/sdk';
import { solfege } from '../music/theory';
import { Feel, FEEL_LABEL } from './accompaniment';
import { composeCloud } from './cloudComposer';
import { ComposeRequest, finishMelody, Melody, suggestFeels } from './melody';
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

const OFFLINE_TITLES: Record<Feel, string[]> = {
  gentle: ['月光搖籃', '晚安小雲朵', '輕輕的風'],
  flowing: ['風中的小船', '溫暖的午後', '彩色的河'],
  bright: ['跳跳糖', '開心小步舞', '泡泡飛呀飛'],
  march: ['勇敢小兵', '出發吧！', '小小探險隊'],
  mysterious: ['森林的秘密', '月夜探險', '神秘的門'],
};

const OFFLINE_PICTURE: Record<Feel, string> = {
  gentle: '像媽媽輕輕哼的搖籃曲',
  flowing: '像小船在河上慢慢漂',
  bright: '像小兔子在草地上跳來跳去',
  march: '像小隊伍神氣地向前走',
  mysterious: '像在月光下打開一扇神秘的門',
};

/** The feel for a tune: the host's choice, or one that suits the motif and differs from the last tune. */
export function chooseFeel(req: ComposeRequest): Feel {
  if (req.feel) return req.feel;
  const options = suggestFeels(req.motif, req.key).filter((f) => f !== req.avoidFeel);
  return options[(req.seed ?? 0) % options.length];
}

export function offline(req: ComposeRequest): Melody {
  const feel = chooseFeel(req);
  const m = finishMelody({ ...composeOffline(req), feel }, feel);
  const minor = req.key.mode === 'minor';
  const motif = req.motif.map((n) => solfege(n, req.key.fifths, minor)).join(' ');
  const fresh = OFFLINE_TITLES[feel].filter((t) => !req.avoidTitles?.includes(t));
  const titles = fresh.length ? fresh : OFFLINE_TITLES[feel];
  return {
    ...m,
    title: titles[(req.seed ?? 0) % titles.length],
    idea: `「${motif}」變成一首${FEEL_LABEL[feel]}的小曲，${OFFLINE_PICTURE[feel]}`,
  };
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
