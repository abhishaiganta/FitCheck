-- FAKE fixture rows so Person B can build before real data exists (spec section 13).
-- Loaded only by `python -m scripts.seed_demo` (it uploads the sample models and fills in the URL placeholders).
-- Every fixture listing has external_id 'fixture-NN'. `python -m scripts.drop_fixtures` removes them all.
-- NEVER shown at judging: delete them before the demo branch is made.

insert into listings (source, external_id, url, title, description, price_usd, shipping_usd, ships, city, lat, lng, photo_urls, raw, posted_at, demo_pin) values
('fb_marketplace','fixture-01','https://example.com/fixture/01','Solid wood side table','Warm oak side table with a lower shelf. 20 x 18 x 22 inches. Pickup near UTC.',15,null,false,'University City, CA',32.861,-117.210,array['{{PHOTO_SIDE_TABLE}}'],'{"fixture":true}',now() - interval '3 hours',false),
('fb_marketplace','fixture-02','https://example.com/fixture/02','Desk lamp, works great','Cream shade desk lamp, about 18 inches tall. Free to a good home.',0,null,false,'La Jolla, CA',32.840,-117.274,array['{{PHOTO_DESK_LAMP}}'],'{"fixture":true}',now() - interval '5 hours',false),
('ebay','fixture-03','https://example.com/fixture/03','Mid-century accent chair, grey fabric','Used accent chair, 28 W x 30 D x 33 H. Ships from Texas.',45,29,true,'Irving, Texas, United States',null,null,array['{{PHOTO_ACCENT_CHAIR}}'],'{"fixture":true}',now() - interval '1 day',false),
('craigslist','fixture-04','https://example.com/fixture/04','Nightstand with two drawers','Dark walnut nightstand. Some scratches on top.',25,null,false,'Pacific Beach',32.798,-117.240,array['{{PHOTO_SIDE_TABLE}}'],'{"fixture":true}',now() - interval '8 hours',false),
('fb_marketplace','fixture-05','https://example.com/fixture/05','Floor lamp, brass look','Tall floor lamp, about 60 inches.',20,null,false,'Clairemont, CA',32.820,-117.185,array['{{PHOTO_DESK_LAMP}}'],'{"fixture":true}',now() - interval '2 days',false),
('fb_marketplace','fixture-06','https://example.com/fixture/06','Wooden stool','Round seat stool, 22 inches high.',10,null,false,'Mira Mesa, CA',32.915,-117.144,array['{{PHOTO_SIDE_TABLE}}'],'{"fixture":true}',now() - interval '4 hours',false),
('ebay','fixture-07','https://example.com/fixture/07','Storage ottoman, grey','Used storage ottoman. Free shipping.',30,0,true,'Phoenix, Arizona, United States',null,null,array['{{PHOTO_ACCENT_CHAIR}}'],'{"fixture":true}',now() - interval '3 days',false),
('craigslist','fixture-08','https://example.com/fixture/08','Coffee table, wood and metal','44 x 22 x 17 coffee table with a shelf.',40,null,false,'North Park',32.741,-117.130,array['{{PHOTO_SIDE_TABLE}}'],'{"fixture":true}',now() - interval '6 hours',false),
('fb_marketplace','fixture-09','https://example.com/fixture/09','White 6-drawer dresser','Dresser in good shape, 50 inches wide.',60,null,false,'Carmel Valley, CA',32.944,-117.215,array['{{PHOTO_SIDE_TABLE}}'],'{"fixture":true}',now() - interval '1 day',false),
('fb_marketplace','fixture-10','https://example.com/fixture/10','Bookshelf, 5 shelves','Tall bookshelf 30 x 12 x 65.',35,null,false,'Sorrento Valley, CA',32.901,-117.193,array['{{PHOTO_SIDE_TABLE}}'],'{"fixture":true}',now() - interval '9 hours',false),
('craigslist','fixture-11','https://example.com/fixture/11','Small student desk','48 inch desk with a drawer.',50,null,false,'Hillcrest',32.748,-117.165,array['{{PHOTO_SIDE_TABLE}}'],'{"fixture":true}',now() - interval '2 days',false),
('ebay','fixture-12','https://example.com/fixture/12','Dining chair, single','One oak dining chair. Ships in 3 to 5 days.',22,18,true,'Portland, Oregon, United States',null,null,array['{{PHOTO_ACCENT_CHAIR}}'],'{"fixture":true}',now() - interval '4 days',false)
on conflict (source, external_id) do nothing;

insert into listing_details (listing_id, category, style_tags, condition, w_in, d_in, h_in, dims_source, dims_from_text, weight_lb_est, best_photo_idx, photo_ok, eligible_3d, summary, embedding, model_used)
select l.id, v.category, v.style_tags, v.condition, v.w, v.d, v.h, v.dims_source, v.dims_source = 'listing_text', v.weight, 0, true, true, v.summary,
       ('[' || array_to_string(array_fill(0::real, array[768]), ',') || ']')::vector, 'fixture'
