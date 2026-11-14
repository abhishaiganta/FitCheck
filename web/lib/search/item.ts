import { readBranch } from '../db';
import { env } from '../env';
import { AppError } from '../errors';
import { UCSD } from '../logic/geo';
import { costFor, toCard } from './evaluate';
import { EMPTY_ARGS } from './schema';
import { snapshotItem } from './snapshot';
import { fetchRawItems } from './sql';
import type { Card, RawItem } from './types';

/** One card for /item/[id] (the QR target). Distance is from UCSD; falls back to the snapshot in DEMO_MODE. */
export async function getItemCard(id: number): Promise<{ card: Card; data_source: 'live' | 'snapshot' } | null> {
  let raw: RawItem | null = null;
  let data_source: 'live' | 'snapshot' = 'live';
  try {
    raw = (await fetchRawItems([id], readBranch()))[0] ?? null;
  } catch (e) {
    if (!(e instanceof AppError && e.code === 'db_unreachable' && env.DEMO_MODE)) throw e;
    raw = snapshotItem(id);
    data_source = 'snapshot';
  }
  if (!raw) return null;
  const origin = { ...UCSD, lat: env.ORIGIN_LAT, lng: env.ORIGIN_LNG };
  const f = { ...EMPTY_ARGS, max_distance_mi: 500 };
  const c = costFor(raw, f, origin, env.FUEL_USD_PER_MI) ?? { road_mi: null, total: raw.price, mode: 'pickup' as const, extra: 0 };
  return { card: toCard(raw, { ...c, car_fit: null, car_name: null, score: 0 }), data_source };
}
