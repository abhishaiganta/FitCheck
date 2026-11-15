'use client';
import Link from 'next/link';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { categoryFromText, isCategory, type Category } from '@/lib/logic/categories';

type Price = { source: 'comps' | 'estimate' | null; comparables: number; suggested_usd: number | null; low_usd: number | null; high_usd: number | null; new_median_usd: number | null; basis: string | null };
type Draft = {
  id: number; status: 'new' | 'processing' | 'ready' | 'failed'; category: string | null; title: string | null;
  height_in: number; ask_usd: number | null; fair_price_usd: number | null; fair_low_usd: number | null; fair_high_usd: number | null;
  comps_n: number | null; error: string | null; item: string | null; price_source: 'comps' | 'estimate' | null; price_basis: string | null; listing_id: number | null; published: boolean;
  asset_status: string | null; usdz_url: string | null; glb_url: string | null; is_approx_model: boolean;
  w_in: number | null; d_in: number | null; h_in: number | null;
};

const STORE = 'liveroom.sell.draft';
const STEP: Record<string, string> = {
  new: 'Photo received. Waiting for the 3D worker…',
  queued: 'Reading your photo and finding similar listings…',
  cutout: 'Cutting the item out of the background…',
  gen_pending: 'Building the 3D model (about a minute)…',
  gen_done: 'Scaling it to your measurements…',
  exporting: 'Making the AR file for iPhone and Android…',
};

/** Shrink to <= 1600 px JPEG in the browser so uploads stay small and fast on phone data. */
async function shrinkPhoto(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.85));
  } catch {
    return file;
  }
}

/**
 * Seller flow: one photo + the height -> a true-scale 3D listing (same worker pipeline as the buyer side),
 * a fair-price suggestion from comparable listings in Neon, and a link anyone can open in AR.
 */
