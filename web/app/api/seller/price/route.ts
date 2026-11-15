import { NextResponse } from 'next/server';
import { z } from 'zod';
import { route } from '@/lib/errors';
import { categoryFromText, isCategory } from '@/lib/logic/categories';
import { checkIpLimit } from '@/lib/ratelimit';
import { sellerPrice } from '@/lib/seller/price';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const Body = z.object({
  item: z.string().trim().max(80).optional(),
  category: z.string().optional(),
  title: z.string().trim().max(120).optional(),
  condition: z.enum(['like_new', 'good', 'fair']).default('good'),
  w_in: z.number().positive().max(200).optional(), d_in: z.number().positive().max(200).optional(),
  h_in: z.number().positive().max(200).optional(),
});

/** Seller flow: a price that should sell this week, for any item. See lib/seller/price.ts. Estimate only. */
export const POST = route('api.seller.price', async (req: Request) => {
  checkIpLimit(req, 'seller', 20);
  const b = Body.parse(await req.json());
  const category = b.category && isCategory(b.category) ? b.category : categoryFromText(b.item ?? b.title);
  return NextResponse.json(await sellerPrice({ ...b, item: b.item ?? null, category }));
});
