// Every fallback in spec section 14 that lives on the server, with the failing dependency mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFixtureDb } from '@/lib/db';
import { errorJson, toAppError, AppError, err } from '@/lib/errors';
import { MemoryStore, configureLimits } from '@/lib/limits';
import { backfill, handleSearch } from '@/lib/search/run';
import { parseSearchArgs } from '@/lib/search/schema';
import { checkIpLimit } from '@/lib/ratelimit';
import { getItemCard } from '@/lib/search/item';

const ids = { thread: 't', resource: 'r' };
const DEMO = 'desk lamp and side table under $40, warm wood, I drive a Civic';
const realFetch = globalThis.fetch;

function geminiReply(args: object) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'search_listings', args } }] } }] }), { status: 200 });
}

beforeEach(() => {
  process.env.DATABASE_URL = 'pglite://fixtures';
  process.env.DATABASE_URL_DEMO = 'pglite://fixtures';
  process.env.DEMO_MODE = '1';
  process.env.SEARCH_ENGINE = 'direct';
  process.env.GEMINI_API_KEYS = '';
  configureLimits({ store: new MemoryStore(), now: () => new Date(), resetBreakers: true, sleep: async () => {} });
});
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe('search never hard-fails', () => {
  it('no Gemini keys: the keyword parser answers', async () => {
    const out = await handleSearch({ text: DEMO }, ids);
    expect(out.engine).toBe('keyword');
    expect(out.results.length).toBe(3);
    expect(out.profile).toMatchObject({ location: 'UCSD', car: 'Honda Civic', budget_usd: 40, style: 'warm wood' });
    expect(out.data_source).toBe('live');
  });

  it('Gemini function call is used when it works, with zod validation of its arguments', async () => {
    process.env.GEMINI_API_KEYS = 'k1,k2';
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push(String(url));
      expect(init.headers['x-goog-api-key']).toBe('k1');
      if (String(url).includes(':embedContent')) return new Response(JSON.stringify({ embedding: { values: Array(768).fill(0.01) } }));
      return geminiReply({ categories: ['desk_lamp', 'side_table', 'sofa'], max_total_usd: '40', style_text: 'warm wood', car_make_model: 'Honda Civic', has_car: true });
    }) as any;
    const out = await handleSearch({ text: DEMO }, ids);
    expect(out.engine).toBe('gemini');
    expect(out.filters.categories).toEqual(['desk_lamp', 'side_table']); // "sofa" dropped by the schema
    expect(out.filters.max_total_usd).toBe(40);
    expect(out.results.length).toBe(3);
    expect(calls.some((c) => c.includes(':generateContent'))).toBe(true);
    expect(calls.some((c) => c.includes(':embedContent'))).toBe(true);
  });

  it('Gemini out of quota on every key: rotates, then falls back to the keyword parser', async () => {
    process.env.GEMINI_API_KEYS = 'k1,k2,k3';
    const keys: string[] = [];
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      keys.push(init.headers['x-goog-api-key']);
      return new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 });
    }) as any;
    const out = await handleSearch({ text: DEMO }, ids);
    expect(keys.slice(0, 3)).toEqual(['k1', 'k2', 'k3']);
    expect(out.engine).toBe('keyword');
    expect(out.results.length).toBe(3);
    // all keys are now cooling down: the next search does not even call Gemini
    keys.length = 0;
    await handleSearch({ text: 'stool' }, ids);
    expect(keys).toEqual([]);
  });

  it('Gemini returns junk or times out: keyword parser', async () => {
    process.env.GEMINI_API_KEYS = 'k1';
    globalThis.fetch = vi.fn(async () => new Response('{"candidates":[{"content":{"parts":[{"text":"sure!"}]}}]}')) as any;
    expect((await handleSearch({ text: 'free dresser' }, ids)).engine).toBe('keyword');
    globalThis.fetch = vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError'); }) as any;
    const out = await handleSearch({ text: 'stool that ships' }, ids);
    expect(out.engine).toBe('keyword');
    expect(out.results.map((r) => r.id)).toEqual([6]);
  });

  it('embedding failure alone keeps the Gemini parse and ranks by keywords', async () => {
    process.env.GEMINI_API_KEYS = 'k1';
    globalThis.fetch = vi.fn(async (url: any) =>
      String(url).includes(':embedContent') ? new Response('boom', { status: 500 }) : geminiReply({ categories: ['desk_lamp'], style_text: 'brass' })) as any;
    const out = await handleSearch({ text: 'brass desk lamp' }, ids);
    expect(out.engine).toBe('gemini');
    expect(out.results[0].id).toBe(1);
  });

  it('backfill restores what the model dropped but the shopper said', () => {
    const llm = parseSearchArgs({ categories: [], has_car: true });
    expect(backfill(llm, 'side table under 30 bucks near Pepper Canyon, no car')).toMatchObject({
      categories: ['side_table'], max_total_usd: 30, origin_text: 'Pepper Canyon', has_car: false, car_make_model: null,
    });
  });

  it('widen chips apply an explicit override without calling the LLM', async () => {
    process.env.GEMINI_API_KEYS = 'k1';
    globalThis.fetch = vi.fn(async () => { throw new Error('should not be called'); }) as any;
    const first = parseSearchArgs({ categories: ['dresser'], max_total_usd: 5 });
    const out = await handleSearch({ text: 'dresser under $5', prev: { filters: first }, override: { max_total_usd: 100, max_distance_mi: 25 } }, ids);
    expect(out.filters).toMatchObject({ categories: ['dresser'], max_total_usd: 100, max_distance_mi: 25 });
    expect(out.results.map((r) => r.id)).toEqual([8]);
  });

  it('empty results come with a message and chips', async () => {
    const out = await handleSearch({ text: 'dresser under $5 pickup only' }, ids);
    expect(out.results).toEqual([]);
    expect(out.empty_message).toBe('No matches under $5 within 20 miles.');
    expect(out.widen.length).toBeGreaterThan(1);
    expect(out.spoken_summary).toBe(out.empty_message);
  });

  it('with CAR_FIT off the car is ignored: no badge, no chip, no car sentence', async () => {
    const saved = process.env.CAR_FIT;
    process.env.CAR_FIT = '0';
    try {
      const out = await handleSearch({ text: DEMO }, ids);
      expect(out.filters.car_make_model).toBeNull();
      expect(out.car_unknown).toBe(false);
      expect(out.results.length).toBe(3);
      expect(out.results.every((r) => r.car_fit === null)).toBe(true);
      expect(out.spoken_summary).not.toMatch(/Civic/);
      expect(out.results.every((r) => r.mode === 'ship' || r.road_mi != null)).toBe(true); // where it is, pickup or delivery
    } finally { process.env.CAR_FIT = saved; }
  });

  it('unknown car is reported, not guessed', async () => {
    const out = await handleSearch({ text: 'stool', prev: { filters: parseSearchArgs({ car_make_model: 'DeLorean' }) } }, ids);
    expect(out.car_unknown).toBe(true);
    expect(out.results.every((r) => r.car_fit === null)).toBe(true);
  });
});

