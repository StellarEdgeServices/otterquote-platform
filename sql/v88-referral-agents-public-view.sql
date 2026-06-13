-- ============================================================================
-- Migration v88 — referral_agents public-safe view + policy tightening
-- Created: 2026-06-13
-- ============================================================================
-- Problem:
--   "Public can read active agents" policy (v7) has USING(status='active')
--   with no TO clause — applies to EVERY role including anon. All columns
--   are readable, including email, phone, w9_file_url, payments_blocked,
--   total_commission_earned, total_commission_paid, metadata, user_id,
--   recruit_earnings. Two live rows exist; 0 have w9_file_url populated, but
--   the exposure window exists for all future rows.
--
-- Read-site map (grep referral_agents across all JS/TS/HTML/PY):
--
--   ANON / public (referral landing / signup) — needs view:
--     ref.html:152              select id,agent_type,first_name,last_name,company,photo_url,status by unique_code
--     ref-inspector.html:750    select * by unique_code+agent_type (uses first_name,last_name,photo_url,status)
--     ref-insurance.html:717    select * by referral_code (uses first_name,company; referral_code col mismatch — pre-existing bug)
--     ref-re.html:658           select * by unique_code (uses first_name,last_name,photo_url)
--     recruit.html:173          select agent_type,status by recruit_code
--     partner-inspectors.html:943  select id,first_name,last_name,company by recruit_code
--     trade-selector.html:1285,1297  select id by unique_code / by id
--     react-app/app/trade-selector/page.tsx:67,79  select id by unique_code / by id
--     inspector-landing.html:762  select * by unique_code (public personalization)
--
--   AUTHENTICATED / own-record — covered by existing owner policy:
--     partner-dashboard.html:1034,1042,1051,1221  select * WHERE user_id = auth.uid()
--     partner-dashboard.html:1340  select * WHERE recruited_by_id = currentPartner.id (recruits)
--     refer-a-friend.html:938  select code,payments_blocked,... WHERE user_id = auth.uid()
--     js/auth.js:465  UPDATE (claim) — covered by v16 claim-unclaimed policy
--
--   ADMIN — needs full column access:
--     admin-referrals.html:434  select id,first_name,last_name,email,agent_type,created_at,
--                                       payments_blocked,w9_file_url,w9_*,w9_notification_sent_at
--
--   EDGE FUNCTIONS (service_role — bypass RLS):
--     supabase/functions/approve-payout/index.ts:284
--     supabase/functions/notify-partner-w9/index.ts:197
--     supabase/functions/submit-partner-w9/index.ts:112,188
--
-- Decision:
--   1. Create referral_agents_public view — safe columns only, status='active' filter.
--      In Supabase, views run as their owner (postgres) and bypass RLS. Anon callers
--      access the view via GRANT; base-table access remains policy-controlled.
--   2. Add admin SELECT policy (admin-referrals.html needs full base-table columns).
--   3. Add recruit-read SELECT policy (partner-dashboard.html reads recruits by
--      recruited_by_id — not covered by the owner ALL policy which only matches
--      user_id = auth.uid()).
--   4. Drop "Public can read active agents" from the base table.
--      Anon/public reads continue to work through the view (step 1).
--
-- Excluded from view (never expose to anon):
--   email, phone, user_id, w9_file_url, w9_submitted_at, w9_verified_at,
--   w9_notification_sent_at, payments_blocked, total_commission_earned,
--   total_commission_paid, total_referrals, recruit_earnings, recruited_by_id,
--   recruited_at, metadata, referred_by_note, onboarded_at, created_at
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Public-safe view
-- ============================================================================
CREATE OR REPLACE VIEW public.referral_agents_public AS
SELECT
  id,
  first_name,
  last_name,
  company,        -- display name; not an email or address
  photo_url,
  bio,
  website,
  service_area,
  agent_type,
  status,
  unique_code,    -- public URL key (in every referral link already)
  recruit_code    -- public URL key (in every recruit link already)
FROM public.referral_agents
WHERE status = 'active';

COMMENT ON VIEW public.referral_agents_public IS
'Public-safe projection of referral_agents. Exposes only display and lookup '
'columns for active agents. Never exposes email, phone, w9_file_url, '
'payments_blocked, commission totals, or any financial/compliance fields. '
'Runs as postgres (view owner) so it bypasses base-table RLS — the WHERE '
'clause is the sole row filter. Added by v88 migration (2026-06-13).';

-- Grant to anon (referral landing pages) and authenticated (trade-selector in
-- authenticated flows). Admin and service_role can query the base table.
GRANT SELECT ON public.referral_agents_public TO anon;
GRANT SELECT ON public.referral_agents_public TO authenticated;


-- ============================================================================
-- 2. Admin SELECT policy on the base table
--    admin-referrals.html reads ALL columns (w9_file_url, email, etc.) and
--    needs base-table access. Without this, dropping the public policy below
--    would break the admin dashboard.
-- ============================================================================
CREATE POLICY "Admin can read all referral agents"
  ON public.referral_agents
  FOR SELECT
  TO authenticated
  USING (auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com');


-- ============================================================================
-- 3. Recruit-read SELECT policy
--    partner-dashboard.html:1340 reads agents WHERE recruited_by_id = own_id.
--    The existing "Agents can manage own profile" policy (v7) only allows
--    user_id = auth.uid(). Recruits are OTHER rows — not covered.
--    This policy adds that access without opening everything.
--
--    The subquery references the same table (referral_agents) which could
--    trigger RLS recursion. We use a SECURITY DEFINER helper function (same
--    pattern as v21-fix-rls-recursion.sql) to break the cycle.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_own_referral_agent_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT id FROM public.referral_agents WHERE user_id = auth.uid() LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_own_referral_agent_id() IS
'Helper for the "Partners can read their recruits" RLS policy. Returns the '
'referral_agents.id for the currently authenticated user without triggering '
'RLS recursion. SECURITY DEFINER so it runs as postgres. Added v88.';

CREATE POLICY "Partners can read their recruits"
  ON public.referral_agents
  FOR SELECT
  TO authenticated
  USING (recruited_by_id = public.get_own_referral_agent_id());


-- ============================================================================
-- 4. Drop the broad public SELECT policy
--    Anon reads now go through referral_agents_public view (step 1).
--    Admin reads are covered by step 2.
--    Owner reads remain on the existing "Agents can manage own profile" policy.
--    Recruit reads are covered by step 3.
-- ============================================================================
DROP POLICY IF EXISTS "Public can read active agents" ON public.referral_agents;

COMMIT;
