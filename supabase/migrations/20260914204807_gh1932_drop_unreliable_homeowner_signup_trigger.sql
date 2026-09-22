-- gh-1932 rework: drop the profiles-insert admin-alert trigger added by
-- 20260914195746_gh1932_notify_admin_new_homeowner_triggers.sql (applied to
-- prod as schema_migrations version 20260914200612). Refuter FAIL
-- (CEO42-REFUTE-1932-2026-09-14T20:39:54Z-SENTINEL, Check 7b) found it
-- false-positives on every contractor signup, not just homeowners.
--
-- ROOT CAUSE, confirmed by reading the real signup path (not guessed):
--   - js/auth.js `signUpWithPassword(email, password, role, redirectTo)`
--     calls `sb.auth.signUp({ email, password, options: { emailRedirectTo }})`
--     with NO `options.data` at all -- the `role` parameter only selects a
--     post-signup REDIRECT PAGE, it is never written to auth metadata.
--   - `public.handle_new_user()` (the AFTER INSERT ON auth.users trigger)
--     inserts profiles WITHOUT a role column at all:
--       INSERT INTO public.profiles (id, email, full_name, address_state,
--         created_at, updated_at) VALUES (...)
--   - `public.profiles.role` is `text NOT NULL DEFAULT 'homeowner'::text`
--     -- so EVERY new auth user, contractor included, gets a profiles row
--     with role='homeowner' at INSERT time.
--   - A contractor's role is only corrected to 'contractor' by a SEPARATE,
--     LATER event: inserting into public.contractors fires
--     trg_sync_contractor_profile_role, which UPDATEs profiles.role. Live
--     evidence (refuter, 2026-09-14): 12 of 15 contractor rows have
--     updated_at > created_at + 2s; the newest was created 13:07:52Z and
--     corrected to role='contractor' at 13:38:52Z -- 31 minutes later.
--   - auth-callback.html's `?intent=homeowner|contractor` is a CLIENT-SIDE
--     routing hint only (localStorage/query param) -- it is never written
--     to any column this database can see, so it cannot be used as a
--     trigger predicate either.
--
-- CONCLUSION: there is no reliable per-request signal for "this is a
-- homeowner" available at profiles-INSERT time in this schema today. Per
-- the refuter's own stated fallback, the profiles trigger is dropped
-- rather than patched with another heuristic. Admin alerting now happens
-- on claims INSERT only (trg_notify_admin_new_claim, unchanged, still
-- live) -- the point a homeowner is unambiguously real and engaged, and
-- the one event that also carries a property address, closing the
-- original signup alert's "where are they" gap as a side effect.
--
-- If a reliable signup-time signal is added later (e.g. handle_new_user()
-- starts copying raw_user_meta_data->>'role', with the signup UI actually
-- passing it via options.data first), recreating this trigger is a valid
-- fast-follow -- see the rollback block at the bottom of the original
-- migration file for the exact DDL this drops.

BEGIN;

DROP TRIGGER IF EXISTS trg_notify_admin_new_homeowner ON public.profiles;
DROP FUNCTION IF EXISTS public.notify_admin_new_homeowner_signup();

COMMIT;

-- =============================================================================
-- ROLLBACK (re-adds the dropped profiles trigger — NOT recommended without
-- also fixing the false-positive root cause above; kept for symmetry with
-- every other migration in this repo).
-- =============================================================================
-- See 20260914195746_gh1932_notify_admin_new_homeowner_triggers.sql,
-- section "1 of 2: homeowner signup", for the exact CREATE FUNCTION /
-- CREATE TRIGGER statements to re-run.
