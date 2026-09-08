# Pre-flight — gh-1759 backfill of `claims.platform_fee_stripe_id` / `platform_fee_amount`

**Tier 3B. NOT APPLIED by the PR that adds this file.** Gate: the R-097 window on
issue #1759 elapsed (`2026-09-07T22:25:34Z` → `2026-09-08T22:25:34Z`, `stamp.py`
pasted) **and** `tier:3b-approved` on the issue. The label is the GO.

## What this migration is, and what it is not

It is **not** the fix. The fix is the code half in the same PR: `create-payment-intent`
returns Stripe's `latest_charge`, and both fee-settle sites persist it. This file only
cleans up the **one** row that was charged before a writer existed. Applying this file
alone satisfies the issue's first `closes-on` query and **fails its second**, which is
exactly what the second query is for.

## Scope

| | |
|---|---|
| Rows written | **1** (`claims` `82f5dff4-5867-4b7a-88ca-942ce9bfe867`) |
| Columns written | `platform_fee_stripe_id`, `platform_fee_amount` |
| DDL / schema change | **none** |
| Other tables | **none** |
| Reversible | yes, exactly — see `_rollback.sql` |

## Pre-state, measured read-only on production 2026-09-07

`mcp__Supabase__execute_sql`, project `yeszghaspzwwstvsrioa`:

```
total_claims                                16
non-null platform_fee_stripe_id               0
non-null platform_fee_amount                  0
platform_fee_charged = true                   1
charged but no charge id                      1     <-- the target row
rows matching ch_3UAdlB0AJRnqIYPU0vC3SeiG     0

forward guard 1 predicate (id + charged + both NULL)   -> 1    (must be 1, is 1)
```

## The eight danger patterns

| pattern | present? |
|---|---|
| `DROP` of anything | no |
| `DELETE`/`TRUNCATE` | no |
| Column type change | no |
| `NOT NULL` added to an existing column | no |
| Unqualified `UPDATE` (no `WHERE`) | no — `WHERE id = …` plus two NULL predicates |
| Index build on a large table | no |
| Constraint added without validation | no |
| Data loss without a rollback | no — rollback restores the exact pre-image (NULL/NULL) |

## Run order

1. Deploy the three function changes **first** (they only add fields and gates; they
   never write a wrong value into an empty column).
2. Apply the forward half.
3. Re-run the issue's two `closes-on` queries and paste both **beside their pre-fix
   values re-measured in the same session** — the 2026-09-07 numbers above are a
   citation, not a control.
4. Settle **one new** `is_test` fee charge with **no backfill running** and assert
   `platform_fee_stripe_id` is non-null on its claim. This is the assertion that
   distinguishes a writer from a one-off `UPDATE`.
5. Exercise the dispute path both ways: a seeded **miss** observed **NOT** POSTing
   `evidence[submit]: "true"` and routed to `admin_dispute_queue` with
   `reason = "claim_unresolved"`, beside a seeded **hit** submitting correctly.

## Rollback trigger

Any of: post-check A or B raises; the issue's second query is non-zero after the next
settled charge; or a dispute simulation shows a final submission on a miss. Run
`_rollback.sql`, then redeploy the current `main` blobs of the three functions.
