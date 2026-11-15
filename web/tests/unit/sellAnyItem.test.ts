import { describe, expect, it } from 'vitest';
import { parsePriceEstimate, parseSizeEstimate } from '@/lib/gemini';
import { categoryFromText } from '@/lib/logic/categories';

describe('sell: any item', () => {
  it('maps free text to our furniture categories, and leaves everything else alone', () => {
    expect(categoryFromText('old wicker armchair')).toBe('accent_chair');
    expect(categoryFromText('Floor lamp')).toBe('floor_lamp');
    expect(categoryFromText('small end table')).toBe('side_table');
    expect(categoryFromText('bookcase')).toBe('bookshelf');
    expect(categoryFromText('water bottle')).toBeNull();
    expect(categoryFromText('')).toBeNull();
  });

  it('keeps a small item small', () => {
    const e = parseSizeEstimate(JSON.stringify({ item: 'Water Bottle', w_in: 3, d_in: 3, h_in: 10, confidence: 'low', basis: 'typical bottle' }));
    expect(e).toMatchObject({ item: 'water bottle', w_in: 3, d_in: 3, h_in: 10 });
  });

  it('rounds a used price like a person and keeps low <= suggested <= high', () => {
    const p = parsePriceEstimate(JSON.stringify({ suggested_usd: 6.4, low_usd: 8, high_usd: 4, new_usd: 24.99, basis: 'used bottles sell cheap' }));
    expect(p).toMatchObject({ suggested_usd: 6, low_usd: 6, high_usd: 6, new_usd: 25 });
    const q = parsePriceEstimate(JSON.stringify({ suggested_usd: 47, low_usd: 33, high_usd: 61, basis: 'x' }));
    expect(q).toMatchObject({ suggested_usd: 45, low_usd: 35, high_usd: 60, new_usd: null });
    expect(() => parsePriceEstimate('{"suggested_usd": 0}')).toThrow();
  });
});
