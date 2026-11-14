'use client';
import { useEffect, useState } from 'react';
import type { PipelineData } from '@/lib/stats';

const LABEL: Record<string, string> = {
  queued: 'Queued', cutout: 'Cutting out', gen_pending: 'Generating 3D', gen_done: '3D done', exporting: 'Exporting USDZ',
  ready: 'Ready', fallback_ready: 'Ready (approx)', failed: 'Failed',
};
const TONE: Record<string, string> = { ready: 'bg-go-soft text-go', fallback_ready: 'bg-warn-soft text-warn', failed: 'bg-stop-soft text-stop' };
const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

/** Live board of the Neon job queue. Polls /api/pipeline every 3 s and keeps Neon warm every 4 min. */
export default function PipelinePage() {
  const [data, setData] = useState<PipelineData | null>(null);
  const [down, setDown] = useState(false);
  const [fresh, setFresh] = useState<Set<number>>(new Set());

  useEffect(() => {
    let alive = true;
    let seen = new Set<number>();
    const tick = async () => {
      try {
        const res = await fetch('/api/pipeline', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as PipelineData;
        if (!alive) return;
        const ids = new Set(j.events.map((e) => e.id as number));
        setFresh(seen.size ? new Set([...ids].filter((i) => !seen.has(i))) : new Set());
        seen = ids;
        setData(j);
        setDown(false);
      } catch {
        if (alive) setDown(true);
      }
    };
    void tick();
    const poll = setInterval(tick, 3000);
    const warm = setInterval(() => { fetch('/api/health', { cache: 'no-store' }).catch(() => {}); }, 4 * 60_000);
    return () => { alive = false; clearInterval(poll); clearInterval(warm); };
  }, []);

  const t = data?.totals as Record<string, any> | undefined;
  const real = Number(t?.real_models ?? 0);
  const approx = Number(t?.approx_models ?? 0);
  const share = real + approx ? Math.round((real / (real + approx)) * 100) : null;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-4xl font-extrabold">Pipeline</h1>
          <p className="mt-1 max-w-[65ch] text-muted">
            A Postgres job queue on Neon drives scraping, tagging and 3D generation. This board reads it live every 3 seconds.
          </p>
        </div>
        <p className="badge" data-testid="pipeline-updated" role="status">
          {down ? "Can't reach the database. Retrying…" : data ? `Updated ${new Date(data.at).toLocaleTimeString()}` : 'Loading…'}
        </p>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Listings scraped', t?.listings], ['Tagged by Gemini', t?.tagged], ['Eligible for 3D', t?.eligible],
          ['True-scale models', share == null ? '–' : `${share}%`],
        ].map(([k, v]) => (
          <div key={k as string} className="panel p-3">
            <dt className="text-sm text-muted">{k}</dt>
            <dd className="font-display text-3xl font-extrabold">{v ?? <span className="skeleton inline-block h-7 w-12" />}</dd>
          </div>
        ))}
      </dl>
      {share != null && <p className="mt-1 text-sm text-muted">{real} made from the listing photo, {approx} generic stand-ins labeled &ldquo;approx model&rdquo;.</p>}

      <h2 className="mt-7 text-2xl font-bold">Where every item is</h2>
      <ol className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8" data-testid="pipeline-columns">
        {(data?.columns ?? Array.from({ length: 8 }, () => null)).map((c, i) => (
          <li key={c?.status ?? i} className={`rounded-xl border-[1.5px] border-line p-3 ${c ? TONE[c.status] ?? 'bg-white' : 'bg-white'}`}>
            <p className="text-sm font-semibold">{c ? LABEL[c.status] : <span className="skeleton inline-block h-4 w-16" />}</p>
            <p className="font-display text-3xl font-extrabold" data-status={c?.status}>{c ? c.count : '·'}</p>
          </li>
        ))}
      </ol>

      <div className="mt-7 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section>
          <h2 className="text-2xl font-bold">Latest moves</h2>
          <ul className="mt-3 divide-y divide-line rounded-xl border-[1.5px] border-line bg-white" data-testid="pipeline-events">
            {data?.events.length === 0 && <li className="p-4 text-muted">No activity yet. Start the worker to see items move.</li>}
            {data?.events.map((e) => (
              <li key={e.id} className={`flex flex-wrap items-baseline gap-x-2 px-4 py-2.5 text-sm ${fresh.has(e.id) ? 'bg-tape/30' : ''}`}>
                <span className="font-semibold">{e.title ?? `Listing ${e.listing_id}`}</span>
                <span className="text-muted">{e.from_status ? `${LABEL[e.from_status] ?? e.from_status} to ` : ''}<b className="text-ink">{LABEL[e.to_status] ?? e.to_status}</b></span>
                {e.provider && <span className="badge">{e.provider}</span>}
                {e.note && <span className="text-muted">{e.note}</span>}
                <span className="ml-auto text-muted">{ago(e.at)}</span>
              </li>
            ))}
            {!data && Array.from({ length: 5 }, (_, i) => <li key={i} className="p-3"><div className="skeleton h-5 w-full" /></li>)}
          </ul>
        </section>

        <section>
          <h2 className="text-2xl font-bold">Provider health</h2>
          <ul className="mt-3 space-y-2">
            {data?.providers.length === 0 && <li className="panel p-3 text-sm text-muted">No provider calls recorded yet.</li>}
            {data?.providers.map((p) => (
              <li key={p.provider} className="panel flex items-center justify-between gap-2 p-3 text-sm">
                <span className="font-semibold">{p.provider}</span>
                <span className="text-muted">{p.today} today</span>
                {p.cooling
                  ? <span className="badge badge-warn" title={p.note ?? ''}>cooling until {new Date(p.cooldown_until!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                  : <span className="badge badge-go">ok</span>}
              </li>
            ))}
          </ul>
          {!!data?.errors.length && (
            <>
              <h3 className="mt-5 text-lg font-bold">Recent errors</h3>
              <ul className="mt-2 space-y-1 text-sm text-muted">
                {data.errors.map((e: any, i: number) => <li key={i}><b className="text-ink">{e.where_}</b> {e.message} ({ago(e.at)})</li>)}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
