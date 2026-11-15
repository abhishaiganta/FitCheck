import { describe, expect, it } from 'vitest';
import { listingText } from '@/components/PostElsewhere';

describe('Post it: listing text', () => {
  it('has title, price, size, and the link back to the 3D listing', () => {
    const t = listingText({ listingId: 42, title: 'White chair', priceUsd: 40, photoUrl: null, w: 19.6, d: 21, h: 33.2, item: 'office chair' }, 'https://x.test');
    expect(t.split('\n')[0]).toBe('White chair - $40');
    expect(t).toContain('Office chair. About 20" W x 21" D x 33" H.');
    expect(t).toContain('https://x.test/item/42');
  });
  it('skips the details line when there is no size or extra description', () => {
    const t = listingText({ listingId: 1, title: 'Lamp', priceUsd: 5, photoUrl: null, w: null, d: null, h: null, item: 'lamp' }, 'https://x.test');
    expect(t).not.toContain('About');
    expect(t).not.toMatch(/\n\n\n/);
  });
});
