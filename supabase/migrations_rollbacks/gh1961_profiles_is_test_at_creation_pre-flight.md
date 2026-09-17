# Pre-flight — gh-1961 `is_test` at creation (profiles + contractors)

Drafted on PR #2002 (branch `gh-1961-is-test-at-creation`), now through two
fix rounds: REVIEW: FAIL comment 5706433778, then REVIEW: FAIL comment
5707827031 (both a fresh-context Opus refuter, dispatched by Ben, CEO RUN
48, claim `ceo-2026-09-16T13:09:26Z`). Governing instruction:
issuecomment-5698032041 ("the next concrete step is a DB default or trigger
keyed on that domain, as a Tier 3A migration") plus both reviews' fix
instructions. **Not applied.**

## What it does

Two new `BEFORE INSERT` triggers, purely additive, no `ALTER` of any
existing object:

1. `profiles_set_is_test_for_internal_domain` on `public.profiles` --
   sets `NEW.is_test := true` when `NEW.email` ends with
   `@otterquote-internal.test` (case-insensitive). Never sets it false.
2. `contractors_zz_inherit_profile_is_test` on `public.contractors` --
   on an END-USER (authenticated) insert only, sets `NEW.is_test := true`
   when the owning profile (`profiles.id = NEW.user_id`) has
   `is_test = true`. Never sets it false, and never touches a service-role
   or system insert's explicit value (round 2: round 1 had no role check
   and overrode an explicit service-role `is_test=false`, breaking the
   `#564` `test-world-symmetry` spec's S2 fixture -- see "Round 2" below).
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

## Round 2 (review comment 5707827031)

**Finding B1 (blocking).** Round 1's `contractors_zz_inherit_profile_is_test`
had no caller-role check, so it fired for every inserting role. That broke
the existing `#564` regression spec's S2 fixture
(`tests/e2e/flows/test-world-symmetry.spec.ts`): S2 creates an
internal-domain user (`profiles.is_test = true`) and has the service-role
admin client `INSERT` a contractor row with an explicit `is_test = false`,
to prove RLS treats that contractor as real and hides seeded test claims
from it. Round 1's trigger silently flipped that explicit `false` to
`true`. **Checked directly against the spec file, not just the review's
description of it** -- confirmed the fixture is exactly as described
(lines ~160/175/186).

**Cure applied (reviewer-tested):** scope the override to end-user inserts
only, via `coalesce(auth.jwt() ->> 'role', '') = 'authenticated'`.
Deliberately not `current_user` -- the function is `SECURITY DEFINER`, so
`current_user` inside it is always the function's owner, never the calling
role; keying on it would have silently disabled the round-1 fix for every
caller, not narrowed it correctly. `auth.jwt()`'s real body (pulled live via
`pg_get_functiondef` against `yeszghaspzwwstvsrioa`) reads the
request-scoped GUC PostgREST actually sets per caller, and is now installed
in the companion `.test.sql` in place of the round-1 static `'{}'` stub, so
both the authenticated and non-authenticated branches are actually
exercised.

**Two explicit decisions this draft does NOT make, recorded here so Dustin
sees them before approving the apply (per the review's own ask):**

- **The one pre-existing live disagreement row is left as-is.** Read again
  2026-09-17 against `yeszghaspzwwstvsrioa`: still exactly 1 row where
  `profiles.is_test` disagrees with `contractors.is_test` for an
  already-live internal contractor. This migration is INSERT-only by
  design -- it does not repair existing rows. Backfilling that one row
  would be a data `UPDATE` against an existing identity row, which is the
  same shape of change that moved gh-1763 to Tier 3B; it is not bundled
  into this Tier 3A DDL change. The daily `#1763` guard's current-state
  reading is unaffected by applying this migration either way.
- **Applying this migration to the CI-test project
  (`zsdvaqilfdclwosmiheh`) is a separate explicit decision from applying it
  to prod (`yeszghaspzwwstvsrioa`), not bundled into this Tier 3A
  approval.** CI-test carries the same `contractors_freeze_privileged_columns`
  / `trg_contractors_privileged_guard` / `trg_sync_contractor_profile_role`
  triggers as prod (checked via `SELECT`), and the nightly E2E suite
  (`e2e-nightly.yml`) that exercises the S2 fixture runs against it -- so
  whoever approves the prod apply should decide CI-test on its own merits
  at the same time, not assume it follows automatically.

**The S2 spec itself was checked, not just cited.** Confirmed
`tests/e2e/flows/test-world-symmetry.spec.ts` S2 does exactly what the
review says (service-role insert, explicit `is_test: false`, asserts the
seeded test claim is not visible) and that the round-2 fix's local
reproduction (`.test.sql` section 8.5) matches it: PRE (round-1 function)
flips the fixture to `true`; POST (round-2 function) leaves it `false`.

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
4. **Round 2 (section 8.5 of `.test.sql`)**: the round-1 function body is
   temporarily reinstalled to reproduce the S2-fixture bug (service-role
   explicit `is_test=false` -> flipped `true`, labeled PRE), then the real
   migration file is re-sourced to restore the round-2 fixed body, and the
   same S2 fixture, the authenticated true/true case, the real-domain
   false/false case, and the `#1763` count are all re-asserted (labeled
   POST) -- so the fix and the no-regression claim are both demonstrated
   in one run, not just described.

This is exactly the "acceptance test that can FAIL" shape gh-1763's own
pre-flight used: the test is built to demonstrate the disagreement (RED) if
Part 2 is left out, or the S2 regression (RED) if the round-2 role check is
left out, and to demonstrate the GREEN state with the shipped code --
not merely asserted to already pass.

## Explicitly out of scope for this draft (see PR body QUESTIONS)

- `claims.is_test` propagation from the owning profile at claim creation --
  measured live, no such trigger exists today (`claims_copy_first_touch`
  copies only UTM/first-touch columns). Not built here.
- Revoking `authenticated`'s column-level `UPDATE` on `profiles.is_test`
  (review non-blocking item 3, carried forward again as review round 2's
  non-blocking item 6: any user can currently flip their own `is_test` flag
  either way via RLS + column grant, which undermines the flag's
  trustworthiness more than the domain-matching rule does). Recommended as
  a follow-up issue twice now across both reviews; still not filed as an
  issue and not built here -- Tier C (security-policy change) on its own.
