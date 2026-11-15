// Writes lib/data/demo_snapshot.json from the branch the app reads (demo branch in DEMO_MODE).
// Run right after the demo branch is refreshed:  npm run snapshot
// Usage with fixtures (dev only):  DATABASE_URL=pglite://fixtures npm run snapshot
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchCars, fetchRawItems } from '../lib/search/sql';
import { readBranch } from '../lib/db';

async function main() {
  try { process.loadEnvFile?.('.env.local'); } catch { /* optional */ }
  const branch = readBranch();
  const [items, cars] = await Promise.all([fetchRawItems('all-active', branch), fetchCars(branch)]);
  const fixture = (process.env.DATABASE_URL ?? '').startsWith('pglite:');
  const pinned = items.filter((i) => i.demo_pin);
  const chosen = (pinned.length >= 8 ? pinned : items).slice(0, 60);
  const out = { generated_at: new Date().toISOString(), fixture, items: chosen, cars };
  const file = path.join(process.cwd(), 'lib', 'data', 'demo_snapshot.json');
  await writeFile(file, JSON.stringify(out, null, 1));
  console.log(`snapshot: ${chosen.length} items (${pinned.length} pinned), ${cars.length} cars, branch=${branch}, fixture=${fixture} -> ${file}`);
}
main().then(() => process.exit(0), (e) => { console.error('snapshot FAILED:', e.message); process.exit(1); });
