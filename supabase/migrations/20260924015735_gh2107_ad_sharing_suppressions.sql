-- gh-2107: a hashed-email suppression list for advertising-sharing opt-outs from people who have no account.
-- Authorised by Ben (CEO RUN 66, claim ceo-2026-09-23T18:56:07Z), DECIDED ruling c. on #2078, comment 5805593465:
-- "Opt-outs from people without an account go on a hashed-email suppression list. This is a small Tier 3A table plus a check in
-- the CAPI send, so Section 12's email promise holds for everyone." Tier 3A under D-261 (additive: one new table, nothing
-- dropped, renamed, retyped or rewritten), no R-097 window.
--
-- WHY. profiles.ad_sharing_opt_out (migration 20260924003805) records an opt-out only for a person who HAS a profile. Privacy
-- policy Section 12's opt-out is an email to support@otterquote.com, which anyone can send, account or not. A person who opts
-- out by email and creates an account, or buys, later would otherwise be sent to Meta. This table records the opt-out against
-- the SHA-256 of the lower-cased, trimmed address, the same digest the server-side CAPI Purchase already sends as `user_data.em`,
-- so the check is a lookup of a value that is already computed, and the table holds no readable address.
--
-- WHAT. public.ad_sharing_suppressions:
--   email_sha256  text PRIMARY KEY  lowercase 64-hex SHA-256 (CHECK), so a malformed or non-hash value cannot be stored.
--   source        text NOT NULL     how it was recorded (CHECK): support_email.
--   created_at    timestamptz NOT NULL DEFAULT now().
-- RLS is ON with NO policy, and every privilege is revoked from PUBLIC, anon and authenticated: only the service role (the
-- admin Edge Function and the Stripe webhook) can read or write it. Supabase's default privileges GRANT ALL on a new public
-- table to anon and authenticated, so the REVOKE is explicit (the #2126 lesson).
--
-- WHAT THIS DOES NOT DO. No code reads or writes the table yet; the writer (the admin support-email function) and the check (the
-- CAPI send) ship in their own PR, after this is applied. A row is never overwritten: the primary key makes a repeat an
-- ON CONFLICT DO NOTHING.
--
-- Companion rollback: supabase/migrations_rollbacks/20260924015735_gh2107_ad_sharing_suppressions_rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS public.ad_sharing_suppressions (
  email_sha256 text PRIMARY KEY,
  source       text NOT NULL DEFAULT 'support_email',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ad_sharing_suppressions_email_sha256_check CHECK (email_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ad_sharing_suppressions_source_check CHECK (source IN ('support_email'))
);

ALTER TABLE public.ad_sharing_suppressions ENABLE ROW LEVEL SECURITY;
-- No policy on purpose: with RLS on and no policy, anon and authenticated see and change nothing.

REVOKE ALL ON public.ad_sharing_suppressions FROM PUBLIC;
REVOKE ALL ON public.ad_sharing_suppressions FROM anon;
REVOKE ALL ON public.ad_sharing_suppressions FROM authenticated;
GRANT SELECT, INSERT ON public.ad_sharing_suppressions TO service_role;

COMMENT ON TABLE public.ad_sharing_suppressions IS
  'gh-2107 / D-330 (Ben ruling c. on #2078, 5805593465): SHA-256 (lowercase hex) of the lower-cased, trimmed email of a person who opted out of advertising sharing by emailing support@otterquote.com and who may have no profile. Checked by the server-side Meta CAPI Purchase send. Service role only; no readable address is stored.';

COMMIT;

-- =============================================================================
-- ROLLBACK lives in supabase/migrations_rollbacks/ (NOT here: a file in this directory would be applied by the Supabase
-- runner as a migration).
-- =============================================================================
