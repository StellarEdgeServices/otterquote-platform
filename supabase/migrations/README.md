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
