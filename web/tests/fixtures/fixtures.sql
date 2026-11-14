-- FAKE fixture data for local development and tests only (spec section 4, "Fixtures vs. real data").
-- Never load this into the Neon demo branch. USDZ/GLB URLs are public sample models used as stand-ins.
insert into listings (id, source, external_id, url, title, description, price_usd, shipping_usd, ships, city, lat, lng, photo_urls, raw, scraped_at, demo_pin) values
 (1,'craigslist','fx-1','https://sandiego.craigslist.org/fixture/1','Brass desk lamp, warm glow','Small brass desk lamp with a wood base. Works great. 16 in tall.',0,null,false,'La Jolla',32.8690,-117.2330,'{/fixtures/desk_lamp.svg}','{"fixture":true}', now() - interval '3 hours', true),
 (2,'ebay','fx-2','https://www.ebay.com/itm/fixture-2','Walnut side table, mid-century','Solid walnut side table. 18 x 18 x 22 in. Light wear on top.',15,9,true,null,null,null,'{/fixtures/side_table.svg}','{"fixture":true}', now() - interval '5 hours', true),
 (3,'fb_marketplace','fx-3','https://www.facebook.com/marketplace/item/fixture-3','Mustard accent chair','Comfy accent chair, mustard fabric, oak legs.',35,null,false,'University City',32.8610,-117.2110,'{/fixtures/accent_chair.svg}','{"fixture":true}', now() - interval '9 hours', true),
 (4,'fb_marketplace','fx-4','https://www.facebook.com/marketplace/item/fixture-4','Wooden desk lamp, adjustable arm','Warm wood desk lamp with an adjustable arm.',12,null,false,'Pacific Beach',32.7978,-117.2403,'{/fixtures/desk_lamp.svg}','{"fixture":true}', now() - interval '1 hours', false),
 (5,'craigslist','fx-5','https://sandiego.craigslist.org/fixture/5','Oak nightstand with drawer','Oak nightstand, one drawer. 20 x 16 x 24 inches.',25,null,false,'Clairemont',32.8328,-117.2040,'{/fixtures/nightstand.svg}','{"fixture":true}', now() - interval '12 hours', false),
 (6,'ebay','fx-6','https://www.ebay.com/itm/fixture-6','Round wood stool, 18 in','Round wooden stool, natural finish.',18,12,true,null,null,null,'{/fixtures/stool.svg}','{"fixture":true}', now() - interval '20 hours', false),
 (7,'fb_marketplace','fx-7','https://www.facebook.com/marketplace/item/fixture-7','Tall white bookshelf, 5 shelves','White bookshelf. 30 x 12 x 71 in.',40,null,false,'Mira Mesa',32.9150,-117.1440,'{/fixtures/bookshelf.svg}','{"fixture":true}', now() - interval '2 hours', false),
 (8,'craigslist','fx-8','https://sandiego.craigslist.org/fixture/8','6-drawer dresser, dark wood','Heavy dresser. 60 x 18 x 32 inches.',60,null,false,'La Jolla',32.8400,-117.2740,'{/fixtures/dresser.svg}','{"fixture":true}', now() - interval '30 hours', false),
 (9,'fb_marketplace','fx-9','https://www.facebook.com/marketplace/item/fixture-9','Black floor lamp','Simple black floor lamp, about 60 in tall.',10,null,false,'Sorrento Valley',32.9020,-117.1930,'{/fixtures/floor_lamp.svg}','{"fixture":true}', now() - interval '4 hours', false),
 (10,'ebay','fx-10','https://www.ebay.com/itm/fixture-10','Velvet ottoman, forest green','Round velvet ottoman.',22,14,true,null,null,null,'{/fixtures/ottoman.svg}','{"fixture":true}', now() - interval '7 hours', false),
 (11,'craigslist','fx-11','https://sandiego.craigslist.org/fixture/11','Glass coffee table','Glass top coffee table with chrome legs.',30,null,false,'Hillcrest',32.7480,-117.1620,'{/fixtures/coffee_table.svg}','{"fixture":true}', now() - interval '15 hours', false),
 (12,'fb_marketplace','fx-12','https://www.facebook.com/marketplace/item/fixture-12','Small writing desk, pine','Pine writing desk. 40 x 20 x 30 in.',45,null,false,'UTC',32.8710,-117.2120,'{/fixtures/desk.svg}','{"fixture":true}', now() - interval '6 hours', false);
select setval('listings_id_seq', 100);

insert into listing_details (listing_id, category, style_tags, condition, w_in, d_in, h_in, dims_source, weight_lb_est, photo_ok, eligible_3d, summary, embedding, model_used) values
 (1,'desk_lamp','{brass,warm,wood,vintage}','good',7,7,16,'listing_text',4,true,true,'Small brass desk lamp on a wood base', array_fill(0, array[768])::vector,'fixture'),
 (2,'side_table','{walnut,"warm wood",mid-century,wood}','good',18,18,22,'listing_text',14,true,true,'Mid-century walnut side table', array_fill(0, array[768])::vector,'fixture'),
 (3,'accent_chair','{mustard,fabric,oak,retro}','like_new',28,30,33,'estimated',32,true,true,'Mustard fabric accent chair with oak legs', array_fill(0, array[768])::vector,'fixture'),
 (4,'desk_lamp','{"warm wood",wood,adjustable,modern}','good',6,9,18,'estimated',3,true,true,'Wooden desk lamp with adjustable arm', array_fill(0, array[768])::vector,'fixture'),
 (5,'nightstand','{oak,wood,traditional}','good',20,16,24,'listing_text',25,true,true,'Oak nightstand with one drawer', array_fill(0, array[768])::vector,'fixture'),
 (6,'stool','{wood,natural,minimal}','good',14,14,18,'estimated',8,true,true,'Round wooden stool', array_fill(0, array[768])::vector,'fixture'),
 (7,'bookshelf','{white,modern,tall}','good',30,12,71,'listing_text',55,true,true,'Tall white five-shelf bookshelf', array_fill(0, array[768])::vector,'fixture'),
 (8,'dresser','{"dark wood",wood,traditional}','fair',60,18,32,'listing_text',120,true,true,'Six-drawer dark wood dresser', array_fill(0, array[768])::vector,'fixture'),
 (9,'floor_lamp','{black,minimal,modern}','good',12,12,60,'estimated',9,true,true,'Simple black floor lamp', array_fill(0, array[768])::vector,'fixture'),
 (10,'ottoman','{velvet,green,round}','like_new',20,20,16,'estimated',11,true,true,'Round green velvet ottoman', array_fill(0, array[768])::vector,'fixture'),
 (11,'coffee_table','{glass,chrome,modern}','good',44,22,17,'estimated',40,false,false,'Glass and chrome coffee table', array_fill(0, array[768])::vector,'fixture'),
 (12,'desk','{pine,wood,simple}','good',40,20,30,'listing_text',38,true,true,'Small pine writing desk', array_fill(0, array[768])::vector,'fixture');

