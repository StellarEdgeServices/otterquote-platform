# Migration chain reconciliation — issue #385

Status as of 2026-08-07: **partial**. Three confirmed, mechanically-fixable
defects are corrected in this change. The dominant defect (missing
foundational schema) is diagnosed and quantified below but **not** fixed
in this change — closing it requires tooling this session did not have
access to (see "What's still needed").

## Method

Compared `supabase/migrations/` in git against the live project's applied
migration ledger (`yeszghaspzwwstvsrioa`, via `list_migrations` /
`supabase_migrations.schema_migrations`), which returned 82 applied
entries dated 2026-04-23 through 2026-08-07 (the most recent, `v100` /
`contractors_user_id_unique_index`, was applied the same day this audit
ran). Cross-checked suspect files against live schema via `list_tables`
and targeted `information_schema` queries (read-only).

## Defect 1 — rollback scripts inside the forward-replay path (fixed)

`supabase/migrations/` contained 15 `*_rollback.sql` files and 6
`*_pre-flight.md` planning docs sitting directly alongside the forward
migrations they document. The Supabase CLI does not distinguish these by
convention — it treats every `.sql` file in the directory as a forward
migration and applies it in filename order.

Confirmed concrete case: `20260618125007_p15_quotes_payment_status_no_method.sql`
widens `quotes.payment_status_check` to allow `'no_method'`.
`20260618125007_p15_quotes_payment_status_no_method_rollback.sql` sat in
the same directory with a filename that sorts immediately after it, and
would replay right after — silently reverting the widened constraint on
every fresh branch, before any code path could ever write `'no_method'`.
Multiplied across all paired migrations, a fresh branch would diverge
from production in dozens of narrower ways even if the base schema
existed.

**Fix:** moved all 15 rollback scripts + 6 pre-flight docs to
`supabase/migrations_rollbacks/`, out of the CLI's replay path. Nothing
about their content changed; they remain available to run manually
against a real database if a migration needs reverting.

## Defect 2 — malformed / missing timestamp prefixes (fixed)

