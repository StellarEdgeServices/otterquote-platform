# Pre-flight: 20260928215500_gh2300_set_lead_converted_8day_window (Tier 3B)

NOT APPLIED. `apply_migration` was never called. Refs #2300 (finding: comment 5878649711), #2121 (HO-1.S16 / HO-2.S16).

## What it does
Recreates `public.set_lead_converted(uuid)` with `created_at > now() - interval '8 days'` instead of `'24 hours'`.
8 days = the reminder's 7-day max age (`REMINDER_MAX_AGE_MS`) + 1. Reason: the reminder only sends once a lead is
>= 24 h old (`REMINDER_MIN_AGE_MS`), so under the 24 h window a reminded homeowner who signs up is never linked
and `lead_goal_events` (joins on `converted_user_id`) undercounts conversion.

## Live vs repo (read-only, project yeszghaspzwwstvsrioa, 2026-09-28T21:5x Z)
- first 12 hex of `md5(prosrc)` live = `ba14bac2d987`; md5 of the function body in
  `20260926221500_gh2121_s16_lead_goal_security_fix.sql` = the same value. So the repo source is what is live.
- The forward file differs from live in exactly one executable token (`interval '24 hours'` -> `interval '8 days'`)
  plus the COMMENT text ("24h window" -> "8-day window ..."). Everything else is identical: null check, S1 anon
  rejection (28000), D4 JWT-email guard, first-write-wins, SECURITY DEFINER, `SET search_path = public, pg_temp`.
- Live ACL: `{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}`; anon has no EXECUTE.
  The file contains no REVOKE/GRANT (permissions-ratchet, gh-1767, flags a re-GRANT to authenticated). CREATE OR REPLACE
  keeps the existing ACL (service_role entry included); proven below by comparing `proacl` before and after inside BEGIN...ROLLBACK.

## Danger-pattern check (migration-author Step 1)
No column, table, index or type change. Row 9 (new function in public): not new; existing function, ACL kept by CREATE OR REPLACE, no GRANT/REVOKE in the file. No data is touched. Lock: CREATE OR REPLACE FUNCTION only.

## Proof: supabase/tests/gh2300_set_lead_converted_window_proof.sql (BEGIN ... ROLLBACK)
Run against production in BEGIN...ROLLBACK (run A = live 24 h function, run B = this migration's function created
inside the same rolled-back transaction):

| case | A: live 24 h | B: with migration |
|---|---|---|
| W1 2-day-old, matching email links | FAIL (false) | PASS (true) |
| W2 7.5-day-old links | FAIL (false) | PASS (true) |
| W3 9-day-old does not link | PASS | PASS |
| W4 different email, 2-day-old, does not link (negative control) | PASS | PASS |
| W5 first write wins | FAIL (never linked) | PASS |
| W6 anon rejected (28000) | PASS | PASS |

After both runs: leads count 108, converted 0, leads fingerprint `b5fdd190c7fa`, function md5
`ba14bac2d987`, 0 `gh2300-%` fixture rows: identical to the pre-run baseline.

Fixture note: `trg_leads_force_safe_insert_defaults` forces `created_at := now()` on INSERT, so age is set by UPDATE.
The earlier `gh2121_s16_lead_goal_proof.sql` inserts `created_at = now() - 2 hours`, which the trigger overwrites,
and its random-uuid accounts would violate `leads_converted_user_id_fkey` (FK to auth.users). Not changed here;
noted for #2121.

## Apply (after R-097 window and Dustin approval), rollback
Apply the forward file. Verify: `SELECT prosrc LIKE '%8 days%' FROM pg_proc WHERE proname='set_lead_converted'` is true,
`has_function_privilege('anon', 'public.set_lead_converted(uuid)', 'EXECUTE')` is false, `authenticated` true.
Rollback: `supabase/migrations_rollbacks/20260928215500_gh2300_set_lead_converted_8day_window_rollback.sql`
(restores the 24 h body verbatim; no data change; already-linked leads stay linked).

## Residual
The 8-day figure is a judgment (7 + 1). The D4 email guard carries the security; a longer window only widens the time
a signed-in caller with the matching email can link. Leads 8+ days old still cannot link.
