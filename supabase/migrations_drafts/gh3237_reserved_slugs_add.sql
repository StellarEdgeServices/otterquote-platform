-- STATUS (gh-1438, as of 2026-10-30T17:30:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3237_reserved_slugs_add (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-30 under #3239 / #3237; production read-only the same day (yeszghaspzwwstvsrioa): reserved_slugs has 169 rows
--   (p18_vanity_slug_data, ledger 20261030141912), neither 'partner-agreement-v3' nor 'ref-bind' among them. No database was written.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and
--   pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3237_reserved_slugs_add (data only, append-only reserved list; Tier 3A additive)
-- Two served top-level paths a partner vanity slug must never shadow:
--   partner-agreement-v3  -- partner-agreement-v3.html, the archived Partner Agreement v3-2026-09 (#3242 / #3239)
--   ref-bind              -- POST /ref-bind, the edge function that re-issues the server-set oq_pc cookie (#3230; closes #3237)
-- Both are in scripts/p18-reserved-slugs.py output (171 rows; the generator now also reads netlify.toml edge-function `path`s).
-- scripts/vanity-reserved.test.py reads this file's INSERT together with p18_vanity_slug_data's.
-- Apply after p18_vanity_slug_data (it needs public.reserved_slugs); apply before or with the #3242 Netlify publish.
-- Rollback: gh3237_reserved_slugs_add_rollback.sql   Pre-flight: gh3237_reserved_slugs_add_pre-flight.md
-- Check: supabase/tests/gh3237_reserved_slugs_add_check.sql (p18_slug_is_reserved() is true for both after apply)

BEGIN;

INSERT INTO public.reserved_slugs (slug) VALUES
  ('partner-agreement-v3'),
  ('ref-bind')
ON CONFLICT (slug) DO NOTHING;

COMMIT;
