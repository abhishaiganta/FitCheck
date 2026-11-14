import type { SearchArgs } from '@/lib/search/schema';
import data from './queries.json';

export type EvalCase = { q: string; expect: Partial<SearchArgs> };
export const EVAL_CASES = data as EvalCase[];

const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b)
    ? JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
    : typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Field-level accuracy of filter extraction: every expected field must match. */
export function scoreExtraction(got: SearchArgs[], cases: EvalCase[] = EVAL_CASES) {
  let fields = 0, hit = 0, exact = 0;
  const misses: string[] = [];
  cases.forEach((c, i) => {
    let all = true;
    for (const [k, v] of Object.entries(c.expect)) {
      fields++;
      if (same((got[i] as any)?.[k], v)) hit++;
      else { all = false; misses.push(`"${c.q}": ${k} expected ${JSON.stringify(v)}, got ${JSON.stringify((got[i] as any)?.[k])}`); }
    }
    if (all) exact++;
  });
  return { field_accuracy: hit / fields, query_accuracy: exact / cases.length, misses };
}
