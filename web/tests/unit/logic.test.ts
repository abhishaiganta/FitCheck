import { describe, expect, it } from 'vitest';
import { AR_BANNER_TAPPED, buildArHref } from '@/lib/logic/arHref';
import { carFit, findCarInText, matchCar, shortCarName, type Car } from '@/lib/logic/carFit';
import {
  driveMinutes, formatDistance, formatUsd, haversineMi, hoursAgo, maxRoadMiles, pickupCost, roadMiles, savingsVsNew, totalCost,
} from '@/lib/logic/cost';
import { lookupPlace, resolveOrigin } from '@/lib/logic/geo';

const civic: Car = { make_model: 'Honda Civic', cargo_w_in: 39, cargo_h_in: 18, cargo_d_in: 38, seats_folded_d_in: 68 };
const rav4: Car = { make_model: 'Toyota RAV4', cargo_w_in: 40, cargo_h_in: 30, cargo_d_in: 37, seats_folded_d_in: 70 };

describe('pickupCost', () => {
  it('is round trip x fuel cost per mile', () => {
    expect(pickupCost(1.2)).toBe(0.36);
    expect(pickupCost(10)).toBe(3);
    expect(pickupCost(10, 0.2)).toBe(4);
  });
  it('is 0 for zero, negative or bad distances', () => {
    expect(pickupCost(0)).toBe(0);
    expect(pickupCost(-3)).toBe(0);
    expect(pickupCost(NaN)).toBe(0);
  });
});

describe('totalCost', () => {
  it('price + shipping for shipped items', () => {
    expect(totalCost({ price_usd: 15, shipping_usd: 9, ships: true })).toEqual({ total: 24, mode: 'ship', extra: 9 });
  });
  it('price + estimated pickup cost for local items', () => {
    expect(totalCost({ price_usd: 0, road_mi: 1.2 })).toEqual({ total: 0.36, mode: 'pickup', extra: 0.36 });
  });
  it('picks the cheaper option when both exist', () => {
    expect(totalCost({ price_usd: 20, shipping_usd: 30, ships: true, road_mi: 5 }).mode).toBe('pickup');
    expect(totalCost({ price_usd: 20, shipping_usd: 1, ships: true, road_mi: 30 }).mode).toBe('ship');
  });
  it('walking costs nothing', () => {
    expect(totalCost({ price_usd: 5, road_mi: 0.4, walk: true })).toEqual({ total: 5, mode: 'walk', extra: 0 });
  });
  it('treats a missing price as 0 and never goes negative', () => {
    expect(totalCost({ price_usd: null }).total).toBe(0);
    expect(totalCost({ price_usd: -5, shipping_usd: -1, ships: true }).total).toBe(0);
  });
});

describe('distance helpers', () => {
  it('formats with a tilde and one decimal', () => {
    expect(formatDistance(1.2)).toBe('~1.2 mi');
    expect(formatDistance(3)).toBe('~3.0 mi');
    expect(formatDistance(0.04)).toBe('~0.0 mi');
  });
  it('haversine: UCSD to downtown is roughly 12 miles straight-line', () => {
    const mi = haversineMi(32.8801, -117.2376, 32.7157, -117.1611);
    expect(mi).toBeGreaterThan(11);
    expect(mi).toBeLessThan(13);
    expect(roadMiles(32.8801, -117.2376, 32.7157, -117.1611)).toBeCloseTo(mi * 1.3, 5);
  });
  it('drive time uses 25 mph', () => {
    expect(driveMinutes(25)).toBe(60);
    expect(driveMinutes(0.1)).toBe(1);
  });
  it('max_drive_min wins, then max_distance_mi, then 10 miles', () => {
    expect(maxRoadMiles({ max_drive_min: 12, max_distance_mi: 50 })).toBe(5);
    expect(maxRoadMiles({ max_distance_mi: 4 })).toBe(4);
    expect(maxRoadMiles({})).toBe(10);
  });
  it('money, savings and age labels', () => {
    expect(formatUsd(0)).toBe('FREE');
    expect(formatUsd(15)).toBe('$15');
    expect(formatUsd(0.36)).toBe('$0.36');
    expect(savingsVsNew(64, 24)).toBe(40);
    expect(savingsVsNew(20, 24)).toBe(0);
    expect(savingsVsNew(null, 24)).toBeNull();
    const now = new Date('2026-11-14T20:00:00Z');
    expect(hoursAgo('2026-11-14T17:00:00Z', now)).toBe('3 hrs ago');
    expect(hoursAgo('2026-11-14T19:40:00Z', now)).toBe('under an hour ago');
  });
});

