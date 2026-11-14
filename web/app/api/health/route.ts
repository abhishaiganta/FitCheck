import { NextResponse } from 'next/server';
import { query, readBranch } from '@/lib/db';
import { env } from '@/lib/env';
import { errorJson } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** `select 1` on both branches. Pinged every 4 minutes during judging to keep Neon warm. */
export async function GET(req: Request) {
  const soft = new URL(req.url).searchParams.get('soft') === '1';
  const t0 = Date.now();
  const check = async (branch: 'main' | 'demo') => {
    const t = Date.now();
    try {
      await query('select 1 as ok', [], { branch, timeoutMs: 5000 });
      return { ok: true, ms: Date.now() - t };
    } catch (e) {
      return { ok: false, ms: Date.now() - t, ...errorJson(e) };
    }
  };
  const [main, demo] = await Promise.all([check('main'), env.DATABASE_URL_DEMO ? check('demo') : Promise.resolve(null)]);
  const reading = readBranch();
  const ok = (reading === 'demo' ? demo?.ok : main.ok) ?? false;
  return NextResponse.json(
    { ok, reading, demo_mode: env.DEMO_MODE, main, demo, ms: Date.now() - t0 },
    { status: ok || soft ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
