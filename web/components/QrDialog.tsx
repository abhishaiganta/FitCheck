'use client';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';

/** QR code for /item/[id], so a judge can open the same item on their own phone. */
export function QrDialog({ id, title, onClose }: { id: number; title: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  // the address this page is open on (fitcheck-sd.vercel.app), so the QR never points at an old domain
  const base = (typeof window !== 'undefined' ? window.location.origin : process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/$/, '');
  const url = `${base}/item/${id}`;

  useEffect(() => {
    ref.current?.showModal();
    QRCode.toDataURL(url, { margin: 1, width: 560, color: { dark: '#15233b', light: '#ffffff' } }).then(setSrc).catch(() => setSrc(''));
  }, [url]);

  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}
      aria-label={`QR code for ${title}`}
      className="m-auto w-[min(92vw,380px)] rounded-2xl border-[1.5px] border-ink bg-white p-5 text-center backdrop:bg-ink/60">
      <h2 className="text-lg font-bold">Open this on your phone</h2>
      <p className="mt-1 truncate text-sm text-muted">{title}</p>
      <div className="mx-auto mt-4 aspect-square w-full max-w-[280px]">
        {src === null ? <div className="skeleton h-full w-full" /> : src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={`QR code linking to ${url}`} data-testid="qr" className="h-full w-full" />
        ) : <p className="pt-10 text-muted">Could not draw the QR code. Use the link below.</p>}
      </div>
      <a className="mt-3 block break-all text-sm font-semibold text-blanket underline" href={url}>{url}</a>
      <button className="btn btn-quiet mt-4 w-full" onClick={() => ref.current?.close()}>Close</button>
    </dialog>
  );
}
