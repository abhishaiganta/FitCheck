import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { route } from '@/lib/errors';
import { checkIpLimit } from '@/lib/ratelimit';
import { handleSearch } from '@/lib/search/run';
import { SearchRequestSchema } from '@/lib/search/schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export const POST = route('api.search', async (req: Request) => {
  checkIpLimit(req, 'search', 30);
  const body = SearchRequestSchema.parse(await req.json());
  // anonymous ids for agent memory: resource = cookie, thread = per-browser session
  const cookie = req.headers.get('cookie') ?? '';
  let uid = cookie.match(/(?:^|;\s*)lr_uid=([a-zA-Z0-9-]{8,64})/)?.[1];
  const fresh = !uid;
  uid ??= randomUUID();
  const thread = `s-${(body.session_id ?? uid).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || uid}`;
  const out = await handleSearch(body, { thread, resource: `u-${uid}` });
  const res = NextResponse.json(out, { headers: { 'cache-control': 'no-store' } });
  if (fresh) res.cookies.set('lr_uid', uid, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 30, path: '/' });
  return res;
});
