# Pre-Flight: gh2154_register_partner_rate_limit_fix

**Migration**: gh2154_register_partner_rate_limit_fix.sql
**Date**: 2026-09-26
**Author**: CEO RUN 71 subagent (ceo71-regpartner-ratelimit), claim ceo-2026-09-26T16:23:19Z
**GitHub**: refs #2154 (P-5/foundation umbrella). Discovered by CEO RUN 71's pr2223-fix3 subagent while re-recording re-5/hi-5 partner-funnel demo videos; see `In Flight/reports/ceo71-pr2223-fix3-20260926.md` BLOCKERS.
**D-numbers**: D-182 (deploy tier 3), D-221 (Path A deploy)
**Tier**: **3B** — this is a `CREATE OR REPLACE` of `register_partner()`, a live anon-callable RPC with real production traffic (5+ partner-funnel pages call it today, more launching this program). Per the task's own framing: "a `CREATE OR REPLACE` of the function counts as a function change... RPC behaviour change on a live anon endpoint is likely 3B." Nothing here is destructive DDL (no DROP, no ALTER COLUMN, no data loss possible), but an anon-RPC *behavior* change gets the conservative tier. **DRAFT ONLY — NOT APPLIED.** No `apply_migration` call was made against `yeszghaspzwwstvsrioa` this session — SELECT-only throughout, per program rules ("Never merge, deploy, apply migrations, or write the production DB").
**R-097 window**: NOT posted. Program rules for this dispatch say "Do not file new GitHub issues," which is where this repo's own `migration-author-code` skill says a Tier 3B 24-hour risk brief must be filed. This migration is therefore left in `DRAFT` state with the tier called out here and in the PR description; Ben/Dustin can open the risk-brief issue (or approve directly) when reviewing the PR.

