-- gh-1529 [SECURITY, tier:3b]: anon can EXECUTE 29 SECURITY DEFINER functions
-- (Supabase advisor `anon_security_definer_function_executable`, live count
-- re-verified 2026-09-04 = 29, zero drift vs the issue's 2026-09-02 reading;
-- names match the issue body verbatim). tier:3b-approved applied by the CTO
-- 2026-09-04T13:11:17Z after the R-097 24h notice window closed with no
-- objection (issue #1529 comment history).
--
-- Caller enumeration was run twice: once by a CTO subagent pre-approval
-- (comment 5532863615, full table committed to
-- `In Flight/reports/gh1529-step1-caller-table-cto-2026-09-03T122920Z.md`),
-- and independently re-run in this dispatch (live Supabase SELECTs against
-- pg_proc/pg_trigger/pg_event_trigger/pg_policies + repo grep on this
-- worktree's HEAD == origin/main 9f567ba). Both enumerations agree except
-- for one function (contractor_can_bid, see below) where this PR is more
-- conservative than the prior report.
--
-- 23 of the 29 functions are revoked here because no anon (or, for 15 of
-- them, no caller of ANY kind) was found:
--
--   15 trigger / event-trigger functions -- fire under trigger machinery,
--   never invoked via `.rpc()` by anyone, so a direct EXECUTE grant to
--   anon/PUBLIC serves no purpose:
--     apply_referral_commission, enforce_bid_can_submit,
--     enforce_bid_window_expiry, handle_new_user, log_bid_submitted,
--     notify_admin_new_contractor, notify_feature_request_webhook,
--     notify_hover_rebate, notify_partner_status_on_bid_submitted,
--     referral_agents_guard_payout_columns, reverse_referral_commission,
--     rls_auto_enable (DDL event trigger `ensure_rls`), set_bid_window_on_first_bid,
--     sync_contractor_cert_status, sync_contractor_profile_role.
--
--   8 non-trigger functions whose only real callers (if any) are
--   authenticated, or which have zero callers anywhere in the repo:
--     bid_can_submit (contractor-bid-form.html:4081,4763 +
--       bid-form.tsx:292, all behind Auth.requireAuth('contractor')),
--     contractor_has_required_docs (admin-contractors.html:1396 /
--       admin/contractors/page.tsx:281, admin surface, authenticated),
--     get_contractor_last_logins (admin-incomplete-profiles.html:690,
--       admin surface, authenticated; also has an internal
--       auth.email() admin hardcode as a second layer),
--     get_own_referral_agent_id (RLS-internal only; the ONE policy that
--       calls it -- "Partners can read their recruits" on
--       referral_agents -- has roles={authenticated}, confirmed live via
--       pg_policies, so anon never reaches this qual),
--     get_platform_fee_percentage (zero callers of any kind: no .rpc()
--       hit, no RLS policy reference, confirmed by grep + pg_policies scan),
--     record_attestation_ip (contractor-settings.html:2972,
--       contractor/settings/page.tsx:338, js/auth.js:984 post-signup --
--       all authenticated / post-session),
--     record_cpa_ip (contractor-dashboard.html:1179,
--       contractor/dashboard/page.tsx:391, behind requireAuth('contractor')),
--     record_partner_agreement_reacceptance (zero callers of any kind;
--       original migration 20260820004212_gh1059 granted `authenticated`
--       only -- current PUBLIC/anon grant is drift from that intent).
--
-- 6 of the 29 are deliberately LEFT ALONE, anon EXECUTE untouched:
--
--   5 intentional public/pre-auth RPCs (KEEP -- anon access is the design,
--   not a bug):
--     get_contractor_licenses_public (bids.html:668 / use-bids-data.ts:192
--       -- public license-lookup, name+grant pattern both say "public"),
--     get_contractors_public (contractor-about.html, bids.html,
--       project-confirmation.html, repair-intake.html + react-app
--       equivalents -- public contractor-directory RPC),
--     get_referral_agents_public (ref*.html, partner-*.html, recruit.html
--       -- pre-auth referral/partner landing pages, no auth gate found
--       before the call on those pages; also called from
--       trade-selector.html and partner-profile.html, which ARE
--       authenticated, but the pre-auth callers govern the grant),
--     register_partner (partner-adjusters/inspectors/insurance/other/re.html
--       -- pre-auth partner signup form; those pages gate a "welcome back"
--       banner via Auth.hasPartnerSession(), not the registration call
--       itself, so anon reach is real and intended),
--     track_referral_click (ref-re/ref-insurance/ref-inspector/ref.html --
--       referral click attribution must fire before any session exists).
--
--   1 function reclassified MORE conservatively than the prior CTO report,
--   NOT revoked in this PR:
--     contractor_can_bid -- the prior report called this RLS-internal /
--       authenticated-only and proposed REVOKE-anon. Live pg_policies
--       shows the ONE policy that calls it -- "Contractors can insert
--       quotes" (INSERT on quotes) -- has roles={public}, i.e. it DOES
--       apply to the anon role, with
--       `with_check = (contractor_id IN (...auth.uid()...)) AND
--       contractor_can_bid(contractor_id)`. In practice an anon INSERT
--       attempt fails the auth.uid() half first, but Postgres does not
--       guarantee left-to-right short-circuit evaluation of AND operands
--       in a RLS qual, so revoking anon EXECUTE here risks turning a
--       clean RLS denial into a "permission denied for function
--       contractor_can_bid" error on the live bid-submission / quotes
--       INSERT path for any unauthenticated attempt -- a functional
--       change on a revenue path this dispatch is not authorized to risk.
--       Treated as classification (C) (cannot fully rule out) per this
--       dispatch's instruction to treat (C) as (B) -- left alone. Flagged
--       as a fast-follow: either move the RLS policy to
--       roles={authenticated} (matching its actual intended callers) or
--       confirm short-circuit behavior in a branch test, then revoke.
--
-- OUT OF SCOPE (explicitly, per this dispatch): the 36
-- `authenticated_security_definer_function_executable` advisor findings and
-- the 1 `extension_in_public` (pg_net) finding on the same issue are NOT
-- touched here. A wrong authenticated-grant revoke on any of the 23
-- functions above is not possible from this file (only PUBLIC and anon are
-- referenced) -- explicit `authenticated` grants are left exactly as they
-- are today.
--
-- PUBLIC is revoked alongside anon wherever the live proacl carries a
-- PUBLIC grant (`=X/postgres` with no role name), because `GRANT ... TO
-- PUBLIC` gives EXECUTE to every role including anon regardless of any
-- anon-specific REVOKE -- revoking anon alone would not close the exposure
-- on those functions. Revoking PUBLIC does not touch authenticated's own
-- separate, explicit grant entry (confirmed live: every one of these 23
-- functions carries authenticated=X/postgres as its own ACL entry,
-- independent of the PUBLIC entry).
--
-- MIGRATION NOT APPLIED. SECURITY / tier:3b -- not merged on lane
-- authority. Rollback: same-named _rollback.sql in this directory,
-- restoring the exact live proacl captured before this revoke.

BEGIN;

-- Trigger / event-trigger functions (15) -- PUBLIC + anon revoked; no
-- legitimate caller of any kind, so no authenticated carve-out needed here
-- either, but authenticated's explicit grant is intentionally left in
-- place (out of scope, see header).
REVOKE EXECUTE ON FUNCTION public.apply_referral_commission() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.apply_referral_commission() FROM anon;

REVOKE EXECUTE ON FUNCTION public.enforce_bid_can_submit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_bid_can_submit() FROM anon;

REVOKE EXECUTE ON FUNCTION public.enforce_bid_window_expiry() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_bid_window_expiry() FROM anon;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;

REVOKE EXECUTE ON FUNCTION public.log_bid_submitted() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_bid_submitted() FROM anon;

REVOKE EXECUTE ON FUNCTION public.notify_admin_new_contractor() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_admin_new_contractor() FROM anon;

REVOKE EXECUTE ON FUNCTION public.notify_feature_request_webhook() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_feature_request_webhook() FROM anon;

REVOKE EXECUTE ON FUNCTION public.notify_hover_rebate() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_hover_rebate() FROM anon;

REVOKE EXECUTE ON FUNCTION public.notify_partner_status_on_bid_submitted() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_partner_status_on_bid_submitted() FROM anon;

REVOKE EXECUTE ON FUNCTION public.referral_agents_guard_payout_columns() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.referral_agents_guard_payout_columns() FROM anon;

REVOKE EXECUTE ON FUNCTION public.reverse_referral_commission() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reverse_referral_commission() FROM anon;

REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;

REVOKE EXECUTE ON FUNCTION public.set_bid_window_on_first_bid() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_bid_window_on_first_bid() FROM anon;

REVOKE EXECUTE ON FUNCTION public.sync_contractor_cert_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_contractor_cert_status() FROM anon;

REVOKE EXECUTE ON FUNCTION public.sync_contractor_profile_role() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_contractor_profile_role() FROM anon;

-- Non-trigger functions (8) -- authenticated-only real callers, or zero
-- callers anywhere. authenticated's explicit grant is left in place
-- (out of scope, see header) except where noted.
REVOKE EXECUTE ON FUNCTION public.bid_can_submit(p_contractor_id uuid, p_trade text, p_funding_type text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bid_can_submit(p_contractor_id uuid, p_trade text, p_funding_type text) FROM anon;

REVOKE EXECUTE ON FUNCTION public.contractor_has_required_docs(p_contractor_id uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.contractor_has_required_docs(p_contractor_id uuid) FROM anon;

-- get_contractor_last_logins carries no PUBLIC grant in the live proacl
-- (anon and authenticated are separate explicit entries) -- anon only.
REVOKE EXECUTE ON FUNCTION public.get_contractor_last_logins() FROM anon;

REVOKE EXECUTE ON FUNCTION public.get_own_referral_agent_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_own_referral_agent_id() FROM anon;

REVOKE EXECUTE ON FUNCTION public.get_platform_fee_percentage() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_platform_fee_percentage() FROM anon;

REVOKE EXECUTE ON FUNCTION public.record_attestation_ip(p_contractor_id uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_attestation_ip(p_contractor_id uuid) FROM anon;

REVOKE EXECUTE ON FUNCTION public.record_cpa_ip(p_contractor_id uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_cpa_ip(p_contractor_id uuid) FROM anon;

REVOKE EXECUTE ON FUNCTION public.record_partner_agreement_reacceptance(p_referral_agent_id uuid, p_agreement_version text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_partner_agreement_reacceptance(p_referral_agent_id uuid, p_agreement_version text) FROM anon;

-- NOT touched in this PR (see header for full reasoning):
--   contractor_can_bid(uuid)                     -- (C)->(B), RLS with_check ambiguity, fast-follow
--   get_contractor_licenses_public(uuid[])        -- (B), intentional public RPC
--   get_contractors_public()                      -- (B), intentional public RPC
--   get_referral_agents_public()                  -- (B), intentional public RPC
--   register_partner(...)                         -- (B), pre-auth signup, anon access is the point
--   track_referral_click(text, text, text, text, text) -- (B), must fire pre-session

COMMIT;