insert into assets (listing_id, status, provider, glb_url, usdz_url, is_approx_model, final_w_in, final_d_in, final_h_in, attempts, last_error) values
 (1,'ready','tripo','https://modelviewer.dev/shared-assets/models/Astronaut.glb','https://developer.apple.com/augmented-reality/quick-look/models/gramophone/gramophone.usdz',false,7,7,16,1,null),
 (2,'ready','tripo','https://modelviewer.dev/shared-assets/models/Astronaut.glb','https://developer.apple.com/augmented-reality/quick-look/models/teapot/teapot.usdz',false,18,18,22,1,null),
 (3,'ready','manual','https://modelviewer.dev/shared-assets/models/Astronaut.glb','https://developer.apple.com/augmented-reality/quick-look/models/chair-swan/chair_swan.usdz',false,28,33,33,1,null),
 (4,'ready','tripo','https://modelviewer.dev/shared-assets/models/Astronaut.glb','https://developer.apple.com/augmented-reality/quick-look/models/gramophone/gramophone.usdz',false,6,9,18,1,null),
 (5,'fallback_ready','generic','https://modelviewer.dev/shared-assets/models/Astronaut.glb','https://developer.apple.com/augmented-reality/quick-look/models/teapot/teapot.usdz',true,20,16,24,2,null),
 (6,'ready','hf','https://modelviewer.dev/shared-assets/models/Astronaut.glb','https://developer.apple.com/augmented-reality/quick-look/models/teapot/teapot.usdz',false,14,14,18,1,null),
 (7,'ready','tripo','https://modelviewer.dev/shared-assets/models/Astronaut.glb','https://developer.apple.com/augmented-reality/quick-look/models/teapot/teapot.usdz',false,30,12,71,1,null),
 (8,'ready','tripo','https://modelviewer.dev/shared-assets/models/Astronaut.glb','https://developer.apple.com/augmented-reality/quick-look/models/teapot/teapot.usdz',false,60,18,32,1,null),
 (9,'exporting','tripo','https://modelviewer.dev/shared-assets/models/Astronaut.glb',null,false,null,null,null,1,null),
 (10,'gen_pending','tripo',null,null,false,null,null,null,1,null),
 (12,'failed','tripo',null,null,false,null,null,null,3,'tripo: task timed out after 6 min');

insert into asset_events (listing_id, from_status, to_status, note, at) values
 (1,'exporting','ready','usdz 1.8 MB', now() - interval '50 minutes'),
 (2,'exporting','ready','usdz 2.4 MB', now() - interval '44 minutes'),
 (5,'gen_pending','fallback_ready','all providers out of quota, generic model', now() - interval '30 minutes'),
 (9,'gen_done','exporting','auto-orient: +90 X', now() - interval '2 minutes'),
 (10,'cutout','gen_pending','tripo task queued', now() - interval '1 minutes'),
 (12,'gen_pending','failed','tripo: task timed out after 6 min', now() - interval '12 minutes');

insert into new_price_baselines (category, style_key, median_usd, sample_n, sample_urls) values
 ('desk_lamp','any',32.00,10,'{https://www.amazon.com/s?k=desk+lamp}'),
 ('side_table','any',64.00,10,'{https://www.amazon.com/s?k=side+table}'),
 ('accent_chair','any',139.00,10,'{https://www.amazon.com/s?k=accent+chair}'),
 ('nightstand','any',79.00,10,'{https://www.amazon.com/s?k=nightstand}'),
 ('bookshelf','any',89.00,10,'{https://www.amazon.com/s?k=bookshelf}'),
 ('dresser','any',189.00,10,'{https://www.amazon.com/s?k=dresser}'),
 ('stool','any',38.00,10,'{https://www.amazon.com/s?k=stool}');

-- Fixture cargo numbers are rough placeholders for tests; real rows come from /data/cars.csv with sources.
insert into cars (make_model, cargo_w_in, cargo_h_in, cargo_d_in, seats_folded_d_in, source_url) values
 ('Honda Civic',39,18,38,68,'https://example.com/fixture-not-a-real-source'),
 ('Toyota RAV4',40,30,37,70,'https://example.com/fixture-not-a-real-source'),
 ('Tesla Model 3',38,17,42,66,'https://example.com/fixture-not-a-real-source');

insert into impact_events (listing_id, kind, dollars_saved_est, lbs_diverted_est) values
 (1,'ar_view',32,4),(2,'ar_view',40,14),(2,'listing_open',40,14);
