import geo from '../data/geo_sd.json';

export type Origin = { lat: number; lng: number; label: string; source: 'said' | 'browser' | 'default' };
type Place = { name: string; aliases: string[]; lat: number; lng: number };
const PLACES = (geo as { places: Place[] }).places;

export const UCSD: Origin = { lat: 32.8801, lng: -117.2376, label: 'UCSD', source: 'default' };

/** Looks a spoken place or ZIP up in geo_sd.json. Longest alias wins ("la jolla village" before "la jolla"). */
export function lookupPlace(text: string | null | undefined): Place | null {
  return lookupPlaceDetailed(text)?.place ?? null;
}

export function lookupPlaceDetailed(text: string | null | undefined): { place: Place; alias: string } | null {
  if (!text) return null;
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  let best: { p: Place; len: number; a: string } | null = null;
  for (const p of PLACES) {
    for (const a of [p.name.toLowerCase(), ...p.aliases]) {
      if (a.length < 2) continue;
      if (t.includes(` ${a} `) && (!best || a.length > best.len)) best = { p, len: a.length, a };
    }
  }
  return best ? { place: best.p, alias: best.a } : null;
}

/**
 * Where the user is, in priority order: (1) a place they said, (2) browser coordinates
 * (already rounded to 2 decimals by the client, never stored), (3) UCSD.
 */
export function resolveOrigin(
  input: { origin_text?: string | null; coords?: { lat: number; lng: number } | null },
  fallback: { lat: number; lng: number } = UCSD,
): Origin {
  const place = lookupPlace(input.origin_text);
  if (place) return { lat: place.lat, lng: place.lng, label: place.name, source: 'said' };
  const c = input.coords;
  if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng) && Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180) {
    return { lat: Math.round(c.lat * 100) / 100, lng: Math.round(c.lng * 100) / 100, label: 'your location', source: 'browser' };
  }
  return { lat: fallback.lat, lng: fallback.lng, label: 'UCSD', source: 'default' };
}

export const placeNames = () => PLACES.map((p) => p.name);
