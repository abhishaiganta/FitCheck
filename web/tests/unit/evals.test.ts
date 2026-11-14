import { expect, it } from 'vitest';
import { EVAL_CASES, scoreExtraction } from '@/mastra/evals/score';
import { keywordParse } from '@/lib/search/keywordParser';

it('keyword parser scores at least 90% on the 25-query eval set', () => {
  expect(EVAL_CASES.length).toBe(25);
  const s = scoreExtraction(EVAL_CASES.map((c) => keywordParse(c.q)));
  expect(s.misses, s.misses.join('\n')).toHaveLength(0);
  expect(s.field_accuracy).toBeGreaterThanOrEqual(0.9);
});
