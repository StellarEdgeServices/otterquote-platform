<!--
STATUS (gh-1438, as of 2026-10-14T07:22Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh2431_profiles_address_state_backfill (the STATUS is the set's; it describes the forward migration)
EVIDENCE: written by gh-2431 (CTO RUN 65); production read-only SELECT counts 2026-10-14 below; proof file written, NOT yet run on production (the authoring session may not write; run it verbatim before the apply, expect the forced-rollback text)
REPO COPY: none in supabase/migrations/ (forward draft: supabase/migrations_drafts/gh2431_profiles_address_state_backfill.sql)
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh2431_profiles_address_state_backfill

**Refs** #2431. **Tier 3B** (production data write). **R-097 notice owed before apply.** **Not applied.** LEGAL-READ needed: no (no consent or disclosure wording).

## What it does
Sets `profiles.address_state = NULL` where the value is the seeded `'IN'` and nothing shows the homeowner entered it: `role='homeowner'`, `address_state='IN'`, no street, no city, no zip, and `updated_at <= created_at + 1 minute`. Each cleared id goes to a new RLS-enabled audit table so the rollback is exact. Claims, contractors and every other column are untouched.

## Production counts (read-only SELECT, project yeszghaspzwwstvsrioa, 2026-10-14)
| measure | count |
|---|---|
| homeowner profiles | 106 |
| homeowner profiles with `address_state='IN'` | 92 (36 real, 56 test) |
| matching the rule (untouched IN) | 80 = 35 real + 45 test |
| of those, with a claim | 3 (all 3 claims store a `property_state` other than IN, so the profile IN was a default, not the claim's state) |
| homeowner profiles with NULL state today | 5 |
| profiles created after the 2026-10-07T20:19:40Z fix | 3, with `address_state='IN'`: 0 |
| claims created after the fix | 1 (`post_fix_mismatch=0`) |

## Readers
Every reader already treats NULL as unknown (table in `gh2431_profiles_address_state_default_pre-flight.md`). Effect on the 80 rows: the profile state reads blank instead of Indiana until the homeowner enters one.

## Risk and rollback
Worst case: one of the 80 is an Indiana homeowner who never typed an address; their profile reads blank, not Indiana. Rollback: `supabase/migrations_rollbacks/gh2431_profiles_address_state_backfill_rollback.sql` restores `'IN'` on exactly the audited ids still NULL, then drops the audit table.

## Proof
`supabase/tests/gh2431_address_state_backfill_proof.sql` (one DO block, forced RAISE): fixtures A untouched IN (cleared, restored), B IN with city (kept), C IN updated later (kept), D WA (kept). Static guard: `tests/gh2431-profiles-address-state-backfill.mjs` (21 pass; negative control: removing the city condition fails 2).
