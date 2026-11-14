'use client';
import { createElement, useEffect, useRef, useState } from 'react';

/** 3D preview in a dialog (<model-viewer> from the GLB). Also the fallback wherever AR Quick Look is missing. */
export function ModelPreview({ glb, usdz, title, dims, onClose }: {
  glb: string | null; usdz: string | null; title: string; dims: string | null; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    let alive = true;
    import('@google/model-viewer').then(() => alive && setReady(true)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, []);

  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}
      aria-label={`3D preview of ${title}`}
      className="m-auto w-[min(94vw,640px)] rounded-2xl border-[1.5px] border-ink bg-white p-0 backdrop:bg-ink/60">
      <div className="flex items-center justify-between gap-3 px-4 pt-3">
        <h2 className="truncate text-lg font-bold">{title}</h2>
        <button className="btn btn-quiet !min-h-9 !px-3" onClick={() => ref.current?.close()}>Close</button>
      </div>
      <div className="p-4">
        <div className="aspect-square w-full">
          {!glb || failed ? (
            <div className="grid h-full place-items-center rounded-xl bg-paper p-6 text-center text-muted">
              The 3D preview for this item could not load. The photos and measurements on the card are still accurate.
            </div>
          ) : ready ? (
            createElement('model-viewer', {
              src: glb, 'ios-src': usdz ?? undefined, alt: `3D model of ${title}`, ar: true,
              'ar-modes': 'scene-viewer webxr quick-look', 'ar-scale': 'fixed', 'camera-controls': true,
              'auto-rotate': true, 'shadow-intensity': '0.8', 'touch-action': 'pan-y',
              onError: () => setFailed(true),
            })
          ) : (
            <div className="skeleton h-full w-full" />
          )}
        </div>
        <p className="mt-3 text-sm text-muted">
          Drag to spin. {dims ? `True size: ${dims}.` : ''} On a phone, the AR button places it in your room.
        </p>
      </div>
    </dialog>
  );
}
