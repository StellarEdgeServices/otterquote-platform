<!-- STATUS (gh-1438, as of 2026-10-30T21:00:00Z): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh3259_referrals_revoke_status_job_value (forward and rollback beside it) -->
<!-- EVIDENCE: drafted 2026-10-30 under #3259; production read-only (SELECT) the same day, project yeszghaspzwwstvsrioa; no database was written. -->
<!-- REPO COPY: none. DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh3259_referrals_revoke_status_job_value (#3259)

Tier 3B: removes a read capability from `authenticated`. Follows the R-097 24-hour notice. Project P18.

## 1. What changes

| | before (production, 2026-10-30) | after |
|---|---|---|
| `has_column_privilege('authenticated','public.referrals','job_value','SELECT')` | true | **false** (closes-on query) |
| `has_column_privilege('authenticated','public.referrals','status','SELECT')` | true | **false** |
| `attacl` of `referrals.job_value` and `referrals.status` | `{authenticated=r/postgres}` | NULL |
| authenticated SELECT on `id, created_at, referral_agent_id, commission_amount, recruit_commission_amount` | true | true (unchanged) |
| table ACL, INSERT/UPDATE/DELETE, RLS policies | as live | unchanged |
| `get_my_referrals()`, `admin_list_referrals()` | SECURITY DEFINER, owner postgres | unchanged, and still answer (see 3) |

`anon` holds neither column before or after. The forward names it only so that the post-assertion covers both client roles.

## 2. Caller inventory at origin/main 0b6b1d98 (every client read of `referrals.status` / `referrals.job_value`)

Searched for `from('referrals')`, `"referrals"`, `/rest/v1/referrals`, and every `get_my_referrals` / `admin_list_referrals` call. The search covered the static HTML/JS, `react-app/`, and `supabase/functions/`.

| caller | key | reads status/job_value directly? | effect of this migration |
|---|---|---|---|
| `partner-dashboard.html:2370` `loadStats()` `.select('status, job_value, commission_amount')` | partner JWT | **yes** | Returns 42501 and the four stat cards stay unpopulated (the page catches the error). **PR #3258 removes this read** and uses the `get_my_referrals()` rows instead. Hence the gate. |
| `partner-dashboard.html:2432` recruit earnings `.select('referral_agent_id, recruit_commission_amount')` | partner JWT | no | none |
| `react-app/app/partner/dashboard/page.tsx:150` recruit earnings, same columns | partner JWT | no | none |
| partner dashboard tables (static + React), `refer-a-friend.html`, React `/refer` | partner JWT | no: `rpc('get_my_referrals')` since #3217 | none (SECURITY DEFINER) |
| `admin-referrals.html:677/730` | admin JWT | no: `rpc('admin_list_referrals')`, which renders `job_value` | none (SECURITY DEFINER) |
| React `/admin/referrals` | admin JWT | no: reads `referral_agents` only | none |
| `ref.html`, `ref-inspector.html`, `ref-re.html`, `ref-insurance.html` | anon | no: inserts go through the record-referral path (gh-2472). No reads. | none |
| edge functions `approve-payout`, `get-business-lines-dashboard`, `get-payout-completion-status`, `mark-job-complete`, `mark-payout-paid`, `send-partner-status-email` | service role (`mark-job-complete` uses the anon key only for `auth.getUser()`) | n/a | none |

Production catalog check, read-only: no view depends on `referrals`, no SECURITY INVOKER function outside triggers reads it, and no RLS policy on another table references it. The only invoker trigger function is `update_referral_stats()`, which fires on writes, and writes come from service_role or definer paths. In the two tables of section 1, a partner's direct `select('*')` was already refused before this change, because the contact columns were revoked under #3217 B.

**Gate.** The forward refuses (P0A92) unless the apply transaction first runs `SET LOCAL gh3259.frontend_published = 'yes';`. Run that statement only after PR #3258's `partner-dashboard.html` is deployed and smoke-tested. #3258 is the only change needed: the read in the first row is the one direct read.

## 3. get_my_referrals() is unaffected (confirmed)

`get_my_referrals()` is `SECURITY DEFINER`, owned by `postgres`. It reads `referrals` with its owner's privileges, so the caller's column grants do not apply. The proof checks this three ways:
- Phase 0–5: on the production body (gh3217a, prosrc md5 `e63684bf…` = production), it returns status and job_value before and after the revoke.
- Phase 6: on #3255 + #3258's gh3241 → gh3257 bodies, read from PR #3258's head, it returns the same rows before and after. Those rows have `job_value` NULL and status NULL for an opted-out row.
- The `rpc_invoker` mutant flips the function to SECURITY INVOKER. That breaks the RPC after the revoke, which proves the property is what carries it. The forward also refuses (P0A93) if the function is missing or not SECURITY DEFINER.

The order is free: #3255/#3258 replace only the function body, and this file touches only grants.

## 4. Apply

1. #3258's frontend is deployed. Smoke-test `/partner-dashboard.html`: the stats load, and the network tab shows no `referrals?select=status`.
2. Run this, as `postgres`:
   ```
   BEGIN; SET LOCAL gh3259.frontend_published = 'yes'; <forward body without its BEGIN/COMMIT>; COMMIT;
   ```
3. Run the closes-on query: `select has_column_privilege('authenticated','public.referrals','job_value','SELECT')` returns `false` (was `true`), and the same holds for `status`.
4. Smoke-test `/partner-dashboard.html`, React `/partner/dashboard`, `/refer-a-friend.html`, React `/refer` and `/admin-referrals.html`.
5. File the forward under its ledger version in `supabase/migrations/`, and move the rollback and pre-flight to `supabase/migrations_rollbacks/`.

## 5. Rollback

Run `gh3259_referrals_revoke_status_job_value_rollback.sql` as `postgres`. It runs `GRANT SELECT (status, job_value) ON public.referrals TO authenticated`, grantor postgres. The proof shows the catalog afterwards is identical to the pre-forward snapshot, and that running it twice is safe.

## 6. Proof

`PGHOST=… PGPORT=… PGUSER=postgres bash supabase/tests/gh3259_referrals_column_revoke_proof_run.sh`. Run it on a throwaway PG16 only.

The scratch setup recreates the live columns, ACLs (MAINTAIN is omitted: it is PG17-only), and policies. A partner session is `SET ROLE authenticated` plus `request.jwt.claims`, as PostgREST does it.

| phase | result |
|---|---|
| BEFORE (negative control) | The partner reads `job_value` (18450.00) and `status` directly. |
| GATE | Without the operator statement the forward is refused and the catalog is unchanged. |
| AFTER | `job_value`, `status`, filtering on `status`, the old `loadStats` select and a homeowner session all get `ERR 42501`. Unchanged: the allowed columns, the recruit read, RLS isolation, `get_my_referrals()`, `admin_list_referrals()`, service_role and anon. |
| RERUN | Same as AFTER, catalog unchanged. |
| ROLLBACK | Catalog identical to BEFORE; probe output identical to BEFORE; running it twice is safe. |
| REAPPLY | Same as AFTER. |
| GH3257 | See section 3. |
| Mutants | 15/15 killed: 11 forward, 4 rollback. |

## 7. Not in scope (flagged)

- `commission_amount` stays readable. On an opted-out row, a non-NULL fee implies the job reached completion. That is consistent with #3258, which keeps the fee fields for every row under the same ruling, but it is a weak status signal. Changing it is a product/legal call, not part of this issue.
- The recruit-earnings read on both partner dashboards asks for *recruits'* referrals. The RLS policy only returns the caller's own rows, so that read already returns nothing. This is pre-existing and unchanged here.
