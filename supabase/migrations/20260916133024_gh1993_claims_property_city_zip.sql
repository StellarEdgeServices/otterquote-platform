-- Migration: gh1993_claims_property_city_zip
-- Issue: #1993 — every single-box address input becomes Street/City/State/ZIP
-- Tier: 3A (additive, nullable, no default, no backfill, no constraint) per D-182 / D-261
-- Filed: 2026-09-16 (stamp.py: 2026-09-16T13:30:24Z), CEO RUN 48 (ceo48-gh1991-1993)
--
-- ⚠ STATUS: NOT APPLIED. Filed as a PR only, per CEO RUN 48 dispatch brief
-- ("do NOT apply it — the orchestrator applies after review"). Nothing in this
-- file has been run against production or any branch. Mirrors the precedent
-- set by 20260907220015_gh1796_claims_loss_sheet_reviewed_at.sql (also filed
-- NOT APPLIED, additive, Tier 3A).
--
-- IMPORTANT (unlike gh-1796's read-side fallback): PostgREST REJECTS THE
-- WHOLE insert/update when a payload names a column that does not exist yet
-- (PGRST204/42703, undefined_column) — not just the one unknown key. The
-- claims writer this PR also changes (react-app/app/trade-selector/page.tsx)
-- shares ONE payload object across property_address/property_state/trades/
-- funding_type/etc. and the two new keys, so sending it unmodified before
-- this migration applies would silently break claim creation for every
-- homeowner completing trade-selector, not just drop two fields. That
-- writer therefore tries the full payload first and, ONLY on a 42703
-- (undefined_column) error, retries once with property_city/property_zip
-- stripped — so the rest of the claim still lands pre-migration, exactly as
-- mark-loss-sheet-reviewed's PG_UNDEFINED_COLUMN check degrades gh-1796's
-- write path. Applying this migration removes the need for that retry (a
-- one-line follow-up, not a correctness fix) but does not require it: the
-- retry path is dead code, not a bug, once the column exists.
--
-- WHY
-- Dustin, 2026-09-16 chat, verbatim: "for one of the homeowner intake forms,
-- we ask for their address and the example has the street, city, state, zip
-- all in one box. Every address collection should have separate boxes for
-- street address, city, state, zip. Not all in one box." The measured harm:
-- the one real homeowner this week typed only "910 Congress Street" into the
-- single box on get-started Step 1; claims.property_state was NULL and
-- Otter Quotes could not tell which market she was in. Splitting the input
-- (this PR's get-started/page.tsx change) only helps if the parsed city and
-- ZIP have somewhere to land — property_address already exists (kept as the
-- STREET LINE ONLY per this issue's ruling, not the full combined string it
-- held before) and property_state already exists; property_city and
-- property_zip are the two columns this table was missing.
--
-- WHY A COLUMN AND NOT A JSONB BLOB
-- Repo convention for claims' property location is already three flat text
-- columns living directly on the row (property_address, property_state) —
-- not a nested jsonb address object — because contractor-facing cards,
-- D-178 state gating, and admin dashboards all filter/read these as plain
-- columns today. Two more flat text columns matching that same shape is the
-- change with the least new surface area, not a schema redesign.
--
-- SAFETY
-- Additive, nullable, no DEFAULT, no NOT NULL, no CHECK, no index, no
-- trigger, no backfill. Existing rows read NULL = "never split-collected" —
-- true of every row today, since these columns have never existed and
-- property_address previously held the full combined string (street, city,
-- state, zip all folded together) rather than separated components. No
-- existing query, RLS policy, view, or Edge Function references either name
-- (grepped across the tree at filing time — the only references are the
-- ones added in the accompanying trade-selector/page.tsx change in this same
-- PR, and those are additive keys in an update/insert payload, not reads).
-- ADD COLUMN with no default and no volatile expression is a catalog-only
-- change in PG 11+ — no table rewrite, no long lock on claims.

BEGIN;

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS property_city text,
  ADD COLUMN IF NOT EXISTS property_zip text;

COMMENT ON COLUMN public.claims.property_city IS
'gh-1993. The city component of the property address, split out of the single free-text box get-started Step 1 (and every other homeowner/partner-referral address form) used to collect as one combined string. NULL for every claim created before this column existed, and for any claim whose intake flow could not parse a city out of a legacy combined address. Populated by react-app/app/trade-selector/page.tsx (the claims writer) from cs_signup.address_city (get-started''s split City field) or, for a legacy cs_signup payload written before this change, from parseAddress()''s comma/regex fallback (./utils.ts). Distinct from property_address, which is the STREET LINE ONLY as of this same PR (previously the full combined address).';

COMMENT ON COLUMN public.claims.property_zip IS
'gh-1993. The 5-digit ZIP component of the property address, split out of the single free-text box the intake forms used to collect as one combined string. NULL for every claim created before this column existed, and for any claim whose intake flow could not parse a ZIP out of a legacy combined address. Populated by react-app/app/trade-selector/page.tsx (the claims writer) from cs_signup.address_zip (get-started''s split ZIP field, validated to exactly 5 digits client-side) or, for a legacy cs_signup payload, from parseAddress()''s fallback (./utils.ts), which also cross-checks the token against a static ZIP3-to-state table (./zip3-state.ts) when resolving property_state.';

COMMIT;
