// Gemini REST client with key rotation, cooldowns and caching (spec sections 5 and 7).
import { createHash } from 'node:crypto';
import { env } from './env';
import { AppError, err } from './errors';
import { QuotaExceeded, callWithKeys, type Failure } from './limits';
import { SEARCH_TOOL_DECLARATION } from './search/schema';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

class GeminiHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`gemini http ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

/** Maps a Gemini failure to a cooldown decision. Exported for tests. */
export function classifyGeminiError(e: unknown): Failure {
  if (e instanceof GeminiHttpError) {
    if (e.status === 429) {
      const b = e.body.toLowerCase();
      if (/per[_ ]?day|perday|daily|requestsperday/.test(b)) return { kind: 'day' };
      const m = e.body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
      return { kind: 'minute', retryAfterMs: m ? Math.max(65_000, Number(m[1]) * 1000) : undefined };
    }
    if (e.status === 403 || e.status === 401) return { kind: 'cooldown', ms: 15 * 60_000 }; // bad or disabled key: rotate
    if (e.status >= 500) return { kind: 'retry' };
    return { kind: 'fatal' };
  }
  return { kind: 'retry' }; // network error or timeout
}
export const makeGeminiHttpError = (status: number, body: string): Error => new GeminiHttpError(status, body);

async function post(path: string, key: string, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new GeminiHttpError(res.status, await res.text().catch(() => ''));
  return res.json();
}

export const geminiFamily = (model: string) => `gemini.${model}`;

async function call<T>(model: string, method: string, body: unknown, timeoutMs: number): Promise<T> {
  const path = `models/${model}:${method}`;
  const keys = env.GEMINI_API_KEYS;
  if (!keys.length) throw err.notConfigured('Gemini');
  try {
    return await callWithKeys<T>(geminiFamily(model), keys, {
      perMinute: env.GEMINI_RPM_PARSE,
      perDay: env.GEMINI_RPD,
      tries: 2,
      baseDelayMs: 250,
      classify: classifyGeminiError,
      fn: (key) => post(path, key, body, timeoutMs),
    });
  } catch (e) {
    if (e instanceof QuotaExceeded) throw err.quota('Gemini');
    if (e instanceof AppError) throw e;
    throw err.upstream('gemini', 'Gemini did not answer.', true, { message: String((e as Error)?.message ?? e).slice(0, 300) });
  }
}

const SYSTEM = `You turn a shopper's spoken request for used furniture into one search_listings call.
Rules: only fill what was said. "under forty bucks" -> max_total_usd 40. "no car", "I walk", "I bike" -> has_car false.
"I drive a Civic" -> car_make_model "Honda Civic", has_car true. A named place or ZIP -> origin_text.
Colors, materials and vibes go in style_text. Always call the tool exactly once.`;

/** One Gemini function call (fast model). Returns the raw tool arguments. */
export async function parseQueryWithGemini(text: string, prev?: unknown): Promise<Record<string, unknown>> {
  const user = prev
    ? `Previous search filters (the shopper may be following up; keep what still applies and change what they ask):\n${JSON.stringify(prev)}\n\nShopper says: ${text}`
    : text;
  const data = await call<any>(env.GEMINI_MODEL_FAST, 'generateContent', {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    tools: [{ functionDeclarations: [SEARCH_TOOL_DECLARATION] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search_listings'] } },
    generationConfig: { temperature: 0, maxOutputTokens: 300 },
  }, 4500);
  const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
  const fc = parts.find((p) => p.functionCall)?.functionCall;
  if (!fc?.args) throw err.upstream('gemini', 'Gemini returned no search arguments.', true);
  return fc.args as Record<string, unknown>;
}

type G = typeof globalThis & { __lr_embed?: Map<string, number[]> };
const g = globalThis as G;

/** Embeds the style text at EMBED_DIM. Cached by text hash; returns null instead of throwing. */
export async function embedText(text: string): Promise<number[] | null> {
  const t = text.trim().toLowerCase();
  if (!t || !env.GEMINI_API_KEYS.length) return null;
  g.__lr_embed ??= new Map();
  const k = createHash('sha256').update(`${env.GEMINI_EMBED_MODEL}|${env.EMBED_DIM}|${t}`).digest('hex');
  const hit = g.__lr_embed.get(k);
  if (hit) return hit;
  try {
    const data = await call<any>(env.GEMINI_EMBED_MODEL, 'embedContent', {
      content: { parts: [{ text: t }] },
      taskType: process.env.GEMINI_EMBED_TASK || 'RETRIEVAL_QUERY',
      outputDimensionality: env.EMBED_DIM,
    }, 3000);
    const v: number[] | undefined = data?.embedding?.values;
    if (!Array.isArray(v) || v.length !== env.EMBED_DIM) return null;
    if (g.__lr_embed.size > 500) g.__lr_embed.clear();
    g.__lr_embed.set(k, v);
    return v;
  } catch (e) {
    console.warn('[gemini.embed] falling back to keyword similarity:', (e as Error).message);
    return null;
  }
}
