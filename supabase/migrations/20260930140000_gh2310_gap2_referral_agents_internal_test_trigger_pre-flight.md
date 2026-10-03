# Pre-flight: 20260930140000_gh2310_gap2_referral_agents_internal_test_trigger (Tier 3B)

NOT APPLIED. Refs #2310 Gap 2 (forward mechanism). Rulings: Ben 5911272800, 5912247548. Sibling: PR #2400 (9-id backfill, merged).

## What it does
Creates `public.is_internal_test_email(text)` (IMMUTABLE, SECURITY INVOKER, pinned search_path) and a BEFORE INSERT
trigger `referral_agents_set_is_test_internal` (function `referral_agents_flag_internal_test()`, SECURITY DEFINER,
pinned search_path) that sets `NEW.is_test := true` when the helper matches. It never sets false and leaves an explicit
true alone. Match rule: exact domain in {stellaredgeservices.com, tryotterquote.com, stohlerroof.com,
otterquote-internal.test}, or gmail.com with the +tag-stripped local part equal to `dustinstohler1` or Stacy's base.

Stacy's base local part is read at apply time from `referral_agents` row `0a934e11-...` and embedded with
`EXECUTE format(... %L ...)`. It is not in the repo. The deployed function body (pg_proc.prosrc) contains it; accepted per Ben.
The migration RAISEs (whole transaction aborts) on: row missing, email null/blank, domain not gmail.com, empty base.

## gh-886 guard trigger analysis
`referral_agents_guard_payout_columns` is BEFORE UPDATE only, so it does not fire on INSERT and does not reject the
is_test write. Trigger-name ordering is irrelevant to it. The other BEFORE INSERT triggers (generate_code,
generate_recruit_code) touch other columns. The AFTER INSERT `trg_notify_admin_new_partner` still fires and, per
notify-admin-new-partner, alerts Dustin with a "[TEST] " prefix for is_test=true partners on non-`.test` domains.

## Danger-pattern check (migration-author Step 1)
| # | Pattern | Triggered? |
|---|---|---|
| 1-8 | column/type/index/rename/truncate/cascade | No. No table, column, index or data change. |
| 9 | New function in public | Yes, handled: both functions `REVOKE ALL ... FROM PUBLIC, anon, authenticated`; no GRANT lines (permissions-ratchet safe). Trigger fn is SECURITY DEFINER so anon/authenticated INSERTs still work. |
Lock: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on referral_agents (69 rows) for milliseconds.

## Verification done WITHOUT production
Local Postgres 16 harness (stub auth schema, referral_agents columns, the real gh-886 migration applied, a fixture
Stacy row with a fake address): migration applies; proof positive cases pass (14 cases + explicit-true control); negative
control (trigger disabled) fails all 7 internal cases as intended; RAISE paths verified for missing row, non-gmail and
empty base; anon-role INSERT flags a staff domain and anon/authenticated have no EXECUTE on either function; rollback removes
both functions and the trigger. Static deno test: `supabase/tests/gh2310_gap2_internal_test_trigger.test.ts`.
NOT verified: real schema (columns added after the v000 baseline), real pg_net alert trigger, production data.

## Applier runbook
1. R-097 notice; after the window, merge the PR.
2. Read-only precheck: `SELECT email FROM referral_agents WHERE id='0a934e11-5cac-4607-a63c-7446fe446f81'` is non-null gmail.com (the migration asserts this anyway).
3. Apply the forward file (it is its own BEGIN/COMMIT and records via the normal migration path).
4. Run `supabase/tests/gh2310_gap2_internal_test_trigger_proof.sql` (BEGIN ... ROLLBACK). Expect the NOTICEs `positive cases OK` and `negative control OK`, and `after`: ra_total unchanged, fixtures_left 0, trigger_enabled_flag `O`.
5. Verify ACL: `has_function_privilege('anon'|'authenticated', 'public.is_internal_test_email(text)'::regprocedure, 'EXECUTE')` false; same for `public.referral_agents_flag_internal_test()`.
6. Sentry check for partner sign-up errors for 30 minutes.
Rollback: `supabase/migrations_rollbacks/20260930140000_gh2310_gap2_referral_agents_internal_test_trigger_rollback.sql` (drops trigger, trigger fn, helper; no data change).

## Open questions (not blocking)
Q1. INSERT-only per Ben. An UPDATE of a real partner's email to an internal address (or a staff member changing their email) will not flip is_test. Adding `BEFORE UPDATE OF email` would collide with the gh-886 guard only if ordered wrongly, and would need the service_role claim trick; recommend leaving as is unless founder edits appear in counts.
Q2. Gmail ignores dots and treats googlemail.com as gmail.com. A dotted variant of Dustin's base (a dot inserted in the local part) is the same mailbox but is not matched (per the exact spec). Recommend leaving; widen only if observed.
Q3. Exact-domain rule: subdomains (e.g. `mail.stohlerroof.com`) do not match.
