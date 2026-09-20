# Pre-Flight: gh2055_add_notifications_suppressed_and_is_synthetic

**Migration**: 20260920195654_gh2055_add_notifications_suppressed_and_is_synthetic.sql
**Date**: 2026-09-20
**Author**: Code lane sub-agent (automated), run-work orchestration (`rw-f22-20260920T195229-m3xq`)
**GitHub**: #2055 (split from #2047 by CEO RUN 56, claim `ceo-2026-09-20T17:37:05Z`)
**Tier**: 3A — purely additive: two new nullable columns, no backfill, no
existing column altered, no RLS/GRANT change. `tier:3a` applied to the
issue by Ben (CEO) after Kevin (Code lane) correctly declined to
self-apply the label. **Autonomous: no R-097 24-hour notice, no D-182
approval gate for this step.**
**Status**: APPLIED — same-session apply path (Tier 3A), per this repo's
gh749/gh2010 precedent.

---

## Change Summary

Adds two independent, single-meaning nullable boolean columns:

1. `public.contractors.notifications_suppressed boolean NULL DEFAULT NULL`
   — "real company, do not send them product email yet." This is the
   second meaning currently smuggled inside `contractors.is_test = true`
   (per the hazard-register standing ruling and #2047).
2. `public.leads.is_synthetic boolean NULL DEFAULT NULL` — "synthetic vs.
   real" lead data marker. Deliberately **not** named `is_test`, per the
   CEO's explicit instruction on #2055, to avoid reproducing the exact
   overload #2047 exists to remove. `leads` has no notification-consent
   column of its own, so `is_synthetic` cannot collide with the
   "don't-email" meaning — that meaning lives exclusively on
   `contractors.notifications_suppressed`.

No backfill, no reclassification, no reader added. `contractors.is_test`
and `leads`' existing columns are untouched.

---

## Live Pre-Verification (captured fresh this session, 2026-09-20, against project `yeszghaspzwwstvsrioa`, pasted on #2055 BEFORE execution per R-147)

1. `information_schema.columns` for `public.contractors` — 108 columns,
   `is_test boolean NOT NULL` present, `notifications_suppressed` absent.
2. `information_schema.columns` for `public.leads` — 20 columns (issue
   text said 19; one more than stated at filing time — does not change
   scope, purely additive either way), no `is_test`, no `is_synthetic`, no
   equivalent synthetic/test marker anywhere in the list.
3. Row counts: `contractors = 14`, `leads = 82`.
4. Negative control: `information_schema.columns` filtered to
   `('notifications_suppressed','is_synthetic','nonexistent_probe_column_xyz123')`
   across both tables returned 0 rows pre-migration — confirms none of the
   three existed yet and that the query discriminates.

Full output pasted verbatim on issue #2055 (comment
issuecomment-5752268375) before the migration was applied.

---

## Row Count Estimate

| Table | Row Count | Source |
|-------|-----------|--------|
| contractors | 14 | `execute_sql` this session, 2026-09-20 |
| leads | 82 | `execute_sql` this session, 2026-09-20 |

---

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|--------------------|
| `ADD COLUMN notifications_suppressed boolean NULL` (no default, nullable) | `ACCESS EXCLUSIVE`, brief — metadata-only, no table rewrite | < 5ms on a 14-row table |
| `ADD COLUMN is_synthetic boolean NULL` (no default, nullable) | `ACCESS EXCLUSIVE`, brief — metadata-only, no table rewrite | < 5ms on an 82-row table |

No backfill UPDATE — nothing else touches either table.

---

## Danger Pattern Check

| # | Pattern | Triggered? | Override? |
|---|---------|-----------|-----------|
| 1 | NOT NULL column without DEFAULT | No — both columns nullable, default NULL | — |
| 2 | NOT NULL on table > 100K rows | No | — |
| 3 | DROP COLUMN | No (forward migration adds only; rollback drops only the two new columns) | — |
| 4 | Type change requiring table rewrite | No | — |
| 5 | Index without CONCURRENTLY on hot table | No — no index added | — |
| 6 | RENAME TABLE or RENAME COLUMN | No | — |
| 7 | TRUNCATE or DELETE all rows | No — no DML at all, ADD COLUMN only | — |
| 8 | CASCADE DROP | No | — |

**All 8 patterns clear. No overrides required.**

---

## Code Path Impact Analysis

- No application code, Edge Function, RLS policy, view, trigger, or query
  reads or writes either column today — this migration is additive-only
  and inert by construction. That inertness is the entire tier:3a safety
  argument (nothing can change behaviour, and in particular nothing can
  email anyone).
- `contractors.is_test` and every existing `leads` column are unmodified —
  no value on any existing row changes meaning.
- Backfilling values, reclassifying rows, and wiring any reader are
  explicitly out of scope here and stay on #2047 (tracked as "2047b").

---

## Supabase Branch Test Results

**Not run.** Two single-statement ADD COLUMN operations across two tables
(14 and 82 rows respectively), no backfill, no default requiring a table
rewrite. A branch test is judged unnecessary; the post-apply verification
below (against the real result) serves the same confirmatory purpose,
consistent with this repo's gh749/gh2010 precedent.

---

## Post-Apply Verification (run immediately after `apply_migration`)

1. `information_schema.columns` for both tables, filtered to the two new
   column names — both present, `boolean`, `is_nullable='YES'`,
   `column_default=null`. Confirmed.
2. Negative control re-run post-apply for an invented column name — 0
   rows, confirming the query still discriminates and no other column
   leaked in. Confirmed.
3. Row counts unchanged (`contractors=14`, `leads=82`) — ADD COLUMN cannot
   change row count, not re-verified separately.
4. Read the applied version from `supabase_migrations.schema_migrations`
   directly (via `list_migrations`) — not the git filename. Applied
   version: `20260920195654`,
   name `gh2055_add_notifications_suppressed_and_is_synthetic`. This
   file's on-disk timestamp prefix matches.

---

## Deploy Notes

- **Tier**: 3A, autonomous. No R-097 24-hour notice; no D-182 approval
  gate for this step — CEO-applied `tier:3a` on #2055.
- **Deploy path**: applied directly via `apply_migration` against
  `yeszghaspzwwstvsrioa` this session (Tier 3A autonomy), migration files
  included in the same PR for git history / review record.
- **Rollback pre-authorized**: yes —
  `gh2055_add_notifications_suppressed_and_is_synthetic_rollback.sql`. No
  guard needed (see rollback file header) — dropping either column cannot
  destroy data anywhere else and cannot change any existing row's
  `is_test` meaning.
- **Monitoring**: none required beyond routine — additive-only, zero
  readers added, zero behaviour change possible.
- **Follow-on work**: 2047b (backfill + reader wiring) stays on #2047, not
  filed as a new issue by this PR.

---

## Danger Overrides

None.
