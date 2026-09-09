-- gh-1314 step 4 — persist what the signed-price reconciliation actually read.
--
-- DRAFT. NOT APPLIED. Staged in migrations_drafts/ deliberately: this repo's
-- supabase/migrations/ holds only SQL already applied in production, because the
-- CLI replays that directory forward onto every fresh branch. Same convention
-- #1800 (gh-1339) used.
--
-- Tier 3A: additive, nullable, no backfill, no RLS change, no index, no rewrite.
-- ADD COLUMN with no DEFAULT is catalogue-only in PG11+.
--
-- WHY. docusign-webhook/price-verify.ts computes a verdict on every completed
-- contract and then throws it away: the only durable trace is a message STRING
-- in platform_alerts_log (3 rows as of 2026-09-07, all signed_price_unverified).
-- Nothing in the schema records what the contractor typed into contract_price,
-- so the statement "0 signed contracts had a price mismatch" cannot be made from
-- the database — the two amounts that ARE stored, claims.selected_bid_amount and
-- quotes.total_price, are BOTH platform-side and would agree even in the exact
-- defect #1314 describes. Measured 2026-09-06 by CTO RUN 27: no column anywhere
-- in `public` holds a signed contract price.
--
-- ⛔ CORRECTION to the 2026-09-06 draft (In Flight/sql/gh1314-persist-signed-
-- price-20260906.sql), which this file supersedes. That draft's reason CHECK
-- listed three values — no_expected, field_absent, unparseable. PR #1798 (merged
-- 2026-09-08T03:38:01Z) added TWO more, properties_unreadable and
-- reconciliation_error, and made both of them HALT verdicts. Applied as drafted,
-- the constraint would have REJECTED every write on the two newest halt paths,
-- and the writer's non-fatal error handling would have swallowed the rejection —
-- losing precisely the verdicts this column set exists to record. The list below
-- is the full UnverifiedReason union in price-verify.ts, and
-- price-verify.test.ts asserts the two lists stay identical.

-- ============================ FORWARD ============================
begin;

alter table public.claims
  add column if not exists signed_contract_price   numeric(12,2),
  add column if not exists signed_price_raw        text,
  add column if not exists signed_price_verdict    text,
  add column if not exists signed_price_reason     text,
  add column if not exists signed_price_checked_at timestamptz;

alter table public.claims
  add constraint claims_signed_price_verdict_check
  check (signed_price_verdict is null
         or signed_price_verdict in ('reconciled','mismatch','unverified'));

alter table public.claims
  add constraint claims_signed_price_reason_check
  check (signed_price_reason is null
         or signed_price_reason in ('no_expected','field_absent','unparseable',
                                    'properties_unreadable','reconciliation_error'));

comment on column public.claims.signed_contract_price is
  'gh-1314: the contract price read back off the signed BoldSign document, parsed. NULL when the field was absent, unparseable, or never read — NULL is not $0.';
comment on column public.claims.signed_price_raw is
  'gh-1314: the pre-parse string as BoldSign returned it. Kept so an unparseable value stays inspectable.';
comment on column public.claims.signed_price_verdict is
  'gh-1314: price-verify.ts PriceEvaluation.state — reconciled | mismatch | unverified.';
comment on column public.claims.signed_price_reason is
  'gh-1314: PriceEvaluation.reason when verdict = unverified. Full UnverifiedReason union, five values.';
comment on column public.claims.signed_price_checked_at is
  'gh-1314: when docusign-webhook last evaluated the signed price for this claim.';

commit;

-- ===================== WHAT IT BUYS (read-only) ==================
-- The statement this issue has never been able to make honestly:
--   select signed_price_verdict, signed_price_reason, count(*)
--   from public.claims where contract_signed_at is not null
--   group by 1,2 order by 1,2;
-- Today that query cannot be written at all.
