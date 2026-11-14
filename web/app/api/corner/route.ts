import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, err, route } from '@/lib/errors';
import { checkIpLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Body = z.object({
  text: z.string().trim().min(3).max(400),
  coords: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
  build: z.boolean().optional(),
});

/**
 * "Furnish a corner": runs the Mastra workflow furnishCorner. Returns the picked items (same cards as search),
 * the combined total and a spoken summary; with 2+ items it queues one arranged AR file (poll /api/corner/:id).
 */
export const POST = route('api.corner', async (req: Request) => {
  checkIpLimit(req, 'corner', 10);
  const body = Body.parse(await req.json());
  const { mastra } = await import('@/mastra');
  const { furnishCorner } = await import('@/mastra/workflows/furnishCorner');
  // registered on the Mastra instance (Studio, traces); the cast only narrows the union type of the singleton
  const wf = (mastra.getWorkflow.bind(mastra) as (id: string) => typeof furnishCorner)('furnishCorner');
  const run = await wf.createRun();
  const res = await run.start({ inputData: { request: body.text, coords: body.coords ?? null, queue_set: body.build ?? true } });
  if (res.status !== 'success') {
    const cause = res.status === 'failed' ? res.error : undefined;
    if (cause instanceof AppError) throw cause;
    throw err.upstream('workflow', "Couldn't plan that corner. Try again in a moment.", true, { status: res.status });
  }
  return NextResponse.json(res.result, { headers: { 'cache-control': 'no-store' } });
});
