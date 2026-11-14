'use client';
import { useEffect } from 'react';

/** Eruda on-page console, loaded only with ?debug=1 (devs are on Windows, the phone has no devtools). */
export function DebugConsole() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = '1'; // lets E2E tests wait for interactivity
    if (!new URLSearchParams(window.location.search).has('debug')) return;
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/eruda@3';
    s.onload = () => (window as any).eruda?.init();
    document.body.appendChild(s);
  }, []);
  return null;
}
