# Pre-Flight: 20260923211259_gh2122_leads_details_consent

**Migration**: `supabase/migrations/20260923211259_gh2122_leads_details_consent.sql`
**Rollback**: `supabase/migrations_rollbacks/20260923211259_gh2122_leads_details_consent_rollback.sql`
**Date**: 2026-09-23
**Author**: Kevin, Code lane (`rw-f22-20260923T205250-a2f6`, under `ceo-2026-09-23T18:56:07Z`)
**Authorised by**: Ben, CEO RUN 66, "A: MIGRATION: GO" on #2122 (comment 5802853627), answering Q 5802781694
**Tier**: 3A (additive), D-261. No R-097 window, per that ruling.
**Amended by**: Ben's ruling on Kevin's HANDOFF-LIVE, #2122 comment 5803524541: the insert guard `leads_force_safe_insert_defaults()` gains exactly four lines. Protective fix, constitution entry 4 / R-134, executed with a notice and no 24-hour wait (that comment is the notice).
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
| Policies on `leads` | `Allow anonymous inserts` (INSERT, anon + authenticated, `WITH CHECK (true)`), `leads_admin_select` (SELECT, authenticated, `is_admin_email()`); **no UPDATE policy** |
| Table grants on `leads` | anon: INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE (no UPDATE, no DELETE); authenticated: table-level UPDATE and DELETE but no policy to use them |
| `leads_force_safe_insert_defaults()` | SECURITY DEFINER, `search_path = public, pg_temp`, owner `postgres`, ACL `{postgres=X/postgres,service_role=X/postgres}`, five assignments (`created_at`, `converted_user_id`, `role`, `partner_industry`, `alerted_at`); `md5(prosrc) = 61d154d12d28801c788825ef18199a2a` |
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

## The one change to an existing object, and the non-changes (Ben's rulings)

**Changed, by Ben's ruling 5803524541:** the guard function `leads_force_safe_insert_defaults()` gains exactly four assignment lines, `NEW.funding_type`, `NEW.property_address`, `NEW.fbc` and `NEW.fbp` set to NULL. Its five existing assignments, SECURITY DEFINER, pinned search_path, owner and ACL are unchanged. The proof diffs the function definition before and after: **4 lines added, 0 removed**, and compares the metadata field by field. `CREATE OR REPLACE` keeps the ACL and the function comment. The rollback restores the original body first.

**Not changed:** the trigger `trg_leads_force_safe_insert_defaults`, `trg_notify_admin_new_router_lead`, every RLS policy on `leads`, and no CHECK constraint is added to `leads` (see `20260918122231_gh2011_leads_variant.sql` for why). Proven below by trigger, policy and constraint counts before and after.

## Test method, and why it is not a Supabase branch

Ben asked for both halves to be proven on a Supabase branch. A Supabase branch is a paid resource whose creation needs a cost confirmation, and spending money is not this lane's to authorise. It also has a recorded failure mode (fresh branches replay the whole migration history and report MIGRATIONS_FAILED). The proof was run instead on a **throwaway PostgreSQL 15.19 in Docker**, against a stub schema that reproduces the parts of production this migration touches: `leads` exactly as measured above (21 columns, 7 constraints, both triggers, the anon insert policy), `rate_limit_config`, and **Supabase's default privileges for `anon`, `authenticated` and `service_role`** so the REVOKEs are genuinely needed. If a branch is still wanted, say so and it is a one-command re-run of the same scripts against that branch. The scripts and their full output are in the PR comment.

Sequence run: stub schema, schema fingerprint captured, forward applied twice, forward checks, behaviour checks with role probes, rollback attempted while evidence rows exist (refused), forward state re-checked intact, evidence rows deleted, rollback attempted again with the `leads` columns still populated (refused), forward state re-checked intact, the columns NULLed, rollback applied, fingerprint compared, forward re-applied, forward checks again.

