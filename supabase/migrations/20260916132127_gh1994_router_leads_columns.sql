-- gh-1994: front-door router page (phase 1) -- additive `leads` columns,
-- an admin-only SELECT policy, a BEFORE INSERT guard trigger, and three
-- SECURITY DEFINER RPCs. Requested-by exec:cro (Sloane, CRO RUN 24, claim
-- cro-2026-09-16T11:19:36Z); filed as issue #1994; Dustin's verbatim
-- 2026-09-16 spec is quoted in full on the issue body.
--
-- FIX ROUND 1 (PR #1997, CEO RUN 48, claim ceo-2026-09-16T13:09:26Z) --
-- rewritten after REVIEW: FAIL (comment 5698829220) and LEGAL-READ: FAIL
-- (comment 5698634115), per Ben's ruling (comment 5698874513, items 2-6).
-- This version is IDEMPOTENT and matches what is already live in
-- production, applied directly by Ben as an R-134 protective fix ahead of
-- this file (ruling comment, same thread):
--   - The 11 nullable columns from the original version of this file are
--     APPLIED (re-verified live below).
--   - `DROP POLICY "Allow authenticated reads"` /
--     `CREATE POLICY "leads_admin_select" ... USING (public.is_admin_email())`
--     are APPLIED (a signed-in contractor/partner/homeowner account could
--     otherwise read every router lead's name, email and phone -- both
--     refuters found this independently: REVIEW B3, LEGAL-READ B2).
--   - The two original RPCs, the CHECK/FK constraints, the new
--     `prefill_used_at` column, the BEFORE INSERT trigger, and the new
--     `update_lead_contact` RPC below are NOT yet applied -- that is what
--     this file adds. NOT APPLIED BY THIS PR; a claim-holder applies it
--     after re-review (Ben's ruling: "I apply it after re-review").
--
-- Schema/policy re-verified LIVE (production yeszghaspzwwstvsrioa),
-- 2026-09-16, before drafting this version:
--   SELECT column_name FROM information_schema.columns WHERE
--     table_schema='public' AND table_name='leads' ORDER BY ordinal_position;
--   -> id, email, name, zip, source, created_at, phone, role,
--      partner_industry, utm_source, utm_medium, utm_campaign, utm_content,
--      utm_term, fbclid, gclid, converted_user_id (17 columns -- the
--      original 6 plus this migration's 11, no `prefill_used_at` yet).
--   SELECT policyname, cmd, roles, qual, with_check FROM pg_policies WHERE
--     schemaname='public' AND tablename='leads';
--   -> "Allow anonymous inserts" (INSERT, {anon}, with_check=true) and
--      "leads_admin_select" (SELECT, {authenticated}, qual=is_admin_email()).
--      "Allow authenticated reads" is gone. No anon UPDATE/SELECT policy
--      exists -- hence the RPCs below rather than a direct client
--      UPDATE/SELECT.
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid) FROM
--     pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE
--     n.nspname='public' AND p.proname='is_admin_email';
--   -> is_admin_email() -- confirmed zero-argument, matching the call
--      below and Ben's ruling's exact statement text.
--
-- Insert path (unchanged by this migration): Step 1's direct
-- `sb.from('leads').insert(...)` reuses the existing "Allow anonymous
-- inserts" policy (anon INSERT, with_check=true) already exercised today by
-- partner-re.html and react-app/app/get-started/page.tsx:795. This
-- migration adds no new INSERT policy and no insert RPC -- the BEFORE
-- INSERT trigger below narrows what an anon insert can put in certain
-- columns, but the INSERT path itself (and its RLS policy) is untouched.
--
-- Statements below are written to be safe to run more than once (repo
-- convention: `IF NOT EXISTS` / `DROP ... IF EXISTS` / a guarding `DO`
-- block for anything Postgres has no bare `IF NOT EXISTS` clause for --
-- ADD CONSTRAINT, CREATE POLICY, CREATE TRIGGER).

BEGIN;

-- 1. Columns -------------------------------------------------------------
-- ADD COLUMN IF NOT EXISTS is itself idempotent; re-running this against
-- production (where the first 11 are already applied) is a no-op for them
-- and adds only prefill_used_at.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS phone              text,
  ADD COLUMN IF NOT EXISTS role               text,
  ADD COLUMN IF NOT EXISTS partner_industry   text,
  ADD COLUMN IF NOT EXISTS utm_source         text,
  ADD COLUMN IF NOT EXISTS utm_medium         text,
  ADD COLUMN IF NOT EXISTS utm_campaign       text,
  ADD COLUMN IF NOT EXISTS utm_content        text,
  ADD COLUMN IF NOT EXISTS utm_term           text,
  ADD COLUMN IF NOT EXISTS fbclid             text,
  ADD COLUMN IF NOT EXISTS gclid              text,
  ADD COLUMN IF NOT EXISTS converted_user_id  uuid,
  ADD COLUMN IF NOT EXISTS prefill_used_at    timestamptz;

-- 2. Admin-only SELECT (REVIEW B3 / LEGAL-READ B2) ---------------------------
-- Already applied live by Ben's R-134 protective fix; guarded here so this
-- file matches production AND is safe against a fresh/staging database that
-- never got the manual patch. DROP-then-CREATE (not "CREATE POLICY IF NOT
-- EXISTS", which Postgres has no syntax for) is this repo's own convention
-- for a widened/replaced policy -- see the migration-author-code precedent
-- and the ratchet's own module docstring ("this repo never uses ALTER
-- POLICY to change a predicate in place").
DROP POLICY IF EXISTS "Allow authenticated reads" ON public.leads;
DROP POLICY IF EXISTS "leads_admin_select" ON public.leads;
CREATE POLICY "leads_admin_select" ON public.leads
  FOR SELECT TO authenticated
  USING (public.is_admin_email());

COMMENT ON POLICY "leads_admin_select" ON public.leads IS
  'gh-1994 fix round 1: replaces "Allow authenticated reads" (qual=true), which let any signed-in account read every lead''s name/email/phone. Applied live ahead of this file (Ben''s R-134 protective fix, PR #1997 ruling comment 5698874513) -- restated here so the migration history matches production.';

-- 3. CHECK / FK constraints, guarded (repo has no bare
-- "ADD CONSTRAINT IF NOT EXISTS"; a DO block checking pg_constraint is the
-- standard Postgres idiom for this and is what makes this file re-runnable,
-- per REVIEW finding 10). --------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.leads'::regclass AND conname = 'leads_role_check'
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_role_check
        CHECK (role IS NULL OR role IN ('homeowner', 'contractor', 'referral_partner'));
  END IF;
END $$;

-- partner_industry values mirror the five CHOOSER_LABELS keys in
-- js/agent-types.js (gh-914 single source for the partner-page industry
-- set), which itself is drawn from the six-value
-- referral_agents_agent_type_check CHECK constraint
-- (supabase/migrations/20260101000000_v000_baseline_schema.sql) minus
-- 'customer' -- a router visitor who answers "Referral partner" at Step 2
-- always reaches Step 2a and picks one of the five partner industries.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.leads'::regclass AND conname = 'leads_partner_industry_check'
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_partner_industry_check
        CHECK (partner_industry IS NULL OR partner_industry IN
          ('re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other'));
  END IF;
END $$;

-- Same FK pattern as claims.user_id / contractors.user_id
-- (supabase/migrations/20260101000000_v000_baseline_schema.sql:3819,3826).
-- ON DELETE SET NULL, not CASCADE: a lead is marketing/attribution history
-- and should survive the account it converted to being deleted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.leads'::regclass AND conname = 'leads_converted_user_id_fkey'
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_converted_user_id_fkey
        FOREIGN KEY (converted_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.leads.phone IS
  'gh-1994: router Step 1, required 10-digit US number (NANP-shaped: area/exchange codes 2-9, not all-same-digit), validated client-side only (no server-side format CHECK in phase 1).';
COMMENT ON COLUMN public.leads.role IS
  'gh-1994: router Step 2 answer (homeowner/contractor/referral_partner). Forced NULL on INSERT by trg_leads_force_safe_insert_defaults; set post-insert only via set_lead_role().';
COMMENT ON COLUMN public.leads.partner_industry IS
  'gh-1994: router Step 2a answer, set only when role=referral_partner. Forced NULL on INSERT; set via set_lead_role(), same call as role.';
COMMENT ON COLUMN public.leads.utm_source IS
  'gh-1994: captured from the router landing URL, with the oq_ft cookie (gh-1983, js cookie name FT_COOKIE) as fallback, at the Step 1 insert.';
COMMENT ON COLUMN public.leads.fbclid IS
  'gh-1994: see utm_source comment. No length cap enforced at the DB layer in phase 1 (client truncates before insert, mirroring attribution-core.ts CLICK_ID_MAX=1000).';
COMMENT ON COLUMN public.leads.converted_user_id IS
  'gh-1994: reserved for a future backfill linking this lead to the auth.users row it became, if any. Forced NULL on INSERT by trg_leads_force_safe_insert_defaults; not written anywhere in phase 1.';
COMMENT ON COLUMN public.leads.prefill_used_at IS
  'gh-1994 fix round 1: stamped by get_lead_prefill() the first (and only) time a caller successfully redeems ?lead=<uuid> for prefill. A second call after this is set returns zero rows -- single-use, independent of the 30-minute window.';

-- 4. BEFORE INSERT guard trigger (REVIEW finding 5) --------------------------
-- The anon INSERT policy is `with_check = true` with table-level INSERT
-- privilege, so without this trigger a direct anon insert could set
-- `converted_user_id` (a forged attribution link and an FK-existence
-- oracle), `role`/`partner_industry` (bypassing set_lead_role's validation),
-- or a future `created_at` (defeating every RPC's time window). This
-- trigger forces all four to safe values on every insert, regardless of
-- what the client sends. It does not run on UPDATE, so set_lead_role's and
-- update_lead_contact's own UPDATEs are unaffected.
CREATE OR REPLACE FUNCTION public.leads_force_safe_insert_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.created_at        := now();
  NEW.converted_user_id := NULL;
  NEW.role              := NULL;
  NEW.partner_industry  := NULL;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.leads_force_safe_insert_defaults() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.leads_force_safe_insert_defaults() IS
  'gh-1994 fix round 1: BEFORE INSERT guard on public.leads -- forces created_at=now() and nulls converted_user_id/role/partner_industry so an anon insert (with_check=true) cannot forge them. SECURITY DEFINER only so the function itself cannot be re-pointed by a non-owner; it grants no privilege an ordinary trigger would lack.';

DROP TRIGGER IF EXISTS trg_leads_force_safe_insert_defaults ON public.leads;

CREATE TRIGGER trg_leads_force_safe_insert_defaults
  BEFORE INSERT ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.leads_force_safe_insert_defaults();

COMMENT ON TRIGGER trg_leads_force_safe_insert_defaults ON public.leads IS
  'gh-1994 fix round 1: see public.leads_force_safe_insert_defaults() for what it forces and why.';

-- 5. Prefill RPC -- single-use, 30-minute window (fix round 1) --------------
-- Returns name/email/phone for a lead row created within the last 30
-- minutes (shrunk from 60 -- Ben's ruling item 3) that has never been
-- redeemed before, keyed by the opaque lead id only -- so the router's Step
-- 3 redirect can pass `?lead=<uuid>` instead of email/phone/name in the
-- query string (#1931: GA4, Clarity and the Meta pixel all record full
-- URLs). Rewritten from the original LANGUAGE sql STABLE version to plpgsql
-- VOLATILE because it now performs a write (stamping prefill_used_at) as
-- part of the read -- REVIEW non-blocking 4 / Ben's ruling item 3
-- ("one-time use... stamps prefill_used_at and returns nothing once it is
-- set"). The UPDATE ... RETURNING shape makes the check-and-stamp atomic:
-- two concurrent callers holding the same uuid cannot both get a row back,
-- because the second UPDATE's WHERE clause (prefill_used_at IS NULL) no
-- longer matches once the first has committed its stamp.
-- SECURITY DEFINER because leads has no anon SELECT/UPDATE policy (only
-- "leads_admin_select" above, admin-only), and the destination pages
-- (contractor-join.html, partner-re/insurance/inspectors/adjusters/
-- other.html) run fully anonymous at this point in the funnel.
CREATE OR REPLACE FUNCTION public.get_lead_prefill(p_lead_id uuid)
RETURNS TABLE(name text, email text, phone text)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.leads l
     SET prefill_used_at = now()
   WHERE l.id = p_lead_id
     AND l.created_at > now() - interval '30 minutes'
     AND l.prefill_used_at IS NULL
  RETURNING l.name, l.email, l.phone;
END;
$$;

-- Project default privileges grant EXECUTE on new public functions to anon
-- and authenticated explicitly (see gh-1983's gh1983_attr_clean() comment,
-- same migration), so REVOKE ... FROM PUBLIC alone would not remove it.
REVOKE ALL ON FUNCTION public.get_lead_prefill(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_lead_prefill(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.get_lead_prefill(uuid) IS
  'gh-1994 fix round 1: SECURITY DEFINER, single-use prefill lookup for the router''s ?lead=<uuid> redirect. Stamps prefill_used_at atomically via UPDATE...RETURNING and returns zero rows on a second call, past the 30-minute window, or for any id that never matched -- callers must treat an empty result as "no prefill available", never as an error.';

-- 6. Role/industry RPC -- UNCHANGED from the original version of this file
-- (Ben's ruling item: "set_lead_role stays") -------------------------------
-- Sets role (and partner_industry, for referral_partner only) on a lead row
-- created within the last 60 minutes. Mirrors the register_partner() /
-- record_first_touch_attribution() precedent already in this repo: a
-- SECURITY DEFINER RPC is how this codebase lets an anonymous client write a
-- column no anon RLS policy exposes directly, rather than widening leads'
-- RLS or table grants.
CREATE OR REPLACE FUNCTION public.set_lead_role(
  p_lead_id uuid,
  p_role text,
  p_partner_industry text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_role NOT IN ('homeowner', 'contractor', 'referral_partner') THEN
    RAISE EXCEPTION 'set_lead_role: invalid role %', p_role;
  END IF;

  IF p_role = 'referral_partner' AND p_partner_industry IS NOT NULL
     AND p_partner_industry NOT IN
       ('re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other') THEN
    RAISE EXCEPTION 'set_lead_role: invalid partner_industry %', p_partner_industry;
  END IF;

  UPDATE public.leads
     SET role             = p_role,
         partner_industry = CASE WHEN p_role = 'referral_partner' THEN p_partner_industry ELSE NULL END
   WHERE id = p_lead_id
     AND created_at > now() - interval '60 minutes';
END;
$$;

REVOKE ALL ON FUNCTION public.set_lead_role(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_lead_role(uuid, text, text) TO anon, authenticated;

COMMENT ON FUNCTION public.set_lead_role(uuid, text, text) IS
  'gh-1994: SECURITY DEFINER role/industry write for the router''s Step 2/2a, called by an anon client (leads has no anon UPDATE policy). Silently no-ops (0 rows updated, no error) past the 60-minute window or for an id that never matched -- callers must not depend on an error to detect that case. Unchanged in fix round 1 per Ben''s ruling.';

-- 7. Contact-update RPC -- new in fix round 1 (Ben's ruling item 7: "A
-- resubmit after going back updates the existing lead through the RPC
-- instead of inserting a duplicate.") ---------------------------------------
-- The anon INSERT policy has no matching anon UPDATE policy, so a plain
-- second `sb.from('leads').insert({id: <same uuid>, ...})` would hit the
-- primary key and error, not update -- an RPC is the only anon-safe path to
-- an update, exactly like set_lead_role above. Restricted to the same
-- 30-minute window as the (tightened) prefill RPC, not set_lead_role's
-- 60-minute one: a resubmit is closer in nature to "is this still the same
-- live funnel visit" than to a role click, and reusing the tighter window
-- keeps a stale/shared leadId from being replayed to overwrite a lead's
-- contact info long after the visit ended. Revalidates phone shape
-- server-side (mirrors start.html's isValidUsPhone: exactly 10 digits,
-- area/exchange codes 2-9, not all one repeated digit) so a resubmit can't
-- be used to plant an invalid phone the client-side check would have
-- blocked on a fresh insert.
CREATE OR REPLACE FUNCTION public.update_lead_contact(
  p_lead_id uuid,
  p_name text,
  p_email text,
  p_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'update_lead_contact: name required';
  END IF;
  IF p_email IS NULL OR p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'update_lead_contact: invalid email';
  END IF;
  IF p_phone IS NULL
     OR p_phone !~ '^[2-9]\d{2}[2-9]\d{6}$'
     OR p_phone ~ '^(\d)\1{9}$' THEN
    RAISE EXCEPTION 'update_lead_contact: invalid phone';
  END IF;

  UPDATE public.leads
     SET name  = p_name,
         email = p_email,
         phone = p_phone
   WHERE id = p_lead_id
     AND created_at > now() - interval '30 minutes';
END;
$$;

REVOKE ALL ON FUNCTION public.update_lead_contact(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_lead_contact(uuid, text, text, text) TO anon, authenticated;

COMMENT ON FUNCTION public.update_lead_contact(uuid, text, text, text) IS
  'gh-1994 fix round 1: SECURITY DEFINER contact-info update for a Step 1 resubmit (browser back to Step 1, then Continue again) -- updates the existing row instead of start.html inserting a duplicate. Silently no-ops (0 rows updated, no error) past the 30-minute window or for an id that never matched, same convention as set_lead_role/get_lead_prefill.';

COMMIT;

-- ============================================================================
-- PERMISSIONS-RATCHET NOTE (Ben's ruling item 5; #1987 precedent)
-- ============================================================================
-- scripts/permissions-ratchet.py's rules 1 and 2 fire on every GRANT EXECUTE
-- ... TO anon, authenticated above (four functions x rule 1's
-- grant-to-disallowed-role, plus rule 2's security-definer-plus-broad-grant
-- for each SECURITY DEFINER function paired with those grants) -- this is
-- inherent to the design, not an oversight: get_lead_prefill, set_lead_role
-- and update_lead_contact all MUST be callable by an anonymous visitor, the
-- same as this repo's existing register_partner()/check-email-exists
-- pattern. PR #1987 (gh-1983) hit the identical rule 2 shape for its own
-- authenticated-only SECURITY DEFINER RPC and shipped by carrying the
-- `permissions-ratchet: reviewed` label rather than by removing the grant --
-- this PR does the same, applied by Ben per this ruling (comment
-- 5698874513, item 5), which stands as the human review the ratchet's
-- bypass exists for. The ratchet still prints every finding as BYPASSED,
-- not silently. Label applied to PR #1997 as part of this fix round; this
-- comment-only touch exists solely to re-trigger CI against the now-labeled
-- PR (the ratchet workflow reads PR labels at run time, not at push time,
-- so a label added after the last push does not re-evaluate an existing
-- check run on its own).

-- ROLLBACK (manual -- this migration is not applied, and phase 1 was not
-- granted a separate supabase/migrations_rollbacks/ file; inline per the
-- lighter convention already used by
-- supabase/migrations/20260914195746_gh1932_notify_admin_new_homeowner_triggers.sql).
-- This rolls back ONLY what THIS FILE applies -- it deliberately does NOT
-- touch the columns or the leads_admin_select policy Ben already applied
-- live ahead of this file; rolling those back is a separate decision with
-- its own negative control (see the ruling comment's own rollback line for
-- the policy swap).
--
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.update_lead_contact(uuid, text, text, text);
-- DROP FUNCTION IF EXISTS public.set_lead_role(uuid, text, text);
-- DROP FUNCTION IF EXISTS public.get_lead_prefill(uuid);
-- DROP TRIGGER IF EXISTS trg_leads_force_safe_insert_defaults ON public.leads;
-- DROP FUNCTION IF EXISTS public.leads_force_safe_insert_defaults();
-- ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_converted_user_id_fkey;
-- ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_partner_industry_check;
-- ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_role_check;
-- ALTER TABLE public.leads DROP COLUMN IF EXISTS prefill_used_at;
-- COMMIT;
