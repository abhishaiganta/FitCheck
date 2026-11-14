// Shared rate-limit module (spec section 5), mirrored from worker/limits.py.
// Usage counters and cooldowns live in Neon (provider_usage / provider_state) so the
// worker and every web instance see the same numbers. If the database is unreachable the
// module degrades to in-memory counters instead of blocking the request.
import { createHash } from 'node:crypto';
import { query } from './db';

export class QuotaExceeded extends Error {
  provider: string;
  window: 'minute' | 'day' | 'cooldown' | 'breaker' | 'all_keys';
  constructor(provider: string, window: QuotaExceeded['window']) {
    super(`${provider} quota exceeded (${window})`);
    this.provider = provider;
    this.window = window;
  }
}

export type Failure =
  | { kind: 'minute'; retryAfterMs?: number } // per-minute 429
  | { kind: 'day' } // daily cap
  | { kind: 'cooldown'; ms: number } // provider told us how long
  | { kind: 'retry' } // network / 5xx: retry with backoff
  | { kind: 'fatal' }; // bad request etc: do not retry, do not rotate

export interface LimitStore {
  bump(provider: string, minuteStart: Date, dayStart: Date): Promise<{ minute: number; day: number }>;
  cooldowns(providers: string[]): Promise<Map<string, Date>>;
  setCooldown(provider: string, until: Date, note: string): Promise<void>;
}

export const keyHash = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 8);
export const providerId = (family: string, key?: string) => (key ? `${family}:${keyHash(key)}` : family);

export const GEMINI_MINUTE_COOLDOWN_MS = 65_000;
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
export const BREAKER_THRESHOLD = 5;
export const BREAKER_OPEN_MS = 10 * 60_000;

/** Next midnight in America/Los_Angeles (Gemini daily caps reset then). DST-safe. */
export function nextMidnightPacific(now: Date): Date {
  return new Date(startOfDayPacific(new Date(startOfDayPacific(now).getTime() + 26 * 3600_000)).getTime());
}

export function startOfDayPacific(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const sinceMidnight = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - sinceMidnight);
}

export const startOfMinute = (now: Date) => new Date(Math.floor(now.getTime() / 60_000) * 60_000);

// ---------- stores ----------

export class MemoryStore implements LimitStore {
  usage = new Map<string, number>();
  cd = new Map<string, Date>();
  async bump(provider: string, minuteStart: Date, dayStart: Date) {
    const mk = `${provider}|m|${minuteStart.toISOString()}`;
    const dk = `${provider}|d|${dayStart.toISOString()}`;
    this.usage.set(mk, (this.usage.get(mk) ?? 0) + 1);
    this.usage.set(dk, (this.usage.get(dk) ?? 0) + 1);
    if (this.usage.size > 2000) for (const k of [...this.usage.keys()].slice(0, 1000)) this.usage.delete(k);
    return { minute: this.usage.get(mk)!, day: this.usage.get(dk)! };
  }
  async cooldowns(providers: string[]) {
    const out = new Map<string, Date>();
    for (const p of providers) if (this.cd.has(p)) out.set(p, this.cd.get(p)!);
    return out;
  }
  async setCooldown(provider: string, until: Date) { this.cd.set(provider, until); }
}

