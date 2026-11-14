import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '@/lib/db';
import { classifyElevenError, makeElevenHttpError } from '@/lib/elevenlabs';
import { classifyGeminiError, makeGeminiHttpError } from '@/lib/gemini';
import {
  BREAKER_OPEN_MS, DbStore, GEMINI_MINUTE_COOLDOWN_MS, MemoryStore, QuotaExceeded, acquire, availableKeys, breakerOpen,
  callWithKeys, configureLimits, keyHash, nextMidnightPacific, pickKey, providerId, reportFailure, startOfDayPacific,
} from '@/lib/limits';
import { looksGone } from '@/lib/verifyListing';

let now = new Date('2026-11-14T20:00:30Z'); // 12:00:30 PST
let slept: number[] = [];
const advance = (ms: number) => { now = new Date(now.getTime() + ms); };

beforeEach(() => {
  now = new Date('2026-11-14T20:00:30Z');
  slept = [];
  configureLimits({
    now: () => now, rand: () => 0, store: new MemoryStore(), resetBreakers: true,
    sleep: async (ms) => { slept.push(ms); advance(ms); },
  });
});

const retryable = () => ({ kind: 'retry' as const });

describe('time windows', () => {
  it('Pacific midnight, standard time and daylight time', () => {
    expect(startOfDayPacific(new Date('2026-11-14T20:00:30Z')).toISOString()).toBe('2026-11-14T08:00:00.000Z');
    expect(nextMidnightPacific(new Date('2026-11-14T20:00:30Z')).toISOString()).toBe('2026-11-15T08:00:00.000Z');
    expect(nextMidnightPacific(new Date('2026-07-01T06:59:00Z')).toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(nextMidnightPacific(new Date('2026-07-01T07:00:00Z')).toISOString()).toBe('2026-07-02T07:00:00.000Z');
  });
  it('key hashes hide the key', () => {
    expect(keyHash('secret-key')).toMatch(/^[0-9a-f]{8}$/);
    expect(providerId('gemini', 'secret-key')).not.toContain('secret');
  });
});

describe('acquire', () => {
  it('counts per minute and resets on the next minute window', async () => {
    await acquire('p', 2, 100);
    await acquire('p', 2, 100);
    await expect(acquire('p', 2, 100)).rejects.toMatchObject({ window: 'minute' });
    advance(60_000);
    await expect(acquire('p', 2, 100)).resolves.toBeUndefined();
  });
  it('daily cap cools the provider down until midnight Pacific', async () => {
    await acquire('d', 100, 1);
    advance(120_000);
    await expect(acquire('d', 100, 1)).rejects.toBeInstanceOf(QuotaExceeded);
    expect(await availableKeys('x', [])).toEqual([]);
    advance(3 * 3600_000);
    expect((await availableKeys('fam', ['k1'])).length).toBe(1);
  });
});

describe('key rotation and cooldowns', () => {
  it('pickKey skips keys that are cooling down and returns after the cooldown', async () => {
    await reportFailure(providerId('gemini', 'k1'), { kind: 'minute' });
    expect((await pickKey('gemini', ['k1', 'k2'], { perMinute: 5, perDay: 50 })).key).toBe('k2');
    advance(GEMINI_MINUTE_COOLDOWN_MS + 1000);
    expect((await pickKey('gemini', ['k1', 'k2'], { perMinute: 5, perDay: 50 })).key).toBe('k1');
  });
  it('a 429 rotates to the next key without sleeping', async () => {
    const used: string[] = [];
    const out = await callWithKeys('gemini', ['k1', 'k2', 'k3'], {
      perMinute: 10, perDay: 100, classify: classifyGeminiError,
      fn: async (k) => { used.push(k); if (k !== 'k3') throw makeGeminiHttpError(429, 'RESOURCE_EXHAUSTED'); return 'ok'; },
    });
    expect(out).toBe('ok');
    expect(used).toEqual(['k1', 'k2', 'k3']);
    expect(slept).toEqual([]);
    expect((await availableKeys('gemini', ['k1', 'k2', 'k3'])).map((k) => k.key)).toEqual(['k3']);
  });
  it('a daily-cap 429 stays cooled past the minute window', async () => {
    await callWithKeys('gemini', ['k1', 'k2'], {
      perMinute: 10, perDay: 100, classify: classifyGeminiError,
      fn: async (k) => { if (k === 'k1') throw makeGeminiHttpError(429, 'Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel'); return 'ok'; },
    });
    advance(10 * 60_000);
    expect((await availableKeys('gemini', ['k1', 'k2'])).map((k) => k.key)).toEqual(['k2']);
    advance(13 * 3600_000);
    expect((await availableKeys('gemini', ['k1', 'k2'])).map((k) => k.key)).toEqual(['k1', 'k2']);
  });
  it('throws QuotaExceeded when every key is out', async () => {
    await expect(callWithKeys('gemini', ['k1', 'k2'], {
      perMinute: 10, perDay: 100, classify: classifyGeminiError,
      fn: async () => { throw makeGeminiHttpError(429, ''); },
    })).rejects.toMatchObject({ window: 'all_keys' });
    await expect(callWithKeys('gemini', [], { perMinute: 1, perDay: 1, classify: retryable, fn: async () => 1 })).rejects.toBeInstanceOf(QuotaExceeded);
  });
  it('retries network errors with exponential backoff, then succeeds', async () => {
    let n = 0;
    const out = await callWithKeys('svc', ['k'], {
      perMinute: 10, perDay: 100, tries: 5, baseDelayMs: 1000, classify: retryable,
      fn: async () => { if (++n < 4) throw new Error('ECONNRESET'); return n; },
    });
    expect(out).toBe(4);
    expect(slept).toEqual([1000, 2000, 4000]);
  });
  it('fatal errors are not retried and do not burn other keys', async () => {
    let n = 0;
    await expect(callWithKeys('gemini', ['k1', 'k2'], {
      perMinute: 10, perDay: 100, classify: classifyGeminiError,
      fn: async () => { n++; throw makeGeminiHttpError(400, 'bad request'); },
    })).rejects.toThrow(/http 400/);
    expect(n).toBe(1);
  });
  it('circuit breaker opens after 5 consecutive failures for 10 minutes', async () => {
    const p = providerId('svc', 'k');
    for (let i = 0; i < 4; i++) await reportFailure(p, { kind: 'retry' });
    expect(breakerOpen(p)).toBe(false);
    await reportFailure(p, { kind: 'retry' });
    expect(breakerOpen(p)).toBe(true);
    expect(await availableKeys('svc', ['k'])).toEqual([]);
    advance(BREAKER_OPEN_MS + 1000);
    expect(breakerOpen(p)).toBe(false);
    expect((await availableKeys('svc', ['k'])).length).toBe(1);
  });
});

describe('provider error mapping', () => {
  it('Gemini', () => {
    expect(classifyGeminiError(makeGeminiHttpError(429, 'x'))).toMatchObject({ kind: 'minute' });
    expect(classifyGeminiError(makeGeminiHttpError(429, '"retryDelay": "90s"'))).toEqual({ kind: 'minute', retryAfterMs: 90_000 });
    expect(classifyGeminiError(makeGeminiHttpError(429, 'requests per day'))).toEqual({ kind: 'day' });
    expect(classifyGeminiError(makeGeminiHttpError(503, ''))).toEqual({ kind: 'retry' });
    expect(classifyGeminiError(makeGeminiHttpError(403, ''))).toMatchObject({ kind: 'cooldown' });
    expect(classifyGeminiError(makeGeminiHttpError(400, ''))).toEqual({ kind: 'fatal' });
    expect(classifyGeminiError(new TypeError('fetch failed'))).toEqual({ kind: 'retry' });
  });
  it('ElevenLabs', () => {
    expect(classifyElevenError(makeElevenHttpError(429, ''))).toMatchObject({ kind: 'minute' });
    expect(classifyElevenError(makeElevenHttpError(401, '{"detail":{"status":"quota_exceeded"}}'))).toMatchObject({ kind: 'cooldown' });
    expect(classifyElevenError(makeElevenHttpError(422, ''))).toEqual({ kind: 'fatal' });
    expect(classifyElevenError(makeElevenHttpError(500, ''))).toEqual({ kind: 'retry' });
  });
  it('sold-listing detection', () => {
    expect(looksGone(404, '')).toBe(true);
    expect(looksGone(200, '<h2>This posting has been deleted by its author.</h2>')).toBe(true);
    expect(looksGone(200, '<p>This listing was ended by the seller</p>')).toBe(true);
    expect(looksGone(200, '<h1>Walnut side table - $15</h1>')).toBe(false);
  });
});

describe('database-backed store (provider_usage / provider_state)', () => {
  it('upserts both windows atomically and reads cooldowns back', async () => {
    process.env.DATABASE_URL = 'pglite://fixtures';
    const store = new DbStore();
    configureLimits({ store });
    await acquire('gemini:test', 5, 50);
    await acquire('gemini:test', 5, 50);
    const rows = await query(`select window_kind, count from provider_usage where provider = 'gemini:test' order by 1`);
    expect(rows).toEqual([{ window_kind: 'day', count: 2 }, { window_kind: 'minute', count: 2 }]);
    await reportFailure('gemini:test', { kind: 'day' });
    const cd = await store.cooldowns(['gemini:test', 'other']);
    expect(cd.get('gemini:test')!.toISOString()).toBe('2026-11-15T08:00:00.000Z');
    expect(cd.has('other')).toBe(false);
    expect(await availableKeys('gemini', ['zzz'])).toHaveLength(1);
  });
});
