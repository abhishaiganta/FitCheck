'use client';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { ListingCard } from '@/components/ListingCard';
import type { Card } from '@/lib/search/types';

type Result = {
  set_id: number | null; title: string; items: Card[]; total_usd: number; budget: number | null; missing: string[];
  origin_label: string; extraction: 'gemini' | 'keyword'; spoken_summary: string;
};
type SetRow = { id: number; status: 'pending' | 'exporting' | 'ready' | 'failed'; usdz_url: string | null; glb_url: string | null; error: string | null;
  w_in: number | null; d_in: number | null; h_in: number | null };

const EXAMPLES = ['study corner under $80', 'cozy reading corner under $60, no car', 'bedside setup under $40 near Clairemont'];

/** "Furnish a corner": one sentence -> a few real items within budget -> one arranged AR scene (Mastra workflow). */
export default function CornerPage() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [set, setSet] = useState<SetRow | null>(null);
  const [mvReady, setMvReady] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const arRef = useRef<HTMLAnchorElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const speak = useCallback(async (line: string) => {
    const a = audioRef.current;
    if (!a) return;
    try {
      const r = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: line }) });
      if (!r.ok) return;
      if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
      a.src = URL.createObjectURL(await r.blob());
      await a.play();
    } catch { /* silent */ }
  }, []);

  const poll = useCallback(async (id: number) => {
    try {
      const r = await fetch(`/api/corner/${id}`, { cache: 'no-store' });
      if (r.ok) {
        const s: SetRow = await r.json();
        setSet(s);
        if (s.status === 'ready') { import('@google/model-viewer').then(() => setMvReady(true)).catch(() => {}); return; }
        if (s.status === 'failed') return;
      }
    } catch { /* keep polling */ }
    timer.current = setTimeout(() => void poll(id), 3000);
  }, []);

  const go = async (q: string) => {
    const query = q.trim();
    if (query.length < 3) { setMsg('Describe the corner, like "study corner under $80".'); return; }
    if (timer.current) clearTimeout(timer.current);
    setBusy(true); setMsg(null); setRes(null); setSet(null); setMvReady(false);
    try {
      const r = await fetch('/api/corner', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: query }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? "Couldn't plan that corner.");
      setRes(j);
      void speak(j.spoken_summary);
      if (j.set_id) void poll(j.set_id);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const isIos = typeof navigator !== 'undefined' && /iP(hone|ad|od)/.test(navigator.userAgent);
  const dims = set?.w_in && set?.d_in && set?.h_in ? `${Math.round(set.w_in)}" W × ${Math.round(set.d_in)}" D × ${Math.round(set.h_in)}" H` : null;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-4xl font-extrabold">Furnish a corner</h1>
      <p className="mt-2 text-lg text-muted">Say the corner and the budget. We pick one real second-hand piece per spot that fit the budget together, and arrange them into one AR scene you can walk around.</p>

      <form className="panel mt-5 flex flex-wrap gap-3 p-4" onSubmit={(e) => { e.preventDefault(); void go(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="cozy reading corner under $60, no car" aria-label="Describe the corner"
          className="min-h-12 flex-1 rounded-[10px] border-[1.5px] border-ink px-3 text-lg" maxLength={400} />
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Planning…' : 'Plan my corner'}</button>
        <div className="flex w-full flex-wrap gap-2">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" className="rounded-full border border-line bg-white px-3 py-1 text-sm" onClick={() => { setText(x); void go(x); }}>{x}</button>
          ))}
        </div>
      </form>

      {msg && <p role="alert" className="mt-3 rounded-lg bg-warn-soft px-3 py-2 font-semibold text-warn">{msg}</p>}
      <audio ref={audioRef} hidden />

      {res && (
        <section className="mt-5" aria-live="polite">
          <p className="text-lg font-semibold">{res.spoken_summary}</p>
          <p className="mt-1 text-sm text-muted">From {res.origin_label}. Filters read by {res.extraction === 'gemini' ? 'Gemini' : 'the keyword parser'}.</p>

          {res.set_id && (
            <div className="panel mt-4 p-4">
              <p className="font-bold">{res.title} in AR</p>
              {(!set || set.status === 'pending' || set.status === 'exporting') && (
                <>
                  <p className="mt-1 text-muted">Arranging the pieces against a wall and building one AR file (about 20 seconds)…</p>
                  <div className="skeleton mt-3 h-3 w-full rounded-full" />
                </>
              )}
              {set?.status === 'failed' && <p className="mt-1 text-muted">The combined scene couldn&apos;t be built. Each piece below still opens in AR on its own.</p>}
              {set?.status === 'ready' && set.glb_url && (
                <>
                  <div className="mt-3 aspect-[4/3] w-full overflow-hidden rounded-xl bg-paper">
                    {mvReady ? createElement('model-viewer', {
                      src: set.glb_url, 'ios-src': set.usdz_url ?? undefined, alt: `3D scene: ${res.title}`, ar: true,
                      'ar-modes': 'scene-viewer webxr quick-look', 'ar-scale': 'fixed', 'camera-controls': true, 'auto-rotate': true,
                      'shadow-intensity': '0.8', 'touch-action': 'pan-y', style: { width: '100%', height: '100%' },
                    }) : <div className="skeleton h-full w-full" />}
                  </div>
                  {dims && <p className="mt-2 text-sm text-muted">The whole corner takes about {dims}.</p>}
                  {isIos && set.usdz_url && (
                    <>
                      {/* AR Quick Look needs an <a rel="ar"> wrapping an <img> */}
                      <a ref={arRef} rel="ar" href={set.usdz_url} className="hidden">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={res.items[0]?.photo ?? '/fixtures/placeholder.svg'} alt="" />
                      </a>
                      <button className="btn btn-primary mt-3" onClick={() => arRef.current?.click()}>See the corner in your room</button>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {res.items.map((c) => <ListingCard key={c.id} card={c} />)}
          </div>
        </section>
      )}
    </div>
  );
}