export class DbStore implements LimitStore {
  async bump(provider: string, minuteStart: Date, dayStart: Date) {
    const rows = await query<{ window_kind: string; count: number }>(
      `insert into provider_usage (provider, window_start, window_kind, count)
       values ($1, $2::timestamptz, 'minute', 1), ($1, $3::timestamptz, 'day', 1)
       on conflict (provider, window_kind, window_start) do update set count = provider_usage.count + 1
       returning window_kind, count::int as count`,
      [provider, minuteStart.toISOString(), dayStart.toISOString()],
      { branch: 'main', timeoutMs: 2500 },
    );
    const by = Object.fromEntries(rows.map((r) => [r.window_kind, Number(r.count)]));
    return { minute: by.minute ?? 1, day: by.day ?? 1 };
  }
  async cooldowns(providers: string[]) {
    const rows = await query<{ provider: string; cooldown_until: Date | string }>(
      `select provider, cooldown_until from provider_state where provider = any($1::text[]) and cooldown_until is not null`,
      [providers],
      { branch: 'main', timeoutMs: 2500 },
    );
    return new Map(rows.map((r) => [r.provider, new Date(r.cooldown_until)]));
  }
  async setCooldown(provider: string, until: Date, note: string) {
    await query(
      `insert into provider_state (provider, cooldown_until, note) values ($1, $2::timestamptz, $3)
       on conflict (provider) do update set cooldown_until = excluded.cooldown_until, note = excluded.note`,
      [provider, until.toISOString(), note.slice(0, 200)],
      { branch: 'main', timeoutMs: 2500 },
    );
  }
}

/** Database first, memory when the database is down. Never throws from the store itself. */
class ResilientStore implements LimitStore {
  db = new DbStore();
  mem = new MemoryStore();
  async bump(p: string, m: Date, d: Date) {
    try { return await this.db.bump(p, m, d); } catch { return this.mem.bump(p, m, d); }
  }
  async cooldowns(ps: string[]) {
    const mem = await this.mem.cooldowns(ps);
    try { return new Map([...mem, ...(await this.db.cooldowns(ps))]); } catch { return mem; }
  }
  async setCooldown(p: string, until: Date, note: string) {
    await this.mem.setCooldown(p, until);
    try { await this.db.setCooldown(p, until, note); } catch { /* memory copy still protects this instance */ }
  }
}

// ---------- runtime (injectable for tests) ----------

type Runtime = {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  store: LimitStore;
  breaker: Map<string, { fails: number; openUntil: number }>;
};
type G = typeof globalThis & { __lr_limits?: Runtime };
const g = globalThis as G;

function rt(): Runtime {
  g.__lr_limits ??= {
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    rand: Math.random,
    store: new ResilientStore(),
    breaker: new Map(),
  };
  return g.__lr_limits;
}

export function configureLimits(patch: Partial<Omit<Runtime, 'breaker'>> & { resetBreakers?: boolean }) {
  const r = rt();
  Object.assign(r, { ...patch, resetBreakers: undefined });
  if (patch.resetBreakers) r.breaker.clear();
}

// ---------- core ----------

/** Count one call against the provider's minute and day windows. Throws QuotaExceeded at a cap. */
export async function acquire(provider: string, perMinute: number, perDay: number): Promise<void> {
  const r = rt();
  const now = r.now();
  const { minute, day } = await r.store.bump(provider, startOfMinute(now), startOfDayPacific(now));
  if (perDay > 0 && day > perDay) {
    await r.store.setCooldown(provider, nextMidnightPacific(now), 'local daily cap');
    throw new QuotaExceeded(provider, 'day');
  }
  if (perMinute > 0 && minute > perMinute) {
    await r.store.setCooldown(provider, new Date(startOfMinute(now).getTime() + 60_000), 'local per-minute cap');
    throw new QuotaExceeded(provider, 'minute');
  }
}

export function breakerOpen(provider: string): boolean {
  const b = rt().breaker.get(provider);
  return !!b && b.openUntil > rt().now().getTime();
}

export function reportSuccess(provider: string) {
  rt().breaker.delete(provider);
}

/** Record a failure: sets the right cooldown and trips the breaker after 5 in a row. */
export async function reportFailure(provider: string, f: Failure, note = ''): Promise<void> {
  const r = rt();
  const now = r.now();
  if (f.kind === 'fatal') return;
  if (f.kind === 'minute') {
    await r.store.setCooldown(provider, new Date(now.getTime() + (f.retryAfterMs ?? GEMINI_MINUTE_COOLDOWN_MS)), note || 'per-minute limit (429)');
  } else if (f.kind === 'day') {
    await r.store.setCooldown(provider, nextMidnightPacific(now), note || 'daily cap (429)');
  } else if (f.kind === 'cooldown') {
    await r.store.setCooldown(provider, new Date(now.getTime() + f.ms), note || 'provider cooldown');
  }
  const b = r.breaker.get(provider) ?? { fails: 0, openUntil: 0 };
  b.fails += 1;
  if (b.fails >= BREAKER_THRESHOLD) {
    b.openUntil = now.getTime() + BREAKER_OPEN_MS;
    b.fails = 0;
    await r.store.setCooldown(provider, new Date(b.openUntil), 'circuit breaker open (5 consecutive failures)');
  }
  r.breaker.set(provider, b);
}

