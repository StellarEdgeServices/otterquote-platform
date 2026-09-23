# Pre-Flight: 20260923211259_gh2122_leads_details_consent

**Migration**: `supabase/migrations/20260923211259_gh2122_leads_details_consent.sql`
**Rollback**: `supabase/migrations_rollbacks/20260923211259_gh2122_leads_details_consent_rollback.sql`
**Date**: 2026-09-23
**Author**: Kevin, Code lane (`rw-f22-20260923T205250-a2f6`, under `ceo-2026-09-23T18:56:07Z`)
**Authorised by**: Ben, CEO RUN 66, "A: MIGRATION: GO" on #2122 (comment 5802853627), answering Q 5802781694
**Tier**: 3A (additive), D-261. No R-097 window, per that ruling.
**Issue**: #2122 (Arm F, checklist row 1.1 on #2121)

## Change summary

Arm F saves a homeowner lead in four taps before any account exists. Production `public.leads` has no place to keep what it collects (the funding answer, the property address, the Meta browser ids) and no place to keep the D-299 TCPA consent evidence. This migration adds four nullable `leads` columns, a `lead_consents` evidence table, one SECURITY DEFINER function that is the only write path, and the `rate_limit_config` row for the new Edge Function. The Edge Function (`supabase/functions/record-lead-details`, same PR) reads the client IP from the request headers and calls the function with the service role.

## Live measurements this run (production `yeszghaspzwwstvsrioa`, read-only, 2026-09-23)

| Check | Result |
|---|---|
| `information_schema.columns` for `public.leads` | 21 columns; none for funding, address, fbc, fbp, or consent |
| Tables matching `%consent%` or `%tcpa%` | none |
| `pg_constraint` on `public.leads` | 7 (pkey, converted_user_id FK, 3 length CHECKs, role CHECK, partner_industry CHECK) |
| `leads` row count | 88 (17 `is_synthetic`, 71 NULL) |
| Triggers on `leads` | `trg_leads_force_safe_insert_defaults` (BEFORE INSERT), `trg_notify_admin_new_router_lead` (AFTER UPDATE, role NULL to non-NULL) |
| Anon INSERT policies naming a suitable evidence sink | none (`activity_log` is user-scoped) |

## Row count and lock estimate

| Table | Rows | Operation | Lock | Estimate |
|---|---|---|---|---|
| `leads` | 88 | 4x `ADD COLUMN` nullable, no default | ACCESS EXCLUSIVE, catalog-only, no rewrite | well under 1 second |
| `lead_consents` | 0 (new) | `CREATE TABLE`, enable RLS | none on existing tables | instant |
| `rate_limit_config` | small | one `INSERT ... ON CONFLICT DO NOTHING` | row lock | instant |

## Danger pattern check (migration-author-code Step 1)

| # | Pattern | Triggered? | Note |
|---|---|---|---|
| 1 | NOT NULL column with no DEFAULT | No | the 4 new `leads` columns are nullable; `lead_consents` is a new table |
| 2 | NOT NULL on a table over 100K rows | No | `leads` has 88 rows |
| 3 | Drop a column | No | (rollback only) |
| 4 | Type change / table rewrite | No | |
| 5 | Index on a hot table without CONCURRENTLY | No | no index created; the one unique constraint is on a new empty table |
| 6 | RENAME | No | |
| 7 | TRUNCATE / DELETE all | No | |
| 8 | CASCADE DROP | No | no CASCADE anywhere; the FK is `ON DELETE RESTRICT` |
| 9 | New public function | **Yes, handled** | `REVOKE ALL ... FROM PUBLIC, anon, authenticated` then `GRANT EXECUTE ... TO service_role` only; `has_function_privilege` probes and `proacl` read below. The same is done for the new table's grants. |

## Explicit non-changes (Ben's ruling)

`leads_force_safe_insert_defaults` and its trigger, `trg_notify_admin_new_router_lead`, and every RLS policy on `leads` are untouched, and no CHECK constraint is added to `leads` (see `20260918122231_gh2011_leads_variant.sql` for why). Proven below by trigger, policy and constraint counts before and after.

## Test method, and why it is not a Supabase branch

