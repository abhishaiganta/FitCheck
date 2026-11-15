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

export type SizeEstimate = {
  category: string | null;
  title: string | null;
  w_in: number; d_in: number; h_in: number;
  confidence: 'low' | 'medium' | 'high';
  /** what the estimate leans on, shown to the seller: "door frame behind it", "typical desk chair" */
  basis: string;
};

const MEASURE_PROMPT = `You estimate the real-world size of ONE piece of furniture from a seller's photo(s).
The photos show the same item (front, and sometimes a side view). Work like a careful appraiser:
1. Identify the item and its type.
2. Look for scale cues in the scene, in this order of trust: a sheet of letter paper (8.5 x 11 in), a credit card,
   a standard interior door (80 in tall, 30-36 in wide), a wall outlet or light switch plate (4.5 in tall),
   a door knob (36 in from the floor), floor tiles or planks, a bed, a laptop, a water bottle, a person's hand.
3. If there is no usable cue, fall back on typical sizes for exactly this kind of item and say so.
Return the overall bounding box in inches: width (left to right as it faces you), depth (front to back), height (floor to top).
confidence: "high" only with a known-size reference object clearly next to the item; "medium" with indirect cues
(door, outlet, tiles); "low" when you relied on typical sizes. basis: under 12 words, plain English, naming the cue you used.
category must be one of: side_table, nightstand, coffee_table, desk_lamp, floor_lamp, stool, ottoman, accent_chair,
dining_chair, dresser, bookshelf, desk; or "other". title: 3 to 6 words a seller would use.`;

/**
 * Size from photos, no typing. A web page cannot use LiDAR or ARKit, so this is an estimate from visual cues;
 * the sell page labels it that way and lets the seller correct it. Uses the fast multimodal model so it does
 * not share the worker's vision-model daily quota.
 */
export async function estimateItemSize(images: { mime: string; b64: string }[]): Promise<SizeEstimate> {
  const model = process.env.GEMINI_MODEL_MEASURE || env.GEMINI_MODEL_FAST;
  const data = await call<any>(model, 'generateContent', {
    systemInstruction: { parts: [{ text: MEASURE_PROMPT }] },
    contents: [{ role: 'user', parts: [
      ...images.map((i) => ({ inlineData: { mimeType: i.mime, data: i.b64 } })),
      { text: 'Estimate this item\'s width, depth and height in inches.' },
    ] }],
    generationConfig: {
      temperature: 0, maxOutputTokens: 300, responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          category: { type: 'STRING' }, title: { type: 'STRING' },
          w_in: { type: 'NUMBER' }, d_in: { type: 'NUMBER' }, h_in: { type: 'NUMBER' },
          confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] }, basis: { type: 'STRING' },
        },
        required: ['w_in', 'd_in', 'h_in', 'confidence', 'basis'],
      },
    },
  }, 12_000);
  const text: string | undefined = data?.candidates?.[0]?.content?.parts?.find((p: any) => typeof p.text === 'string')?.text;
  return parseSizeEstimate(text);
}

/** Validates the model's JSON. Exported for tests. Throws a retryable error on nonsense. */
export function parseSizeEstimate(text: string | undefined): SizeEstimate {
  let j: any;
  try { j = JSON.parse(text ?? ''); } catch { throw err.upstream('gemini', "Couldn't read the size from that photo.", true); }
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 2 && n <= 120 ? Math.round(n * 2) / 2 : null; };
  const w = num(j?.w_in), d = num(j?.d_in), h = num(j?.h_in);
  if (w == null || d == null || h == null) throw err.upstream('gemini', "Couldn't read the size from that photo.", true);
  const confidence = ['low', 'medium', 'high'].includes(j.confidence) ? j.confidence : 'low';
  return {
    category: typeof j.category === 'string' && j.category !== 'other' ? j.category : null,
    title: typeof j.title === 'string' ? j.title.trim().slice(0, 80) || null : null,
    w_in: w, d_in: d, h_in: h, confidence,
    basis: typeof j.basis === 'string' ? j.basis.trim().slice(0, 90) : 'typical size for this kind of item',
  };
}
