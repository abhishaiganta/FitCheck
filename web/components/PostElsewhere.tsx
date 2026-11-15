'use client';
import { useState } from 'react';

type Props = {
  listingId: number; title: string; priceUsd: number; photoUrl: string | null;
  w: number | null; d: number | null; h: number | null; item: string | null;
};

// Each site's own "create a listing" page. None of the three lets an app post for a person (eBay only with a
// signed-in seller account and its Sell API), so we prepare the text and the seller pastes it.
const SITES = [
  { name: 'Facebook Marketplace', url: 'https://www.facebook.com/marketplace/create/item' },
  { name: 'Craigslist', url: 'https://post.craigslist.org/c/sdo' },
  { name: 'eBay', url: 'https://www.ebay.com/sl/sell' },
] as const;

export function listingText(p: Props, origin: string): string {
  const size = p.w && p.d && p.h ? `About ${Math.round(p.w)}" W x ${Math.round(p.d)}" D x ${Math.round(p.h)}" H.` : '';
  const what = p.item && p.item.toLowerCase() !== p.title.toLowerCase() ? `${p.item[0].toUpperCase()}${p.item.slice(1)}.` : '';
  const details = [what, size].filter(Boolean).join(' ');
  return [
    `${p.title} - $${Math.round(p.priceUsd)}`,
    ...(details ? [details] : []),
    `See it at true size in your own room before you come get it (3D / AR, works on iPhone and Android): ${origin}/item/${p.listingId}`,
    'Pickup only. If this post is up, it is still available.',
  ].join('\n\n');
}

/** "Post it" for a published /sell listing: copy ready-made text, save the photo, open each site's posting page. */
export function PostElsewhere(p: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const text = listingText(p, origin);

  const copy = async (what: 'title' | 'all') => {
    const v = what === 'title' ? p.title : text;
    try {
      await navigator.clipboard.writeText(v);
      setCopied(what);
      setTimeout(() => setCopied(null), 2500);
    } catch {
      setCopied('failed');
    }
  };

  return (
    <section className="mt-5 rounded-xl border-[1.5px] border-line p-4" data-testid="post-elsewhere">
      <h2 className="text-xl font-bold">Post it on Marketplace, Craigslist and eBay</h2>
      <p className="mt-1 text-sm text-muted">
        These sites don&apos;t let other apps post for you, so we wrote the listing for you. Copy it, open the site, paste, and add your photo.
        The text links back here, so buyers can see it in their room first.
      </p>
      <textarea readOnly value={text} rows={7} aria-label="Listing text to paste"
        className="mt-3 block w-full resize-none rounded-lg border border-line bg-paper p-3 text-sm" data-testid="post-text"
        onFocus={(e) => e.currentTarget.select()} />
      {copied === 'failed' && <p className="mt-2 text-sm font-semibold text-warn">Couldn&apos;t copy automatically. Tap the text above, select all, and copy.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" onClick={() => void copy('all')}>{copied === 'all' ? 'Copied' : 'Copy listing text'}</button>
        <button type="button" className="btn btn-quiet" onClick={() => void copy('title')}>{copied === 'title' ? 'Copied' : 'Copy title only'}</button>
        {p.photoUrl && <a className="btn btn-quiet" href={p.photoUrl} target="_blank" rel="noopener noreferrer" download>Save photo</a>}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {SITES.map((s) => (
          <a key={s.name} className="btn btn-tape" href={s.url} target="_blank" rel="noopener noreferrer" onClick={() => void copy('all')}>
            Open {s.name}
          </a>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">Opening a site also copies the text, so you can paste it straight into the description.</p>
    </section>
  );
}
