# Pre-Flight: gh2154_register_partner_rate_limit_fix

**Migration**: gh2154_register_partner_rate_limit_fix.sql
**Date**: 2026-09-26
**Author**: CEO RUN 71 subagent (ceo71-regpartner-ratelimit), claim ceo-2026-09-26T16:23:19Z
**GitHub**: refs #2154 (P-5/foundation umbrella). Discovered by CEO RUN 71's pr2223-fix3 subagent while re-recording re-5/hi-5 partner-funnel demo videos; see `In Flight/reports/ceo71-pr2223-fix3-20260926.md` BLOCKERS.
**D-numbers**: D-182 (deploy tier 3), D-221 (Path A deploy)
**Tier**: **3B** — this is a `CREATE OR REPLACE` of `register_partner()`, a live anon-callable RPC with real production traffic (5+ partner-funnel pages call it today, more launching this program). Per the task's own framing: "a `CREATE OR REPLACE` of the function counts as a function change... RPC behaviour change on a live anon endpoint is likely 3B." Nothing here is destructive DDL (no DROP, no ALTER COLUMN, no data loss possible), but an anon-RPC *behavior* change gets the conservative tier. **DRAFT ONLY — NOT APPLIED.** No `apply_migration` call was made against `yeszghaspzwwstvsrioa` this session — SELECT-only throughout, per program rules ("Never merge, deploy, apply migrations, or write the production DB").
**R-097 window**: NOT posted. Program rules for this dispatch say "Do not file new GitHub issues," which is where this repo's own `migration-author-code` skill says a Tier 3B 24-hour risk brief must be filed. This migration is therefore left in `DRAFT` state with the tier called out here and in the PR description; Ben/Dustin can open the risk-brief issue (or approve directly) when reviewing the PR.

---

## Change Summary

`register_partner()`'s rate-limit gate (gh973, 2026-08-18) keys every anonymous caller with `auth.uid()`, which is `NULL` for every anonymous browser signup — so **every** real signup across every partner funnel and **all** `is_test` QA/video-recording traffic drew from one shared 10/hour + 30/day bucket. Confirmed live today: the day's 30/30 cap was consumed entirely by `is_test=true` rows — 0 real signups — before a single real realtor/agent/inspector could sign up. The mechanism could not tell a real signup from a QA one.

This migration splits that one bucket into three independent `rate_limit_config` rows, all still enforced through the unmodified generic `check_rate_limit()` engine:

1. **`register_partner`** (existing row, re-tuned) — per-client budget for real signups, keyed by a new deterministic salted hash of the caller's IP (`rate_limit_client_key()`, read from `request.headers` the same way the function already reads it for UA/IP logging). 8/hour, 20/day, 150/month per client.
2. **`register_partner_test`** (new) — is_test-only bucket (`public.is_test_email()`, never the caller-supplied `p_is_test` flag for a non-service-role caller, unchanged from existing behavior). 100/hour, 300/day, 3000/month — generous, exists only to bound a genuinely runaway test loop.
3. **`register_partner_global`** (new) — platform-wide ceiling across all real (non-test) signups, the actual abuse backstop for a multi-IP attack the per-client key alone can't catch. 120/hour, 500/day (the task's own recommended default), 6000/month.

A new function, `check_register_partner_global_budget()`, scheduled on `pg_cron` every 15 minutes, writes a deduped `platform_alerts_log` row (`rate_limit_global_warning` at 80% of `max_per_day`, `rate_limit_global_exhausted` at 100%) — see "Alert Delivery Mechanism" below for why this had to be a separate reconciler rather than an insert made in the same statement as the `RAISE EXCEPTION`.

