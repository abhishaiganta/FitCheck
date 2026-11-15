// Pure cost and distance helpers. Every number produced here is an estimate and the UI labels it so.
export const ROAD_FACTOR = 1.3; // straight-line -> road miles
export const AVG_MPH = 25;
export const DEFAULT_FUEL_USD_PER_MI = 0.15;
export const DEFAULT_MAX_DISTANCE_MI = 20;
export const WALK_MAX_MI = 1;
export const WALK_MAX_LB = 15;
/** Listings that only say "San Diego" sit at the city centroid. Keep them when the shopper's radius is at least this. */
export const CITY_ONLY_MIN_RADIUS_MI = 10;

/** False when the listing's location is just the city name (its lat/lng is the city centroid). */
export function isPreciseLocation(city: string | null | undefined, lat: number | null | undefined): boolean {
  if (lat == null) return false;
  const c = (city ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return !['sandiego', 'sandiegoca', 'sandiegocalifornia', ''].includes(c);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Round trip x fuel cost per mile. "est." */
export function pickupCost(distance_mi: number, fuelUsdPerMi = DEFAULT_FUEL_USD_PER_MI): number {
  if (!Number.isFinite(distance_mi) || distance_mi <= 0) return 0;
  return round2(distance_mi * 2 * fuelUsdPerMi);
}

export function haversineMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const roadMiles = (lat1: number, lng1: number, lat2: number, lng2: number) =>
  haversineMi(lat1, lng1, lat2, lng2) * ROAD_FACTOR;

export const driveMinutes = (road_mi: number) => Math.max(1, Math.round((road_mi / AVG_MPH) * 60));

/** max_drive_min wins, then max_distance_mi, then the 20 mile default. Result is in road miles. */
export function maxRoadMiles(f: { max_drive_min?: number | null; max_distance_mi?: number | null }): number {
  if (f.max_drive_min && f.max_drive_min > 0) return round2((f.max_drive_min / 60) * AVG_MPH);
  if (f.max_distance_mi && f.max_distance_mi > 0) return f.max_distance_mi;
  return DEFAULT_MAX_DISTANCE_MI;
}

export type CostInput = {
  price_usd: number | null;
  shipping_usd?: number | null;
  ships?: boolean;
  /** road miles to the item, null when the listing has no pickup location (eBay) */
  road_mi?: number | null;
  /** walking pickup costs nothing */
  walk?: boolean;
};
export type CostResult = { total: number; mode: 'ship' | 'pickup' | 'walk'; extra: number };

/** price + shipping, or price + estimated pickup cost. Picks the cheaper option when both exist. */
export function totalCost(l: CostInput, fuelUsdPerMi = DEFAULT_FUEL_USD_PER_MI): CostResult {
  const price = Math.max(0, Number(l.price_usd ?? 0));
  const options: CostResult[] = [];
  if (l.road_mi != null && Number.isFinite(l.road_mi)) {
    const extra = l.walk ? 0 : pickupCost(l.road_mi, fuelUsdPerMi);
    options.push({ total: round2(price + extra), mode: l.walk ? 'walk' : 'pickup', extra });
  }
  if (l.ships) {
    const extra = Math.max(0, Number(l.shipping_usd ?? 0));
    options.push({ total: round2(price + extra), mode: 'ship', extra });
  }
  if (!options.length) return { total: price, mode: 'pickup', extra: 0 };
  return options.reduce((a, b) => (b.total < a.total ? b : a));
}

export const formatDistance = (mi: number) => `~${(Math.round(mi * 10) / 10).toFixed(1)} mi`;

export function formatUsd(n: number): string {
  if (n <= 0) return 'FREE';
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** Whole-dollar display used on badges: "$9", never "$9.00". */
export const formatUsdShort = (n: number) => (n <= 0 ? 'FREE' : `$${Math.round(n)}`);

export function savingsVsNew(baseline_usd: number | null | undefined, total: number): number | null {
  if (baseline_usd == null || !Number.isFinite(Number(baseline_usd))) return null;
  return Math.max(0, Math.round(Number(baseline_usd) - total));
}

export function hoursAgo(iso: string | Date, now = new Date()): string {
  const h = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 3600_000);
  if (h < 1) return 'under an hour ago';
  if (h < 36) return `${Math.round(h)} hr${Math.round(h) === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}
