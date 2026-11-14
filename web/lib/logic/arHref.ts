import { formatDistance, formatUsdShort } from './cost';

export type ArInput = {
  usdz_url: string;
  title: string;
  price_usd: number;
  mode: 'ship' | 'pickup' | 'walk';
  road_mi?: number | null;
  shipping_usd?: number | null;
  condition?: string | null;
};

const CONDITION_LABEL: Record<string, string> = {
  new: 'New', like_new: 'Like new', good: 'Used', fair: 'Used', poor: 'Used',
};

export function arSubtitle(i: ArInput): string {
  const cond = CONDITION_LABEL[i.condition ?? ''] ?? 'Used';
  const where =
    i.mode === 'ship'
      ? `Ships ${formatUsdShort(Number(i.shipping_usd ?? 0)).replace('FREE', 'free')}`
      : i.road_mi != null ? formatDistance(i.road_mi) : 'Pickup';
  return `${where} · ${cond}`;
}

/**
 * The AR Quick Look link, exactly as the spec requires:
 *   {usdz}#allowsContentScaling=0&callToAction=View%20listing&checkoutTitle=..&checkoutSubtitle=..&price=..
 * Returns null unless the model is a hosted https URL (Safari drops the fragment on blob: URLs).
 */
export function buildArHref(i: ArInput): string | null {
  if (!i.usdz_url || !/^https:\/\//i.test(i.usdz_url)) return null;
  const base = i.usdz_url.split('#')[0];
  const title = i.title.length > 48 ? `${i.title.slice(0, 47).trimEnd()}…` : i.title;
  const price = i.price_usd <= 0 ? 'Free' : formatUsdShort(i.price_usd);
  return (
    `${base}#allowsContentScaling=0&callToAction=View%20listing` +
    `&checkoutTitle=${encodeURIComponent(title)}` +
    `&checkoutSubtitle=${encodeURIComponent(arSubtitle(i))}` +
    `&price=${encodeURIComponent(price)}`
  );
}

export const AR_BANNER_TAPPED = '_apple_ar_quicklook_button_tapped';
