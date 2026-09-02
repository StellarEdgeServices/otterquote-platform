# Pre-Flight: gh1021_add_paid_state

**Migration**: gh1021_add_paid_state.sql
**Date**: 2026-08-21
**Author**: Code lane sub-agent (automated), run-work orchestration
**GitHub**: #1150 (child of #1021 — D-293 manual commission payment)
**Tier**: 3A — purely additive: one new nullable column, one CHECK constraint
widened (never narrowed), nothing rewritten, nothing dropped, no data
destroyed. Per the tier test stated on #916 (`issuecomment-5346544316`):
"purely additive (new nullable columns, new tables, indexes) … is Tier 3A
and autonomous." This migration adds exactly one nullable column and widens
a CHECK constraint by exactly one admitted value — it clears that test.
**Autonomous: no R-097 24-hour notice, no D-182 approval gate for this
step.** (#1021's own `tier:3b` label is correct for the parent and stays —
it describes the money-state change carried by #1021's *other* child, the
Edge Function/dashboard wiring that will actually read/write `paid_at` and
transition a row to `status='paid'`. It does not apply to this purely
additive schema-only child.)
**Status**: DRAFT — PR-then-apply path (see Deploy Notes below).

---

## Change Summary

Adds `paid_at timestamptz NULL` to `public.payout_approvals` and widens
`payout_approvals_status_check` to additionally admit `'paid'`, while
preserving every value already admitted today: `pending_approval`,
`approved`, `rejected`, `auto_approved`, `pre_approved`. Nothing reads or
writes the new column yet — that wiring is #1021's other (Tier-3B) child,
deliberately out of scope here.

---

## Live Pre-Verification (captured fresh this session, 2026-08-21, independent of the issue body)

Re-run from scratch against Supabase project `yeszghaspzwwstvsrioa` before
touching anything, per this lane's verification-first rail. All four checks
matched the issue's stated pre-verification exactly — nothing had drifted:

1. **`information_schema.columns` for `public.payout_approvals`**, full
   `ORDER BY ordinal_position` walk — 17 columns, no `paid_at`:
   `id, referral_id, payout_type, partner_id, partner_name, amount,
   trigger_event, status, rejection_reason, auto_approve_at, approved_at,
   rejected_at, approved_by, reminder_sent_at, notification_sent_at,
   created_at, is_test`.

2. **`pg_get_constraintdef` on `payout_approvals_status_check`** — exactly:
   `CHECK ((status = ANY (ARRAY['pending_approval'::text, 'approved'::text,
   'rejected'::text, 'auto_approved'::text, 'pre_approved'::text])))`
   — byte-identical to the issue's quoted definition, no extra or missing
   values.

3. **Row census** — `SELECT count(*), array_agg(DISTINCT status) FROM
   payout_approvals` → `count=1`, `array_agg={pending_approval}`. Matches
   the issue's stated single row (`99923a15-…`, `commission_referral`,
   `pending_approval`, $200.00, `is_test=false`).

4. **`ls supabase/migrations_drafts/`** — 11 files present (`gh1050` ×3,
   `gh916` ×3, `gh969` ×2, `v88` ×3), none named `gh1021_add_paid_state*`.
   Starting from nothing, not from review of an existing draft.

Rail satisfied: live state matched the issue's pre-verification exactly, so
this migration proceeds.

---

## Row Count Estimate

| Table | Row Count | Source |
|-------|-----------|--------|
| payout_approvals | 1 | `execute_sql` this session, 2026-08-21 |

---

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|--------------------|
| `ADD COLUMN paid_at timestamptz NULL` (no DEFAULT, nullable) | `ACCESS EXCLUSIVE`, brief — metadata-only, no table rewrite for a nullable column with no default | < 5ms on a 1-row table |
| `DROP CONSTRAINT` + `ADD CONSTRAINT` (CHECK) | `ACCESS EXCLUSIVE`, brief — constraint is validated against existing rows, but the table holds 1 row | < 5ms |

---

## Danger Pattern Check

