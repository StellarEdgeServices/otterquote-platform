-- C4 — per-contractor priced slope bands
-- Tier 3A (purely additive: one nullable JSONB column, no constraint changes,
-- nothing dropped, renamed, retyped or narrowed, no existing row rewritten).
-- Drafted 2026-08-27. NOT APPLIED — every migration requires Dustin's approval.

alter table public.contractors
  add column if not exists pitch_bands jsonb;

comment on column public.contractors.pitch_bands is
  'C4: the contractor''s own priced roof-slope bands and access adders, as HIS rate '
  'card states them. Shape: {"source":"contractor_rate_card","bands":[{"label":..., '
  '"min_over_12":int|null,"max_over_12":int|null,"rate_per_square":numeric|null}], '
  '"two_story_adder":{"label":...,"rate_per_square":numeric}}. Pitch is expressed as '
  'rise over a run of 12. NULL means no rate card on file, and create-docusign-envelope '
  'falls back to the Xactimate-aligned 7/12 threshold. Deliberately NOT a platform '
  'constant: Indy Rooftops prices steep from 5/12 while Xactimate and RoofScope both '
  'use 7/12, and that is a commercial choice each contractor makes.';
