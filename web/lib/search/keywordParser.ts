// Keyword parser: the no-LLM fallback for /api/search (spec 7 step 6, section 14).
// Deterministic, fast and unit-tested, so search never hard-fails when Gemini is out of quota.
import { CATEGORY_SYNONYMS, type Category } from '../logic/categories';
import { findCarInText } from '../logic/carFit';
import { lookupPlaceDetailed } from '../logic/geo';
import { EMPTY_ARGS, parseSearchArgs, type SearchArgs } from './schema';

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** "under forty bucks" -> "under 40 bucks", "a hundred" -> "100", "twenty five" -> "25". */
export function wordsToNumbers(text: string): string {
  let t = text;
  t = t.replace(/\b(a|one) hundred( and)? (fifty)\b/g, '150');
  t = t.replace(/\b(a|one)? ?hundred\b/g, '100');
  t = t.replace(/\ba (couple|few)( of)?\b/g, (_m, w) => (w === 'couple' ? '2' : '3'));
  const tens = Object.keys(TENS).join('|');
  const ones = Object.keys(ONES).join('|');
  t = t.replace(new RegExp(`\\b(${tens})[ -](${ones})\\b`, 'g'), (_m, a, b) => String(TENS[a] + ONES[b]));
  t = t.replace(new RegExp(`\\b(${tens})\\b`, 'g'), (_m, a) => String(TENS[a]));
  t = t.replace(new RegExp(`\\b(${ones})\\b(?= (bucks?|dollars?|usd|miles?|mi|minutes?|mins?|inch|inches|in|feet|foot|ft)\\b)`, 'g'), (_m, a) => String(ONES[a]));
  return t;
}

const STYLE_VOCAB = [
  'warm wood', 'dark wood', 'light wood', 'solid wood', 'real wood', 'mid-century modern', 'mid century modern',
  'mid-century', 'mid century', 'midcentury', 'modern', 'minimalist', 'minimal', 'industrial', 'rustic', 'farmhouse',
  'boho', 'bohemian', 'scandinavian', 'scandi', 'vintage', 'retro', 'antique', 'cozy', 'cosy', 'wooden', 'wood',
  'walnut', 'oak', 'pine', 'maple', 'cherry', 'teak', 'bamboo', 'rattan', 'wicker', 'metal', 'brass', 'gold', 'chrome',
  'black', 'white', 'gray', 'grey', 'brown', 'beige', 'cream', 'green', 'blue', 'red', 'yellow', 'mustard', 'pink',
  'orange', 'velvet', 'leather', 'fabric', 'marble', 'glass', 'round', 'square', 'compact', 'sturdy', 'cute',
  'aesthetic', 'warm', 'dark', 'bright', 'natural', 'colorful', 'simple', 'clean',
];

const UNIT = '(?:in|inch|inches|"|ft|foot|feet|cm)';
const toInches = (n: number, unit: string) =>
  /^(ft|foot|feet)$/.test(unit) ? n * 12 : unit === 'cm' ? Math.round((n / 2.54) * 10) / 10 : n;

export type PrevContext = { filters?: unknown; max_seen_total?: number | null; min_seen_total?: number | null } | null;

