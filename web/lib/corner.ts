// "Furnish a corner" planning (spec 15 stretch): pure helpers, unit-tested, no network.
import type { Category } from './logic/categories';

/** What a corner of a given kind usually needs, in priority order (max 3: a corner, not a room). */
export const CORNER_KITS: { match: RegExp; categories: Category[] }[] = [
  { match: /\b(study|desk|work|homework|office|wfh)\b/, categories: ['desk', 'dining_chair', 'desk_lamp'] },
  { match: /\b(bed|bedside|bedroom|sleep)\b/, categories: ['nightstand', 'desk_lamp'] },
  { match: /\b(living|lounge|tv|hang ?out)\b/, categories: ['accent_chair', 'coffee_table', 'floor_lamp'] },
  { match: /\b(book|library)\b/, categories: ['bookshelf', 'accent_chair', 'floor_lamp'] },
  { match: /\b(reading|cozy|chill|nook|corner)\b/, categories: ['accent_chair', 'side_table', 'desk_lamp'] },
];
export const DEFAULT_KIT: Category[] = ['accent_chair', 'side_table', 'desk_lamp'];

/** Anything the shopper named comes first, then the corner kit fills up to 3 categories. */
export function planCategories(request: string, asked: readonly Category[]): Category[] {
  if (asked.length >= 2) return asked.slice(0, 3);
  const low = request.toLowerCase();
  const kit = CORNER_KITS.find((k) => k.match.test(low))?.categories ?? DEFAULT_KIT;
  return [...new Set([...asked, ...kit])].slice(0, 3);
}

export type BudgetPick<T> = { chosen: T[]; total: number; missing: string[] };

/**
 * At most one item per category with the combined total within the budget.
 * Best = covers the most categories, then fewest approximate models, then the lowest total.
 * Exhaustive over the top 6 per category (3 categories = 343 combos).
 */
export function pickWithinBudget<T extends { total_usd: number; is_approx_model: boolean }>(
  byCategory: { category: string; candidates: T[] }[], budget: number | null,
): BudgetPick<T> {
  const lists = byCategory.map((c) => [null, ...c.candidates.slice(0, 6)] as (T | null)[]);
  let best: { items: (T | null)[]; key: [number, number, number] } | null = null;
  const better = (a: [number, number, number], b: [number, number, number]) =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  const walk = (i: number, acc: (T | null)[], sum: number) => {
    if (budget !== null && sum > budget + 1e-9) return;
    if (i === lists.length) {
      const items = acc.filter((x): x is T => x !== null);
      const key: [number, number, number] = [items.length, -items.filter((x) => x.is_approx_model).length, -sum];
      if (!best || better(key, best.key)) best = { items: [...acc], key };
      return;
    }
    for (const c of lists[i]) walk(i + 1, [...acc, c], sum + (c ? c.total_usd : 0));
  };
  walk(0, [], 0);
  const items = (best as { items: (T | null)[] } | null)?.items ?? lists.map(() => null);
  return {
    chosen: items.filter((x): x is T => x !== null),
    total: Math.round(items.reduce((s, x) => s + (x ? x.total_usd : 0), 0) * 100) / 100,
    missing: byCategory.filter((_, i) => !items[i]).map((c) => c.category),
  };
}

export function cornerTitle(request: string): string {
  const m = request.toLowerCase().match(/\b(study|desk|reading|bedside|bedroom|living|book|cozy)\b/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} corner` : 'Your corner';
}

const nice = (c: string) => c.replace(/_/g, ' ');
const article = (w: string) => (/^[aeiou]/.test(w) ? 'an' : 'a');

/** Written to be spoken (ElevenLabs). Every number comes from the picked cards. */
export function cornerSummary(
  items: { category: string; total_usd: number; mode: string; road_mi: number | null; loc_precise?: boolean }[],
  total: number, budget: number | null, missing: string[], building: boolean,
): string {
  if (!items.length) {
    return `I couldn't find ${missing.map((m) => `${article(nice(m))} ${nice(m)}`).join(' or ')} with a 3D model${budget != null ? ` under $${budget}` : ''} yet.`;
  }
  const parts = items.map((i) => `${article(nice(i.category))} ${nice(i.category)} for $${Math.round(i.total_usd)}`
    + (i.mode === 'ship' ? ' shipped' : i.loc_precise === false ? ' in San Diego'
      : i.road_mi != null ? `, about ${i.road_mi.toFixed(1)} miles away` : ''));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  let s = `Found ${list}. That's $${Math.round(total)} together${budget != null ? `, within your $${budget}` : ''}.`;
  if (missing.length) s += ` No ${missing.map(nice).join(' or ')} fit yet.`;
  if (building) s += ' Building the whole corner in AR now.';
  return s;
}
