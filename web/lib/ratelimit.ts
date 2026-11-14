import { err } from './errors';

// Per-IP sliding window, kept in memory per server instance. Good enough for a judging
// crowd scanning QR codes; provider quotas are guarded separately by lib/limits.ts.
type G = typeof globalThis & { __lr_ip?: Map<string, number[]> };
const g = globalThis as G;

export function clientIp(req: Request): string {
  const h = req.headers;
  return (h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? 'local').trim();
}

export function checkIpLimit(req: Request, routeName: string, perMinute: number, now = Date.now()) {
  g.__lr_ip ??= new Map();
  const key = `${routeName}:${clientIp(req)}`;
  const hits = (g.__lr_ip.get(key) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= perMinute) {
    g.__lr_ip.set(key, hits);
    throw err.rateLimited("You're going a bit fast. Give it a few seconds and try again.");
  }
  hits.push(now);
  g.__lr_ip.set(key, hits);
  if (g.__lr_ip.size > 5000) {
    for (const [k, v] of g.__lr_ip) if (!v.some((t) => now - t < 60_000)) g.__lr_ip.delete(k);
  }
}
