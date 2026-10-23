<!-- STATUS (gh-1438, as of 2026-10-23): NOT APPLIED -->
<!-- EVIDENCE: production read-only (Supabase MCP execute_sql, SELECT only) 2026-10-23: no contractor-sms-verify-* row in rate_limit_config. No database was written. -->
<!-- REPO COPY: none. When applied, file the forward under its real ledger version in supabase/migrations/. -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->
# Pre-flight: gh2875_contractor_sms_verify_rate_limits (#2875, D-391 layer 2 rate-limit rows)

Additive, Tier 3A in shape: two `INSERT ... ON CONFLICT (function_name) DO NOTHING` rows in `public.rate_limit_config`. No DDL, no GRANT, no RLS, no function change.
Draft only: applied under the #2875 rollout runbook (`In Flight/reports/cto77-w2875r-20261023.md` §5 step 8) after REVIEW and merge, by the CTO's recorded apply. Not applied by this PR.

## Why it is needed
`contractor-sms-verify` (handler.ts L32-33, L238-245 at `c7162ab60f422ee0 (main, #3043 merge)`) calls `check_rate_limit('contractor-sms-verify-start' | 'contractor-sms-verify-check', bucket)` for the account bucket and then the number bucket. `check_rate_limit` returns `allowed: false` when no config row exists, so without these rows every request is answered 429 `rate_limited`.

## Values and their source
| key | hour / day / month per bucket | cost per row | monthly cap (global) | source |
|---|---|---|---|---|
| `contractor-sms-verify-start` | 5 / 10 / 30 | 0.0292 | 10.00 | handler.ts L32 (key), L239-244 (2 calls per request, account + number bucket); #2875 spec "6 digits / 10 min / 5 attempts"; REVIEW 6323770893 / 6323942779 (number-bucket burn: size the row); cost = ($0.05 Verify success + $0.0083 SMS) / 2 rows per send; same shape as live `send-sms` 0.0079 / 4.00 |
| `contractor-sms-verify-check` | 10 / 30 / 100 | 0.0000 | 0.00 (no cap) | handler.ts L33 (key), L264-266 (Twilio's own 5-checks-per-code 429 maps to too_many_attempts); a check sends nothing |

Windows are fixed by the live limiter (rolling 1 hour, 1 day, 1 month per `caller_id`; the budget cap counts every non-blocked row for the name across all callers): `check_rate_limit(text,uuid)` md5 `905e1e5378a90834 (first 16 hex)`, read 2026-10-23.

What the numbers mean in practice:
- One account + one number: 5 code sends an hour, 10 a day, 30 a rolling month. A code lives 10 minutes.
- Burn (any signed-in owner can spend another number's bucket): the number is refused for at most 1 hour after 5 starts, 1 day after 10, or a rolling month after 30, and 30 starts also spend the burner's own whole month. Proof Q4.
- Budget: new sends stop at 343 global rows (343 x 0.0292 = 10.0156 >= 10.00), about 171 code texts a month across all contractors. Proof Q13/Q14. Raise the cap with an UPDATE if real signups approach it; an attacker with several accounts can reach it, which stops verification (fails closed, no texts) until rows age out.

## Pre-flight measured 2026-10-23 (production yeszghaspzwwstvsrioa, SELECT only)
- `rate_limit_config`: 41 rows; `count(*) WHERE function_name LIKE 'contractor-sms-verify%'` = 0. `rate_limits` rows for those names = 0.
- `rate_limit_config` columns: function_name text PK; max_per_hour/day/month integer NOT NULL; enabled boolean default true; monthly_cost_estimate numeric(10,4); monthly_budget_cap numeric(10,2); notes, alert_sent_month, notes_alert text.
- `check_rate_limit(text,uuid)` md5 `905e1e5378a90834 (first 16 hex)`.

## Re-check immediately before apply
The same three reads. If a `contractor-sms-verify-*` row now exists, the forward leaves it as it is and prints a NOTICE; compare it to the table above before deciding.

## After apply
- `SELECT function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap FROM public.rate_limit_config WHERE function_name LIKE 'contractor-sms-verify%' ORDER BY 1;` returns exactly the two rows above.
- Negative control (rolled back, no row survives): `BEGIN; SELECT public.check_rate_limit('contractor-sms-verify-start', gen_random_uuid()) ->> 'allowed'; SELECT public.check_rate_limit('contractor-sms-verify-nope', gen_random_uuid()) ->> 'allowed'; ROLLBACK;` gives `true` then `false`.

## Proof (throwaway Postgres, never production)
`PGBIN=/usr/lib/postgresql/16/bin bash supabase/tests/gh2875_contractor_sms_verify_rate_limits_proof_run.sh` on PostgreSQL 16, 2026-10-23: `ALL EXPECTATIONS HOLD`, exit 0.
The stub carries production's table shape and the live `check_rate_limit` body; the runner checks its md5 equals production's `905e1e53...`. Databases: TODAY (NEGATIVE CONTROL: every request refused, "No rate limit config found"), AFTER, TWICE (idempotent), PREEXIST (an existing row is kept, NOTICE printed), MUTANT_HR and MUTANT_CAP (the probes flip when the hourly value or the cap changes), ROLLBACK and ROLLBACK2 (back to TODAY; the unrelated `send-sms` row untouched).

## Danger patterns
None of the nine triggered: no NOT NULL column, no DROP, no type change, no index, no RENAME, no unqualified DELETE (the rollback deletes two named rows), no CASCADE, no new function.

## Rollback
`gh2875_contractor_sms_verify_rate_limits_rollback.sql` deletes the two rows. Effect: the function is back to 429 for everyone (fail closed). No function change is needed. `rate_limits` history rows stay.

## Deploy order
Before, or together with, the first deploy of `contractor-sms-verify`. Applying it earlier is harmless: nothing else reads these names.
