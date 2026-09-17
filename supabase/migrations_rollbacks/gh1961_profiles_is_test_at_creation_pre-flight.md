# Pre-flight — gh-1961 `is_test` at creation (profiles + contractors)

Drafted on PR #2002 (branch `gh-1961-is-test-at-creation`), fix round after
REVIEW: FAIL comment 5706433778 (fresh-context Opus refuter, dispatched by
Ben, CEO RUN 48, claim `ceo-2026-09-16T13:09:26Z`). Governing instruction:
issuecomment-5698032041 ("the next concrete step is a DB default or trigger
keyed on that domain, as a Tier 3A migration") plus the review's B1 fix
instruction. **Not applied.**

## What it does

Two new `BEFORE INSERT` triggers, purely additive, no `ALTER` of any
existing object:

1. `profiles_set_is_test_for_internal_domain` on `public.profiles` --
   sets `NEW.is_test := true` when `NEW.email` ends with
   `@otterquote-internal.test` (case-insensitive). Never sets it false.
2. `contractors_zz_inherit_profile_is_test` on `public.contractors` --
   sets `NEW.is_test := true` when the owning profile
   (`profiles.id = NEW.user_id`) has `is_test = true`. Never sets it false.
   Named to sort alphabetically after the existing
   `contractors_freeze_privileged_columns` trigger so it fires second on
   the same `INSERT`, per Postgres's documented same-event trigger firing
   order (alphabetical by trigger name).

No schema change, no column added, no rows touched, no data migration --
the forward file only changes what future `INSERT`s do.

## Tier

Issue #1961 does not itself carry a `tier:` label; issuecomment-5698032041
calls this "a Tier 3A migration" (D-182 Tier 3, lightweight 2-hour window).
Unlike gh-1763 (a data `UPDATE` against existing identity rows, moved to
3B), this is purely additive DDL (two `CREATE FUNCTION` + two
`CREATE TRIGGER`, both idempotent) touching no existing rows -- it does not
carry the same "writes production rows" argument that moved gh-1763 to 3B.
Recommend it stays 3A; not this draft's call to decide on its own, and
Dustin's apply decision governs regardless of which line it sits on.

## Why it is needed

Part 1 (profiles) alone leaves a **half-flagged** state for any internal
test contractor created through the real signup UI: `handle_new_user()`
inserts the profile, Part 1 sets `profiles.is_test := true`, then the
existing `contractors_freeze_privileged_columns` trigger forces
`contractors.is_test := false` on the `authenticated` insert into
`contractors`. That is exactly the `#1763` cross-table disagreement
(`scripts/is-test-cross-table-check.py`'s `DISAGREEMENT_SQL`), and the
daily prod guard (`.github/workflows/edge-function-drift.yml`, cron
`17 9 * * *`) asserts that count must stay 0. Measured live on
`yeszghaspzwwstvsrioa` (review comment 5706433778): one such row already
exists in production today (an internal-domain contractor,
`profiles.is_test = true` / `contractors.is_test = false`), and applying
Part 1 alone would make every *future* internal test contractor signup add
another one, turning the daily guard red on a schedule rather than once.

Part 2 closes that gap by copying `is_test` from the owning profile onto
the contractor row at the same `INSERT`, without touching the freeze
trigger itself (constitution entry 30 posture: additive fix, not a rewrite
of an existing gate).

## Acceptance test (can FAIL)

`supabase/migrations_drafts/gh1961_profiles_is_test_at_creation.test.sql`,
run against a local Postgres 17 scratch database, installs the **real**
`handle_new_user()`, `on_auth_user_created`, `contractors_freeze_privileged_columns`,
and `sync_contractor_profile_role` function/trigger bodies (pulled live via
`pg_get_functiondef` against `yeszghaspzwwstvsrioa`, not paraphrased), then:

1. **Negative control, no migration applied**: an internal-domain homeowner
   signup and an internal-domain contractor signup (inserted as role
   `authenticated`, matching the real app) both land `is_test = false`, and
   the `#1763` `DISAGREEMENT_SQL` predicate (same SQL the daily prod guard
   runs) returns 0 rows.
2. **With the migration applied**: the same internal-domain homeowner
   signup lands `profiles.is_test = true`; the same internal-domain
   contractor signup lands **both** `profiles.is_test = true` **and**
   `contractors.is_test = true` (the alphabetical-ordering fix actually
   overriding the freeze trigger's `false`, not merely a documented
   assumption); a real-domain signup of both kinds stays `false`
   (negative control); and the `DISAGREEMENT_SQL` predicate still returns 0
   rows after the internal contractor insert.
3. **Idempotency**: the migration is applied a second time; exit 0, exactly
   one copy of each new trigger survives, and behavior is unchanged.

This is exactly the "acceptance test that can FAIL" shape gh-1763's own
pre-flight used: the test is built to demonstrate the disagreement (RED) if
Part 2 is left out, and to demonstrate 0 disagreements (GREEN) with both
parts applied -- not merely asserted to already pass.

## Explicitly out of scope for this draft (see PR body QUESTIONS)

- `claims.is_test` propagation from the owning profile at claim creation --
  measured live, no such trigger exists today (`claims_copy_first_touch`
  copies only UTM/first-touch columns). Not built here.
- Revoking `authenticated`'s column-level `UPDATE` on `profiles.is_test`
  (review non-blocking item 3: any user can currently flip their own
  `is_test` flag either way via RLS + column grant, which undermines the
  flag's trustworthiness more than the domain-matching rule does).
  Recommended as a follow-up issue, not built here.
