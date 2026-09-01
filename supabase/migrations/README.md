# supabase/migrations/ — replay-path contract

This directory is walked by the Supabase CLI / branching system as a
**forward-only replay chain**: every `*.sql` file here is applied in
filename order to a brand-new (empty) Postgres database when a fresh
branch is created. That means:

- Every file must be a **forward** migration (no rollback scripts).
- Every file must have a valid `<14-digit-UTC-timestamp>_<name>.sql`
  filename, or it sorts incorrectly relative to properly-named files
  (ASCII: digits sort before letters, so an unprefixed `v83_*.sql` file
  was replaying *after* every `2026...`-prefixed file, regardless of
  when it actually ran in production).
- Every file must be something that has **actually been approved and
  applied to production** — draft/pending-approval SQL does not belong
  here, because replaying it on a fresh branch would create schema that
  production does not have (new drift in the other direction).

Sibling directories (added 2026-08-07, issue #385):

- `supabase/migrations_rollbacks/` — rollback scripts and pre-flight
  planning docs for migrations in this directory. These are reference
  material to run **manually** if a migration needs to be reverted; they
  must never be renamed into a CLI-parseable timestamp or placed back in
  this directory, or the CLI will replay them forward and undo the
  migration they were meant to roll back (see
  `MIGRATIONS-RECONCILIATION-385.md`, defect 2, for a confirmed example).
- `supabase/migrations_drafts/` — SQL that was written but is **not**
  applied in production (Tier 3 approval pending or abandoned). Kept for
  history; must not be added to this directory until it is actually
  applied and its filename carries the real applied timestamp.

See `MIGRATIONS-RECONCILIATION-385.md` in this directory for the full
audit of what is and is not reconciled as of 2026-08-07, and why a fresh
branch still will not reach parity with production until the remaining
gap is closed.

See `MIGRATIONS-RECONCILIATION-1438.md` in this directory for the
2026-09-01 follow-up: `supabase/migrations_drafts/` reconciled against
production (5 of 9 testable draft sets filed here as post-apply traces;
several were not byte-identical to what actually ran and required
reading the applied text back out of
`supabase_migrations.schema_migrations` rather than moving the draft
file), plus a re-measurement of the #385 gap (still ~104 applied
migrations with no repo file as of that date). Building a CI check that
keeps that number from growing is flagged there as follow-up work, not
done in that pass.

## Naming convention (2026-08-14, #822)

The `v<N>` integer scheme used in `sql/` (see `Docs/sql-migration-conventions.md`)
is not used here — it was de facto abandoned in this directory as of the two
most recent entries (`20260812182824_gh720_...`, `20260812200000_gh738_...`),
which switched to `<timestamp>_gh<issue>_<slug>.sql`. **Going forward, new
files in this directory should follow that pattern** — the issue number is
globally unique by construction, which removes the possibility of two
independent authors reserving the same identifier (the failure mode that
prompted #822).

`sql/` is a separate, still-live, actively-maintained directory with its own
numbering convention documented in `Docs/sql-migration-conventions.md` — it is
not a duplicate or legacy path, and a shared identifier appearing in both
directories (e.g. `v105` used once in each) is not itself a collision.
