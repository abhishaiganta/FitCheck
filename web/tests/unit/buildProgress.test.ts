import { describe, expect, it } from 'vitest';
import { estimateProgress, fmtLeft } from '@/components/BuildProgress';

describe('Sell build progress', () => {
  it('fills up through the steps and never reaches 100 before the model is ready', () => {
    const a = estimateProgress('new', 0, null), b = estimateProgress('cutout', 10, null), c = estimateProgress('exporting', 5, null);
    expect(a.pct).toBe(0);
    expect(b.pct).toBeGreaterThan(a.pct);
    expect(c.pct).toBeGreaterThan(b.pct);
    expect(estimateProgress('exporting', 999, null).pct).toBeLessThan(100);
    expect(a.secondsLeft).toBeGreaterThan(c.secondsLeft);
  });
  it("uses the 3D provider's own percent when it is further along", () => {
    expect(estimateProgress('gen_pending', 5, 80).pct).toBeGreaterThan(estimateProgress('gen_pending', 5, null).pct);
    expect(estimateProgress('gen_pending', 5, 80).secondsLeft).toBeLessThan(estimateProgress('gen_pending', 5, 10).secondsLeft);
  });
  it('keeps a small remainder when a step runs long', () => {
    expect(estimateProgress('gen_pending', 600, null).secondsLeft).toBeGreaterThanOrEqual(30);
  });
  it('formats time left', () => {
    expect(fmtLeft(12)).toBe('10 s');
    expect(fmtLeft(95)).toBe('1 min 40 s');
    expect(fmtLeft(178)).toBe('3 min');
  });
});
