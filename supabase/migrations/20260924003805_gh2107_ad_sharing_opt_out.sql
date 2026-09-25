-- gh-2107 (D-330 half 2, server-side Meta CAPI Purchase): a stored advertising-sharing opt-out on the person record.
-- Authorised by Dustin's ruling "b." on the Section 12 opt-out gap (#2078 comment 5801822166; Ben, CEO RUN 66, claim
-- ceo-2026-09-23T18:56:07Z), scope item 1: "A nullable/boolean ad_sharing_opt_out on the person record. This is an additive
-- migration, Tier 3A." Handed to Kevin by SLOT OPEN: #2107 (#2078 comment 5805243903). Tier 3A under D-261, no R-097 window.
--
-- WHAT. Three nullable columns on public.profiles, the row the Purchase belongs to (claims.user_id -> profiles.id; the
-- Stripe webhook already resolves the buyer's email through this row):
--   ad_sharing_opt_out         boolean      NULL = never recorded; TRUE = the person opted out of advertising sharing.
--   ad_sharing_opt_out_at      timestamptz  when the opt-out was first recorded.
--   ad_sharing_opt_out_source  text         how: gpc_header (Sec-GPC: 1 on the request), gpc_client
--                                           (navigator.globalPrivacyControl read by the page) or support_email (an admin
--                                           recorded a request made by email to support@otterquote.com).
-- The two audit columns go beyond the ruling's single column. They are additive, nullable and cost nothing, and they are
-- the evidence of WHEN and HOW an opt-out was honoured, which (the D-299 lesson) cannot be added retroactively. Drop them
-- from this file if Ben wants the single column only.
--
-- WHAT THIS DOES NOT DO. No code reads or writes the columns yet; the writers and the CAPI check ship in their own PRs,
-- after this is applied. Nothing is dropped, renamed, retyped or rewritten. Existing rows read NULL, so behaviour is
-- unchanged until a writer sets a flag. RLS is untouched: profiles_user_update already lets a signed-in user update their
-- own row, so a person can see and change their own flag; the flag only ever REDUCES sharing when true.
--
-- LOCKING. ADD COLUMN with no default is a catalog-only change. The CHECK is added on a column that is NULL in every row,
-- so its validation scan passes trivially. Apply with SET lock_timeout to fail fast rather than queue behind a long
-- transaction.
--
-- Companion rollback: supabase/migrations_rollbacks/20260924003805_gh2107_ad_sharing_opt_out_rollback.sql

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ad_sharing_opt_out boolean,
  ADD COLUMN IF NOT EXISTS ad_sharing_opt_out_at timestamptz,
  ADD COLUMN IF NOT EXISTS ad_sharing_opt_out_source text;

DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.profiles'::regclass
       AND conname = 'profiles_ad_sharing_opt_out_source_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_ad_sharing_opt_out_source_check
      CHECK (ad_sharing_opt_out_source IS NULL
             OR ad_sharing_opt_out_source IN ('gpc_header', 'gpc_client', 'support_email'));
  END IF;
END
$mig$;

COMMENT ON COLUMN public.profiles.ad_sharing_opt_out IS
  'gh-2107 / D-330: TRUE = this person opted out of advertising sharing (privacy policy Section 12). NULL = never recorded. The server-side Meta CAPI Purchase send is skipped when TRUE. Only ever set to TRUE by the writers (GPC header or client signal, or an admin recording a support email); clearing it is the person''s own choice.';
COMMENT ON COLUMN public.profiles.ad_sharing_opt_out_at IS
  'gh-2107: when ad_sharing_opt_out was first recorded as TRUE.';
COMMENT ON COLUMN public.profiles.ad_sharing_opt_out_source IS
  'gh-2107: how the opt-out was recorded: gpc_header, gpc_client or support_email.';

COMMIT;

-- =============================================================================
-- ROLLBACK lives in supabase/migrations_rollbacks/ (NOT here: a file in this directory would be applied by the Supabase
-- runner as a migration).
-- =============================================================================
