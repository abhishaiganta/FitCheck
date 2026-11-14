// ElevenLabs speech-to-text and text-to-speech. Server-side only.
import { createHash } from 'node:crypto';
import { blobEnabled, blobFind, blobPut } from './blob';
import { env } from './env';
import { AppError, err } from './errors';
import { QuotaExceeded, callWithKeys, type Failure } from './limits';

const BASE = 'https://api.elevenlabs.io/v1';

class ElevenHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`elevenlabs http ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}
export const makeElevenHttpError = (status: number, body: string): Error => new ElevenHttpError(status, body);

export function classifyElevenError(e: unknown): Failure {
  if (e instanceof ElevenHttpError) {
    if (e.status === 429) return { kind: 'minute', retryAfterMs: 20_000 };
    if (e.status === 401 && /quota/i.test(e.body)) return { kind: 'cooldown', ms: 60 * 60_000 }; // quota_exceeded
    if (e.status >= 500) return { kind: 'retry' };
    return { kind: 'fatal' };
  }
  return { kind: 'retry' };
}

async function guarded<T>(fn: (key: string) => Promise<T>, what: string): Promise<T> {
  if (!env.ELEVENLABS_API_KEY) throw err.notConfigured('ElevenLabs');
  try {
    return await callWithKeys<T>('elevenlabs', [env.ELEVENLABS_API_KEY], {
      perMinute: 60, perDay: 5000, tries: 2, baseDelayMs: 300, classify: classifyElevenError, fn,
    });
  } catch (e) {
    if (e instanceof QuotaExceeded) throw err.quota('ElevenLabs');
    if (e instanceof AppError) throw e;
    if (e instanceof ElevenHttpError && e.status < 500) {
      throw err.upstream('elevenlabs', `${what} was rejected by ElevenLabs.`, false, { status: e.status, body: e.body.slice(0, 300) });
    }
    throw err.upstream('elevenlabs', `${what} is not answering.`, true, { message: String((e as Error)?.message ?? e).slice(0, 300) });
  }
}

/** iOS Safari records audio/mp4, Chrome records audio/webm. ElevenLabs Scribe accepts both. */
export async function speechToText(audio: Blob, filename: string): Promise<string> {
  const data = await guarded(async (key) => {
    const form = new FormData();
    form.append('model_id', env.ELEVENLABS_STT_MODEL);
    form.append('file', audio, filename);
    form.append('language_code', 'en');
    form.append('tag_audio_events', 'false');
    const res = await fetch(`${BASE}/speech-to-text`, {
      method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ElevenHttpError(res.status, await res.text().catch(() => ''));
    return (await res.json()) as { text?: string };
  }, 'Speech-to-text');
  return (data.text ?? '').replace(/\s+/g, ' ').trim();
}

type G = typeof globalThis & { __lr_tts?: Map<string, Buffer> };
const g = globalThis as G;

export const ttsCacheKey = (text: string) =>
  createHash('sha256').update(`${env.ELEVENLABS_VOICE_ID}|${env.ELEVENLABS_TTS_MODEL}|${text.trim()}`).digest('hex').slice(0, 32);

/** Text to MP3. Cached by text hash: in memory per instance and in Vercel Blob when a token is set. */
export async function textToSpeech(text: string): Promise<{ audio?: Buffer; url?: string; cached: boolean }> {
  const key = ttsCacheKey(text);
  g.__lr_tts ??= new Map();
  const mem = g.__lr_tts.get(key);
  if (mem) return { audio: mem, cached: true };
  const pathname = `tts/${key}.mp3`;
  const hit = await blobFind(pathname);
  if (hit) return { url: hit, cached: true };

  const audio = await guarded(async (k) => {
    const res = await fetch(`${BASE}/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': k, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: env.ELEVENLABS_TTS_MODEL }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new ElevenHttpError(res.status, await res.text().catch(() => ''));
    return Buffer.from(await res.arrayBuffer());
  }, 'Text-to-speech');

  if (g.__lr_tts.size > 100) g.__lr_tts.clear();
  g.__lr_tts.set(key, audio);
  if (blobEnabled()) blobPut(pathname, audio, 'audio/mpeg').catch(() => {});
  return { audio, cached: false };
}
