<!--
STATUS (gh-1438, as of 2026-10-06T20:30Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh2431_profiles_address_state_default (the STATUS is the set's; it describes the forward migration)
EVIDENCE: written by gh-2431; production read-only 2026-10-06 (counts below); forward and rollback proven in one self-rolling-back block, production unchanged after
REPO COPY: none in supabase/migrations/ (forward draft: supabase/migrations_drafts/gh2431_profiles_address_state_default.sql)
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh2431_profiles_address_state_default

**Refs** #2431 (found by the refuter on #2428; relates to #2421 / D-344). **Tier 3B** (a column default and a live auth-trigger function). **Not applied.**

## What it does
1. `ALTER TABLE public.profiles ALTER COLUMN address_state DROP DEFAULT` (catalog only; no row is read or rewritten).
2. `CREATE OR REPLACE public.handle_new_user()`: the live body minus the `address_state` column and its hard-coded `'IN'`. Two lines differ from live; every other line is byte-identical. The existing trigger `on_auth_user_created` is reused; no second trigger.

Effect: a new homeowner's profile starts with no state (NULL) until the homeowner supplies one, instead of starting as Indiana.

## Not touched
Any existing row (no backfill); `contractors.address_state` (also `DEFAULT 'IN'`, another table, another question); the state gate; any Edge Function.

## Readers of `profiles.address_state` and what each does with NULL (main, unfiltered grep; contractor-table readers excluded, they read `contractors`)
| reader | NULL behaviour | change |
|---|---|---|
| `trade-selector.html` (profile select, `property_state: profile?.address_state \|\| null`) | claim `property_state` = null; address string skips it | none |
| `react-app/app/trade-selector/page.tsx` profile fallback | `(x \|\| '').trim() \|\| null` | none |
| `dashboard.html` gate, React `isStateGated` | NULL is not gated (existing, tested: dashboard.test.tsx "does not gate a null/absent property_state"); never coerced to IN | none |
| `help-measurements/utils.ts` | empty string (existing test expects `''`) | none |
| `create-docusign-envelope` `customer_city_zip` | `filter(Boolean)`: state omitted if NULL | none |
| `notify-admin-new-homeowner` location line | `filter(Boolean)`: "location not yet provided" if all empty | none |
| SQL: functions, views, policies, cron, constraints, indexes, matviews referencing `address_state` | only `handle_new_user()` (profiles) and `get_contractors_public()` (contractors) | `handle_new_user()` only |

New test: `tests/gh2431-profiles-address-state-null.mjs` pins the migration shape and each reader's NULL handling. Negative control: with the forward file changed to `SET DEFAULT 'IN'` the first assertion fails.

## What the gate does for a NULL state (decision)
Unchanged and now explicit: a NULL `property_state` is not gated, and the out-of-state alert (gh-2421) does not fire for NULL. Neither treats unknown as Indiana. This is what #2428 shipped and tested (pre-intake drafts are NULL by design). Whether an unknown state should instead be held for review is a question for Ben, not decided here (see the PR).

## Production proof (one DO block, forced rollback; file `supabase/tests/gh2431_address_state_default_proof.sql`)
```
BEFORE  : column_default='IN'::text fn_md5=8d540450... signup_state=IN      explicit_WA_kept=t
FORWARD : column_default=<none>     fn_md5=044cf86f... signup_state=<NULL>  explicit_WA_kept=t
ROLLBACK: column_default='IN'::text fn_md5=8d540450... signup_state=IN      explicit_WA_kept=t
profiles rows: before=120 inside_block=123 (3 fixtures expected)
```
After the block: default `'IN'::text`, function md5 prefix 8d540450, 120 profiles, 0 fixture users left: production unchanged.

## Data (production SELECT, 2026-10-06; no migration writes any of it)
`profiles` by role / `is_test` / `address_state`, with how many were ever updated after creation (`updated_at` more than 1 s after `created_at`):
```
homeowner  is_test=false  IN          36   (1 updated after create)
homeowner  is_test=false  NULL         2   (2 updated)
homeowner  is_test=false  CA, WA       1 each
homeowner  is_test=false  "IN <zip>"   3   (dirty values, pre-existing)
homeowner  is_test=true   IN          56   (10 updated)   NULL 1   "IN <zip>" 3
contractor false IN 1 | true IN 15 | true "IN 46201" 1
```
Signal separating a real Indiana answer from the default: of the 36 real homeowners at `IN`, 35 were never updated after signup and carry no street, city or zip; 1 was updated and has an address. 4 of the 8 real claims have a state that differs from their owner's profile state. Claims: real = NULL 4, CA 1, WA 1; test = IN 20, NULL 4.

Proposed rule for the separate data PR (Tier 3B, not in this PR): set `address_state = NULL` where `role = 'homeowner'` AND `address_state = 'IN'` AND `updated_at <= created_at + 1 second` AND street, city and zip are all NULL AND the owner has no claim with `property_state = 'IN'`. Counted on production 2026-10-06 with exactly that predicate: 35 real and 45 test homeowner rows. Rows with an address, or updated after signup, are left alone.

## Rollback
`supabase/migrations_rollbacks/gh2431_profiles_address_state_default_rollback.sql`: restores `DEFAULT 'IN'::text` and the previous function body. Profiles created while the migration was live keep NULL (nothing rewrites data).

## What could go wrong
- A new homeowner who never enters a state has a NULL state, and so does their claim: the gate lets them through and no alert fires. Before this change they were stored as Indiana, with the same gate and alert outcome, so nothing gets worse; but an unknown-state Florida homeowner is still not caught by the gate. The fix for that is the question for Ben.
- DocuSign contract and the Hover order omit the state for a profile with none (they showed IN before).
- `ALTER TABLE` takes a brief exclusive lock on `profiles`; metadata only.