9 forward-migration files did not follow the required
`<timestamp>_name.sql` naming convention (e.g. `v83_add_public_directory_optin_to_contractors.sql`,
no timestamp prefix). Because ASCII digits sort before letters, these 9
files were sorting **after every properly-timestamped file**, including
ones from weeks later — e.g. a May 2026 change was replaying after a
June 21 change. `git log --follow --diff-filter=A` on
`supabase/migrations/` shows the directory was introduced in commit
`9f2cc31` (2026-05-01) containing *only* a rollback stub — these 9 files
were "registered" into git well after they'd already been run by hand
against production (see e.g. commit `fb9dea0`, "register v84 migration
in supabase/migrations/", filed after the fact), which is how they ended
up without CLI-valid names.

**Fix:** renamed all 9 to `<timestamp>_<original-name>.sql`. Timestamps
were assigned as follows, in order of confidence:

| File | New timestamp | Basis |
|---|---|---|
| `v83_add_public_directory_optin_to_contractors.sql` | `20260527013505` | Exact name match in live ledger |
| `v85_notify_admin_new_contractor.sql` | `20260602144731` | Exact name match (live ledger has this name applied twice, `20260602144731` and `20260602155343` — used the earlier; the duplicate re-run is not reproducible from a single file and is called out below) |
| `v86_drop_activity_log_event_type_check.sql` | `20260611213121` | Exact name match |
| `v87_code3_rls_hardening_bundle.sql` | `20260703222148` | Exact name match |
| `v90_add_claims_carrier_name.sql` | `20260708214122` | Exact name match |
| `v89_fix_template_privileged_guard.sql` | `20260708214138` | Exact name match (correctly sorts after v90 above — live ledger confirms v90 was applied 16s before v89 despite the version labels suggesting the opposite order) |
| `v82_d182_retroactive_members_table.sql` | `20260519221215` | **No live ledger match found** — synthetic, derived from the commit that first added this file to git (`2026-05-19T18:12:15-04:00`). File content is a self-documented retroactive filing ("this table exists in production but had no migration file") and its `CREATE TABLE IF NOT EXISTS members (...)` was verified against live `list_tables` (table exists, 0 rows) — content is consistent with production even though the exact original apply timestamp is unrecoverable. |
| `v84_drop_orphan_tables.sql` | `20260529172840` | **No confident live ledger match** — live has `20260527194224 v82_drop_orphaned_tables`, which is close in wording but not an exact name match and carries a different version label; not assumed to be the same migration. Used the commit-add date as a synthetic, traceable timestamp instead. Content verified independently: all 4 tables it drops (`documents`, `job_assignments`, `inspection_bookings`, `claim_trade_items`) are absent from the current live schema, consistent with this migration (or an equivalent) having already run. |

For the two "no confident match" rows, treat the assigned timestamp as
**a reconciliation-time filing date, not a claim about when the SQL
actually ran in production** — flagging this explicitly rather than
guessing a false-precision match.

## Defect 3 — unapproved draft migration in the replay path (fixed)

`v88_referral_agents_public_directory_optin.sql` carries an explicit
header: `Status: DRAFT ONLY — DO NOT APPLY. Tier 3 (D-182) approval
pending.` It had a malformed (non-timestamped) filename, which — by
accident, not by design — is the only reason it was never actually
replayed by anything. Verified live: `referral_agents.public_directory_optin`
does not exist in the production schema, confirming the draft was never
applied.

Fixing defect 2 mechanically (just adding a timestamp) would have
promoted this draft into the live replay chain and made every fresh
branch diverge from production by one column — a regression, not a fix.

**Fix:** moved it, its rollback, and its pre-flight doc to
`supabase/migrations_drafts/` instead of renaming it into
`supabase/migrations/`. It should only move into `supabase/migrations/`
(with the real applied timestamp) once D-182 approval lands and it is
actually run against production.

## What's still needed — the dominant defect (not fixed here)

The live ledger has **82** applied migrations; after the above cleanup,
this repo has **22** corresponding forward-migration files. The other
**~62 are recorded as applied in production but have no file in this
repo at all** — including effectively the entire foundational schema:

- `v53` through `v81` (2026-04-23 → 2026-05-14): the run that created
  most base tables (`contractors`, `claims`, `quotes`, `profiles`, etc.
  — none of which has a `CREATE TABLE` anywhere in this directory).
- `v84_rls_policy_consolidation`, `v85_add_missing_fk_indexes`,
  `v86_add_is_test_to_claims_contractors`, `v87_referrals_rls_update_scope`,
  `v88_referral_agents_public_view`, `v89_contractors_public_view`,
  `v88_contractor_claim_docs_read`, `phase31_biddable_claims_exclude_is_test`,
  `v92_counter_sig_reminder_cron`.
- `v93` through `v100` (2026-07-13 → 2026-08-05) and
  `contractors_user_id_unique_index` (2026-08-07, applied hours before
  this audit) — i.e. **this gap is still growing**: migrations are
  continuing to be applied directly to production without a
  corresponding file ever landing in git.

This is why a genuinely fresh (empty) branch still ends up at
"MIGRATIONS_FAILED" / zero public tables even after this fix: the
replay chain in this repo was never a complete history to begin with.
The first commit to touch this directory (`9f2cc31`, 2026-05-01) added
only a rollback stub, not a baseline — there never was a captured
starting schema.

Closing this for real requires one of:

1. **A schema-only `pg_dump` of production**, captured as a single
   baseline migration timestamped before `20260519221215` (the earliest
   file now in this directory), superseding the untracked history. This
   session had Supabase CLI (`v2.109.1`) and `SUPABASE_ACCESS_TOKEN`
   available and successfully linked to the project, but `supabase db
   dump` shells out to Docker to run `pg_dump` in a matching Postgres
   image, and Docker was not available in this environment
   (`dockerDesktopLinuxEngine` pipe not found) — the dump could not be
   produced.
2. Reconstructing the baseline via raw catalog introspection
   (`pg_get_constraintdef`, `pg_get_indexdef`, `pg_policies`,
   `pg_get_functiondef`, etc. against `information_schema`/`pg_catalog`)
   instead of `pg_dump`. Technically possible read-only, but was judged
   too large and too unverifiable to attempt blind in this session: ~43
   tables, their RLS policies, functions/triggers, and indexes would
   need to be reconstructed by hand from catalog text with no way to
   test-replay the result (see point 3) before shipping it — a wrong
   baseline would be worse than an honestly-incomplete one.
3. **Verification is also blocked**: the acceptance criteria call for
   testing replay on a fresh branch (`supabase db reset` locally, or a
   real `create_branch`). Local reset needs the same unavailable Docker
   dependency; a live Supabase preview branch incurs cost and requires
   the `confirm_cost` step, which this session did not obtain sign-off
   for and therefore did not create.
4. Going forward, the process gap that caused this — migrations applied
   directly to production (dashboard / MCP `execute_sql`) and
   "registered" into git after the fact, sometimes weeks later — needs
   to stop, or this directory will never converge with production no
   matter how many times it's reconciled.

## Evidence

Full live ledger (`list_migrations` on `yeszghaspzwwstvsrioa`, 82 rows)
and the local-file diff used to produce the table above are reproducible
via:

```
# Live ledger
supabase migrations list --linked   # or the list_migrations MCP tool

# Local files (normalized, dedup rollback/pre-flight suffixes)
ls supabase/migrations supabase/migrations_rollbacks supabase/migrations_drafts \
  | sed -E 's/^[0-9]{14}_//; s/\.(sql|md)$//; s/_rollback$//; s/_pre-flight$//' \
  | sort -u
```