`register_partner_service_role` (the Meta Lead Ads webhook's own bucket, added gh-2154 P-5r) is untouched.

---

## Alert Delivery Mechanism (why a cron reconciler, not an in-request insert)

The original design (first draft this session) inserted a `platform_alerts_log` row immediately before `RAISE EXCEPTION 'rate_limited: ...'`, inside `register_partner()`'s own body. **Verified empirically this session, against a local scratch Postgres 16, that this insert never persists:**

```sql
create or replace function probe_fn() returns void language plpgsql as $$
begin
  insert into probe values (1);
  raise exception 'boom';
exception when division_by_zero then   -- does NOT match 'boom'
  raise notice 'never';
end;
$$;
-- called from a DO block with its own EXCEPTION WHEN OTHERS:
-- result: probe table is EMPTY. The insert was rolled back.
```

Reason: `register_partner()` already has its own `BEGIN...EXCEPTION WHEN unique_violation` block. Any exception raised inside that block — matched by a `WHEN` clause or not — first rolls back to that block's *implicit savepoint* before PL/pgSQL can even inspect whether a `WHEN` clause matches. An unmatched exception (like our `rate_limited` error) then re-raises past the rolled-back point. This undoes every statement executed since the block began, including an `INSERT` issued moments earlier in the same function call.

This is not a new problem this migration introduces — it already affects `check_rate_limit()`'s own bookkeeping. `check_rate_limit()` unconditionally tries to insert a `blocked=true` row into `rate_limits` on every refusal; that insert suffers the exact same rollback whenever the caller (like `register_partner()`) re-raises the failure from inside its own exception-bearing block. **Confirmed live** against `yeszghaspzwwstvsrioa`: `rate_limits.blocked` is `0/0` (zero blocked rows recorded, ever) for both `register_partner` and `track_referral_click` — the two PL/pgSQL RPCs that follow this same check-then-raise pattern — while Edge-Function callers of the same `check_rate_limit()` (e.g. `check-email-exists`, `create-docusign-envelope`), which call it as one plain SQL statement with no enclosing PL/pgSQL exception block, DO show real blocked-row counts (35 and 13 respectively). This confirms the mechanism, not just the theory.

**Fix for the alert specifically**: `check_register_partner_global_budget()` is a standalone function, scheduled on `pg_cron` every 15 minutes (same cadence as this repo's other periodic sweeps, e.g. `gh2154_p4_partner_onboarding_cron`). It reads the count of **allowed** `register_partner_global` calls in the last 24h — which persist reliably, since they're only ever written on the success path, which never rolls back — and writes the deduped alert row itself, entirely outside any request's transaction. Trade-off: alert delivery has a worst-case ~15-minute lag instead of being synchronous with the blocking event. Given the alternative (an alert that is synchronous but provably never fires), this is the right trade — and it also means the block itself is unaffected: `register_partner()` still raises `rate_limited` to the caller in real time on every refusal, exactly as before.

---

## Live Pre-Verification (captured fresh this session, 2026-09-26, against `yeszghaspzwwstvsrioa`, SELECT only)

1. **Mechanism**: `rate_limit_config` row for `register_partner` — `max_per_hour=10, max_per_day=30, max_per_month=300, enabled=true`. `check_rate_limit(p_function_name, p_user_id)` counts `rate_limits` rows matching `(function_name, caller_id)` — `caller_id` is compared `IS NULL` when `p_user_id IS NULL`. `register_partner()` calls it with `p_user_id => auth.uid()`, which is `NULL` for every anonymous/authenticated (non-service-role) caller — confirming the single shared bucket.
2. **Today's counts**: `select count(*) filter (where not blocked), count(*) from rate_limits where function_name='register_partner' and called_at > now() - interval '1 day'` → `ok_today: 30, total_today: 30` (0 blocked rows recorded — consistent with the rollback finding above: any refused call's bookkeeping row never persisted either, so this can't be read as "no refusals happened," only "no refusal was ever recorded here").
3. **Real vs. test breakdown of today's 30**: `select is_test, count(*) from referral_agents where created_at > now() - interval '1 day' group by is_test` → **`is_test=true: 30`, `is_test=false: 0`**. Of the 30: 6 rows are `@gmail.com`/`@stellaredgeservices.com` addresses independently marked `is_test=true` (QA accounts), the other 24 are `@otterquote-internal.test`. **Zero real partner signups today; the entire daily budget was consumed by QA/video-recording traffic.**
4. **Config table full row**: `notes` field on the existing `register_partner` config row already documents (gh973) "Limits are a starting judgment call, not traffic-validated — raise if legitimate signup volume is ever throttled" — this migration is exactly that raise-when-throttled event, four days after the row was created.
5. **`check_rate_limit()`** (generic engine) — pulled verbatim via `pg_get_functiondef`, confirmed UNCHANGED by this migration; only the config rows it reads and the `p_user_id` values `register_partner()` passes to it change.
6. **`referral_agents` schema** — pulled via `information_schema.columns` to build the accurate test-harness table (see the `.test.sql` file's own documented simplifications).
7. **Grants/RLS on `rate_limits`/`rate_limit_config`** — `anon`/`authenticated` hold full table-level CRUD grants at the Postgres level (pre-existing, unrelated to this fix — `gh970` migration name references a prior partial cleanup: `revoke_anon_execute_ops_ratelimit_functions`), but RLS is `enabled=true` on both tables with no permissive policy for those roles, so the base grants are currently inert. Flagged under QUESTIONS in the report rather than fixed here — out of scope for a rate-limit bucketing fix, and not part of the incident.
8. **`pg_cron`**: confirmed installed and active (`installed_version: 1.6.4`), already used by 10+ scheduled jobs in this repo (`gh2154_p4_partner_onboarding_cron`, `gh1932_homeowner_signup_sweep_cron`, etc.) — no new extension dependency introduced.

---

## Row Count Estimate

| Table | Row Count | Source |
|---|---|---|
| `rate_limit_config` | 1 row updated, 2 rows inserted (idempotent upsert) | this migration |
| `referral_agents` | 36 total rows (30 from today alone) — migration touches none of them, only the function that inserts future rows | Supabase MCP, 2026-09-26 |
| `rate_limits` | append-only audit table, unaffected by this migration's own execution (only by future `register_partner()` calls) | — |

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|---|---|---|
| `CREATE OR REPLACE FUNCTION` ×3 (`rate_limit_client_key`, `register_partner`, `check_register_partner_global_budget`) | Catalog-only (`pg_proc` update) | <5ms each |
| `REVOKE` ×2 functions | Catalog-only (ACL update) | <5ms each |
| `INSERT ... ON CONFLICT DO UPDATE` ×3 on `rate_limit_config` | Row-level, single-row upsert on a tiny config table | <5ms |
| `cron.schedule(...)` | pg_cron catalog insert/update | <5ms |

No table rewrite, no `ACCESS EXCLUSIVE` lock on any application table (`referral_agents`, `rate_limits`) — every statement is either a catalog/function change or a single-row upsert against a config table with one row per function name.

## Danger Pattern Check

| # | Pattern | Triggered? | Notes |
|---|---|---|---|
| 1 | NOT NULL column without DEFAULT | No | No column added |
| 2 | NOT NULL on >100K rows | No | No column added |
| 3 | DROP COLUMN | No | — |
| 4 | Type change requiring rewrite | No | — |
| 5 | Index without CONCURRENTLY | No | No index added |
| 6 | RENAME TABLE/COLUMN | No | — |
| 7 | TRUNCATE/DELETE all rows | No | — |
| 8 | CASCADE DROP | No | — |
| 9 | New function in `public` (default anon/authenticated EXECUTE grant) | **YES** — `rate_limit_client_key()` and `check_register_partner_global_budget()` are both new | **Addressed**: both ship an explicit `REVOKE ALL ... FROM PUBLIC, anon, authenticated` in the same migration. `register_partner()` itself is `CREATE OR REPLACE`, not new, so its existing grants are untouched. |

**All 8 numbered patterns clear; #9 triggered and closed in-migration.** The one load-bearing risk not on the standard list is the RPC-behavior-change risk named in the Tier classification above: could this change ever refuse a REAL signup the old code would have allowed? Addressed directly: the per-client bucket (8/hour, 20/day) is far above any plausible single real signup, and the global ceiling (500/day) is far above the old shared 30/day — this migration can only ever be MORE permissive to real traffic than the code it replaces, never less.

## Code Path Impact Analysis

- **P-1 browser signup forms** (`partner-re/insurance/inspectors/adjusters/other.html`, and the newer `re-1/ins-1/hi-1/re-5/hi-5.html` funnel pages) — call `register_partner()` as anon/authenticated with no `p_is_test`/`p_meta_lead_id` override honored (unchanged). Only behavior change observable to them: a real signup that would have been refused under the old shared-bucket math (someone else's QA traffic ate the budget) is now refused ONLY if their own IP or the platform-wide real-signup total is genuinely over budget — strictly more permissive.
- **`meta-leadgen-webhook`** (service_role caller) — completely unaffected; still keys off `register_partner_service_role`, a bucket this migration does not touch.
- **`partner-invite-accept`** and any other caller of `register_partner()` — signature is unchanged, so no caller needs a code change.
- **QA / video-recording / CI traffic** (`@otterquote-internal.test` or any `is_test_email()`-matching address) — now draws from `register_partner_test` (100/hour, 300/day) instead of competing with real traffic. This is the direct fix for today's incident.

## Supabase Branch Test Results

**Not run against a live Supabase branch** (no `create_branch`/`apply_migration` call this session — SELECT-only per program rules). Instead, both forward and rollback SQL were verified against a **local scratch Postgres 16.13** instance this session, with a hand-built schema matching the live `rate_limit_config`/`rate_limits`/`platform_alerts_log`/`referral_agents` columns (pulled via `information_schema.columns`) and stub `auth.uid()`/`auth.role()`/`cron.schedule`/`cron.unschedule` functions:

- Forward migration (`gh2154_register_partner_rate_limit_fix.sql`): applied cleanly. ✅
- Forward migration re-applied a second time (idempotency check): applied cleanly, no errors, upserts left exactly 3 config rows. ✅
- Rollback (`gh2154_register_partner_rate_limit_fix_rollback.sql`): applied cleanly against the post-forward state. ✅
- Full behavioral test harness (`gh2154_register_partner_rate_limit_fix.test.sql`, using the REAL `check_rate_limit()`/`is_test_email()`/`rate_limit_client_key()`/`register_partner()`/`check_register_partner_global_budget()` function bodies against a scratch `gh2223_test` database): **all steps PASSED**, specifically both required negative controls —
  - a real signup is refused **only** when its own per-client key exceeds the limit (steps 1–2: IP-A's 4th signup refused while IP-B's signup from a fresh key succeeds immediately, and the shared `register_partner_global` bucket is nowhere near its own ceiling at that point);
  - test signups **never** consume or get blocked by the real budget (step 3: 6 `@otterquote-internal.test` signups from the already-exhausted IP-A all succeed, and the real per-client/global counts are provably unchanged by them).
  - Global-ceiling abuse protection and its alert reconciler (steps 4–5), including alert dedup.

This local-scratch verification is a stand-in for, not a substitute for, an actual `create_branch`/`apply_migration` dry run against `yeszghaspzwwstvsrioa` — recommended as the next step for whoever applies this after approval, per the repo's own migration-author skill (Step 6).

## Deploy Notes

- **Tier**: 3B (see above). **DRAFT ONLY. NOT APPLIED.**
- **R-097 window**: not posted (program rule against filing new GitHub issues this session). Flagged in the PR body for Ben/Dustin.
- **Deploy path once approved**: D-221 Path A — GitHub PR → CI green → merge → `apply_migration` against `yeszghaspzwwstvsrioa` (manual, gated on Tier-3B sign-off).
- **Rollback pre-authorized**: yes — `gh2154_register_partner_rate_limit_fix_rollback.sql`, verified above. Re-opens the exact defect this migration fixes (single shared bucket) — only run it if this fix is found to have broken something worse than today's incident.
- **Post-apply verification**: (1) `select * from rate_limit_config where function_name like 'register_partner%'` — 4 rows (`register_partner`, `register_partner_test`, `register_partner_global`, `register_partner_service_role`, the last untouched); (2) a real-looking signup from a fresh IP succeeds; (3) an `@otterquote-internal.test` signup succeeds even if the real per-client/global buckets are saturated; (4) `select * from cron.job where jobname = 'gh2223-register-partner-global-budget-check'` — job present, `active=true`.
- **Monitoring**: watch `platform_alerts_log` for `rate_limit_global_warning`/`rate_limit_global_exhausted` rows for the first 24–48h post-launch of the remaining partner funnels; watch Sentry for any unexpected `rate_limited` errors on real (non-`@otterquote-internal.test`) signups.
- **Immediate mitigation** (separate from this migration; see the incident report's "IMMEDIATE MITIGATION" section) — a one-statement reset of today's counter so real signups work again tonight, proposed but NOT executed, pending Ben/Dustin's decision.

## Danger Overrides

None.