Ben asked for both halves to be proven on a Supabase branch. A Supabase branch is a paid resource whose creation needs a cost confirmation, and spending money is not this lane's to authorise. It also has a recorded failure mode (fresh branches replay the whole migration history and report MIGRATIONS_FAILED). The proof was run instead on a **throwaway PostgreSQL 15.19 in Docker**, against a stub schema that reproduces the parts of production this migration touches: `leads` exactly as measured above (21 columns, 7 constraints, both triggers, the anon insert policy), `rate_limit_config`, and **Supabase's default privileges for `anon`, `authenticated` and `service_role`** so the REVOKEs are genuinely needed. If a branch is still wanted, say so and it is a one-command re-run of the same scripts against that branch. The scripts and their full output are in the PR comment.

Sequence run: stub schema, schema fingerprint captured, forward applied twice, forward checks, behaviour checks with role probes, rollback attempted while evidence rows exist (refused), forward state re-checked intact, evidence rows deleted, rollback attempted again with the `leads` columns still populated (refused), forward state re-checked intact, the columns NULLed, rollback applied, fingerprint compared, forward re-applied, forward checks again.

**Result: 103 PASS, 0 FAIL** (the run was repeated after an independent review, which added a second rollback refusal; see below).

Key lines:

- Forward applied twice with no error (idempotent).
- `has_function_privilege('anon', ...) = false`, `has_function_privilege('authenticated', ...) = false`, `has_function_privilege('service_role', ...) = true`.
- `proacl = {postgres=X/postgres,service_role=X/postgres}` (no PUBLIC, anon or authenticated entry).
- `anon` and `authenticated` hold no privilege on `lead_consents`; negative probes as `anon` and `authenticated` get `permission denied` for `EXECUTE record_lead_details`, `SELECT lead_consents`, and `INSERT` of forged evidence.
- The RPC did not fire the new-lead alert trigger and never wrote `role`.
- First write wins: a second call did not overwrite funding, address or fbc, and did not add a second evidence row.
- A lead older than 30 minutes, a redeemed lead (`prefill_used_at` set) and an unknown lead id each return `false` and write nothing.
- Unknown funding becomes NULL (no error); address, fbc, consent text, page URL, user agent and IP are capped.
- A lead that has consent evidence cannot be deleted (`ON DELETE RESTRICT`).
- Rollback was **refused** while `lead_consents` held rows; the forward state was fully intact afterwards. With the evidence rows deleted but the new `leads` columns still populated it was **refused a second time**, and the forward state was again fully intact. After both were cleared deliberately (`DELETE FROM public.lead_consents`, then `UPDATE public.leads SET funding_type = NULL, property_address = NULL, fbc = NULL, fbp = NULL`) the rollback applied, all fixture `leads` rows survived, and **the schema fingerprint was identical to the pre-migration fingerprint**. Re-applying forward afterwards passed every forward check again.

**Negative control for the proof itself.** The same migration with both `REVOKE` statements removed was run through the same checks: **8 FAIL** (`anon can EXECUTE`, `authenticated can EXECUTE`, table grants leaked, `proacl` carrying `=X`, `anon=X`, `authenticated=X`, and four behaviour probes where `anon` and `authenticated` succeeded in executing the function and reading the table). So the REVOKEs are load-bearing and the probes detect their absence.

## Repo gates run locally on this diff

`scripts/permissions-ratchet.py --check-file`: GATE PASS (both `REVOKE` lines and both `GRANT ... TO service_role` lines pass). `scripts/migration-filename-lint.py`: PASS (147 files, 0 violations). `scripts/schema-column-lint.py`: PASS (0 violations). `scripts/migrations-reconciliation-check.py`: informational only, not gated. `deno test --allow-read=supabase/functions supabase/functions/record-lead-details/`: 22 passed, 0 failed, with 7 mutations each caught.

## Deploy notes (an executive or the CTO applies; this PR applies nothing)

