// Search orchestration: agent -> direct Gemini function call -> keyword parser. Never hard-fails on the LLM.
import { query } from '../db';
import { env } from '../env';
import { AppError, logError } from '../errors';
import { embedText, parseQueryWithGemini } from '../gemini';
import { findCarInText } from '../logic/carFit';
import { resolveOrigin, type Origin } from '../logic/geo';
import { keywordParse, type PrevContext } from './keywordParser';
import { parseSearchArgs, type SearchArgs, type SearchRequest } from './schema';
import { searchSnapshot } from './snapshot';
import { searchListingsSql } from './sql';
import { emptyMessage, profileFrom, spokenSummary, widenChips } from './summary';
import type { Card, SearchResponse } from './types';

export type Executed = { results: Card[]; origin: Origin; data_source: 'live' | 'snapshot' };

/** Filters -> cards. Embeds the style text, runs the one SQL query, falls back to the snapshot in DEMO_MODE. */
export async function executeSearch(
  f: SearchArgs, coords?: { lat: number; lng: number } | null,
): Promise<Executed> {
  const origin = resolveOrigin({ origin_text: f.origin_text, coords }, { lat: env.ORIGIN_LAT, lng: env.ORIGIN_LNG });
  const fuel = env.FUEL_USD_PER_MI;
  try {
    const embedding = f.style_text ? await embedText(f.style_text) : null;
    return { results: await searchListingsSql(f, origin, embedding, fuel), origin, data_source: 'live' };
  } catch (e) {
    if (e instanceof AppError && e.code === 'db_unreachable' && env.DEMO_MODE) {
      logError('api.search.snapshot', e);
      return { results: searchSnapshot(f, origin, fuel), origin, data_source: 'snapshot' };
    }
    throw e;
  }
}

/** Safety net over LLM output: things the shopper literally said that the model dropped. */
export function backfill(llm: SearchArgs, text: string, prev?: PrevContext): SearchArgs {
  const kw = keywordParse(text, prev);
  const out = { ...llm };
  if (!out.categories.length) out.categories = kw.categories;
  if (!kw.has_car) { out.has_car = false; out.car_make_model = null; }
  if (out.has_car && !out.car_make_model && findCarInText(text)) out.car_make_model = kw.car_make_model;
  if (out.max_total_usd == null && kw.max_total_usd != null) out.max_total_usd = kw.max_total_usd;
  if (!out.origin_text && kw.origin_text) out.origin_text = kw.origin_text;
  return parseSearchArgs(out);
}

export async function handleSearch(
  req: SearchRequest, ids: { thread: string; resource: string },
): Promise<SearchResponse> {
  const t0 = Date.now();
  const prev = (req.prev && typeof req.prev === 'object' ? req.prev : null) as PrevContext;
  let filters: SearchArgs | null = null;
  let executed: Executed | null = null;
  let engine: SearchResponse['engine'] = 'keyword';
  let assistant_text: string | null = null;

  if (req.override && typeof req.override === 'object') {
    // widen chips: explicit edit of the last filters, no LLM needed
    filters = parseSearchArgs({ ...(prev?.filters as object | undefined), ...(req.override as object) });
  }

  const hasKeys = env.GEMINI_API_KEYS.length > 0;
  if (!filters && hasKeys && env.SEARCH_ENGINE === 'agent') {
    try {
      const { runShopperAgent } = await import('@/mastra/run');
      const a = await runShopperAgent({ text: req.text, coords: req.coords ?? null, prev, ...ids });
      filters = backfill(a.filters, req.text, prev);
      // the agent already ran the query; reuse it unless the backfill changed the filters
      executed = JSON.stringify(filters) === JSON.stringify(a.filters) ? a.executed : null;
      assistant_text = a.text;
      engine = 'agent';
    } catch (e) {
      logError('api.search.agent', e);
      if (e instanceof AppError && e.code === 'db_unreachable' && !env.DEMO_MODE) throw e;
    }
  }
  if (!filters && hasKeys && env.SEARCH_ENGINE !== 'keyword') {
    try {
      filters = backfill(parseSearchArgs(await parseQueryWithGemini(req.text, prev?.filters)), req.text, prev);
      engine = 'gemini';
    } catch (e) {
      logError('api.search.gemini', e);
    }
  }
  if (!filters) filters = keywordParse(req.text, prev);
  if (!env.CAR_FIT && filters.car_make_model) {
    filters = { ...filters, car_make_model: null }; // car fit is switched off: show where it is and pickup vs. delivery only
    executed = null;
  }

  executed ??= await executeSearch(filters, req.coords ?? null);
  const { results, origin, data_source } = executed;
  const car_unknown = !!(filters.has_car && filters.car_make_model && results.length && !results.some((c) => c.car_name));
  const latency_ms = Date.now() - t0;

  if (data_source === 'live') {
    query(
      'insert into searches (query_text, filters, result_ids, latency_ms) values ($1, $2::jsonb, $3::bigint[], $4)',
      [req.text.slice(0, 400), JSON.stringify({ ...filters, engine }), results.map((r) => r.id), latency_ms],
      { branch: 'main', timeoutMs: 3000 },
    ).catch((e) => logError('api.search.log', e));
  }

  return {
    query: req.text, filters, results,
    spoken_summary: spokenSummary(results, filters),
    profile: profileFrom(filters, origin),
    origin, engine, car_unknown,
    empty_message: results.length ? null : emptyMessage(filters),
    widen: results.length ? [] : widenChips(filters),
    data_source, latency_ms, assistant_text,
  };
}
