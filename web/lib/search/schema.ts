import { z } from 'zod';
import { CATEGORIES, isCategory } from '../logic/categories';

const optNum = (max: number) =>
  z.preprocess((v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'string' ? Number(v.replace(/[$,]/g, '')) : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  }, z.number().positive().max(max).nullable());

const optStr = (max: number) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s && !/^(null|none|n\/a|unknown|any)$/i.test(s) ? s.slice(0, max) : null;
  }, z.string().nullable());

const bool = (d: boolean) =>
  z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v === null || v === undefined ? d : v), z.boolean());

/** Arguments of the `search_listings` tool. Lenient on input (LLM output), strict on output. */
export const SearchArgsSchema = z.object({
  categories: z.preprocess(
    (v) => (Array.isArray(v) ? [...new Set(v.filter((c) => typeof c === 'string' && isCategory(c)))].slice(0, 8) : []),
    z.array(z.enum(CATEGORIES)),
  ),
  max_total_usd: optNum(100_000),
  max_distance_mi: optNum(500),
  max_drive_min: optNum(600),
  ships_ok: bool(true),
  style_text: optStr(200),
  max_w_in: optNum(400),
  max_d_in: optNum(400),
  max_h_in: optNum(400),
  car_make_model: optStr(60),
  has_car: bool(true),
  origin_text: optStr(80),
  free_only: bool(false),
  ships_only: bool(false),
});
export type SearchArgs = z.infer<typeof SearchArgsSchema>;

export const EMPTY_ARGS: SearchArgs = SearchArgsSchema.parse({});

export function parseSearchArgs(raw: unknown): SearchArgs {
  const a = SearchArgsSchema.parse(raw && typeof raw === 'object' ? raw : {});
  if (!a.has_car) a.car_make_model = null; // never show a car-fit badge in no-car mode
  return a;
}

/** POST /api/search body. */
export const SearchRequestSchema = z.object({
  text: z.string().trim().min(1, 'Say or type what you need.').max(400),
  coords: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullish(),
  /** Filters from the previous turn, so "cheaper" or "what about one that ships" works without the agent. */
  prev: z.unknown().optional(),
  /** Explicit filter overrides from the widen chips. */
  override: z.unknown().optional(),
  session_id: z.string().max(80).optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/** Gemini function declaration (OpenAPI subset) for the direct function-calling path. */
export const SEARCH_TOOL_DECLARATION = {
  name: 'search_listings',
  description:
    'Search used furniture listings near San Diego. Fill only what the shopper actually said. Prices are total cost in USD.',
  parameters: {
    type: 'OBJECT',
    properties: {
      categories: {
        type: 'ARRAY',
        description: 'Furniture categories asked for. "lamp" alone means desk_lamp and floor_lamp. "table" alone means side_table and coffee_table.',
        items: { type: 'STRING', enum: [...CATEGORIES] },
      },
      max_total_usd: { type: 'NUMBER', description: 'Budget ceiling, e.g. "under forty bucks" -> 40.' },
      max_distance_mi: { type: 'NUMBER', description: 'Max pickup distance in miles, only if stated.' },
      max_drive_min: { type: 'NUMBER', description: 'Max drive time in minutes, only if stated.' },
      ships_ok: { type: 'BOOLEAN', description: 'False only if the shopper refuses shipped items (pickup only).' },
      style_text: { type: 'STRING', description: 'Look, material, color, vibe: "warm wood", "mid-century", "white minimalist".' },
      max_w_in: { type: 'NUMBER', description: 'Max width in inches (convert feet/cm).' },
      max_d_in: { type: 'NUMBER', description: 'Max depth in inches.' },
      max_h_in: { type: 'NUMBER', description: 'Max height in inches.' },
      car_make_model: { type: 'STRING', description: 'Car to check fit against, e.g. "Honda Civic".' },
      has_car: { type: 'BOOLEAN', description: 'False when the shopper says they have no car / walk / bike / bus.' },
      origin_text: { type: 'STRING', description: 'A place or ZIP the shopper says they are at or near, e.g. "Pepper Canyon".' },
      free_only: { type: 'BOOLEAN', description: 'True when the shopper only wants free items.' },
      ships_only: { type: 'BOOLEAN', description: 'True when the shopper only wants items that ship / get delivered.' },
    },
    required: ['categories'],
  },
} as const;
