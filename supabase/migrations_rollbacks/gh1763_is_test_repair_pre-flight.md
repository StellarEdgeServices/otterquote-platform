# Pre-flight — gh-1763 `profiles.is_test` repair (7 fixture rows)

Drafted by run-work Code lane executor, claim `rw-f22-20260908T001648-zqab`
(issue comment 5577431477). Governing ruling: CTO comment 5572645535 on
#1763 (2026-09-07T15:14:04Z). **Not applied.**

## What it does

`UPDATE public.profiles SET is_test = true` on 7 named rows, guarded by a
row-count assertion (refuses to run unless exactly those 7 ids currently
have `is_test = false`). No schema change, no column added, no rows
deleted, no rows inserted. `contractors.is_test` is untouched.

## Tier

Issue #1763 carries label `tier:3a`. Per the CTO's own note on comment
5572645535 — *"the migration writes production rows and is tiered by what
its pipeline executes, not by its diff... Expect the tier to move and say
so in the PR"* — this is a data UPDATE against 7 existing production
identity rows, not an additive schema change, so per D-261/R-097
(migration-author-code Step 8) it is **expected to move from 3A to 3B**
(24-hour risk brief) before Dustin's apply, rather than shipping under the
lightweight 2-hour Tier 3A window. This draft asks `@exec:cto` on the PR to
confirm the move and post the R-097 notice — the draft itself does not
decide its own tier, and it does not apply itself either way (D-182 Tier 3,
Dustin's call regardless of the 3A/3B line).

## Why it is needed

Quoted verbatim from CTO comment 5572645535 (2026-09-07T15:14:04Z), "The
work order":

> 1. **Decide, on the record, which table is authoritative for `is_test` on
>    a contractor identity.** ⛔ **This is mine, not the lane's**, and I am
>    ruling it here so nothing waits: **`profiles` is authoritative for
>    identity-level `is_test`; `contractors` mirrors it.** Reason —
>    `profiles` is the row that carries the human, it is what `auth.users`
>    maps onto, and R-173's entire purpose is *"is this a real person."* A
>    contractor record is a business object hanging off an identity; when
>    they disagree, the identity wins. **Rejected alternative: `contractors`
>    as authoritative**, on the argument that it is the row the product
>    actually reads. That is true and it is exactly why it must not be the
>    source — a test-seeding path that writes `contractors` and not
>    `profiles` is how these 7 rows happened, and making the
>    written-by-the-buggy-path table authoritative ratifies the bug. **The
>    repair therefore moves `contractors.is_test` to match
>    `profiles.is_test`… except that all 7 are `profile=false /
>    contractor=true`, and every one of the 7 company names is visibly a
>    test fixture.** So the correct repair is **the other direction on
>    these specific rows: set `profiles.is_test = true`**, because the
>    profiles rows are wrong on the facts, not merely disagreeing. **Both
>    the rule and the exception go in the migration's comment header, or
>    the next reader will "fix" it back.**
> 2. **Additive, reversible repair migration under the `migration-author`
>    gate** — forward + rollback, Dustin's approval, D-182 Tier 3. `tier:3a`
>    is on this issue; **the migration writes production rows and is tiered
>    by what its pipeline executes, not by its diff.** Expect the tier to
>    move and say so in the PR rather than letting a reviewer discover it.
> 3. **A CI or cron assertion that the disagreement count stays 0.** ⛔ **Not
>    optional and not a follow-up.** Without it this reappears the next
>    time a test contractor is seeded by a path that writes one table and
>    not the other — which is how it got here. Per constitution entry 16, a
>    recurring defect closes on a mechanism.
> 4. **Nothing is deleted** (constitution entry 30). Repair the flag; do
>    not remove rows.

And "Acceptance test that can FAIL", also quoted verbatim:

> The body's disagreement query returns **0 rows**; then seed a contractor
> by writing `contractors.is_test = true` **without** touching `profiles`,
> and confirm the new assertion goes **RED**. A guard that has only ever
> been run against a clean tree is #1738's whole subject.

This draft covers the migration half (items 1, 2, 4) plus the guard (item
3, `scripts/is-test-cross-table-check.py` and its CI wiring in
`.github/workflows/e2e-tests.yml`) and the guard half of the acceptance
test (RED on a seeded fixture, GREEN on a clean one). The disagreement
query's 0-rows-after and the R-173 re-read on claim
`82f5dff4-5867-4b7a-88ca-942ce9bfe867` going to `profile true` both require
the migration to actually be **applied** — Dustin's step, not this draft's.

## The disagreement query — BEFORE state

Read 2026-09-08 via Supabase MCP `execute_sql` against production
(`yeszghaspzwwstvsrioa`), the issue body's own query, verbatim:

```sql
select p.id as profile_id, p.is_test as profile_is_test,
       c.id as contractor_id, c.is_test as contractor_is_test, c.company_name
from profiles p join contractors c on c.user_id = p.id
where p.role = 'contractor' and p.is_test is distinct from c.is_test
order by c.created_at;
```

**Result — 7 rows, exactly matching the issue body and CTO comment
5572645535:**

| profile_id | profile_is_test | contractor_id | contractor_is_test | company_name |
|---|---|---|---|---|
| `67da903b-ac48-4287-846c-0052583d5282` | false | `8fa0d121-d7e1-4064-8da3-c1bf6d83a4be` | true | PFW Walk Roofing LLC |
| `e371c617-8a24-492e-9911-47c85705ebb4` | false | `8e90ff23-3894-4f67-9ca7-58a044cd986b` | true | Stohler Roofing, LLC |
| `3ea4d929-b916-4cc9-a285-d052df397992` | false | `ee452a12-c16e-4d30-9d2c-df8128fbce52` | true | Stohler Roofing, LLC |
| `ce69bf9d-6874-4fcd-9fa1-ef18e7ebf72c` | false | `848798cc-217c-44a5-83f3-c82b3c602452` | true | Video Walk Test Roofing LLC |
| `92d669a8-c02a-42c1-9f52-53b7efd06ddf` | false | `2bc792be-b677-4ac1-bc68-94b1561d9757` | true | Video Walk Test Roofing 2 LLC |
| `eb7dace0-d26b-4a2f-adc3-7762459772c1` | false | `8f2ecbf8-8f41-4b05-a559-f1ed1f4ca746` | true | PFW Test Contractor |
| `d4def812-aebc-444c-bdee-f68bccc19b61` | false | `986ce2b6-39fd-4a2c-aba4-a806c618c8c0` | true | PFW Roofing 1787836001 |

**Expected AFTER state (post-apply, Dustin's step — not run by this
draft):** the same query returns **0 rows**.

## R-173 re-read — claim `82f5dff4-5867-4b7a-88ca-942ce9bfe867`

The gate this issue exists to unblock. Query, read 2026-09-08 against
production:

```sql
select c.id as claim_id, c.is_test as claim_is_test, ct.is_test as contractor_is_test,
       q.is_test as quote_is_test, p.is_test as profile_is_test, p.role
from claims c
  left join contractors ct on ct.id = c.selected_contractor_id
  left join quotes q on q.claim_id = c.id and q.contractor_id = c.selected_contractor_id
  left join profiles p on p.id = ct.user_id
where c.id = '82f5dff4-5867-4b7a-88ca-942ce9bfe867';
```

**BEFORE (four flags, matches the issue body exactly):**

```
claim_is_test=true | contractor_is_test=true | quote_is_test=true | profile_is_test=FALSE | role=contractor
```

**Expected AFTER (post-apply):** `profile_is_test=true`, the other three
flags unchanged — all four tables agreeing `true`, and the R-173 gate
usable again for this claim.

## The 8 danger patterns (migration-author-code Step 1)

| # | Pattern | Triggered? | Notes |
|---|---|---|---|
| 1 | NOT NULL column with no DEFAULT | No | No column added |
| 2 | NOT NULL on >100K rows even with DEFAULT | No | No column added |
| 3 | Dropping a column | No | No column touched |
| 4 | Type change requiring table rewrite | No | No type change |
| 5 | Index creation without CONCURRENTLY | No | No index created |
| 6 | RENAME TABLE / RENAME COLUMN | No | No rename |
| 7 | TRUNCATE or DELETE with no WHERE | No | `UPDATE ... WHERE id IN (7 named ids) AND is_test = false` — fully scoped, zero broad-match risk |
| 8 | CASCADE DROP | No | No DROP of any kind |

None triggered. The migration is a scoped `UPDATE` on 7 named primary keys,
count-guarded so it refuses to run against any row set other than the
exact 7 measured above.

## Blast radius

Exactly 7 rows, all pre-identified by primary key (no broad predicate, no
`WHERE is_test = false` alone). The row-count guard inside the migration
(`DO $$ ... IF (SELECT count(*) ...) <> 7 THEN RAISE ...`) additionally
refuses to run if production has drifted from this baseline since
2026-09-08 — e.g. if one of the 7 rows was already repaired by another
path, or if the id set is wrong. `UPDATE` on 7 rows by primary key is a
row-level lock, momentary regardless of table size.

## Nothing is deleted

Per constitution entry 30, quoted in the CTO's work order item 4: only the
`is_test` flag is repaired on `profiles`. No row is deleted, no row is
inserted, `contractors` is not touched.

## Apply / verify / roll back

```sql
-- apply (Dustin's approval required, D-182 Tier 3 -- expected Tier 3B per
-- the tier note above)
\i supabase/migrations_drafts/gh1763_is_test_repair.sql

-- verify: the issue's own disagreement query, scoped to these 7 ids
select p.id as profile_id, p.is_test as profile_is_test,
       c.id as contractor_id, c.is_test as contractor_is_test, c.company_name
from public.profiles p join public.contractors c on c.user_id = p.id
where p.id in (
  '67da903b-ac48-4287-846c-0052583d5282','e371c617-8a24-492e-9911-47c85705ebb4',
  '3ea4d929-b916-4cc9-a285-d052df397992','ce69bf9d-6874-4fcd-9fa1-ef18e7ebf72c',
  '92d669a8-c02a-42c1-9f52-53b7efd06ddf','eb7dace0-d26b-4a2f-adc3-7762459772c1',
  'd4def812-aebc-444c-bdee-f68bccc19b61'
)
order by c.created_at;
-- expect: all 7 rows profile_is_test = true, contractor_is_test = true

-- roll back (only if the repair is found to be wrong on further review)
\i supabase/migrations_rollbacks/gh1763_is_test_repair_rollback.sql
```

## The guard (issue work-order item 3, "not optional and not a follow-up")

`scripts/is-test-cross-table-check.py` runs the disagreement query (via
PostgREST against `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`) and exits 1
printing every offending pair when the count is nonzero, exit 0 clean,
exit 3 (UNMEASURED, never a silent pass — gh-1419 discipline) on a missing
credential or unreachable API. `scripts/is-test-cross-table-check.test.py`
is the hermetic pure-unit suite (11 tests, no network) covering the
join/compare logic and the fail-loud paths.

`--self-test` seeds one throwaway auth user + profiles + contractors row in
the exact bad shape gh-1763 found, proves the guard goes RED, repairs the
row, proves GREEN, then deletes everything it created — refusing outright
(before any network call) if pointed at the production project ref
(`yeszghaspzwwstvsrioa`), per this issue's hard limit that the RED
control's seeded write may only ever happen in a local/fixture context.

Wired into `.github/workflows/e2e-tests.yml` as a new job,
`is-test-cross-table-guard`, running `--self-test` against the same CI-test
project (`zsdvaqilfdclwosmiheh`) that `Seed Must Pass (gh-1584)` and
`CI-test Edge Function Parity Check` already use — chosen per this issue's
own instruction ("if CI has a DB... wire the guard as a job there") since
CI already has one, via the existing `SUPABASE_TEST_SERVICE_ROLE_KEY`
secret. No continue-on-error: a red run here fails the PR, same discipline
as the parity check beside it.

**Live RED/GREEN run** (executed 2026-09-08 via Supabase MCP `execute_sql`
against `zsdvaqilfdclwosmiheh`, the same disagreement query the script
implements — a service-role JWT for that project wasn't available in this
environment to drive the script's own HTTP path directly, so this
demonstrates the identical detection logic; the script itself is
proven separately by its 11/11-passing hermetic unit suite and is what
actually runs in CI, where the `SUPABASE_TEST_SERVICE_ROLE_KEY` secret
already exists):

```
-- seeded: profile 5ba362e7-6ee3-4b95-87b3-ab439068b533 is_test=false,
--         contractor 4fe92a60-c4db-4d3c-a24d-5fded17d4d58 is_test=true

RED (disagreement query against the seeded fixture):
[{"profile_id":"5ba362e7-6ee3-4b95-87b3-ab439068b533","profile_is_test":false,
  "contractor_id":"4fe92a60-c4db-4d3c-a24d-5fded17d4d58","contractor_is_test":true,
  "company_name":"IS-TEST GUARD SELFTEST (gh-1763) -- DO NOT USE"}]
-- 1 row -- RED, correctly caught

-- repaired: contractor 4fe92a60-... is_test set to false to match profile

GREEN (same query, same fixture, after repair):
[]
-- 0 rows -- GREEN

-- cleanup: contractor, profile, and auth.users rows all deleted;
-- remaining_fixture_rows = 0 confirmed
```

## Danger overrides

None.