1. Apply the migration. It is D-221 Path A; the migration is not applied by the PR.
2. Deploy the Edge Function `record-lead-details` **after** the migration (its RPC and `rate_limit_config` row must exist first, or every call fails; with no config row `check_rate_limit()` fails CLOSED). Deploy with the Supabase CLI, not the MCP `deploy_edge_function` (known to corrupt some byte runs), and byte-verify the deployed body after. `verify_jwt = false` is pinned in `supabase/config.toml` in this PR.
3. Refresh `sql/schema-snapshot.json` after applying (the repo convention when a migration lands).
4. Only then merge the client PR (`wm/gh-2122-arm-f`). Until the function is deployed, the client's details call fails and retries once, then reports to Sentry; the lead itself is still saved.
5. `edge-function-drift.yml` will report `record-lead-details` as in the repo but not deployed until step 2 is done. That is expected mid-flight, not a defect.
6. Rollback order is written at the top of the rollback file: stop the client, undeploy the function, then run the rollback. The rollback refuses to run while `lead_consents` holds rows.

## Decisions for the reviewer to confirm or overrule

1. **`lead_consents.lead_id` is `ON DELETE RESTRICT`** (Ben's ruling named the FK, not the delete rule). TCPA evidence should outlive casual cleanup. No code path deletes from `leads` today (the 2026-09-22 leads-delete pass on #2096 found none), so nothing existing is blocked. The alternative is `ON DELETE SET NULL` with a nullable `lead_id`.
2. **`verify_jwt = false`**, like `check-email-exists`. supabase-js sends a stale expired session token, when one is in the cookie, in place of the anon key, and a verified-JWT gate would then drop a real lead's consent record. Protection is the per-IP rate limit, the 30-minute unredeemed-lead guard in the RPC, and first-write-wins.
3. **Rate limit 30/hour, 100/day, 1000/month per IP bucket.** A judgment call; a visitor makes one call, two with the single retry, and carrier or in-app-browser NAT can put many visitors behind one IP.
4. **No admin read policy on `lead_consents`.** Ben's ruling said RLS on with no anon SELECT. Reads go through the service role or the dashboard. If Dustin needs to read it as an authenticated admin in the app, that is a follow-up policy (`is_admin_email()`, like `leads_admin_select`), not part of this migration.
5. **A `consent_given = false` row is stored too.** It is evidence of what was displayed when the visitor did not tick the box. The checkbox is not a condition of submitting (the approved line itself says consent is not a condition of purchase).
6. **The rollback deliberately refuses to run once evidence rows exist, or once any `leads` row holds a value in the four new columns.** It also takes a SHARE lock on `lead_consents` before counting, so an insert in flight cannot commit between the count and the DROP.
7. **First recorded consent outcome wins** (`ON CONFLICT DO NOTHING`). Safe for Arm F because the client sends the consent record exactly once per submission and its retry re-sends the identical record; a later call with a different `consent_given` for the same lead and key would be dropped.

## Finding for the CEO/CTO: the new `leads` columns are not write-protected (needs a Tier 3B decision, not made here)

An independent review of this PR (fresh context, `MIGRATION-REVIEW: PASS`, no blocking finding) confirmed a consequence of the constraints this migration was given. The anon and authenticated INSERT policy on `public.leads` is unchanged, table-level INSERT is granted, and the BEFORE INSERT guard nulls only `created_at`, `converted_user_id`, `role`, `partner_industry` and `alerted_at`. So **a direct insert through the public API can still set `funding_type`, `property_address`, `fbc` and `fbp` to any value and any length**, and because `record_lead_details()` is first-write-wins, such a pre-set value is kept, not normalised. The consent evidence table is NOT exposed this way (RLS on, no policy, roles revoked). Mitigation in this PR: the column comments say the columns are untrusted input. **Recommended follow-up (Tier 3B, because it edits `leads_force_safe_insert_defaults()`, which the ruling put out of scope): extend that guard to null the four columns on insert**, so the RPC becomes their only writer. Until then, anything that reads `funding_type` or `property_address` must not trust it.

## Independent review, and what changed because of it

A fresh-context reviewer read the diff and ran the Deno tests (it could not run the SQL). It returned no blocking finding. Its should-fixes were adopted: the rollback lock, the second rollback guard (columns), the corrected column comments, the first-outcome-wins note, NUL stripping and surrogate-safe truncation in the Edge Function (2 more tests). Two nits are recorded, not changed: `getClientIp` falls back to the first `x-forwarded-for` hop exactly like `check-email-exists` (so the stored IP is spoofable only if `cf-connecting-ip` is ever absent), and the rate limit could 429 a visitor behind heavy NAT (the client retries once).

## Danger overrides

None.