| # | Pattern | Triggered? | Override? |
|---|---------|-----------|-----------|
| 1 | NOT NULL column without DEFAULT | No — `paid_at` is nullable, no default needed | — |
| 2 | NOT NULL on table > 100K rows | No | — |
| 3 | DROP COLUMN | No (forward migration adds only; rollback's DROP COLUMN is gated by the paid-row guard) | — |
| 4 | Type change requiring table rewrite | No | — |
| 5 | Index without CONCURRENTLY on hot table | No — no index added | — |
| 6 | RENAME TABLE or RENAME COLUMN | No | — |
| 7 | TRUNCATE or DELETE all rows | No | — |
| 8 | CASCADE DROP | No — plain `DROP CONSTRAINT` / `ADD CONSTRAINT`, not a CASCADE | — |

**All 8 patterns clear. No overrides required.**

**The one thing a reviewer must actually check (per #1150 body):** the CHECK
swap must keep `'auto_approved'` and `'pre_approved'` — historical rows
carry them and dropping either would be destructive and would re-tier this
to 3B. Verified above: the new constraint reproduces all 5 original values
verbatim (checked against the live definition read this session, not
against the issue text) and adds exactly one (`'paid'`).

---

## Code Path Impact Analysis

- No application code, Edge Function, RLS policy, or view reads or writes
  `paid_at` or `status='paid'` today (this migration is schema-only; the
  consuming wiring is #1021's other child, not yet built).
- The 5 values the existing CHECK constraint already admits are unchanged
  in meaning; the widened constraint is a strict superset, so no existing
  row, query, or insert path becomes invalid.
- `payout_approvals_status_check` is table-local — no foreign key or view
  depends on its literal definition.

---

## Supabase Branch Test Results

**Not run.** This migration is draft-only until the PR merges; the live
apply is a single direct `apply_migration` call against production per the
dispatch's PR-then-apply path (see Deploy Notes), not a Supabase branch
test. Given the change is two single-statement DDL operations on a 1-row
table, with a strictly additive shape (new nullable column, widened not
narrowed CHECK), a branch test is judged unnecessary; the post-apply
verification queries below serve the same confirmatory purpose directly
against the real result.

---

## Post-Apply Verification (run immediately after `apply_migration`, per #1150 AC3–5)

1. `pg_get_constraintdef` on `payout_approvals_status_check` — must show all
   6 values including `'paid'`.
2. `information_schema.columns` for `payout_approvals` — must show
   `paid_at`.
3. `SELECT count(*) FROM payout_approvals WHERE paid_at IS NOT NULL` — must
   be 0.
4. Read the applied version from `supabase_migrations.schema_migrations`
   directly — not the git filename. Per #1150 AC4 / R-145, the two have
   drifted apart before on this exact repo.

---

## Deploy Notes

- **Tier**: 3A, autonomous. No R-097 24-hour notice; no D-182 approval gate
  for this step — per the #916 tier-test precedent cited above and #1150's
  own explicit classification.
- **Deploy path**: PR → required CI green → merge → single manual
  `apply_migration` call against `yeszghaspzwwstvsrioa` (this lane's own
  step under its Tier-3A autonomy, not deferred to Dustin). Merging the PR
  does NOT apply the migration — there is no auto-run pipeline for
  `supabase/migrations_drafts/` in this repo.
- **Rollback pre-authorized**: yes — `gh1021_add_paid_state_rollback.sql`.
  It refuses to run (raises inside the transaction, aborting it entirely) if
  any row already carries `status='paid'`, so it cannot silently orphan
  live money-state data. Live state today (1 row, `pending_approval`) means
  the guard is a no-op if invoked now; it is written for future state once
  #1021's other child starts writing `'paid'` rows, per #1150 AC2.
- **Monitoring**: watch Postgres logs / Sentry for ~15 minutes post-apply
  for unexpected errors touching `payout_approvals`. Given the change is
  additive-only on a 1-row table with no consuming code path yet, no
  behavior change anywhere is expected.
- **Follow-on work**: #1021's Tier-3B sibling child — the Edge Function and
  dashboard wiring that actually reads/writes `paid_at` and transitions a
  row to `status='paid'`. Explicitly out of scope here per #1150's "nothing
  reads or writes either yet" framing.

---

## Danger Overrides

None.
