'use client';
import { useEffect, useRef, useState } from 'react';

// Typical seconds per step of the 3D pipeline, measured on our worker (BiRefNet cutout on CPU, Meshy ~2 min).
// [stage, label, expected seconds]
const STAGES: [string, string, number][] = [
  ['new', 'Photo received. Waiting for the 3D worker', 15],
  ['queued', 'Reading your photo and pricing it', 25],
  ['cutout', 'Cutting the item out of the background', 30],
  ['gen_pending', 'Building the 3D model', 120],
  ['gen_done', 'Scaling it to your measurements', 10],
  ['exporting', 'Making the AR file for iPhone and Android', 20],
];
const TOTAL = STAGES.reduce((n, s) => n + s[2], 0);

/**
 * Overall progress 0-100 and seconds left. Inside a step, time since the step started counts toward that step's
 * typical length (never past 95% of it); while the model is being built, the provider's own percent wins when it is
 * further along. Exported for tests.
 */
export function estimateProgress(stage: string, secondsInStage: number, providerPct: number | null): { pct: number; secondsLeft: number } {
  const i = Math.max(0, STAGES.findIndex((s) => s[0] === stage));
  const before = STAGES.slice(0, i).reduce((n, s) => n + s[2], 0);
  const expected = STAGES[i][2];
  let frac = Math.min(0.95, Math.max(0, secondsInStage) / expected);
  if (stage === 'gen_pending' && providerPct != null && providerPct > 0) frac = Math.max(frac, Math.min(0.99, providerPct / 100));
  const done = before + frac * expected;
  const after = STAGES.slice(i + 1).reduce((n, s) => n + s[2], 0);
  // running long: keep a small, honest remainder instead of counting below zero
  const left = Math.max(after + (1 - frac) * expected, after + 5);
  return { pct: Math.min(99, Math.round((done / TOTAL) * 100)), secondsLeft: Math.round(left) };
}

export function fmtLeft(s: number): string {
  if (s < 60) return `${Math.max(5, Math.round(s / 5) * 5)} s`;
  let m = Math.floor(s / 60), r = Math.round((s % 60) / 10) * 10;
  if (r === 60) { m += 1; r = 0; }
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** Filling progress bar for the /sell 3D build, with the current step and time left. Updates twice a second. */
export function BuildProgress({ stage, providerPct, waiting }: { stage: string; providerPct: number | null; waiting: boolean }) {
  const since = useRef<{ stage: string; at: number }>({ stage, at: Date.now() });
  const [, tick] = useState(0);
  if (since.current.stage !== stage) since.current = { stage, at: Date.now() };
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const { pct, secondsLeft } = estimateProgress(stage, (Date.now() - since.current.at) / 1000, providerPct);
  const label = STAGES.find((s) => s[0] === stage)?.[1] ?? 'Working on it';
  return (
    <div data-testid="build-progress">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-muted">{waiting ? 'Waiting for a free 3D builder' : label}…</p>
        <p className="shrink-0 font-display text-2xl font-extrabold tabular-nums">{pct}%</p>
      </div>
      <div className="mt-2 h-4 w-full overflow-hidden rounded-full border-[1.5px] border-ink bg-paper"
        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="3D model progress">
        <div className="h-full rounded-full bg-tape transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-sm text-muted">
        {waiting ? 'All 3D builders are busy right now. Yours starts as soon as one frees up.' : `About ${fmtLeft(secondsLeft)} left`}
      </p>
    </div>
  );
}
