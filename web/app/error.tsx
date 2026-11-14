'use client';
import { useEffect } from 'react';

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[route error]', error); }, [error]);
  return (
    <div className="panel mx-auto mt-10 max-w-md p-6 text-center" role="alert">
      <h1 className="text-2xl font-bold">This page hit a snag</h1>
      <p className="mt-2 text-muted">Nothing was lost. Reload to try again.</p>
      <div className="mt-5 flex justify-center gap-2">
        <button className="btn btn-primary" onClick={() => reset()}>Reload</button>
        <a className="btn btn-quiet" href="/">Back to search</a>
      </div>
    </div>
  );
}
