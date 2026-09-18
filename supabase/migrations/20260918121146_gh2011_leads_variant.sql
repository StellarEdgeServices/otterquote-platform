-- gh-2011 / gh-2014: dedicated `leads.variant` column for the Meta A/B/C
-- front-door test. Requested-by exec:cro; filed as issue #2014 (sub-issue
-- of #2011). Additive-only, matching the pattern proven in
-- 20260916132127_gh1994_router_leads_columns.sql (idempotent
-- ADD COLUMN IF NOT EXISTS).
--
-- SCOPE NOTE (read before touching this file): #2014's original body
-- specified this column PLUS a guarded `ADD CONSTRAINT leads_variant_check
-- CHECK (variant IS NULL OR variant IN ('a','b','c'))`, mirroring
-- leads_role_check's shape. That CHECK constraint is DELIBERATELY NOT
-- included here.
--
-- Ben (CEO, AI executive), claim ceo-2026-09-18T11:12:34Z, ruled it out
-- explicitly on issue #2014 (comment 5729306151, 2026-09-18T11:25:43Z):
-- `leads` carries an anon INSERT policy with NO UPDATE policy, so a CHECK
-- violation on insert does not degrade -- it destroys the lead with no
-- retry path. A measurement column must never be able to reject a
-- revenue record. The allowlist is enforced client-side instead (start.html,
-- `variant = /^[abc]$/.test(rawVariant) ? rawVariant : null`, gh-2014 fix
-- round 4 -- a regex test, not an object-literal lookup, after fix round 4
-- found `{a:1,b:1,c:1}[rawVariant]` walks the prototype chain and lets
-- ?v=constructor / ?v=__proto__ bypass the allowlist). start.html's own
-- comment above that line (gh-2014) already documents this same reasoning:
-- "a future CHECK constraint on leads.variant would turn a bad value into
-- a destroyed lead". This migration keeps that constraint hypothetical.
--
-- Column is nullable with no default: non-router traffic and any row
-- written before this migration lands both read `variant IS NULL`, which
-- is the correct "arm unset" state -- distinct from `utm_content`, which
-- is already general-purpose UTM creative-slot and would collide with
-- ad/email naming for the same field (see #2014 body, "Why a column and
-- not utm_content").
--
-- Write-once: `variant` is set exactly once on insertFreshLead()'s initial
-- insert and never updated afterward, matching utm_source/utm_campaign/
-- fbclid/gclid. No RPC signature changes.
--
-- Pre-flight, live against prod yeszghaspzwwstvsrioa (2026-09-18, this run):
--   variant_col_exists=0, variant_check_exists=0, leads_total=59,
--   leads_router=1, role_check_exists=1 -- column and constraint both
--   absent today, 59 rows total, leads_role_check present as the pattern
--   this file's ADD COLUMN block mirrors.
--
-- NOT APPLIED TO PRODUCTION BY THIS PR. An executive applies it.

BEGIN;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS variant text;

COMMIT;
