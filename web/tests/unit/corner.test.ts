// Corner planning: no network, no LLM.
import { describe, expect, it } from 'vitest';
import { cornerSummary, cornerTitle, pickWithinBudget, planCategories } from '@/lib/corner';

const c = (total_usd: number, is_approx_model = false, id = Math.random()) => ({ id, total_usd, is_approx_model });

describe('planCategories', () => {
  it('uses the corner kit for the kind of corner', () => {
    expect(planCategories('help me set up a study corner', [])).toEqual(['desk', 'dining_chair', 'desk_lamp']);
    expect(planCategories('bedside setup please', [])).toEqual(['nightstand', 'desk_lamp']);
    expect(planCategories('something', [])).toEqual(['accent_chair', 'side_table', 'desk_lamp']);
  });
  it('puts what the user named first and caps at 3', () => {
    expect(planCategories('reading corner with a floor lamp', ['floor_lamp'])).toEqual(['floor_lamp', 'accent_chair', 'side_table']);
    expect(planCategories('x', ['stool', 'ottoman', 'desk', 'dresser'])).toEqual(['stool', 'ottoman', 'desk']);
  });
});

describe('pickWithinBudget', () => {
  it('covers the most categories within the budget, then the cheapest', () => {
    const r = pickWithinBudget([
      { category: 'accent_chair', candidates: [c(50), c(30)] },
      { category: 'side_table', candidates: [c(25), c(15)] },
      { category: 'desk_lamp', candidates: [c(20), c(5)] },
    ], 55);
    expect(r.chosen.map((x) => x.total_usd)).toEqual([30, 15, 5]);
    expect(r.total).toBe(50);
    expect(r.missing).toEqual([]);
  });
  it('prefers real models over approx ones at the same coverage', () => {
    const real = c(40, false), approx = c(10, true);
    expect(pickWithinBudget([{ category: 'stool', candidates: [approx, real] }], 50).chosen).toEqual([real]);
  });
  it('drops a category rather than going over budget, and reports it', () => {
    const r = pickWithinBudget([{ category: 'desk', candidates: [c(70)] }, { category: 'desk_lamp', candidates: [c(12)] }], 60);
    expect(r.chosen.map((x) => x.total_usd)).toEqual([12]);
    expect(r.missing).toEqual(['desk']);
  });
  it('no budget means any total', () => {
    expect(pickWithinBudget([{ category: 'desk', candidates: [c(500)] }], null).total).toBe(500);
  });
});

describe('cornerSummary', () => {
  it('reads naturally and never invents a distance for city-only listings', () => {
    const s = cornerSummary([
      { category: 'accent_chair', total_usd: 30.4, mode: 'pickup', road_mi: 12.7, loc_precise: false },
      { category: 'desk_lamp', total_usd: 8, mode: 'ship', road_mi: null },
    ], 38.4, 60, ['side_table'], true);
    expect(s).toBe("Found an accent chair for $30 in San Diego and a desk lamp for $8 shipped. That's $38 together, within your $60. No side table fit yet. Building the whole corner in AR now.");
  });
  it('says what is missing when nothing fits', () => {
    expect(cornerSummary([], 0, 20, ['desk', 'accent_chair'], false)).toBe("I couldn't find a desk or an accent chair with a 3D model under $20 yet.");
  });
  it('titles', () => {
    expect(cornerTitle('Study corner under $80')).toBe('Study corner');
    expect(cornerTitle('make it nice')).toBe('Your corner');
  });
});
