// Filter-extraction eval over 25 realistic spoken queries.
//   npm run evals              keyword parser (offline)
//   npm run evals -- gemini    direct Gemini function call (needs GEMINI_API_KEYS)
//   npm run evals -- agent     the Mastra agent (needs GEMINI_API_KEYS and DATABASE_URL)
import { keywordParse } from '../../lib/search/keywordParser';
import { parseSearchArgs, type SearchArgs } from '../../lib/search/schema';
import { EVAL_CASES, scoreExtraction } from './score';

async function main() {
  try { process.loadEnvFile?.('.env.local'); } catch { /* optional */ }
  const engine = process.argv[2] ?? 'keyword';
  const got: SearchArgs[] = [];
  for (const c of EVAL_CASES) {
    try {
      if (engine === 'gemini') {
        const { parseQueryWithGemini } = await import('../../lib/gemini');
        const { backfill } = await import('../../lib/search/run');
        got.push(backfill(parseSearchArgs(await parseQueryWithGemini(c.q)), c.q));
      } else if (engine === 'agent') {
        const { runShopperAgent } = await import('../run');
        got.push((await runShopperAgent({ text: c.q, coords: null, prev: null, thread: `eval-${Date.now()}-${got.length}`, resource: 'eval' })).filters);
      } else got.push(keywordParse(c.q));
    } catch (e) {
      console.error(`  failed: "${c.q}": ${(e as Error).message}`);
      got.push(parseSearchArgs({}));
    }
    if (engine !== 'keyword') await new Promise((r) => setTimeout(r, 3500)); // stay under free-tier per-minute caps
  }
  const s = scoreExtraction(got);
  s.misses.forEach((m) => console.log('  miss ' + m));
  console.log(`\n${engine}: field accuracy ${(s.field_accuracy * 100).toFixed(1)}%, whole-query accuracy ${(s.query_accuracy * 100).toFixed(1)}% over ${EVAL_CASES.length} queries`);
  process.exit(s.field_accuracy >= 0.9 ? 0 : 1);
}
main();
