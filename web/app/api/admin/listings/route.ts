import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/admin';
import { query } from '@/lib/db';
import { err, route } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** Admin always works on main: that is where the worker writes. */
export const GET = route('api.admin.listings', async (req: Request) => {
  requireAdmin(req);
  const sp = new URL(req.url).searchParams;
  const q = (sp.get('q') ?? '').trim().slice(0, 80);
  const status = (sp.get('status') ?? '').trim();
  const rows = await query(
    `select l.id::int as id, l.source, l.title, l.url, l.price_usd::float8 as price, l.city, l.demo_pin, l.is_active,
            l.photo_urls[1] as photo, d.category, d.photo_ok, d.eligible_3d,
            d.w_in::float8 as w, d.d_in::float8 as d, d.h_in::float8 as h, d.dims_source,
            a.status::text as status, a.provider, a.glb_url, a.usdz_url, a.is_approx_model, a.orient_override,
            a.last_error, a.attempts
       from listings l
       left join listing_details d on d.listing_id = l.id
       left join assets a on a.listing_id = l.id
      where ($1 = '' or l.title ilike '%' || $1 || '%' or d.category ilike '%' || $1 || '%' or l.id::text = $1)
        and ($2 = '' or a.status::text = $2 or ($2 = 'pinned' and l.demo_pin) or ($2 = 'none' and a.listing_id is null))
      order by l.demo_pin desc, l.scraped_at desc
      limit 60`,
    [q, status], { branch: 'main' },
  );
  return NextResponse.json({ listings: rows });
});

const ORIENTS = ['', 'identity', '+90x', '-90x', '+90z', '-90z', '180x'] as const;
const Patch = z.object({
  listing_id: z.coerce.number().int().positive(),
  demo_pin: z.boolean().optional(),
  orient_override: z.enum(ORIENTS).optional(),
  is_active: z.boolean().optional(),
});

export const PATCH = route('api.admin.listings.patch', async (req: Request) => {
  requireAdmin(req);
  const p = Patch.parse(await req.json());
  const found = await query('select 1 from listings where id = $1', [p.listing_id], { branch: 'main' });
  if (!found.length) throw err.notFound('That listing');
  if (p.demo_pin !== undefined) await query('update listings set demo_pin = $2 where id = $1', [p.listing_id, p.demo_pin], { branch: 'main' });
  if (p.is_active !== undefined) await query('update listings set is_active = $2 where id = $1', [p.listing_id, p.is_active], { branch: 'main' });
  if (p.orient_override !== undefined) {
    // changing the orientation sends a finished model back through the exporter
    const rows = await query<{ status: string }>(
      `update assets set orient_override = nullif($2, ''), updated_at = now(),
              status = case when status in ('ready', 'fallback_ready', 'exporting') and glb_url is not null then 'gen_done'::asset_status else status end,
              locked_by = null, locked_at = null
        where listing_id = $1 returning status::text as status`,
      [p.listing_id, p.orient_override], { branch: 'main' },
    );
    if (!rows.length) throw err.badRequest('This listing has no 3D asset yet, so there is nothing to re-orient.');
    await query(
      `insert into asset_events (listing_id, from_status, to_status, note) values ($1, null, $2, $3)`,
      [p.listing_id, rows[0].status, `admin: orient_override=${p.orient_override || 'auto'}`], { branch: 'main' },
    );
  }
  return NextResponse.json({ ok: true });
});
