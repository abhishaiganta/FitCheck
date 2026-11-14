// Loads the FAKE fixture rows into the database in DATABASE_URL so the UI has something to show
// before real scraped data exists. Refuses to touch a database that already has listings.
// Remove them again with:  npm run seed:fixtures -- --drop
import { readFile } from 'node:fs/promises';
import path from 'node:path';

try { process.loadEnvFile?.('.env.local'); } catch { /* optional */ }

async function main() {
  const { neon } = await import('@neondatabase/serverless');
  const url = process.env.DATABASE_URL ?? '';
  if (!/^postgres/.test(url)) throw new Error('DATABASE_URL must be a Neon Postgres URL');
  const sql = neon(url);
  if (process.argv.includes('--drop')) {
    const r = await sql.query(`delete from listings where raw @> '{"fixture":true}'::jsonb returning id`);
    await sql.query(`delete from cars where source_url like '%fixture-not-a-real-source%'`);
    console.log(`dropped ${r.length} fixture listings (cascades to details, assets, events)`);
    return;
  }
  const [{ n }] = (await sql.query('select count(*)::int as n from listings')) as { n: number }[];
  if (n > 0) throw new Error(`listings already has ${n} rows; not adding fake fixtures on top of real data`);
  const text = await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'fixtures.sql'), 'utf8');
  const statements = text.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  for (const s of statements) {
    await sql.query(s.replace("insert into new_price_baselines", "insert into new_price_baselines").replace(/;$/, '') +
      (/^insert into (new_price_baselines|cars)/.test(s) ? ' on conflict do nothing' : ''));
  }
  console.log(`loaded ${statements.length} fixture statements. These are FAKE listings: drop them before the demo branch is made.`);
}
main().then(() => process.exit(0), (e) => { console.error('seed FAILED:', e.message); process.exit(1); });
