import { CATEGORY_LABEL, isCategory } from '../logic/categories';
import { shortCarName } from '../logic/carFit';
import { maxRoadMiles } from '../logic/cost';
import type { SearchArgs } from './schema';
import type { Card, Profile, WidenChip } from './types';
import type { Origin } from '../logic/geo';

const money = (n: number) => (n <= 0 ? 'free' : `$${Number.isInteger(n) ? n : n.toFixed(2)}`);
const miles = (n: number) => `${n.toFixed(1).replace(/\.0$/, '')} mile${n === 1 ? '' : 's'}`;

function countPhrase(cards: Card[]): string {
  const by = new Map<string, number>();
  for (const c of cards) by.set(c.category, (by.get(c.category) ?? 0) + 1);
  const parts = [...by.entries()].map(([cat, n]) => {
    const [one, many] = isCategory(cat) ? CATEGORY_LABEL[cat] : [cat.replace(/_/g, ' '), `${cat.replace(/_/g, ' ')}s`];
    return `${n} ${n === 1 ? one : many}`;
  });
  if (parts.length > 3) return `${cards.length} items`;
  if (parts.length <= 1) return parts[0] ?? '0 items';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Short reply for ElevenLabs: "Found 3 desk lamps under $30. The closest is free, 1.2 miles away." */
export function spokenSummary(cards: Card[], f: SearchArgs): string {
  if (!cards.length) return emptyMessage(f);
  const s: string[] = [];
  s.push(`Found ${countPhrase(cards)}${f.max_total_usd ? ` under $${f.max_total_usd}` : ''}.`);
  const pickups = cards.filter((c) => c.road_mi != null && c.mode !== 'ship' && c.loc_precise !== false).sort((a, b) => a.road_mi! - b.road_mi!);
  const closest = pickups[0];
  if (closest) {
    s.push(`The closest is ${money(closest.price_usd)}, about ${miles(closest.road_mi!)} away${closest.mode === 'walk' ? ', close enough to walk' : ''}.`);
  }
  const shipped = cards.filter((c) => c.mode === 'ship' && (c.savings_usd ?? 0) > 0).sort((a, b) => b.savings_usd! - a.savings_usd!)[0];
  if (shipped) s.push(`One ships for ${money(shipped.total_usd)} total and saves about $${shipped.savings_usd} versus new.`);
  else if (!closest) {
    const cheapest = [...cards].sort((a, b) => a.total_usd - b.total_usd)[0];
    s.push(`The cheapest is ${money(cheapest.total_usd)} with shipping.`);
  }
  const car = cards.find((c) => c.car_name)?.car_name;
  if (car) {
    const tooBig = cards.filter((c) => c.car_fit === 'too_big').length;
    s.push(tooBig === 0 ? `Everything should fit in your ${shortCarName(car)}.` : `${tooBig} of them won't fit in your ${shortCarName(car)}.`);
  }
  return s.join(' ');
}

export function emptyMessage(f: SearchArgs): string {
  const bits: string[] = [];
  if (f.free_only) bits.push('for free');
  else if (f.max_total_usd) bits.push(`under $${f.max_total_usd}`);
  if (f.ships_only) bits.push('that ship');
  else if (!f.has_car) bits.push('within walking distance or shipped');
  else bits.push(`within ${maxRoadMiles(f)} miles`);
  return `No matches ${bits.join(' ')}.`;
}

/** One-tap ways to widen an empty search. */
export function widenChips(f: SearchArgs): WidenChip[] {
  const chips: WidenChip[] = [];
  if (f.free_only) chips.push({ label: 'Include paid items', override: { free_only: false } });
  if (f.max_total_usd) {
    const up = Math.ceil((f.max_total_usd * 1.5) / 5) * 5;
    chips.push({ label: `Raise budget to $${up}`, override: { max_total_usd: up } });
  }
  if (!f.ships_ok) chips.push({ label: 'Include shipped items', override: { ships_ok: true } });
  if (f.ships_only) chips.push({ label: 'Include pickup', override: { ships_only: false } });
  if (f.style_text) chips.push({ label: 'Any style', override: { style_text: null } });
  if (f.has_car && maxRoadMiles(f) < 25) chips.push({ label: 'Search within 25 miles', override: { max_distance_mi: 25, max_drive_min: null } });
  if (f.max_w_in || f.max_d_in || f.max_h_in) chips.push({ label: 'Any size', override: { max_w_in: null, max_d_in: null, max_h_in: null } });
  if (f.categories.length) chips.push({ label: 'Any furniture', override: { categories: [] } });
  return chips.slice(0, 4);
}

export function profileFrom(f: SearchArgs, origin: Origin): Profile {
  return {
    location: origin.label,
    car: f.has_car ? f.car_make_model : null,
    has_car: f.has_car,
    budget_usd: f.max_total_usd,
    style: f.style_text,
    max_drive_min: f.max_drive_min,
  };
}