describe('carFit', () => {
  it('a lamp fits a Civic trunk', () => {
    expect(carFit({ w: 7, d: 7, h: 16 }, civic)).toBe('fits');
  });
  it('tries every orientation: a tall thin item goes in lying down', () => {
    expect(carFit({ w: 12, d: 12, h: 36 }, civic)).toBe('fits');
  });
  it('needs seats folded when only the long way is too long', () => {
    expect(carFit({ w: 12, d: 12, h: 60 }, civic)).toBe('seats_folded');
    expect(carFit({ w: 30, d: 12, h: 71 }, rav4)).toBe('too_big');
    expect(carFit({ w: 30, d: 12, h: 68 }, rav4)).toBe('seats_folded');
  });
  it('too big when no face clears the opening', () => {
    expect(carFit({ w: 60, d: 18.5, h: 32 }, civic)).toBe('too_big');
    expect(carFit({ w: 28, d: 30, h: 33 }, civic)).toBe('too_big');
    expect(carFit({ w: 28, d: 30, h: 33 }, rav4)).toBe('fits');
  });
  it('bad dimensions never claim to fit', () => {
    expect(carFit({ w: 0, d: 10, h: 10 }, civic)).toBe('too_big');
    expect(carFit({ w: NaN, d: 10, h: 10 }, civic)).toBe('too_big');
  });
  it('finds cars in speech and matches table rows', () => {
    expect(findCarInText('I drive a Civic')).toBe('Honda Civic');
    expect(findCarInText('my roommate has a rav 4')).toBe('Toyota RAV4');
    expect(findCarInText('model y')).toBe('Tesla Model Y');
    expect(findCarInText('I have a bike')).toBeNull();
    expect(matchCar('civic', [civic, rav4])?.make_model).toBe('Honda Civic');
    expect(matchCar('Toyota RAV4', [civic, rav4])?.make_model).toBe('Toyota RAV4');
    expect(matchCar('Ford F-150', [civic, rav4])).toBeNull();
    expect(shortCarName('Honda Civic')).toBe('Civic');
  });
});

describe('AR href builder (exact fragment format)', () => {
  const base = { usdz_url: 'https://x.public.blob.vercel-storage.com/usdz/12-v1.usdz', title: 'Brass desk lamp', price_usd: 15, mode: 'pickup' as const, road_mi: 1.2, condition: 'good' };
  it('matches the spec format exactly', () => {
    expect(buildArHref(base)).toBe(
      'https://x.public.blob.vercel-storage.com/usdz/12-v1.usdz#allowsContentScaling=0&callToAction=View%20listing' +
        '&checkoutTitle=Brass%20desk%20lamp&checkoutSubtitle=~1.2%20mi%20%C2%B7%20Used&price=%2415',
    );
  });
  it('free items say Free, shipped items show shipping', () => {
    expect(buildArHref({ ...base, price_usd: 0 })).toMatch(/&price=Free$/);
    expect(buildArHref({ ...base, mode: 'ship', shipping_usd: 9, road_mi: null })).toContain('checkoutSubtitle=Ships%20%249%20%C2%B7%20Used');
  });
  it('escapes titles and keeps them short', () => {
    const href = buildArHref({ ...base, title: 'Table & "chairs" #1 '.repeat(5) })!;
    const frag = href.split('#')[1];
    expect(frag.split('#').length).toBe(1);
    expect(new URLSearchParams(frag).get('checkoutTitle')!.length).toBeLessThanOrEqual(48);
    expect(new URLSearchParams(frag).get('allowsContentScaling')).toBe('0');
    expect(new URLSearchParams(frag).get('callToAction')).toBe('View listing');
  });
  it('refuses blob:, http: and empty URLs (Safari drops the fragment on blob URLs)', () => {
    expect(buildArHref({ ...base, usdz_url: 'blob:https://x/abc' })).toBeNull();
    expect(buildArHref({ ...base, usdz_url: 'http://x/a.usdz' })).toBeNull();
    expect(buildArHref({ ...base, usdz_url: '' })).toBeNull();
  });
  it('strips an existing fragment and exposes the banner event name', () => {
    expect(buildArHref({ ...base, usdz_url: `${base.usdz_url}#old=1` })!.split('#').length).toBe(2);
    expect(AR_BANNER_TAPPED).toBe('_apple_ar_quicklook_button_tapped');
  });
});

describe('origin', () => {
  it('a said place wins over browser coords', () => {
    const o = resolveOrigin({ origin_text: 'near Pepper Canyon', coords: { lat: 32.7, lng: -117.1 } });
    expect(o).toMatchObject({ label: 'Pepper Canyon', source: 'said' });
  });
  it('browser coords are rounded to 2 decimals', () => {
    expect(resolveOrigin({ coords: { lat: 32.87654, lng: -117.23456 } })).toMatchObject({ lat: 32.88, lng: -117.23, source: 'browser' });
  });
  it('defaults to UCSD, also for unknown places and bad coords', () => {
    expect(resolveOrigin({})).toMatchObject({ label: 'UCSD', source: 'default' });
    expect(resolveOrigin({ origin_text: 'Narnia' }).source).toBe('default');
    expect(resolveOrigin({ coords: { lat: 999, lng: 0 } }).source).toBe('default');
  });
  it('looks up ZIPs and prefers the longest alias', () => {
    expect(lookupPlace('92122')?.name).toBe('UTC');
    expect(lookupPlace('la jolla village')?.name).toBe('La Jolla Village');
    expect(lookupPlace('la jolla')?.name).toBe('La Jolla');
  });
});
