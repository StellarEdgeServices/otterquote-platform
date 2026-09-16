-- Migration: gh1993_claims_property_city_zip
-- Issue: #1993 — every single-box address input becomes Street/City/State/ZIP
-- Tier: 3A (additive, nullable, no default, no backfill, no constraint) per D-182 / D-261
-- Filed: 2026-09-16 (stamp.py: 2026-09-16T13:30:24Z), CEO RUN 48 (ceo48-gh1991-1993)
--
-- ✅ STATUS: APPLIED 2026-09-16 by CEO RUN 48 (add column if not exists).
-- Both columns verified present on production by re-read after apply. This
-- file is kept in supabase/migrations/ (not moved) so a fresh branch replays
-- to the same schema production already has — see this directory's README
-- on the replay-path contract. The statement is idempotent (`ADD COLUMN IF
-- NOT EXISTS`, `COMMENT ON COLUMN` is safe to re-run) so re-applying this
-- exact file is a no-op, not a hazard.
--
-- REVIEW: FAIL (PR #1998 comment 5698654086, B3) correctly found that the
-- pre-apply retry this file's writer originally carried (trade-selector/
-- page.tsx matching a `42703` SELECT-on-missing-column code) would never
-- have fired anyway — PostgREST rejects an INSERT/UPDATE payload naming an
-- unknown column with `PGRST204`, a different code, so the retry was dead
-- on arrival even before the migration applied. Rather than fix the error
-- code for a guard that is now moot, the CEO ruling (comment 5698876771)
-- applied this migration directly and the retry was removed entirely — no
-- dead code path, no pre-migration window left to guard.
--
-- ALSO PER THAT RULING: property_address is NOT switched to street-only.
-- The line below in the original WHY section describing property_address
-- as "kept as the STREET LINE ONLY" was #1993's own body wording, and it
-- shipped that way in this PR's first round — REVIEW: FAIL B1/B2 showed
-- every existing reader of property_address (notify-contractors,
-- check-siding-design-completion, the contractor opportunities card,
-- agreement_requested email/SMS, DocuSign customer_address, color-
-- selection.html's ZIP extraction) expects the full combined line, and a
-- street-only value broke contractor notification outright (silent 400s)
-- and exposed the homeowner's street address pre-selection (D-074). The
-- ruling amends #1993: property_address stays the combined line;
-- property_city/property_zip (this migration) are additive columns
-- alongside it, not a replacement for it.
--
-- WHY
-- Dustin, 2026-09-16 chat, verbatim: "for one of the homeowner intake forms,
-- we ask for their address and the example has the street, city, state, zip
-- all in one box. Every address collection should have separate boxes for
-- street address, city, state, zip. Not all in one box." The measured harm:
-- the one real homeowner this week typed only "910 Congress Street" into the
-- single box on get-started Step 1; claims.property_state was NULL and
-- Otter Quotes could not tell which market she was in. Splitting the INPUT
-- (this PR's get-started/page.tsx change) only helps if the parsed city and
-- ZIP have somewhere to land — property_address and property_state already
-- existed and are unchanged in shape by this PR; property_city and
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
-- true of every row today, since these columns have never existed.
-- property_address is UNCHANGED in shape by this PR (still the full
-- combined string, e.g. "910 Congress Street, Noblesville, IN 46060") —
-- every existing reader keeps working exactly as before. No existing query,
-- RLS policy, view, or Edge Function references property_city/property_zip
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
'gh-1993. The city component of the property address, split out of the single free-text box get-started Step 1 (and every other homeowner/partner-referral address form) used to collect as one combined string. NULL for every claim created before this column existed, and for any claim whose intake flow could not parse a city out of a legacy combined address. Populated by react-app/app/trade-selector/page.tsx (the claims writer) from cs_signup.address_city (get-started''s split City field) or, for a legacy cs_signup payload written before this change, from parseAddress()''s comma/regex fallback (./utils.ts). ADDITIVE alongside property_address, which stays the full combined line per the CEO ruling on PR #1998 (comment 5698876771) — this is a new derived field, not a replacement for any existing column.';

COMMENT ON COLUMN public.claims.property_zip IS
'gh-1993. The 5-digit ZIP component of the property address, split out of the single free-text box the intake forms used to collect as one combined string. NULL for every claim created before this column existed, and for any claim whose intake flow could not parse a ZIP out of a legacy combined address. Populated by react-app/app/trade-selector/page.tsx (the claims writer) from cs_signup.address_zip (get-started''s split ZIP field, validated to exactly 5 digits client-side) or, for a legacy cs_signup payload, from parseAddress()''s fallback (./utils.ts), which also cross-checks the token against a static ZIP3-to-state table (./zip3-state.ts) when resolving property_state. ADDITIVE alongside property_address, which stays the full combined line per the CEO ruling on PR #1998 (comment 5698876771).';

COMMIT;