describe('database unreachable', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/none';
    process.env.DATABASE_URL_DEMO = 'postgresql://u:p@127.0.0.1:1/none';
    process.env.DB_TIMEOUT_MS = '1500';
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as any;
  });
  afterEach(() => { delete process.env.DB_TIMEOUT_MS; resetFixtureDb(); });

  it('DEMO_MODE serves the bundled snapshot', async () => {
    const out = await handleSearch({ text: DEMO }, ids);
    expect(out.data_source).toBe('snapshot');
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.every((r) => r.ar_href?.startsWith('https://'))).toBe(true);
    expect((await getItemCard(1))?.data_source).toBe('snapshot');
  });

  it('outside DEMO_MODE it is a typed, retryable 503', async () => {
    process.env.DEMO_MODE = '0';
    const e = await handleSearch({ text: DEMO }, ids).catch((x) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: 'db_unreachable', status: 503, retryable: true });
    expect(errorJson(e)).toEqual({ error: { code: 'db_unreachable', message: "Can't reach listings right now.", retryable: true } });
  });
});

describe('seller size estimate from a photo', () => {
  it('sends the photo to the fast model and returns validated inches', async () => {
    process.env.GEMINI_API_KEYS = 'k1';
    let body: any;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain(':generateContent');
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        category: 'side_table', title: 'Walnut side table', w_in: 18.2, d_in: 17.9, h_in: 22.26, confidence: 'medium', basis: 'outlet plate on the wall behind it' }) }] } }] }));
    }) as any;
    const { estimateItemSize } = await import('@/lib/gemini');
    const out = await estimateItemSize([{ mime: 'image/jpeg', b64: 'AAAA' }, { mime: 'image/jpeg', b64: 'BBBB' }]);
    expect(out).toMatchObject({ category: 'side_table', w_in: 18, d_in: 18, h_in: 22.5, confidence: 'medium' });
    expect(body.contents[0].parts.filter((p: any) => p.inlineData).length).toBe(2);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });
  it('rejects nonsense instead of filling the form with it', async () => {
    const { parseSizeEstimate } = await import('@/lib/gemini');
    expect(() => parseSizeEstimate('not json')).toThrow(/Couldn't read the size/);
    expect(() => parseSizeEstimate(JSON.stringify({ w_in: 0, d_in: 10, h_in: 10 }))).toThrow();
    expect(() => parseSizeEstimate(JSON.stringify({ w_in: 20, d_in: 20, h_in: 900 }))).toThrow();
    expect(parseSizeEstimate(JSON.stringify({ w_in: 20, d_in: 20, h_in: 30, confidence: 'certain', category: 'other' })))
      .toMatchObject({ confidence: 'low', category: null, basis: 'typical size for this kind of item' });
  });
});

describe('error shaping and per-IP limits', () => {
  it('unknown errors become a generic 500 with no internals', () => {
    const a = toAppError(new Error('secret stack: key=sk_123'));
    expect(a.status).toBe(500);
    expect(JSON.stringify(errorJson(a))).not.toContain('sk_123');
    expect(toAppError(new SyntaxError('Unexpected token')).status).toBe(400);
    expect(err.upstream('gemini', 'x', true).status).toBe(503);
    expect(err.upstream('gemini', 'x', false).status).toBe(502);
  });
  it('per-IP window: 429 after the cap, separate per IP and per route, resets after a minute', () => {
    const req = (ip: string) => new Request('http://x/', { headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } });
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) checkIpLimit(req('1.1.1.1'), 'unit', 3, t + i);
    expect(() => checkIpLimit(req('1.1.1.1'), 'unit', 3, t + 5)).toThrowError(/going a bit fast/);
    expect(() => checkIpLimit(req('2.2.2.2'), 'unit', 3, t + 5)).not.toThrow();
    expect(() => checkIpLimit(req('1.1.1.1'), 'other', 3, t + 5)).not.toThrow();
    expect(() => checkIpLimit(req('1.1.1.1'), 'unit', 3, t + 61_000)).not.toThrow();
  });
});