from (values
 ('fixture-01','side_table',array['warm wood','oak','simple'],'good',20,18,22,'listing_text',14,'Warm oak side table with a lower shelf.'),
 ('fixture-02','desk_lamp',array['cream','metal','classic'],'good',8,8,18,'estimated',4,'Cream shade desk lamp on a dark metal base.'),
 ('fixture-03','accent_chair',array['grey','fabric','mid-century'],'good',28,30,33,'listing_text',38,'Grey fabric mid-century accent chair.'),
 ('fixture-04','nightstand',array['dark wood','walnut','two drawers'],'fair',20,16,24,'estimated',25,'Dark walnut nightstand with two drawers.'),
 ('fixture-05','floor_lamp',array['brass','tall','classic'],'good',12,12,60,'estimated',9,'Tall brass-look floor lamp.'),
 ('fixture-06','stool',array['wood','round','rustic'],'good',14,14,22,'estimated',8,'Round wooden stool.'),
 ('fixture-07','ottoman',array['grey','fabric','storage'],'like_new',20,18,16,'estimated',15,'Grey storage ottoman.'),
 ('fixture-08','coffee_table',array['wood','metal','industrial'],'good',44,22,17,'listing_text',35,'Wood and metal coffee table with a shelf.'),
 ('fixture-09','dresser',array['white','six drawers','modern'],'good',50,18,34,'estimated',95,'White six-drawer dresser.'),
 ('fixture-10','bookshelf',array['wood','tall','five shelves'],'good',30,12,65,'listing_text',50,'Tall five-shelf bookshelf.'),
 ('fixture-11','desk',array['wood','student','drawer'],'fair',48,24,30,'estimated',60,'Small student desk with a drawer.'),
 ('fixture-12','dining_chair',array['oak','wood','classic'],'good',18,20,36,'estimated',14,'Single oak dining chair.')
) as v(ext, category, style_tags, condition, w, d, h, dims_source, weight, summary)
join listings l on l.external_id = v.ext
on conflict (listing_id) do nothing;

-- 3 ready (hosted sample USDZ), 9 in various statuses
insert into assets (listing_id, status, provider, cutout_url, glb_url, usdz_url, is_approx_model, final_w_in, final_d_in, final_h_in, attempts, last_error)
select l.id, v.status::asset_status, v.provider, null, v.glb, v.usdz, v.approx, v.fw, v.fd, v.fh, v.attempts, v.err
from (values
 ('fixture-01','ready','tripo','{{GLB_SIDE_TABLE}}','{{USDZ_SIDE_TABLE}}',false,20.0,18.0,22.0,1,null),
 ('fixture-02','ready','meshy','{{GLB_DESK_LAMP}}','{{USDZ_DESK_LAMP}}',false,8.0,8.0,18.0,1,null),
 ('fixture-03','ready','tripo','{{GLB_ACCENT_CHAIR}}','{{USDZ_ACCENT_CHAIR}}',false,28.0,29.0,33.0,1,null),
 ('fixture-04','fallback_ready','generic','{{GLB_SIDE_TABLE}}','{{USDZ_SIDE_TABLE}}',true,20.0,16.0,24.0,1,null),
 ('fixture-05','queued',null,null,null,false,null,null,null,0,null),
 ('fixture-06','cutout',null,null,null,false,null,null,null,1,null),
 ('fixture-07','gen_pending','tripo',null,null,false,null,null,null,1,null),
 ('fixture-08','gen_pending','hf',null,null,false,null,null,null,1,null),
 ('fixture-09','gen_done','meshy','{{GLB_SIDE_TABLE}}',null,false,null,null,null,1,null),
 ('fixture-10','exporting','tripo','{{GLB_SIDE_TABLE}}',null,false,null,null,null,1,null),
 ('fixture-11','failed',null,null,null,false,null,null,null,3,'mask covers 4% of the photo (under 8%): object too small or not found'),
 ('fixture-12','queued',null,null,null,false,null,null,null,0,null)
) as v(ext, status, provider, glb, usdz, approx, fw, fd, fh, attempts, err)
join listings l on l.external_id = v.ext
on conflict (listing_id) do nothing;

insert into asset_events (listing_id, from_status, to_status, note, at)
select l.id, v.f, v.t, v.note, now() - (v.mins * interval '1 minute')
from (values
 ('fixture-01',null,'queued','eligible for 3D',42),
 ('fixture-01','queued','cutout',null,41),
 ('fixture-01','cutout','gen_pending','cutout ok (1 view)',40),
 ('fixture-01','gen_pending','gen_done','tripo model generated (28291 tris, 4295 KB)',37),
 ('fixture-01','gen_done','exporting',null,36),
 ('fixture-01','exporting','ready','USDZ 7154 KB, 20.0 x 18.0 x 22.0 in, orient identity',36),
 ('fixture-04','gen_pending','gen_done','generic fallback: all providers failed or are out of quota',20),
 ('fixture-04','exporting','fallback_ready','USDZ 33 KB, 20.0 x 16.0 x 24.0 in, orient identity',19),
 ('fixture-07','cutout','gen_pending','cutout ok (1 view)',6),
 ('fixture-07','gen_pending','gen_pending','tripo job started (1 photo)',5),
 ('fixture-11','cutout','failed','mask covers 4% of the photo (under 8%): object too small or not found',12)
) as v(ext, f, t, note, mins)
join listings l on l.external_id = v.ext
where not exists (select 1 from asset_events e where e.listing_id = l.id);
