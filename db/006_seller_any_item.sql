-- /sell takes any item ("water bottle", "wicker armchair"), not only our 12 furniture categories.
-- item: the seller's own words. w_in/d_in: the photo size estimate (h is height_in).
-- price_source: 'comps' (similar local listings) or 'estimate' (Gemini used-price estimate); price_basis: why.
alter table seller_drafts add column if not exists item text;
alter table seller_drafts add column if not exists w_in numeric(6,1);
alter table seller_drafts add column if not exists d_in numeric(6,1);
alter table seller_drafts add column if not exists price_source text;
alter table seller_drafts add column if not exists price_basis text;