**Revised 2026-09-26 (F3, REVIEW FAIL 5850926064)**: this file previously described the FIRST draft's design — a standalone `check_register_partner_global_budget()` function on its own `pg_cron` schedule, writing directly to `platform_alerts_log`. That design was replaced, before this PR's first re-review, with Phase 5 inside `supabase/functions/platform-health-check/index.ts` (D2 in the migration's own header comment) — no `pg_cron` job of this migration's own exists any more. This file is now updated throughout to match: the "Alert Delivery Mechanism" section, the danger-pattern table, and the post-apply verification steps below. It also now reflects the live interim config (#2154, 50/hr+60/day+300/month) as the actual baseline this migration changes, not the original pre-interim 10/30/300, and adds the `register_partner_no_ip` bucket introduced in this same re-review round (reviewer's caveat on the shared NULL-key fallback).

---

## Change Summary

`register_partner()`'s rate-limit gate (gh973, 2026-08-18) keys every anonymous caller with `auth.uid()`, which is `NULL` for every anonymous browser signup — so **every** real signup across every partner funnel and **all** `is_test` QA/video-recording traffic drew from one shared 10/hour + 30/day bucket. Confirmed live today: the day's 30/30 cap was consumed entirely by `is_test=true` rows — 0 real signups — before a single real realtor/agent/inspector could sign up. The mechanism could not tell a real signup from a QA one.

This migration splits that one bucket into four independent `rate_limit_config` rows, all still enforced through the unmodified generic `check_rate_limit()` engine. The row that existed before this fix (`register_partner`) was, as of this re-review, actually the **interim #2154 mitigation value (50/hour, 60/day, 300/month)** — a same-day stopgap applied ahead of this PR to unblock real signups, not the original gh973 10/hour+30/day+300/month row. This migration's upsert supersedes that interim row with the per-client design below:

1. **`register_partner`** (existing row, re-tuned) — per-client budget for real signups, keyed by a new deterministic salted hash of the caller's IP (`rate_limit_client_key()`, read from `request.headers` the same way the function already reads it for UA/IP logging). **8/hour, 20/day, 150/month PER CLIENT** — tighter per-key than the interim 50/60 shared-across-everyone row, but no longer shared: a single office/IP that was throttled by the interim value only when combined with everyone else's traffic is now throttled only by its own volume, and every other client gets its own independent 8/20/150.
2. **`register_partner_test`** (new) — is_test-only bucket (`public.is_test_email()`, never the caller-supplied `p_is_test` flag for a non-service-role caller, unchanged from existing behavior), now per-client (D4). 100/hour, 300/day, 3000/month — generous, exists only to bound a genuinely runaway test loop from one caller.
3. **`register_partner_global`** (new) — platform-wide ceiling across all real (non-test) signups, the actual abuse backstop for a multi-IP attack the per-client key alone can't catch. 120/hour, 500/day (the task's own recommended default), 6000/month.
4. **`register_partner_no_ip`** (new, added in the 2nd re-review round per REVIEW FAIL 5850926064's caveat) — a dedicated bucket for the rare case where no client IP can be derived at all (`rate_limit_client_key()` returns NULL). Previously that case silently fell back into `register_partner`'s own shared NULL-`caller_id` key, which could already be near its cap from unrelated no-IP traffic; now it has its own generous, reset-safe bucket (40/hour, 150/day, 1500/month) that never competes with real per-client signups.

Alerting for `register_partner_global` (D2, and REVIEW FAIL 5850688286) is **not** a standalone `pg_cron` reconciler — an earlier draft of this fix used one (`check_register_partner_global_budget()`, writing directly to `platform_alerts_log`) and it was rejected in review because nothing ever read that table and sent an email; an exhausted ceiling would have just sat there unseen. The design that shipped instead adds a Phase 5 to the existing `supabase/functions/platform-health-check/index.ts` Edge Function (already scheduled on `pg_cron` every 15 minutes for Phases 1–4): it reads `rate_limit_config`/`rate_limits` directly and calls that function's existing `fireAlert()` (Mailgun email + `platform_alerts_log` write + 15-minute dedup) — see "Alert Delivery Mechanism" below. This migration itself creates no `pg_cron` job and no alert-writing function of its own.

`register_partner_service_role` (the Meta Lead Ads webhook's own bucket, added gh-2154 P-5r) is untouched.

---

## Alert Delivery Mechanism (why platform-health-check, not an in-request insert or a standalone SQL reconciler)

The very first draft of this fix (before this file's first version) inserted a `platform_alerts_log` row immediately before `RAISE EXCEPTION 'rate_limited: ...'`, inside `register_partner()`'s own body. **Verified empirically this session, against a local scratch Postgres 16, that this insert never persists:**

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

This is not a new problem this migration introduces — it already affects `check_rate_limit()`'s own bookkeeping. `check_rate_limit()` unconditionally tries to insert a `blocked=true` row into `rate_limits` on every refusal; that insert suffers the exact same rollback whenever the caller (like `register_partner()`) re-raises the failure from inside its own exception-bearing block. **Confirmed live** against `yeszghaspzwwstvsrioa`: `rate_limits.blocked` is `0/0` (zero blocked rows recorded, ever) for both `register_partner` and `track_referral_click` — the two PL/pgSQL RPCs that follow this same check-then-raise pattern — while Edge-Function callers of the same `check_rate_limit()` (e.g. `check-email-exists`, `create-docusign-envelope`), which call it as one plain SQL statement with no enclosing PL/pgSQL exception block, DO show real blocked-row counts (35 and 13 respectively). This confirms the mechanism, not just the theory — an alert cannot be written from inside `register_partner()`'s own body at all.

**The next design (D2, since superseded — do not implement this)**: a standalone SQL function, `check_register_partner_global_budget()`, scheduled on its own `pg_cron` job, reading the count of allowed `register_partner_global` calls (which persist reliably, since they're only ever written on the success path, which never rolls back) and writing a `platform_alerts_log` row directly. **REVIEW FAIL 5850688286 rejected this**: nothing in the codebase ever reads `platform_alerts_log` and turns a new row into an email or a page — that table is a record of alerts a *sender* already delivered, not a queue that triggers delivery on its own. As shipped in that draft, an exhausted global ceiling (every real signup refused) would have just sat in a table no one was watching.

**Fix that shipped**: no SQL-side reconciler and no new `pg_cron` job at all. `supabase/functions/platform-health-check/index.ts` — an existing Edge Function already scheduled on `pg_cron` every 15 minutes, and already the delivery path for four other kinds of platform alert (Phases 1–4) — gets a fifth phase (Phase 5, `runRegisterPartnerBudgetCheck`). It reads the last-hour and last-24h **allowed** (`caller_id IS NULL AND NOT blocked`) `register_partner_global` counts straight from `rate_limits`, reads the bucket's current limits from `rate_limit_config`, and — via the pure threshold logic in `register-partner-budget-check.ts` (unit-tested, 8/8 passing) — calls the SAME `fireAlert()` Phases 1–4 already use: real Mailgun delivery to Dustin, a `platform_alerts_log` write as a side effect (not the trigger), and the existing 15-minute dedup. Trade-off: alert delivery has a worst-case ~15-minute lag instead of being synchronous with the blocking event — the same trade-off the rejected SQL-reconciler design would have had, but this time riding a delivery path that is proven to actually send email. The block itself is unaffected either way: `register_partner()` still raises `rate_limited` to the caller in real time on every refusal, exactly as before this migration.

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
| `rate_limit_config` | 1 row updated (`register_partner`, superseding the interim 50/60/300), 3 rows inserted (`register_partner_test`, `register_partner_global`, `register_partner_no_ip`) — idempotent upsert | this migration |
| `referral_agents` | 36 total rows (30 from today alone) — migration touches none of them, only the function that inserts future rows | Supabase MCP, 2026-09-26 |
| `rate_limits` | append-only audit table, unaffected by this migration's own execution (only by future `register_partner()` calls) | — |

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|---|---|---|
| `CREATE OR REPLACE FUNCTION` ×2 (`rate_limit_client_key`, `register_partner`) | Catalog-only (`pg_proc` update) | <5ms each |
| `REVOKE` ×3 (all against `rate_limit_client_key`) | Catalog-only (ACL update) | <5ms each |
| `INSERT ... ON CONFLICT DO UPDATE` ×4 on `rate_limit_config` | Row-level, single-row upsert on a tiny config table | <5ms |
| `vault.create_secret(...)` (idempotency-guarded `DO` block) | Vault catalog insert, only on first apply | <5ms |

No table rewrite, no `ACCESS EXCLUSIVE` lock on any application table (`referral_agents`, `rate_limits`) — every statement is either a catalog/function change or a single-row upsert against a config table with one row per function name. This migration schedules no `pg_cron` job (see "Alert Delivery Mechanism" above).

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
| 9 | New function in `public` (default anon/authenticated EXECUTE grant) | **YES** — `rate_limit_client_key()` is new (the earlier draft's `check_register_partner_global_budget()` was removed before this fix shipped — see "Alert Delivery Mechanism" above; there is no second new SQL function) | **Addressed**: `rate_limit_client_key()` ships an explicit `REVOKE ALL ... FROM PUBLIC, anon, authenticated` in this migration. `register_partner()` itself is `CREATE OR REPLACE`, not new, so its existing grants are untouched. |

**All 8 numbered patterns clear; #9 triggered and closed in-migration.** The one load-bearing risk not on the standard list is the RPC-behavior-change risk named in the Tier classification above: could this change ever refuse a REAL signup the old code would have allowed? This is **not strictly more permissive** — an earlier version of this file claimed that, which was wrong once the numbers are compared to what was actually live. As of this re-review the live `register_partner` row is the **interim #2154 mitigation (50/hour, 60/day)**, applied same-day as a stopgap; this migration's per-client row (8/hour, 20/day) is *tighter* than that for any single client than the interim shared ceiling was for the platform combined. What changes for the better: that interim 50/60 was one pool every real client drew from together, so one busy office could still crowd out another; per-client keying means each client's own 8/20 is independent of everyone else's traffic, and the actual abuse backstop moves to `register_partner_global` (500/day, well above the interim's 60/day) plus the new `register_partner_no_ip` bucket for the no-derivable-IP edge case. Net effect for ordinary traffic: a legitimate single-office signup burst above 8/hour or 20/day is a new way to get throttled that didn't exist under the interim value; a legitimate signup blocked by *someone else's* QA/traffic volume, which is what caused the 2026-09-26 outage, is no longer possible.

## Code Path Impact Analysis

- **P-1 browser signup forms** (`partner-re/insurance/inspectors/adjusters/other.html`, and the newer `re-1/ins-1/hi-1/re-5/hi-5.html` funnel pages) — call `register_partner()` as anon/authenticated with no `p_is_test`/`p_meta_lead_id` override honored (unchanged). Behavior change observable to them: a real signup that would have been refused under the interim shared-bucket math (someone else's traffic — QA or another real client — ate the shared 50/hr+60/day budget) is now refused only if THEIR OWN IP is over its own 8/hour+20/day, or the platform-wide `register_partner_global` (500/day) or `register_partner_no_ip` (for the rare no-derivable-IP case) ceiling is hit. This is not uniformly more permissive (see the danger-pattern-table note above: a single client bursting past 8/hour+20/day is newly throttled where the interim value would have allowed it, up to the interim's own shared 50/60), but it is what closes the specific 2026-09-26 incident: no real client can ever again be blocked by unrelated traffic's volume.
- **`meta-leadgen-webhook`** (service_role caller) — completely unaffected; still keys off `register_partner_service_role`, a bucket this migration does not touch.
- **`partner-invite-accept`** and any other caller of `register_partner()` — signature is unchanged, so no caller needs a code change.
- **QA / video-recording / CI traffic** (`@otterquote-internal.test` or any `is_test_email()`-matching address) — now draws from `register_partner_test` (100/hour, 300/day) instead of competing with real traffic. This is the direct fix for today's incident.

## Supabase Branch Test Results

**Not run against a live Supabase branch** (no `create_branch`/`apply_migration` call this session — SELECT-only per program rules). Instead, both forward and rollback SQL were verified against a **local scratch Postgres 16.13** instance this session, with a hand-built schema matching the live `rate_limit_config`/`rate_limits`/`platform_alerts_log`/`referral_agents` columns (pulled via `information_schema.columns`) and stub `auth.uid()`/`auth.role()`/`vault.*`/`extensions.hmac`/`extensions.gen_random_bytes` functions:

- Forward migration (`gh2154_register_partner_rate_limit_fix.sql`), applied against a scratch DB seeded with the **live interim `register_partner` row (50/hr, 60/day, 300/month, #2154)**: applied cleanly. ✅
- Forward migration re-applied a second time (idempotency check): applied cleanly, no errors, upserts left exactly 4 config rows (`register_partner`, `register_partner_test`, `register_partner_global`, `register_partner_no_ip`), and exactly one `rate_limit_ip_salt` Vault secret survived. ✅
- Rollback (`gh2154_register_partner_rate_limit_fix_rollback.sql`): applied cleanly against the post-forward state, restored the `register_partner` row to the **interim 50/60/300** (not the original pre-interim 10/30/300 — F2), and removed all three new config rows. ✅
- Forward migration re-applied a third time after the rollback: applied cleanly, config rows restored to the per-client design. ✅
- `python3 scripts/credential-sweep.py --root .`: 0 findings (F1 — the 32-hex-char hash that previously tripped `HEX_RUN_20` is gone). ✅
- Full behavioral test harness (`gh2154_register_partner_rate_limit_fix.test.sql`, using the REAL `check_rate_limit()`/`is_test_email()`/`rate_limit_client_key()`/`register_partner()` function bodies against a scratch `gh2223_test` database, run via `psql`): **all steps PASSED**, specifically —
  - a real signup is refused **only** when its own per-client key exceeds the limit (steps 1–2: IP-A's 4th signup refused while IP-B's signup from a fresh key succeeds immediately, and the shared `register_partner_global` bucket is nowhere near its own ceiling at that point);
  - test signups **never** consume or get blocked by the real budget, and the test bucket is itself per-client (step 3: 6+4 `@otterquote-internal.test` signups from the already-exhausted IP-A all succeed until IP-A's own test allowance is hit, a different client (IP-B) is unaffected);
  - the global ceiling still catches many-IP abuse (step 4) and the config upserts are idempotent (step 5);
  - the D1 spoofing negative control (step 7): a forged left-most `X-Forwarded-For` hop does not create a new bucket when `cf-connecting-ip` is fixed;
  - the no-IP fallback bucket (step 8, new in this fix round): a signup with no headers at all draws from `register_partner_no_ip`, not from the per-client `register_partner` bucket that other steps have already exhausted for their own keys.

This local-scratch verification is a stand-in for, not a substitute for, an actual `create_branch`/`apply_migration` dry run against `yeszghaspzwwstvsrioa` — recommended as the next step for whoever applies this after approval, per the repo's own migration-author skill (Step 6).

## Deploy Notes

- **Tier**: 3B (see above). **DRAFT ONLY. NOT APPLIED.**
- **R-097 window**: not posted (program rule against filing new GitHub issues this session). Flagged in the PR body for Ben/Dustin.
- **Deploy path once approved**: D-221 Path A — GitHub PR → CI green → merge → `apply_migration` against `yeszghaspzwwstvsrioa` (manual, gated on Tier-3B sign-off).
- **Rollback pre-authorized**: yes — `gh2154_register_partner_rate_limit_fix_rollback.sql`, verified above. Re-opens the exact defect this migration fixes (single shared bucket) — only run it if this fix is found to have broken something worse than today's incident.
- **Post-apply verification**: (1) `select * from rate_limit_config where function_name like 'register_partner%'` — 5 rows (`register_partner`, `register_partner_test`, `register_partner_global`, `register_partner_no_ip`, `register_partner_service_role`, the last untouched); (2) a real-looking signup from a fresh IP succeeds; (3) an `@otterquote-internal.test` signup succeeds even if the real per-client/global buckets are saturated; (4) manually invoke `platform-health-check` once (or wait for its next 15-min `pg_cron` tick) and confirm the JSON response includes `"registerPartnerBudgetChecked": true` with `registerPartnerBudgetSkipped: null` — this is the D2 Phase 5 alert path, not a `pg_cron` job of this migration's own (there is none to check for); (5) confirm new `rate_limits` rows for `register_partner` carry a non-null, varying `caller_id` (the reviewer's no-IP-fallback caveat — a stuck-NULL `caller_id` on the `register_partner` function_name itself, rather than on the new `register_partner_no_ip` bucket, would mean `rate_limit_client_key()` is silently failing, e.g. a missing Vault secret).
- **Monitoring**: watch `platform_alerts_log` for `rate_limit_global_warning`/`rate_limit_global_exhausted` rows for the first 24–48h post-launch of the remaining partner funnels; watch Sentry for any unexpected `rate_limited` errors on real (non-`@otterquote-internal.test`) signups.
- **Immediate mitigation status**: the same-day #2154 interim mitigation (raising the single shared `register_partner` row from 10/hr+30/day to 50/hr+60/day) has already been applied live as of this re-review — confirmed by SELECT against `yeszghaspzwwstvsrioa`. This migration's forward SQL supersedes that interim row with the per-client/test/global/no-IP design above; its rollback restores the interim 50/60/300, not the original pre-interim 10/30/300 (F2).

## Danger Overrides

None.
