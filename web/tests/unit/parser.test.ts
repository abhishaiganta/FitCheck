import { describe, expect, it } from 'vitest';
import { keywordParse, wordsToNumbers } from '@/lib/search/keywordParser';
import { parseSearchArgs, SearchRequestSchema } from '@/lib/search/schema';

describe('search-argument zod schema', () => {
  it('fills defaults', () => {
    expect(parseSearchArgs({})).toMatchObject({ categories: [], ships_ok: true, has_car: true, max_total_usd: null, free_only: false });
  });
  it('drops unknown categories and duplicates', () => {
    expect(parseSearchArgs({ categories: ['desk_lamp', 'sofa', 'desk_lamp', 42] }).categories).toEqual(['desk_lamp']);
  });
  it('coerces LLM-ish values', () => {
    const a = parseSearchArgs({ max_total_usd: '$40', has_car: 'false', style_text: '  warm wood ', car_make_model: 'none', max_h_in: -3, max_distance_mi: 0 });
    expect(a).toMatchObject({ max_total_usd: 40, has_car: false, style_text: 'warm wood', car_make_model: null, max_h_in: null, max_distance_mi: null });
  });
  it('never keeps a car in no-car mode', () => {
    expect(parseSearchArgs({ has_car: false, car_make_model: 'Honda Civic' }).car_make_model).toBeNull();
  });
  it('survives garbage', () => {
    expect(parseSearchArgs(null).categories).toEqual([]);
    expect(parseSearchArgs('lamp').categories).toEqual([]);
  });
  it('request body: text is required and bounded', () => {
    expect(SearchRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ text: 'x'.repeat(401) }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ text: 'lamp', coords: { lat: 200, lng: 0 } }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ text: 'lamp', coords: { lat: 32.88, lng: -117.24 } }).success).toBe(true);
  });
});

describe('keyword-parser fallback', () => {
  it('parses the rehearsed demo query', () => {
    const a = keywordParse('desk lamp and side table under $40, warm wood, I drive a Civic.');
    expect(a.categories.sort()).toEqual(['desk_lamp', 'side_table']);
    expect(a).toMatchObject({ max_total_usd: 40, style_text: 'warm wood', car_make_model: 'Honda Civic', has_car: true });
  });
  it('number words and slang', () => {
    expect(wordsToNumbers('under forty bucks')).toBe('under 40 bucks');
    expect(wordsToNumbers('twenty five dollars')).toBe('25 dollars');
    expect(keywordParse('nightstand under forty bucks').max_total_usd).toBe(40);
    expect(keywordParse('a bookshelf for like 60 bucks').max_total_usd).toBe(60);
    expect(keywordParse('stool, a hundred dollars max').max_total_usd).toBe(100);
  });
  it('no car', () => {
    for (const q of ['lamp, no car', "I don't have a car, need a stool", 'ottoman, I bike everywhere']) {
      const a = keywordParse(q);
      expect(a.has_car).toBe(false);
      expect(a.car_make_model).toBeNull();
    }
  });
  it('places and ZIPs', () => {
    expect(keywordParse('free dresser near Pepper Canyon')).toMatchObject({ origin_text: 'Pepper Canyon', free_only: true, categories: ['dresser'] });
    expect(keywordParse('desk in 92122').origin_text).toBe('UTC');
    expect(keywordParse('floor lamp close to pacific beach').origin_text).toBe('Pacific Beach');
  });
  it('a bare "lamp" or "table" or "chair" expands to both kinds', () => {
    expect(keywordParse('lamp').categories.sort()).toEqual(['desk_lamp', 'floor_lamp']);
    expect(keywordParse('table').categories.sort()).toEqual(['coffee_table', 'side_table']);
    expect(keywordParse('chair').categories.sort()).toEqual(['accent_chair', 'dining_chair']);
    expect(keywordParse('standing lamp').categories).toEqual(['floor_lamp']);
    expect(keywordParse('bedside table').categories).toEqual(['nightstand']);
  });
  it('distance, drive time and dimensions are not mistaken for prices', () => {
    const a = keywordParse('bookshelf under 30 inches wide within 5 miles under $50');
    expect(a).toMatchObject({ max_w_in: 30, max_distance_mi: 5, max_total_usd: 50 });
    expect(keywordParse('desk, 10 minute drive').max_drive_min).toBe(10);
    expect(keywordParse('dresser shorter than 3 ft').max_h_in).toBe(36);
    expect(keywordParse('looking for 2 chairs').max_total_usd).toBeNull();
  });
  it('shipping preferences', () => {
    expect(keywordParse('side table pickup only').ships_ok).toBe(false);
    expect(keywordParse('side table that ships')).toMatchObject({ ships_only: true, ships_ok: true });
    expect(keywordParse('lamp with free shipping').free_only).toBe(false);
  });
  it('follow-ups build on the previous turn', () => {
    const first = keywordParse('side table under $40, warm wood, I drive a Civic');
    expect(keywordParse('cheaper', { filters: first })).toMatchObject({ categories: ['side_table'], max_total_usd: 30, car_make_model: 'Honda Civic' });
    expect(keywordParse('what about one that ships', { filters: first })).toMatchObject({ categories: ['side_table'], ships_only: true, max_total_usd: 40 });
    expect(keywordParse('my roommate has a RAV4', { filters: first })).toMatchObject({ categories: ['side_table'], car_make_model: 'Toyota RAV4' });
    expect(keywordParse('any style is fine', { filters: first }).style_text).toBeNull();
  });
  it('a new item keeps who the shopper is but not the old budget', () => {
    const first = keywordParse('side table under $40 near Pepper Canyon, I drive a Civic');
    const next = keywordParse('now a floor lamp', { filters: first });
    expect(next).toMatchObject({ categories: ['floor_lamp'], max_total_usd: null, car_make_model: 'Honda Civic', origin_text: 'Pepper Canyon' });
  });
  it('"cheaper" with no stated budget uses what was shown', () => {
    const first = keywordParse('side table');
    expect(keywordParse('cheaper', { filters: first, max_seen_total: 40 }).max_total_usd).toBe(30);
  });
  it('never throws on odd input', () => {
    for (const q of ['', '???', '$$$', 'under', '🛋️', 'a'.repeat(400)]) expect(() => keywordParse(q)).not.toThrow();
  });
});
