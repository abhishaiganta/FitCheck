// Bundled copy of the demo items, used only when Neon is unreachable in DEMO_MODE (spec section 14).
// Regenerate from the demo branch with `npm run snapshot` once demo_pin items are ready.
import snap from '../data/demo_snapshot.json';
import type { Car } from '../logic/carFit';
import type { Origin } from '../logic/geo';
import { evaluate } from './evaluate';
import type { SearchArgs } from './schema';
import type { Card, RawItem } from './types';

type Snapshot = { generated_at: string; fixture: boolean; items: RawItem[]; cars: Car[] };
const S = snap as unknown as Snapshot;

export const snapshotInfo = () => ({ generated_at: S.generated_at, fixture: S.fixture, count: S.items.length });

export function searchSnapshot(f: SearchArgs, origin: Origin, fuel: number): Card[] {
  return evaluate(S.items, f, origin, S.cars, fuel);
}

export function snapshotItem(id: number): RawItem | null {
  return S.items.find((i) => i.id === id) ?? null;
}
