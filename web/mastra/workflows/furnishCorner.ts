// Mastra workflow furnishCorner (spec 15 stretch): one sentence -> a few real second-hand items that together fit
// the budget -> one arranged AR file (a corner set) built by the Python worker (worker/stages/sets.py).
//
//   plan (Gemini filter extraction, keyword fallback + corner kit)
//   -> search each category in parallel with the same SQL as the result cards (retried)
//   -> pick one per category within the combined budget -> queue the set for the worker
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { cornerSummary, cornerTitle, pickWithinBudget, planCategories } from '@/lib/corner';
import { query } from '@/lib/db';
import { env } from '@/lib/env';
import { parseQueryWithGemini } from '@/lib/gemini';
import { CATEGORIES } from '@/lib/logic/categories';
import { keywordParse } from '@/lib/search/keywordParser';
import { backfill, executeSearch } from '@/lib/search/run';
import { parseSearchArgs, SearchArgsSchema, type SearchArgs } from '@/lib/search/schema';
import type { Card } from '@/lib/search/types';

const PARSE_TIMEOUT_MS = 6000;
const Coords = z.object({ lat: z.number(), lng: z.number() });
// Cards are big; the workflow passes them through untouched.
const CardZ = z.custom<Card>((v) => !!v && typeof v === 'object' && 'id' in (v as object));

export const CornerInput = z.object({
  request: z.string().min(3).max(400).describe('e.g. "study corner under $60, I have no car"'),
  coords: Coords.nullable().default(null).describe('browser location, rounded'),
  queue_set: z.boolean().default(true).describe('false = plan only, do not ask the worker to build the AR file'),
});
const Query = z.object({ category: z.enum(CATEGORIES), filters: SearchArgsSchema, coords: Coords.nullable() });
const Plan = z.object({
  request: z.string(), queue_set: z.boolean(), filters: SearchArgsSchema, extraction: z.enum(['gemini', 'keyword']),
  categories: z.array(z.enum(CATEGORIES)), budget: z.number().nullable(), queries: z.array(Query),
});
const Found = z.object({ category: z.string(), candidates: z.array(CardZ), origin_label: z.string() });
export const CornerOutput = z.object({
  set_id: z.number().nullable(),
  title: z.string(),
  items: z.array(CardZ),
  total_usd: z.number(),
  budget: z.number().nullable(),
  missing: z.array(z.string()),
  origin_label: z.string(),
  extraction: z.enum(['gemini', 'keyword']),
  spoken_summary: z.string(),
});
export type CornerResult = z.infer<typeof CornerOutput>;

const plan = createStep({
  id: 'plan',
  description: 'Extract filters from the sentence and decide which categories make the corner',
  inputSchema: CornerInput,
  outputSchema: Plan,
  execute: async ({ inputData }) => {
    let filters: SearchArgs | null = null;
    let extraction: 'gemini' | 'keyword' = 'keyword';
    if (env.GEMINI_API_KEYS.length && env.SEARCH_ENGINE !== 'keyword') {
      try {
        // cap the wait: a slow model must not eat the route's 30 s budget; keywords are good enough here
        const raw = await Promise.race([
          parseQueryWithGemini(inputData.request),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('gemini slow')), PARSE_TIMEOUT_MS)),
        ]);
        filters = backfill(parseSearchArgs(raw), inputData.request);
        extraction = 'gemini';
      } catch { /* keyword fallback below */ }
    }
    filters ??= keywordParse(inputData.request);
    if (!env.CAR_FIT) filters = { ...filters, car_make_model: null };
    const categories = planCategories(inputData.request, filters.categories);
    return {
      request: inputData.request, queue_set: inputData.queue_set ?? true, filters, extraction, categories,
      budget: filters.max_total_usd,
      queries: categories.map((category) => ({ category, filters: { ...filters!, categories: [category] }, coords: inputData.coords ?? null })),
    };
  },
});

const search = createStep({
  id: 'search-category',
  description: 'Listings with a finished AR model for one category: same SQL, totals and distances as the cards',
  inputSchema: Query,
  outputSchema: Found,
  retries: 2, // Neon cold start
  execute: async ({ inputData }) => {
    const { results, origin } = await executeSearch(inputData.filters, inputData.coords);
    return { category: inputData.category, candidates: results.filter((c) => c.has_model), origin_label: origin.label };
  },
});

const pick = createStep({
  id: 'pick-within-budget',
  description: 'One item per category, combined total within the budget, real models preferred; queue the AR set',
  inputSchema: z.array(Found),
  outputSchema: CornerOutput,
  execute: async ({ inputData, getStepResultAsync }) => {
    const p = (await getStepResultAsync(plan)) as z.infer<typeof Plan>;
    const { chosen, total, missing } = pickWithinBudget(inputData, p.budget);
    const title = cornerTitle(p.request);
    let set_id: number | null = null;
    if (p.queue_set && chosen.length >= 2) set_id = await queueSet(title, p.request, chosen.map((c) => c.id), total);
    return {
      set_id, title, items: chosen, total_usd: total, budget: p.budget, missing,
      origin_label: inputData[0]?.origin_label ?? 'UC San Diego', extraction: p.extraction,
      spoken_summary: cornerSummary(chosen, total, p.budget, missing, set_id !== null),
    };
  },
});

export const furnishCorner = createWorkflow({
  id: 'furnishCorner',
  description: 'Plan a corner from one sentence, find real second-hand items within budget, build one AR set',
  inputSchema: CornerInput,
  outputSchema: CornerOutput,
})
  .then(plan)
  .map(async ({ inputData }) => inputData.queries)
  .foreach(search, { concurrency: 3 })
  .then(pick)
  .commit();

/** One statement (Neon HTTP has no session transactions): the set and its items land together or not at all. */
export async function queueSet(title: string, prompt: string, ids: number[], total: number): Promise<number> {
  const [row] = await query<{ id: number }>(
    `with s as (insert into sets (title, prompt, status, total_usd) values ($1, $2, 'pending', $4) returning id),
          i as (insert into set_items (set_id, listing_id, pos)
                select s.id, x.lid, x.pos - 1 from s, unnest($3::bigint[]) with ordinality as x(lid, pos))
     select id::int as id from s`,
    [title, prompt.slice(0, 400), ids, total], { branch: 'main' },
  );
  return row.id;
}
