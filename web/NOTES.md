# LiveRoom web app (Person B) notes

Everything here lives in `/web`. Nothing in `/worker`, `/db`, `/scripts` or `/data` was touched.

## Run it

```
cd web
npm install
npm run dev:fixtures     # no Neon needed: in-process Postgres (pglite + pgvector) with 12 fake listings
npm run dev              # real Neon, reads .env.local
npm test                 # 93 unit tests (vitest)
npx playwright install chromium && npm run test:e2e      # 12 E2E tests, iPhone 14 emulation
npm run test:e2e:broken-db                               # database-down snapshot fallback
npm run live-check       # live PASS/FAIL per integration (add `-- --agent` to also time the Mastra agent)
npm run evals            # 25-query filter-extraction eval (add `-- gemini` or `-- agent`)
npm run snapshot         # rebuild lib/data/demo_snapshot.json from the branch the app reads
```

## What is built

| Spec item | Where |
|---|---|
| `limits.ts` (acquire, key rotation, cooldowns, backoff, breaker) | `lib/limits.ts` |
| `/api/health`, `/api/stt`, `/api/tts`, `/api/search`, `/api/impact`, `/api/pipeline`, `/api/admin/*` | `app/api/*` |
| Single hybrid SQL (filters + pgvector + cost rank) | `lib/search/sql.ts` |
| Keyword fallback, zod schema | `lib/search/keywordParser.ts`, `lib/search/schema.ts` |
| `carFit`, `pickupCost`, `totalCost`, `formatDistance`, origin, AR href | `lib/logic/*` |
| Mastra agent `liveroomShopper`, 5 tools, Neon memory | `mastra/*` |
| Pages `/`, `/item/[id]`, `/pipeline`, `/impact`, `/admin`, `/sell` (stretch UI) | `app/*` |
| Section 14 fallbacks | covered in `tests/unit/fallbacks.test.ts` and `tests/e2e/*` |

## Decisions and differences from the spec

1. **Search engine chain.** Default is `SEARCH_ENGINE=direct`: one Gemini function call, then the keyword parser.
   Measured live on Nov 14: direct about 1.0 to 1.4 s, Mastra agent about 7.8 s (first call 29 s while memory tables were created).
   `SEARCH_ENGINE=agent` runs the Mastra agent first with a hard `AGENT_TIMEOUT_MS` cap, then falls through the same chain.
   Use it for the Mastra track demo, not for the timed buyer flow.
   **Car fit is off** unless `CAR_FIT=1` (the `cars` table is empty); cards show location and pickup vs. delivery instead.
   **Rate limits are tracked per Gemini model** (`gemini.<model>:<keyhash>`), because the worker's vision-model daily cooldown
   was blocking the fast model here.
2. **Spoken summary is a template**, not model text, so every number in it comes from the query result.
   The agent's sentence is returned as `assistant_text` and is not spoken.
3. **Two extra filter fields** beyond the spec list: `free_only` and `ships_only` ("what about one that ships").
4. **Multi-category queries are interleaved** (row_number per category) so "lamp and side table" shows both in the top results.
5. **Zero-vector embeddings** make pgvector return NaN; the SQL falls back to keyword overlap on title, tags and summary.
   Same fallback when the query embedding call fails.
6. **Car fit is computed in the SQL** (6 orientations) so too-big items rank lower inside the one query; a test checks it
   agrees with the `carFit` module. Unknown car: no badge and "Couldn't check your car".
7. **AR anchor**: the `<a rel="ar">` contains only the `<img>`. The "See it in your room" button clicks it from script.
   Off iOS the same click opens `<model-viewer>` (which has its own Android AR button).
8. **Per-IP limits are in memory per instance** (30/min on stt, tts, search). Provider quotas use Neon via `limits.ts`.
9. **Writes always go to `main`** (`searches`, `impact_events`, `error_log`, admin edits). Reads follow `DEMO_MODE`.
10. **Gemini model ids** default to the `gemini-flash-lite-latest` / `gemini-flash-latest` aliases and `gemini-embedding-001`
    at 768 dims. The worker must embed with the same model and dimension. The web embeds queries with
    `taskType=RETRIEVAL_QUERY`; the worker should use `RETRIEVAL_DOCUMENT`.
11. **ElevenLabs** defaults: STT `scribe_v1`, TTS `eleven_flash_v2_5`, voice `21m00Tcm4TlvDq8ikWAM`. Check the ids in the dashboard.
12. **Schema copy.** `tests/fixtures/schema.sql` is a copy of spec section 4 + `error_log` + `assets.orient_override` and
    `assets.views_used`, used only by the local fixture database. `/db/001_init.sql` must include those two columns and
    `error_log`, or `/admin` orientation and error logging will fail.
13. **`orient_override` values** written by `/admin`: `identity`, `+90x`, `-90x`, `+90z`, `-90z`, `180x`, or null for auto.
    Setting one moves a finished asset back to `gen_done` so the exporter picks it up again.
14. **Impact page copy** says about 12 million tons of furniture are thrown away each year and most is landfilled.
    EPA's figure is about 12.1 M tons generated and about 9.7 M landfilled (2018), so the pitch line
    "Americans landfill about 12 million tons" overstates it slightly.

## Not verified live

This was built in a sandbox with no access to Gemini, ElevenLabs, Neon, Bright Data or Vercel, so those calls are tested
against mocks only. `npm run live-check` is the first thing to run on a laptop. Not done at all:
Vercel deploy, on-device AR test, Bright Data `verifyStillListed` (needs `BD_UNLOCKER_ZONE`), Mastra Studio, corner-set button.
The demo snapshot in `lib/data/demo_snapshot.json` is built from fake fixtures; run `npm run snapshot` after the demo branch exists.
