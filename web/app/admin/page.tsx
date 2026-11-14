'use client';
import { useCallback, useEffect, useState } from 'react';

type Row = {
  id: number; source: string; title: string; url: string; price: number | null; city: string | null; demo_pin: boolean;
  is_active: boolean; photo: string | null; category: string | null; photo_ok: boolean | null; eligible_3d: boolean | null;
  w: number | null; d: number | null; h: number | null; status: string | null; provider: string | null;
  glb_url: string | null; usdz_url: string | null; is_approx_model: boolean | null; orient_override: string | null;
  last_error: string | null; attempts: number | null;
};
const ORIENTS = [['', 'auto'], ['identity', 'as is'], ['+90x', '+90° X'], ['-90x', '-90° X'], ['+90z', '+90° Z'], ['-90z', '-90° Z'], ['180x', '180° X']];
const STATUSES = ['', 'pinned', 'ready', 'fallback_ready', 'gen_done', 'gen_pending', 'queued', 'failed', 'none'];

/** Curation desk: find listings, upload hand-made GLBs, pin demo items, fix sideways models. */
export default function AdminPage() {
  const [token, setToken] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => { try { setToken(sessionStorage.getItem('lr_admin') ?? ''); } catch { /* private mode */ } }, []);

  const call = useCallback(async (path: string, init: RequestInit = {}) => {
    const res = await fetch(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(j?.error?.message ?? `Request failed (${res.status})`);
    return j;
  }, [token]);

  const load = useCallback(async (keepMsg = false) => {
    if (!token) return;
    if (!keepMsg) setMsg(null);
    try {
      try { sessionStorage.setItem('lr_admin', token); } catch { /* ignore */ }
      const j = await call(`/api/admin/listings?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`);
      setRows(j.listings);
    } catch (e) { setRows(null); setMsg((e as Error).message); }
  }, [call, q, status, token]);

  const patch = async (id: number, body: object, done: string) => {
    setBusy(id);
    try {
      await call('/api/admin/listings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listing_id: id, ...body }) });
      setMsg(done);
      await load(true);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  };

  const upload = async (id: number, file: File | undefined) => {
    if (!file) return;
    setBusy(id);
    setMsg(`Uploading ${file.name}…`);
    try {
      const form = new FormData();
      form.append('listing_id', String(id));
      form.append('file', file);
      await call('/api/admin/upload-glb', { method: 'POST', body: form });
      setMsg(`Uploaded. Listing ${id} is queued for export; the worker turns it into USDZ.`);
      await load(true);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <div>
      <h1 className="text-4xl font-extrabold">Curation desk</h1>
      <p className="mt-1 max-w-[70ch] text-muted">Changes here write to the main branch. Refresh the demo branch afterwards so search picks them up.</p>

      <form className="panel mt-4 flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label className="text-sm font-semibold">Admin token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" data-testid="admin-token"
            className="mt-1 block min-h-11 rounded-[10px] border-[1.5px] border-ink px-3" />
        </label>
        <label className="text-sm font-semibold">Title, category or id
          <input value={q} onChange={(e) => setQ(e.target.value)} className="mt-1 block min-h-11 rounded-[10px] border-[1.5px] border-ink px-3" />
        </label>
        <label className="text-sm font-semibold">Show
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1 block min-h-11 rounded-[10px] border-[1.5px] border-ink bg-white px-2">
            {STATUSES.map((s) => <option key={s} value={s}>{s === '' ? 'everything' : s === 'none' ? 'no 3D asset' : s.replace('_', ' ')}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" disabled={!token} data-testid="admin-load">Load listings</button>
      </form>

      {msg && <p role="status" data-testid="admin-msg" className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm font-semibold text-warn">{msg}</p>}

      {rows && (
        <ul className="mt-4 space-y-3" data-testid="admin-rows">
          {rows.length === 0 && <li className="panel p-4 text-muted">No listings match. Clear the filters to see everything.</li>}
          {rows.map((r) => (
            <li key={r.id} className="panel flex flex-wrap items-center gap-3 p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.photo ?? '/fixtures/placeholder.svg'} alt="" className="h-20 w-20 rounded-lg object-cover" />
              <div className="min-w-48 flex-1">
                <p className="font-semibold">#{r.id} {r.title}</p>
                <p className="text-sm text-muted">
                  {r.source}, {r.category ?? 'untagged'}, {r.price == null ? 'no price' : r.price === 0 ? 'free' : `$${r.price}`}
                  {r.w ? `, ${r.w} × ${r.d} × ${r.h} in` : ''} · <a className="underline" href={r.url} target="_blank" rel="noopener noreferrer">listing</a>
                  {r.glb_url && <> · <a className="underline" href={r.glb_url}>GLB</a></>}
                  {r.usdz_url && <> · <a className="underline" href={r.usdz_url}>USDZ</a></>}
                </p>
                <p className="mt-1 flex flex-wrap gap-1.5">
                  <span className={`badge ${r.status === 'ready' ? 'badge-go' : r.status === 'failed' ? 'badge-stop' : ''}`}>{r.status?.replace('_', ' ') ?? 'no 3D asset'}</span>
                  {r.provider && <span className="badge">{r.provider}</span>}
                  {r.is_approx_model && <span className="badge badge-approx">approx model</span>}
                  {r.photo_ok === false && <span className="badge badge-warn">photo not clean</span>}
                  {r.last_error && <span className="badge badge-stop" title={r.last_error}>{r.last_error.slice(0, 40)}</span>}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button className={`btn ${r.demo_pin ? 'btn-tape' : 'btn-quiet'}`} disabled={busy === r.id} aria-pressed={r.demo_pin}
                  onClick={() => patch(r.id, { demo_pin: !r.demo_pin }, r.demo_pin ? `Unpinned #${r.id}.` : `Pinned #${r.id} for the demo.`)}>
                  {r.demo_pin ? 'Pinned for demo' : 'Pin for demo'}
                </button>
                <label className="text-sm font-semibold">Orientation
                  <select value={r.orient_override ?? ''} disabled={busy === r.id || !r.status}
                    onChange={(e) => patch(r.id, { orient_override: e.target.value }, `Orientation saved for #${r.id}. It will be re-exported.`)}
                    className="ml-1 min-h-11 rounded-[10px] border-[1.5px] border-line bg-white px-2">
                    {ORIENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
                <label className={`btn btn-quiet ${busy === r.id ? 'opacity-50' : ''}`}>
                  Upload GLB
                  <input type="file" accept=".glb,model/gltf-binary" className="sr-only" disabled={busy === r.id}
                    onChange={(e) => { void upload(r.id, e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
