export {};
// Live check of the Mastra furnishCorner workflow against Neon (plan only, nothing queued).
//   npm run corner-check -- "study corner under $120"
try { process.loadEnvFile('.env.local'); } catch { /* use the shell env */ }
const { mastra } = await import('@/mastra');
const { furnishCorner } = await import('@/mastra/workflows/furnishCorner');
const wf = (mastra.getWorkflow.bind(mastra) as (id: string) => typeof furnishCorner)('furnishCorner');
const asked = process.argv.slice(2).join(' ').trim();
const queries = asked ? [asked] : ['cozy reading corner under $60', 'study corner under $120', 'bedside setup under $40, no car'];
let failed = 0;
for (const q of queries) {
  const t0 = Date.now();
  const res = await (await wf.createRun()).start({ inputData: { request: q, coords: null, queue_set: false } });
  if (res.status !== 'success') { failed++; console.log(`FAIL  ${q}: ${res.status}`, res.status === 'failed' ? res.error : ''); continue; }
  const r = res.result;
  console.log(`\nPASS  "${q}"  (${Date.now() - t0} ms, filters by ${r.extraction})\n      ${r.spoken_summary}`);
  for (const i of r.items) {
    console.log(`      #${i.id} ${i.category.padEnd(13)} $${i.total_usd.toFixed(2).padStart(7)} ${i.mode.padEnd(6)} ` +
      `${i.mode === 'ship' ? '' : i.loc_precise === false ? 'San Diego' : `~${i.road_mi} mi`} ${i.is_approx_model ? '(approx model)' : '(real model)'}`);
  }
}
process.exit(failed ? 1 : 0);
