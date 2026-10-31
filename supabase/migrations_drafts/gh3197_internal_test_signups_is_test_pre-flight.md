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
2. `claims_guard_referral_columns()` (the one claims guard trigger) gets an INSERT-only block that sets `claims.is_test := true` only when the owner's profile email satisfies `is_internal_test_email()`. It does NOT copy `profiles.is_test`: that flag also means "real, keep off product email" and inheriting it would block platform fees on a real homeowner's claims (Ben, PR comment 6523791817). All earlier rules kept verbatim; no new trigger and no new RAISE. Raise-only (never lowers a true).
3. New helper `is_internal_test_user(uuid)`: SECURITY DEFINER, `search_path = public, pg_temp`, returns boolean only. Why a helper: the guard is SECURITY INVOKER (CI pins it) and `authenticated` cannot EXECUTE `is_internal_test_email` (gh-1529), so the guard cannot evaluate the email rule itself on a browser insert; a DEFINER helper that takes a uuid and returns a boolean is the smallest widening. EXECUTE goes to authenticated and service_role only (REVOKE from PUBLIC and anon); the guard skips the block for `anon` (its claim inserts are refused by RLS anyway). The rollback drops the helper after restoring the guard.

No backfill is in the file. Rollback restores both bodies exactly and drops only the helper this set adds.

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
-- P6 helper: BEFORE 0 rows. AFTER prosecdef=true, authenticated=true, anon=false
SELECT prosecdef, has_function_privilege('authenticated','public.is_internal_test_user(uuid)','EXECUTE') auth_exec, has_function_privilege('anon','public.is_internal_test_user(uuid)','EXECUTE') anon_exec FROM pg_proc WHERE proname = 'is_internal_test_user';
```

### Behavioural proof (one batch; ends with a deliberate RAISE EXCEPTION so nothing commits)
Profiles are created the way production creates them: INSERT into `auth.users` fires `on_auth_user_created` -> `handle_new_user()` (SECURITY DEFINER) -> profile row. `profiles.id` and `claims.user_id` both have FKs to `auth.users(id)`, so a direct profile insert would fail 23503. `auth.users` needs only `id` (is_sso_user and is_anonymous default false); set `email`.
Like supabase/tests/gh2997_inherit_is_test_proof.sql, every result is accumulated into one labelled text variable and returned in the final exception message, so the output survives the rollback.
```sql
DO $t$
DECLARE
  u_int uuid := gen_random_uuid();   -- INT : proof+gh3197@otterquote.com (internal, claim inserted as authenticated)
  u_ext uuid := gen_random_uuid();   -- EXT : proof+gh3197@example.com (negative control, claims inserted as authenticated)
  u_srv uuid := gen_random_uuid();   -- SRV : proof+gh3197-srv@otterquote.com (internal, claim inserted as postgres)
  u_flg uuid := gen_random_uuid();   -- FLG : proof+gh3197-flag@example.com (NOT internal, profile manually flagged is_test=true, claim inserted as authenticated)
  r text := '';
  v text;
BEGIN
  INSERT INTO auth.users(id, email) VALUES (u_int, 'proof+gh3197@otterquote.com'), (u_ext, 'proof+gh3197@example.com'), (u_srv, 'proof+gh3197-srv@otterquote.com'), (u_flg, 'proof+gh3197-flag@example.com');
  UPDATE profiles SET is_test = true WHERE id = u_flg;   -- manual flag, as an operator would set it (runs as postgres; freeze trigger is a no-op)

  -- S1 profiles via the real sign-up path. BEFORE: INT=false SRV=false. AFTER: INT=true SRV=true. EXT=false both times.
  SELECT string_agg(CASE id WHEN u_int THEN 'INT' WHEN u_ext THEN 'EXT' WHEN u_flg THEN 'FLG' ELSE 'SRV' END || '=' || is_test, ' ' ORDER BY email) INTO v FROM profiles WHERE id IN (u_int, u_ext, u_srv, u_flg);
  r := r || E'\nS1 profiles.is_test [' || v || ']';

  -- S2 claims as the browser inserts them: role authenticated, JWT of that user, status documents_needed (the RLS-filtered EXISTS runs here)
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_int, 'email', 'proof+gh3197@otterquote.com', 'role', 'authenticated')::text, true);
  INSERT INTO claims(user_id, status) VALUES (u_int, 'documents_needed');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_ext, 'email', 'proof+gh3197@example.com', 'role', 'authenticated')::text, true);
  INSERT INTO claims(user_id, status) VALUES (u_ext, 'documents_needed');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_flg, 'email', 'proof+gh3197-flag@example.com', 'role', 'authenticated')::text, true);
  INSERT INTO claims(user_id, status) VALUES (u_flg, 'documents_needed');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_ext, 'email', 'proof+gh3197@example.com', 'role', 'authenticated')::text, true);
  -- S4 never-lower, through the INSERT block: a second EXT claim inserted as authenticated with explicit is_test = true
  INSERT INTO claims(user_id, status, is_test) VALUES (u_ext, 'documents_needed', true);
  RESET ROLE;
  SELECT 'FLG claim=' || is_test INTO v FROM claims WHERE user_id = u_flg;
  r := r || E'\nS5 authenticated insert, manually flagged NON-internal profile [' || v || '] (want false BEFORE and AFTER: profiles.is_test is not inherited)';
  SELECT string_agg('INT claim=' || is_test, ' ') INTO v FROM claims WHERE user_id = u_int;
  r := r || E'\nS2 authenticated insert, internal user [' || v || '] (BEFORE false, AFTER true)';
  SELECT string_agg('EXT claim=' || is_test, ' ' ORDER BY is_test) INTO v FROM claims WHERE user_id = u_ext;
  r := r || E'\nS2/S4 authenticated inserts, example.com user, default flag and explicit true [' || v || '] (want: one false = negative control, one true = never lowered, both BEFORE and AFTER)';

  -- S3 claim inserted as postgres (current_user postgres, no RLS; stands in for service_role). BEFORE false, AFTER true
  INSERT INTO claims(user_id, status) VALUES (u_srv, 'documents_needed');
  SELECT 'SRV claim=' || is_test INTO v FROM claims WHERE user_id = u_srv;
  r := r || E'\nS3 postgres insert, internal user [' || v || ']';

  RAISE EXCEPTION E'gh3197 proof (forced rollback)%', r;
END $t$;
```
Read the results from the exception text. Expected BEFORE the migration: S1 INT=false SRV=false EXT=false FLG=true; S2 INT claim=false; S2/S4 EXT claims `false true`; S3 SRV claim=false; S5 FLG claim=false. Expected AFTER: S1 INT=true SRV=true EXT=false FLG=true; S2 INT claim=true; S2/S4 EXT claims still `false true` (negative control false, explicit true not lowered); S3 SRV claim=true; S5 FLG claim=false (narrowed inheritance: a manual flag on a non-internal profile does not reach its claims). If `set_config` for the JWT or the `authenticated` insert policy rejects the shape, adjust the claim columns to what the trade-selector insert sends; the status must stay `documents_needed` so the born-state refusal does not fire.

## Backfill (decided)
Ben ruled YES on #3197 (comments 6522509807, amended by 6522674646): a separate, raise-only draft applied in the same R-097 window, with its own rollback listing the ids it changed. Files: `gh3197_backfill_internal_test_is_test.sql` and `gh3197_backfill_internal_test_is_test_rollback.sql`. Ben dropped the row-paste precondition after the live `is_internal_test_email()` rule was read (no real homeowner can match). It must run as service_role / postgres (profiles_freeze_privileged_columns). Apply the migration first, then the backfill.
