// Live integration check for the web app. Run on a machine with normal internet:
//   npm run live-check
// Prints PASS / FAIL / SKIP per line. Uses a few cents of quota at most. Never prints keys.
import { createHash } from 'node:crypto';

try { process.loadEnvFile?.('.env.local'); } catch { /* optional */ }

let failed = 0;
const line = (s: 'PASS' | 'FAIL' | 'SKIP', name: string, note = '') => {
  if (s === 'FAIL') failed++;
  console.log(`${s}  ${name}${note ? `  (${note})` : ''}`);
};
const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => { const t = Date.now(); return [await fn(), Date.now() - t]; };
const short = (e: unknown) => String((e as any)?.detail?.body ?? (e as any)?.detail?.message ?? (e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 220);

async function main() {
  const { env } = await import('../lib/env');
  const { query } = await import('../lib/db');

  // --- Neon ---
  let dbOk = false;
  try {
    const [, ms] = await timed(() => query('select 1', [], { branch: 'main' }));
    line('PASS', 'Neon main reachable', `${ms} ms`);
    dbOk = true;
  } catch (e) { line('FAIL', 'Neon main reachable', short((e as any)?.cause ?? e)); }
  if (dbOk) {
    try {
      const t = await query<{ n: number; ready: number; cars: number }>(
        `select (select count(*) from listings)::int as n,
                (select count(*) from assets where status in ('ready','fallback_ready'))::int as ready,
                (select count(*) from cars)::int as cars`);
      line('PASS', 'Schema present', `${t[0].n} listings, ${t[0].ready} with models, ${t[0].cars} cars`);
      if (!t[0].ready) line('SKIP', 'Search will return nothing until some assets are ready (or load fixtures: npm run seed:fixtures)');
    } catch (e) { line('FAIL', 'Schema present', `run /db/001_init.sql on Neon main first: ${short((e as any)?.cause ?? e)}`); dbOk = false; }
  }
  if (env.DATABASE_URL_DEMO) {
    try { const [, ms] = await timed(() => query('select 1', [], { branch: 'demo' })); line('PASS', 'Neon demo branch reachable', `${ms} ms`); }
    catch (e) { line('FAIL', 'Neon demo branch reachable', short((e as any)?.cause ?? e)); }
  } else line('SKIP', 'Neon demo branch', 'DATABASE_URL_DEMO not set');

  if (dbOk) {
    try {
      const cd = await query<{ provider: string; cooldown_until: string; note: string | null }>(
        `select provider, cooldown_until, note from provider_state where cooldown_until > now() order by 1`);
      for (const c of cd) line('SKIP', `cooling down: ${c.provider}`, `until ${new Date(c.cooldown_until).toLocaleTimeString()}${c.note ? `, ${c.note.slice(0, 60)}` : ''}`);
    } catch { /* table shape differs: limits fall back to memory */ }
  }

  // --- Gemini, key by key ---
  const keys = env.GEMINI_API_KEYS;
  if (!keys.length) line('FAIL', 'Gemini keys', 'GEMINI_API_KEYS is empty');
  for (const k of keys) {
    const id = createHash('sha256').update(k).digest('hex').slice(0, 8);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL_FAST}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': k },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }], generationConfig: { maxOutputTokens: 5 } }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) line('PASS', `Gemini key ${id} (${env.GEMINI_MODEL_FAST})`);
      else line('FAIL', `Gemini key ${id} (${env.GEMINI_MODEL_FAST})`, `http ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 200)}`);
    } catch (e) { line('FAIL', `Gemini key ${id}`, short(e)); }
  }
  if (keys.length) {
    const { parseQueryWithGemini, embedText } = await import('../lib/gemini');
    const { parseSearchArgs } = await import('../lib/search/schema');
    try {
      const [raw, ms] = await timed(() => parseQueryWithGemini('desk lamp and side table under $40, warm wood, I drive a Civic'));
      const a = parseSearchArgs(raw);
      const ok = a.categories.includes('desk_lamp') && a.categories.includes('side_table') && a.max_total_usd === 40;
      line(ok ? 'PASS' : 'FAIL', 'Gemini function call parses the demo query', `${ms} ms, ${JSON.stringify(a.categories)}, $${a.max_total_usd}, ${a.car_make_model}`);
    } catch (e) { line('FAIL', 'Gemini function call parses the demo query', short(e)); }
    const [v, ms] = await timed(() => embedText('warm wood mid-century'));
    line(v?.length === env.EMBED_DIM ? 'PASS' : 'FAIL', `Gemini embedding (${env.GEMINI_EMBED_MODEL}) returns ${env.EMBED_DIM} dims`, v ? `${ms} ms` : 'no vector; check the model id');
  }

  // --- ElevenLabs round trip: text -> speech -> text ---
  if (!env.ELEVENLABS_API_KEY) line('FAIL', 'ElevenLabs', 'ELEVENLABS_API_KEY is empty');
  else {
    const { textToSpeech, speechToText } = await import('../lib/elevenlabs');
    try {
      const [tts, ms] = await timed(() => textToSpeech('Found three desk lamps under thirty dollars.'));
      const audio = tts.audio ?? Buffer.from(await (await fetch(tts.url!)).arrayBuffer());
      line(audio.length > 2000 ? 'PASS' : 'FAIL', `ElevenLabs TTS (${env.ELEVENLABS_TTS_MODEL})`, `${ms} ms, ${audio.length} bytes`);
      const [text, ms2] = await timed(() => speechToText(new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'speech.mp3'));
      line(/lamp/i.test(text) ? 'PASS' : 'FAIL', `ElevenLabs STT (${env.ELEVENLABS_STT_MODEL}) round trip`, `${ms2} ms, heard "${text}"`);
    } catch (e) { line('FAIL', 'ElevenLabs TTS/STT', short(e)); }
  }

  // --- full search paths ---
  if (dbOk) {
    const { handleSearch } = await import('../lib/search/run');
    for (const engine of (process.argv.includes('--agent') ? ['keyword', 'direct', 'agent'] : ['keyword', 'direct']) as ('keyword' | 'direct' | 'agent')[]) {
      if (engine !== 'keyword' && !keys.length) continue;
      process.env.SEARCH_ENGINE = engine;
      for (const q of ['desk lamp and side table under $40, warm wood, I drive a Civic', 'bookshelf under $50 near Pepper Canyon, no car', 'accent chair, mid-century, within 15 minutes']) {
        try {
          const out = await handleSearch({ text: q }, { thread: `live-${Date.now()}`, resource: 'live-check' });
          const used = out.engine === (engine === 'direct' ? 'gemini' : engine);
          line(used ? 'PASS' : 'FAIL', `search [${engine}] "${q.slice(0, 34)}…"`,
            `${out.latency_ms} ms${out.latency_ms > 3000 ? ' SLOW (>3 s)' : ''}, ${out.results.length} results, answered by ${out.engine}`);
        } catch (e) { line('FAIL', `search [${engine}] "${q.slice(0, 34)}…"`, short(e)); }
      }
    }
  }

  line(env.BLOB_READ_WRITE_TOKEN ? 'PASS' : 'SKIP', 'Vercel Blob token', env.BLOB_READ_WRITE_TOKEN ? '' : 'not set: TTS cache is memory-only and /admin GLB upload is off');
  line(env.ADMIN_TOKEN ? 'PASS' : 'SKIP', 'ADMIN_TOKEN', env.ADMIN_TOKEN ? '' : 'not set: /admin is closed');
  line(env.BRIGHTDATA_API_TOKEN && env.BD_UNLOCKER_ZONE ? 'PASS' : 'SKIP', 'Bright Data live-listing check', env.BD_UNLOCKER_ZONE ? '' : 'BD_UNLOCKER_ZONE not set: verifyStillListed answers "unchecked"');
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll live checks passed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('live-check crashed:', e); process.exit(1); });
