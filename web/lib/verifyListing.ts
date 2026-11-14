// "Is it still listed?" One synchronous Bright Data Web Unlocker fetch, cached for 30 minutes.
import { query } from './db';
import { env } from './env';
import { acquire, reportFailure, reportSuccess } from './limits';

export type ListedStatus = { status: 'listed' | 'gone' | 'unchecked'; note: string };
type G = typeof globalThis & { __lr_verify?: Map<number, { at: number; v: ListedStatus }> };
const g = globalThis as G;
const TTL_MS = 30 * 60_000;

const GONE_PATTERNS = [
  /this posting has been (deleted|flagged|expired)/i, /this posting has expired/i,
  /this listing (has|was) ended/i, /this listing is no longer available/i, /no longer available/i,
  /item (is )?sold/i, /listing (was )?removed/i, /page (not found|doesn'?t exist)/i,
];

/** Exported for tests. */
export function looksGone(status: number, html: string): boolean {
  if (status === 404 || status === 410) return true;
  const head = html.slice(0, 60_000);
  return GONE_PATTERNS.some((re) => re.test(head));
}

export async function verifyStillListed(listingId: number, url: string, now = Date.now()): Promise<ListedStatus> {
  g.__lr_verify ??= new Map();
  const hit = g.__lr_verify.get(listingId);
  if (hit && now - hit.at < TTL_MS) return hit.v;
  if (!env.BRIGHTDATA_API_TOKEN || !env.BD_UNLOCKER_ZONE) {
    return { status: 'unchecked', note: 'live check is not configured (BRIGHTDATA_API_TOKEN / BD_UNLOCKER_ZONE)' };
  }
  if (!/^https?:\/\//.test(url)) return { status: 'unchecked', note: 'listing has no public URL' };
  let v: ListedStatus;
  try {
    await acquire('brightdata', 6, 300);
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.BRIGHTDATA_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ zone: env.BD_UNLOCKER_ZONE, url, format: 'raw' }),
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403) {
      await reportFailure('brightdata', res.status === 429 ? { kind: 'cooldown', ms: 15 * 60_000 } : { kind: 'retry' }, `http ${res.status}`);
      return { status: 'unchecked', note: 'could not check right now' };
    }
    reportSuccess('brightdata');
    const gone = looksGone(res.status, await res.text());
    v = gone ? { status: 'gone', note: 'the listing page says it is no longer available' } : { status: 'listed', note: 'still up as of just now' };
    if (gone) {
      await query('update listings set is_active = false where id = $1', [listingId], { branch: 'main', timeoutMs: 4000 }).catch(() => {});
    }
  } catch {
    return { status: 'unchecked', note: 'could not check right now' };
  }
  g.__lr_verify.set(listingId, { at: now, v });
  return v;
}
