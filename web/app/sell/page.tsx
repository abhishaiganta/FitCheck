'use client';
import { useState } from 'react';
import { CATEGORIES, CATEGORY_LABEL, type Category } from '@/lib/logic/categories';

type Price = { comparables: number; suggested_usd: number | null; low_usd: number | null; high_usd: number | null; new_median_usd: number | null };

/**
 * Seller flow (stretch). The fair-price suggestion is live (median of comparable listings in Neon).
 * Turning the photo into a 3D listing needs the worker's seller endpoint, which is not built yet.
 */
export default function SellPage() {
  const [photo, setPhoto] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>('side_table');
  const [condition, setCondition] = useState<'like_new' | 'good' | 'fair'>('good');
  const [height, setHeight] = useState('');
  const [price, setPrice] = useState<Price | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const suggest = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/seller/price', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category, condition }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? 'Could not get a price.');
      setPrice(j);
    } catch (e) { setPrice(null); setMsg((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-4xl font-extrabold">Sell it instead of dumping it</h1>
      <p className="mt-2 text-lg text-muted">Take one clean photo, tell us how tall it is, and get a fair price based on what similar pieces are listed for nearby.</p>

      <form className="panel mt-5 space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void suggest(); }}>
        <label className="block font-semibold">Photo of the item
          <input type="file" accept="image/*" capture="environment" className="mt-1 block w-full text-sm"
            onChange={(e) => { const f = e.target.files?.[0]; setPhoto(f ? URL.createObjectURL(f) : null); }} />
        </label>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {photo && <img src={photo} alt="Your item" className="max-h-64 rounded-xl border border-line object-contain" />}
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block font-semibold">What is it?
            <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className="mt-1 block min-h-11 w-full rounded-[10px] border-[1.5px] border-ink bg-white px-2">
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c][0]}</option>)}
            </select>
          </label>
          <label className="block font-semibold">Condition
            <select value={condition} onChange={(e) => setCondition(e.target.value as typeof condition)} className="mt-1 block min-h-11 w-full rounded-[10px] border-[1.5px] border-ink bg-white px-2">
              <option value="like_new">Like new</option><option value="good">Good</option><option value="fair">Fair</option>
            </select>
          </label>
          <label className="block font-semibold">Height (inches)
            <input inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="22"
              className="mt-1 block min-h-11 w-full rounded-[10px] border-[1.5px] border-ink px-3" />
          </label>
        </div>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Checking prices…' : 'Suggest a fair price'}</button>
      </form>

      {msg && <p role="alert" className="mt-3 rounded-lg bg-warn-soft px-3 py-2 font-semibold text-warn">{msg}</p>}

      {price && (
        <section className="panel mt-4 p-5" aria-live="polite">
          {price.suggested_usd == null ? (
            <p className="font-semibold">No comparable {CATEGORY_LABEL[category][1]} are listed yet, so there is no price to suggest. Try again after the next scrape.</p>
          ) : (
            <>
              <p className="text-muted">Fair price (estimate)</p>
              <p className="font-display text-6xl font-extrabold">${price.suggested_usd}</p>
              <p className="mt-1 text-muted">
                Similar {CATEGORY_LABEL[category][1]} nearby go for ${price.low_usd} to ${price.high_usd}, from {price.comparables} listing{price.comparables === 1 ? '' : 's'}.
                {price.new_median_usd ? ` New ones cost about $${Math.round(price.new_median_usd)}.` : ''}
              </p>
            </>
          )}
          <p className="mt-4 rounded-lg bg-paper px-3 py-2 text-sm text-muted">
            Next step, not live yet: turning your photo into a true-scale 3D listing with its own QR code. That runs on the same
            pipeline as the buyer side and is switched on once the worker&apos;s seller job is added.
          </p>
        </section>
      )}
    </div>
  );
}