export default function SellPage() {
  const [file, setFile] = useState<File | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [item, setItem] = useState('');
  const [estCategory, setEstCategory] = useState<Category | null>(null);
  const [condition, setCondition] = useState<'like_new' | 'good' | 'fair'>('good');
  const [width, setWidth] = useState('');
  const [depth, setDepth] = useState('');
  const [height, setHeight] = useState('');
  const [ask, setAsk] = useState('');
  const [price, setPrice] = useState<Price | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [auth, setAuth] = useState<{ id: number; token: string } | null>(null);
  const [mvReady, setMvReady] = useState(false);
  const [side, setSide] = useState<File | null>(null);
  const [est, setEst] = useState<{ item: string | null; w_in: number; d_in: number; h_in: number; confidence: 'low' | 'medium' | 'high'; basis: string; views: number } | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [measureMsg, setMeasureMsg] = useState<string | null>(null);
  const measureRun = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async (id: number) => {
    try {
      const r = await fetch(`/api/seller/draft/${id}`, { cache: 'no-store' });
      if (r.ok) {
        const d: Draft = await r.json();
        setDraft(d);
        if (d.status === 'ready' || d.status === 'failed') return;
      }
    } catch { /* keep polling */ }
    timer.current = setTimeout(() => void poll(id), 4000);
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null');
      if (saved?.id && saved?.token) { setAuth(saved); void poll(saved.id); }
    } catch { /* ignore */ }
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [poll]);

  useEffect(() => {
    if (draft?.status === 'ready' && draft.glb_url) import('@google/model-viewer').then(() => setMvReady(true)).catch(() => {});
  }, [draft?.status, draft?.glb_url]);

  /** Photo(s) -> estimated size, so the seller never has to know the dimensions. Fills height, type and title. */
  const measure = useCallback(async (front: File, sideView: File | null) => {
    const run = ++measureRun.current;
    setMeasuring(true); setMeasureMsg(null);
    try {
      const fd = new FormData();
      fd.set('photo', await shrinkPhoto(front), 'photo.jpg');
      if (sideView) fd.set('photo2', await shrinkPhoto(sideView), 'side.jpg');
      let res = await fetch('/api/seller/measure', { method: 'POST', body: fd });
      if (res.status >= 500 && run === measureRun.current) res = await fetch('/api/seller/measure', { method: 'POST', body: fd }); // one retry: a cold start can time out
      const j = await res.json().catch(() => null);
      if (run !== measureRun.current) return;
      if (!res.ok) throw new Error(j?.error?.message ?? 'measure failed');
      setEst(j);
      setWidth(String(j.w_in)); setDepth(String(j.d_in)); setHeight(String(j.h_in));
      setEstCategory(j.category && isCategory(j.category) ? j.category : null);
      if (j.item) setItem((t) => t || j.item);
      if (j.title) setTitle((t) => t || j.title);
    } catch {
      if (run !== measureRun.current) return;
      setEst(null);
      setMeasureMsg("Couldn't size it from the photo. Type the size below instead.");
    } finally { if (run === measureRun.current) setMeasuring(false); }
  }, []);

  // free text -> our closest furniture category (for local comps); anything else ("water bottle") prices on its own
  const category: Category | null = categoryFromText(item) ?? (est?.item && item.trim().toLowerCase() === est.item ? estCategory : null);
  const inches = (v: string) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 200 ? n : undefined; };
  const sizeFields = () => ({ w_in: inches(width), d_in: inches(depth), h_in: inches(height) });

  const suggest = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/seller/price', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: item.trim() || undefined, title: title.trim() || undefined, category: category ?? undefined, condition, ...sizeFields() }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? 'Could not get a price.');
      setPrice(j);
    } catch (e) { setPrice(null); setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const create = async () => {
    setMsg(null);
    if (!file) return setMsg('Add a photo of the item first.');
    if (!item.trim() && !title.trim()) return setMsg('Say what it is, for example "floor lamp" or "water bottle".');
    const h = Number(height);
    if (!Number.isFinite(h) || h <= 0 || h >= 120) return setMsg('Enter how tall it is, in inches.');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('photo', await shrinkPhoto(file), 'photo.jpg');
      fd.set('height_in', String(h));
      fd.set('title', title.trim() || item.trim());
      fd.set('item', item.trim());
      if (category) fd.set('category', category);
      fd.set('condition', condition);
      const { w_in, d_in } = sizeFields();
      if (w_in) fd.set('w_in', String(w_in));
      if (d_in) fd.set('d_in', String(d_in));
      if (ask) fd.set('ask_usd', ask);
      const res = await fetch('/api/seller/draft', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? 'Could not start your listing.');
      const a = { id: j.id as number, token: j.token as string };
      setAuth(a);
      localStorage.setItem(STORE, JSON.stringify(a));
      setDraft(null);
      void poll(a.id);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const publish = async () => {
    if (!auth || !draft) return;
    const v = Number(ask || draft.ask_usd || draft.fair_price_usd || 0);
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/seller/draft/${auth.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: auth.token, ask_usd: v }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? 'Could not publish.');
      setDraft({ ...draft, published: true, ask_usd: v });
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const startOver = () => {
    localStorage.removeItem(STORE);
    if (timer.current) clearTimeout(timer.current);
    setAuth(null); setDraft(null); setFile(null); setPhoto(null); setMvReady(false); setEst(null); setSide(null); setHeight(''); setWidth(''); setDepth(''); setMeasureMsg(null); setItem(''); setTitle(''); setEstCategory(null); setPrice(null);
  };

  const inputCls = 'mt-1 block min-h-11 w-full rounded-[10px] border-[1.5px] border-ink px-3';
  const dims = draft?.w_in && draft?.d_in && draft?.h_in ? `${Math.round(draft.w_in)}" W × ${Math.round(draft.d_in)}" D × ${Math.round(draft.h_in)}" H` : null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-4xl font-extrabold">Sell it instead of dumping it</h1>
      <p className="mt-2 text-lg text-muted">
        One clean photo. We size it for you, turn it into a true-size 3D model buyers can place in their room, and suggest a fair price from similar listings nearby.
      </p>

      {!auth && (
        <form className="panel mt-5 space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <div>
            <p className="font-semibold">Photo of the item</p>
            <label className="mt-1 flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border-[1.5px] border-dashed border-ink bg-paper p-3 text-center focus-within:outline focus-within:outline-3 focus-within:outline-blanket"
              data-testid="photo-picker">
              {photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo} alt="Your item" className="max-h-64 rounded-lg object-contain" />
              ) : (
                <svg viewBox="0 0 24 24" className="h-12 w-12 text-tape" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.4-2h6.6l1.4 2h1.8A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
                  <circle cx="12" cy="12.5" r="3.6" />
                </svg>
              )}
              <span className="font-semibold">{photo ? 'Change photo' : 'Take or upload a photo'}</span>
              <input type="file" accept="image/*" className="sr-only"
                onChange={(e) => { const f = e.target.files?.[0] ?? null; if (!f) return; setFile(f); setPhoto(URL.createObjectURL(f)); setEst(null); void measure(f, side); e.target.value = ''; }} />
            </label>
            <p className="mt-1 text-sm text-muted">For an accurate 3D model: the whole item in frame (legs included), shot from a slight corner angle at about its own height, nothing on top of it, plain wall or floor behind.</p>
          </div>
          {(measuring || est || measureMsg) && (
            <div className="rounded-xl border-[1.5px] border-line bg-paper p-3" aria-live="polite" data-testid="measure">
              {measuring && <p className="font-semibold">Sizing it from your photo…</p>}
              {!measuring && measureMsg && <p className="font-semibold text-warn">{measureMsg}</p>}
              {!measuring && est && (
                <>
                  <p className="font-semibold">
                    About {est.w_in}&quot; wide × {est.d_in}&quot; deep × {est.h_in}&quot; tall
                    <span className="badge badge-approx ml-2">estimated</span>
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    Based on: {est.basis}. {est.confidence === 'high' ? 'A known-size object was in the shot, so this should be close.'
                      : est.confidence === 'medium' ? 'Sized from things around it, so it may be an inch or two off.'
                      : 'No size cue in the photo, so this is a typical size for this kind of item.'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <label className="btn btn-quiet !min-h-9 text-sm">
                      {side ? 'Replace side photo' : 'Add a side photo'}
                      <input type="file" accept="image/*" capture="environment" className="sr-only"
                        onChange={(e) => { const f = e.target.files?.[0] ?? null; setSide(f); if (f && file) void measure(file, f); e.target.value = ''; }} />
                    </label>
                  </div>
                  {est.confidence !== 'high' && (
                    <p className="mt-2 text-sm text-muted">For a closer size, stand a sheet of printer paper against the item and retake the photo.</p>
                  )}
                </>
              )}
            </div>
          )}
          <label className="block font-semibold">Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Solid oak side table" maxLength={120} className={inputCls} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block font-semibold">What is it?
              <input value={item} onChange={(e) => { setItem(e.target.value); setPrice(null); }} placeholder="floor lamp, armchair, water bottle…"
                maxLength={60} autoComplete="off" className={inputCls} />
            </label>
            <label className="block font-semibold">Condition
              <select value={condition} onChange={(e) => setCondition(e.target.value as typeof condition)} className="mt-1 block min-h-11 w-full rounded-[10px] border-[1.5px] border-ink bg-white px-2">
                <option value="like_new">Like new</option><option value="good">Good</option><option value="fair">Fair</option>
              </select>
            </label>
            <fieldset className="sm:col-span-2">
              <legend className="font-semibold">Size in inches{est ? ' (filled in from your photo, fix it if it looks off)' : ''}</legend>
              <div className="mt-1 grid grid-cols-3 gap-3">
                <label className="block text-sm font-semibold">Width
                  <input inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} placeholder="18" className={inputCls} />
                </label>
                <label className="block text-sm font-semibold">Depth
                  <input inputMode="decimal" value={depth} onChange={(e) => setDepth(e.target.value)} placeholder="18" className={inputCls} />
                </label>
                <label className="block text-sm font-semibold">Height
                  <input inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="22" className={inputCls} />
                </label>
              </div>
            </fieldset>
            <label className="block font-semibold">Asking price ($, optional)
              <input inputMode="decimal" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="40" className={inputCls} />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Uploading…' : 'Make my 3D listing'}</button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void suggest()}>Just suggest a price</button>
          </div>
        </form>
      )}

      {msg && <p role="alert" className="mt-3 rounded-lg bg-warn-soft px-3 py-2 font-semibold text-warn">{msg}</p>}

      {!auth && price && (
        <section className="panel mt-4 p-5" aria-live="polite">
          {price.suggested_usd == null ? (
            <p className="font-semibold">We couldn&apos;t price that one right now. Say what it is above and try again.</p>
          ) : (
            <>
              <p className="text-muted">Price that should sell this week (estimate)</p>
              <p className="font-display text-6xl font-extrabold">${price.suggested_usd}</p>
              <p className="mt-1 text-muted">Quick sale ~${price.low_usd}, typical ${price.high_usd}. <PriceBasis source={price.source} basis={price.basis} n={price.comparables} /></p>
            </>
          )}
        </section>
      )}

      {auth && (
        <section className="panel mt-5 p-5" aria-live="polite">
          {(!draft || draft.status === 'new' || draft.status === 'processing') && (
            <>
              <p className="text-lg font-bold">Making your 3D listing</p>
              <p className="mt-1 text-muted">{STEP[draft?.status === 'processing' ? draft.asset_status ?? 'queued' : 'new'] ?? 'Working on it…'}</p>
              <div className="skeleton mt-4 h-3 w-full rounded-full" />
              {draft?.fair_price_usd != null && (
                <p className="mt-4">Price that should sell (estimate): <b>${Math.round(draft.fair_price_usd)}</b> <span className="text-muted">(quick sale ~${Math.round(draft.fair_low_usd ?? 0)}, typical ${Math.round(draft.fair_high_usd ?? 0)}. <PriceBasis source={draft.price_source} basis={draft.price_basis} n={draft.comps_n ?? 0} />)</span></p>
              )}
              <p className="mt-3 text-sm text-muted">Usually 1 to 3 minutes. You can leave this page open; it updates by itself.</p>
            </>
          )}

          {draft?.status === 'failed' && (
            <>
              <p className="text-lg font-bold">We couldn&apos;t make a 3D model from that photo</p>
              <p className="mt-1 text-muted">Try a photo with the whole item in frame, from a slight angle, on a plain background.</p>
              <button className="btn btn-primary mt-4" onClick={startOver}>Try another photo</button>
            </>
          )}

          {draft?.status === 'ready' && (
            <>
              <p className="text-lg font-bold">Your item in 3D{draft.is_approx_model ? ' (approximate shape)' : ''}</p>
              <div className="mt-3 aspect-square w-full overflow-hidden rounded-xl bg-paper">
                {mvReady && draft.glb_url ? createElement('model-viewer', {
                  src: draft.glb_url, 'ios-src': draft.usdz_url ?? undefined, alt: `3D model of ${draft.title ?? 'your item'}`,
                  ar: true, 'ar-modes': 'scene-viewer webxr quick-look', 'ar-scale': 'fixed', 'camera-controls': true,
                  'auto-rotate': true, 'shadow-intensity': '0.8', 'touch-action': 'pan-y', style: { width: '100%', height: '100%' },
                }) : <div className="skeleton h-full w-full" />}
              </div>
              {dims && <p className="mt-2 text-sm text-muted">True size: {dims}. On a phone, tap the AR button to place it in a room.</p>}
              {draft.fair_price_usd != null ? (
                <p className="mt-4">Price that should sell (estimate): <b className="text-2xl">${Math.round(draft.fair_price_usd)}</b>{' '}
                  <span className="text-muted">(quick sale ~${Math.round(draft.fair_low_usd ?? 0)}, typical ${Math.round(draft.fair_high_usd ?? 0)}. <PriceBasis source={draft.price_source} basis={draft.price_basis} n={draft.comps_n ?? 0} />)</span></p>
              ) : (
                <p className="mt-4 text-muted">We couldn&apos;t suggest a price for this one. Set your own below.</p>
              )}
              {draft.published ? (
                <p className="mt-4 rounded-lg bg-paper px-3 py-2 font-semibold">
                  Live at ${draft.ask_usd}. <Link className="underline" href={`/item/${draft.listing_id}`}>Open your listing</Link> to share its QR code.
                </p>
              ) : (
                <div className="mt-4 flex flex-wrap items-end gap-3">
                  <label className="block font-semibold">Your price ($)
                    <input inputMode="decimal" value={ask || String(draft.ask_usd ?? (draft.fair_price_usd != null ? Math.round(draft.fair_price_usd) : ''))}
                      onChange={(e) => setAsk(e.target.value)} className="mt-1 block min-h-11 w-32 rounded-[10px] border-[1.5px] border-ink px-3" />
                  </label>
                  <button className="btn btn-primary" disabled={busy} onClick={() => void publish()}>{busy ? 'Publishing…' : 'Publish listing'}</button>
                </div>
              )}
              <button className="btn btn-quiet mt-4" onClick={startOver}>Sell something else</button>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** Where the suggested price comes from, in plain words. */
function PriceBasis({ source, basis, n }: { source: 'comps' | 'estimate' | null; basis: string | null; n: number }) {
  if (source === 'estimate') return <>Estimated from typical used prices{basis ? `: ${basis.replace(/\.$/, '')}` : ''}.</>;
  return <>From {n} similar local listing{n === 1 ? '' : 's'} on Craigslist and Marketplace.</>;
}