/** Keys in rotation order, minus any that are cooling down or have an open breaker. */
export async function availableKeys(family: string, keys: string[]): Promise<{ key: string; provider: string }[]> {
  const r = rt();
  const all = keys.map((key) => ({ key, provider: providerId(family, key) }));
  const cds = await r.store.cooldowns(all.map((k) => k.provider));
  const now = r.now().getTime();
  return all.filter((k) => !breakerOpen(k.provider) && !((cds.get(k.provider)?.getTime() ?? 0) > now));
}

/** First usable key, already counted against its windows. */
export async function pickKey(family: string, keys: string[], caps: { perMinute: number; perDay: number }) {
  if (!keys.length) throw new QuotaExceeded(family, 'all_keys');
  for (const k of await availableKeys(family, keys)) {
    try {
      await acquire(k.provider, caps.perMinute, caps.perDay);
      return k;
    } catch (e) {
      if (!(e instanceof QuotaExceeded)) throw e;
    }
  }
  throw new QuotaExceeded(family, 'all_keys');
}

export type CallOpts<T> = {
  perMinute: number;
  perDay: number;
  /** attempts per key for retryable errors (spec default 5; web routes use fewer to stay fast) */
  tries?: number;
  baseDelayMs?: number;
  classify: (e: unknown) => Failure;
  fn: (key: string) => Promise<T>;
};

/**
 * Run `fn` with key rotation, cooldowns, backoff with jitter and the circuit breaker.
 * Throws QuotaExceeded('all_keys') when nothing is usable, or the last fatal error.
 */
export async function callWithKeys<T>(family: string, keys: string[], o: CallOpts<T>): Promise<T> {
  const r = rt();
  const tries = o.tries ?? 5;
  const base = o.baseDelayMs ?? 1000;
  if (!keys.length) throw new QuotaExceeded(family, 'all_keys');
  let lastErr: unknown;
  for (const k of await availableKeys(family, keys)) {
    try {
      await acquire(k.provider, o.perMinute, o.perDay);
    } catch (e) {
      if (e instanceof QuotaExceeded) continue;
      throw e;
    }
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const out = await o.fn(k.key);
        reportSuccess(k.provider);
        return out;
      } catch (e) {
        lastErr = e;
        const f = o.classify(e);
        if (f.kind === 'fatal') throw e;
        await reportFailure(k.provider, f, String((e as Error)?.message ?? '').slice(0, 120));
        if (f.kind !== 'retry' || breakerOpen(k.provider)) break; // quota: rotate to the next key
        if (attempt < tries - 1) await r.sleep(Math.min(base * 2 ** attempt, 8 * base) + r.rand() * base * 0.5);
      }
    }
  }
  if (lastErr && o.classify(lastErr).kind === 'retry') throw lastErr;
  throw new QuotaExceeded(family, 'all_keys');
}

/** For the pipeline board: current cooldowns and today's usage per provider. */
export async function providerHealth() {
  return query<{ provider: string; cooldown_until: string | null; note: string | null; today: number }>(
    `select coalesce(s.provider, u.provider) as provider, s.cooldown_until, s.note, coalesce(u.count, 0)::int as today
       from provider_state s
       full join (
         select provider, max(count) as count from provider_usage
          where window_kind = 'day' and window_start > now() - interval '26 hours' group by provider
       ) u on u.provider = s.provider
      order by 1`,
    [],
    { branch: 'main', timeoutMs: 4000 },
  );
}