**Result: 120 PASS, 0 FAIL** (repeated after the independent review, which added a second rollback refusal, and again after Ben's guard ruling).

**Fidelity of the stub.** The stub's guard function is byte-identical to production: `md5(prosrc)` of the stub equals the production value `61d154d12d28801c788825ef18199a2a`, asserted by the runner. Table policies and grants on `leads` mirror the production read above. The runner sends SQL to `psql` as **bytes**, because Windows text-mode pipes rewrite LF to CRLF and would otherwise make function bodies differ from production.

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
- **The guard extension:** a direct anon INSERT that sets `funding_type`, `property_address`, `fbc` or `fbp` lands NULL, one probe per column, and a single insert setting all four lands with all four NULL. The five existing forced columns behave as before (`role`, `alerted_at`, `converted_user_id`, `partner_industry` NULL and `created_at = now()` even when the insert supplies `'2001-01-01'`), and unrelated columns (`name`, `email`) are untouched. `record_lead_details()` still populates the four columns on a row that started NULL, so it is their only writer. There is no UPDATE path: as `anon`, `UPDATE` is `permission denied` (no grant), and as `authenticated` it touches 0 rows (RLS, no UPDATE policy), leaving the stored address unchanged.
- The guard's SECURITY DEFINER, search_path, ACL and owner are identical before and after (`true|{"search_path=public, pg_temp"}|{postgres=X/postgres,service_role=X/postgres}|postgres`), and the trigger is still attached.
- Rollback was **refused** while `lead_consents` held rows; the forward state was fully intact afterwards. With the evidence rows deleted but the new `leads` columns still populated it was **refused a second time**, and the forward state was again fully intact. After both were cleared deliberately (`DELETE FROM public.lead_consents`, then `UPDATE public.leads SET funding_type = NULL, property_address = NULL, fbc = NULL, fbp = NULL`) the rollback applied, all 9 fixture `leads` rows survived, **the guard body was back to the production original (md5 `61d154d1...`)**, an anon INSERT into `leads` still worked (the guard no longer names dropped columns), and **the schema fingerprint, which now includes the guard body md5 and ACL, was identical to the pre-migration fingerprint**. Re-applying forward afterwards passed every forward check again, and a direct anon insert of all four columns again landed NULL.

**Negative controls for the proof itself (both observed).**
1. The same migration with both `REVOKE` statements removed, run through the forward and behaviour checks: **8 FAIL** (`anon can EXECUTE`, `authenticated can EXECUTE`, table grants leaked, `proacl` carrying `=X`, `anon=X`, `authenticated=X`, and four behaviour probes where `anon` and `authenticated` succeeded in executing the function and reading the table). The REVOKEs are load-bearing.
2. **The same migration with the four guard lines removed** (the migration as it stood before Ben's ruling), run through the guard checks: **7 FAIL** (`funding_type`, `property_address`, `fbc` and `fbp` each set by a direct insert, the multi-column insert setting a value, the RPC unable to populate a pre-set row because it is first-write-wins, and the stored address changed). The four lines are load-bearing and the probes detect their absence.

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

## Resolved: the new `leads` columns are now write-protected (Ben's ruling 5803524541)

The independent review found that the untouched anon and authenticated INSERT policy (`WITH CHECK (true)`) plus table-level INSERT let a direct insert set the four new columns to any value and any length, and that the first-write-wins RPC would then keep the pre-set value. Ben ruled this a protective fix to be made in this PR (constitution entry 4 / R-134): the guard now nulls the four columns on every insert, which makes `record_lead_details()` their only writer. Proven above (direct-insert probes per column, no UPDATE path, RPC still populates, existing forced columns unchanged, guard diff exactly +4/-0, negative control with the lines removed). The column comments now say the values are written only by the RPC and can be trusted; `property_address` is still visitor-typed free text, so anything that displays it must escape it.

## Independent review, and what changed because of it

A fresh-context reviewer read the diff and ran the Deno tests (it could not run the SQL). It returned no blocking finding (`MIGRATION-REVIEW: PASS`). It reviewed the head before Ben's guard ruling; the four-line guard change is covered by the SQL proof above, not by that review. Its should-fixes were adopted: the rollback lock, the second rollback guard (columns), the corrected column comments, the first-outcome-wins note, NUL stripping and surrogate-safe truncation in the Edge Function (2 more tests). Two nits are recorded, not changed: `getClientIp` falls back to the first `x-forwarded-for` hop exactly like `check-email-exists` (so the stored IP is spoofable only if `cf-connecting-ip` is ever absent), and the rate limit could 429 a visitor behind heavy NAT (the client retries once).

## Danger overrides

None.
