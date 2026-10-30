<!--
STATUS (as of 2026-10-30): NOT APPLIED -- DRAFT
FILE ROLE: pre-flight file of set gh3197_internal_test_signups_is_test
EVIDENCE: production read-only 2026-10-30 (project yeszghaspzwwstvsrioa); nothing was written.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-Flight: gh3197_internal_test_signups_is_test

**Issue**: #3197. **Tier**: 3B (function replacement; R-097 24-hour notice, CTO applies). **Status**: DRAFT, not applied.

## Change summary
1. `set_is_test_for_internal_test_domain()` now uses `is_internal_test_email(NEW.email)` (was a single hard-coded `%@otterquote-internal.test`).
2. `claims_guard_referral_columns()` (the one claims guard trigger) gets an INSERT-only block copying `profiles.is_test` (id = `NEW.user_id`) onto the claim. All earlier rules kept verbatim; no new trigger, function or RAISE. Raise-only (never lowers a true).

No backfill is in the file. Rollback restores both bodies exactly; it drops nothing.

## Measured 2026-10-30 (SELECT only)
| What | Value |
|---|---|
| profiles with internal-test email and is_test<>true | 38 (gmail 18, stellaredgeservices 13, otterquote 4, stohlerroof 2, tryotterquote 1) |
| claims owned by those profiles with is_test<>true | 3 |
| claims on is_test profiles with is_test<>true | 0 |
| non-internal profiles is_test<>true / is_test=true | 10 / 1 |

## Proof plan (run by the CTO; BEFORE now, AFTER once applied)
Replace `<apply_ts>` with the time the migration is applied.
```sql
-- P1 defect, profiles. BEFORE: 38. AFTER (new sign-ups only; old rows change only via the backfill): 0
SELECT count(*) FROM profiles WHERE public.is_internal_test_email(email) AND is_test IS NOT TRUE AND created_at > '<apply_ts>';
-- (BEFORE reading, whole table, no created_at filter: 38. AFTER the backfill, whole table: 0)
SELECT count(*) FROM profiles WHERE public.is_internal_test_email(email) AND is_test IS NOT TRUE;
-- P2 defect, claims. BEFORE: 3. AFTER the backfill: 0
SELECT count(*) FROM claims c JOIN profiles p ON p.id = c.user_id WHERE public.is_internal_test_email(p.email) AND c.is_test IS NOT TRUE;
-- P3 function body: AFTER must contain is_internal_test_email and not the like-literal
SELECT pg_get_functiondef('public.set_is_test_for_internal_test_domain()'::regprocedure);
-- P4 guard body: AFTER must contain 'gh-3197' and still have exactly 3 ERRCODE '42501'
SELECT pg_get_functiondef('public.claims_guard_referral_columns()'::regprocedure);
-- P5 trigger inventory: AFTER unchanged (no new claims trigger)
SELECT tgname FROM pg_trigger WHERE tgrelid='public.claims'::regclass AND NOT tgisinternal ORDER BY 1;
```

### Behavioural proof (one batch; ends with a deliberate RAISE EXCEPTION so nothing commits)
Profiles are created the way production creates them: INSERT into `auth.users` fires `on_auth_user_created` -> `handle_new_user()` (SECURITY DEFINER) -> profile row. `profiles.id` and `claims.user_id` both have FKs to `auth.users(id)`, so a direct profile insert would fail 23503. `auth.users` needs only `id` (is_sso_user and is_anonymous default false); set `email`.
```sql
DO $t$
DECLARE
  u_int uuid := gen_random_uuid();   -- internal: proof+gh3197@otterquote.com
  u_ext uuid := gen_random_uuid();   -- negative control: proof+gh3197@example.com
  u_srv uuid := gen_random_uuid();   -- internal, claim inserted as service_role
  r text;
BEGIN
  INSERT INTO auth.users(id, email) VALUES (u_int, 'proof+gh3197@otterquote.com'), (u_ext, 'proof+gh3197@example.com'), (u_srv, 'proof+gh3197-srv@otterquote.com');

  -- S1 profiles via the real sign-up path. BEFORE: internal=false. AFTER: internal=true. Control: false both times.
  SELECT string_agg(email || '=' || is_test, ', ' ORDER BY email) INTO r FROM profiles WHERE id IN (u_int, u_ext, u_srv);
  RAISE NOTICE 'S1 %', r;

  -- S2 claim as the browser does it: authenticated role, JWT of that user, status documents_needed (the RLS-filtered EXISTS runs here)
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_int, 'email', 'proof+gh3197@otterquote.com', 'role', 'authenticated')::text, true);
  INSERT INTO claims(user_id, status) VALUES (u_int, 'documents_needed');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_ext, 'email', 'proof+gh3197@example.com', 'role', 'authenticated')::text, true);
  INSERT INTO claims(user_id, status) VALUES (u_ext, 'documents_needed');
  RESET ROLE;
  SELECT string_agg(user_id::text || '=' || is_test, ', ' ORDER BY is_test) INTO r FROM claims WHERE user_id IN (u_int, u_ext);
  RAISE NOTICE 'S2 internal claim must be true, example.com claim must be false: %', r;

  -- S3 claim as service_role / postgres (no RLS) for the third user. AFTER: true
  INSERT INTO claims(user_id, status) VALUES (u_srv, 'documents_needed');
  SELECT is_test::text INTO r FROM claims WHERE user_id = u_srv;
  RAISE NOTICE 'S3 %', r;

  -- S4 never-lower: explicit is_test=true on the example.com user's claim stays true
  UPDATE claims SET is_test = true WHERE user_id = u_ext;
  RAISE NOTICE 'S4 stays true: %', (SELECT is_test FROM claims WHERE user_id = u_ext);

  RAISE EXCEPTION 'gh3197 proof: forced rollback';
END $t$;
```
Expected BEFORE the migration: S1 internal rows false, S2 internal claim false, S3 false. Expected AFTER: S1 internal true / example.com false; S2 internal true / example.com false (negative control); S3 true; S4 true. If `set_config` for the JWT or the `authenticated` insert policy rejects the shape, adjust the claim columns to what the trader-selector insert sends; the status must stay `documents_needed` so the born-state refusal does not fire.

## Backfill (decided)
Ben ruled YES on #3197 (comments 6522509807, amended by 6522674646): a separate, raise-only draft applied in the same R-097 window, with its own rollback listing the ids it changed. Files: `gh3197_backfill_internal_test_is_test.sql` and `gh3197_backfill_internal_test_is_test_rollback.sql`. Ben dropped the row-paste precondition after the live `is_internal_test_email()` rule was read (no real homeowner can match). It must run as service_role / postgres (profiles_freeze_privileged_columns). Apply the migration first, then the backfill.