export function keywordParse(input: string, prev?: PrevContext): SearchArgs {
  const raw = input.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  let t = ` ${wordsToNumbers(raw)} `;
  const out: Partial<SearchArgs> = {};

  // --- no car / car ---
  if (/\b(no car|don'?t (have|own) a car|do not (have|own) a car|without a car|car[- ]?less|no vehicle|i (walk|bike|skate)|on foot|by bike|take the (bus|trolley)|i'?m walking)\b/.test(t)) {
    out.has_car = false;
    out.car_make_model = null;
  }
  const car = findCarInText(t);
  if (car && out.has_car !== false) {
    out.car_make_model = car;
    out.has_car = true;
  }

  // --- dimensions (before price, so "under 20 inches wide" is not read as $20) ---
  const dimRe = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT})\\s*(wide|width|across|deep|depth|tall|high|height)`, 'g');
  for (const m of t.matchAll(dimRe)) {
    const v = toInches(Number(m[1]), m[2]);
    if (/wide|width|across/.test(m[3])) out.max_w_in = v;
    else if (/deep|depth/.test(m[3])) out.max_d_in = v;
    else out.max_h_in = v;
  }
  const dimRe2 = new RegExp(`(narrower|shorter|lower|shallower) than (\\d+(?:\\.\\d+)?)\\s*(${UNIT})`, 'g');
  for (const m of t.matchAll(dimRe2)) {
    const v = toInches(Number(m[2]), m[3]);
    if (m[1] === 'narrower') out.max_w_in = v;
    else if (m[1] === 'shallower') out.max_d_in = v;
    else out.max_h_in = v;
  }
  t = t.replace(dimRe, ' ').replace(dimRe2, ' ');

  // --- distance and drive time ---
  const mi = t.match(/(\d+(?:\.\d+)?)\s*(?:mi|mile|miles)\b/);
  if (mi) { out.max_distance_mi = Number(mi[1]); t = t.replace(mi[0], ' '); }
  const min = t.match(/(\d+)\s*(?:min|mins|minute|minutes)\b/);
  if (min) { out.max_drive_min = Number(min[1]); t = t.replace(min[0], ' '); }

  // --- price ---
  const price =
    t.match(/(?:under|below|less than|cheaper than|max(?:imum)?(?: of)?|up to|no more than|at most|budget(?: is| of)?|<)\s*\$?\s*(\d+(?:\.\d+)?)(?!\s*(?:%|x\b))/) ??
    t.match(/\$\s*(\d+(?:\.\d+)?)/) ??
    t.match(/(\d+(?:\.\d+)?)\s*(?:bucks?|dollars?|usd)\b/);
  if (price) out.max_total_usd = Number(price[1]);
  if (/\bfree\b/.test(t) && !/free (shipping|delivery)/.test(t)) out.free_only = true;

  // --- shipping ---
  if (/\b(pick ?up only|no shipping|local only|don'?t ship|not shipped|in person only)\b/.test(t)) out.ships_ok = false;
  else if (/\b(that ships?|ones? that ships?|ships? only|only (shipped|shipping)|shipped only|must ship|has to ship|deliver(ed|y) only|that (can be |gets? )?deliver(ed|s)?|shipped to me|mail(ed)? to me)\b/.test(t)) {
    out.ships_only = true;
    out.ships_ok = true;
  } else if (/\b(ship|ships|shipped|shipping|delivery|delivered)\b/.test(t)) out.ships_ok = true;

  // --- origin ---
  const seg = t.match(/\b(?:near|around|close to|next to|by|from|live in|living in|i'?m in|i'?m at|i am in|i am at|in|at)\s+([a-z0-9 ]{2,40})/g) ?? [];
  let place = null as ReturnType<typeof lookupPlaceDetailed>;
  for (const s of seg) {
    place = lookupPlaceDetailed(s);
    if (place) break;
  }
  if (!place) {
    const whole = lookupPlaceDetailed(t);
    if (whole && (whole.alias.length >= 6 || /^\d{5}$/.test(whole.alias))) place = whole;
  }
  if (place) out.origin_text = place.place.name;

  // --- categories (longest phrases first; matched text is consumed) ---
  const cats = new Set<Category>();
  let rest = t;
  for (const [re, list] of CATEGORY_SYNONYMS) {
    const g = new RegExp(re.source, 'g');
    if (g.test(rest)) {
      list.forEach((c) => cats.add(c));
      rest = rest.replace(new RegExp(re.source, 'g'), ' ');
    }
  }

  // --- style ---
  const style: string[] = [];
  let srest = ` ${rest} `;
  for (const term of STYLE_VOCAB) {
    const re = new RegExp(`(?<![a-z])${term.replace(/[-]/g, '[- ]')}(?![a-z])`);
    if (re.test(srest)) {
      style.push(term);
      srest = srest.replace(re, ' ');
    }
  }
  if (style.length) out.style_text = style.join(' ');

  // --- merge with the previous turn ---
  const prevArgs = prev?.filters ? parseSearchArgs(prev.filters) : null;
  let base: SearchArgs;
  if (cats.size) {
    // a new search: keep who the shopper is (car, place), not what they last looked for
    base = { ...EMPTY_ARGS, categories: [...cats] };
    if (prevArgs) {
      base.car_make_model = prevArgs.car_make_model;
      base.has_car = prevArgs.has_car;
      base.origin_text = prevArgs.origin_text;
    }
  } else if (prevArgs) {
    base = { ...prevArgs }; // a follow-up: "cheaper", "what about one that ships", "my roommate has a RAV4"
    if (/\b(cheaper|less expensive|lower price|too (expensive|pricey|much)|more affordable)\b/.test(t) && out.max_total_usd == null) {
      const ref = prevArgs.max_total_usd ?? prev?.max_seen_total ?? null;
      if (ref) out.max_total_usd = Math.max(5, Math.floor((ref * 0.75) / 5) * 5);
    }
    if (/\b(closer|nearer|too far)\b/.test(t) && out.max_distance_mi == null) {
      out.max_distance_mi = Math.max(1, Math.round(((prevArgs.max_distance_mi ?? 10) / 2) * 10) / 10);
    }
    if (/\b(any style|any color|any look|don'?t care (about|what) (style|color|it looks))\b/.test(t)) base.style_text = null;
    if (/\b(pick ?up is fine|i can pick ?up|pickup works)\b/.test(t)) base.ships_only = false;
  } else {
    base = { ...EMPTY_ARGS };
  }

  return parseSearchArgs({ ...base, ...out });
}
