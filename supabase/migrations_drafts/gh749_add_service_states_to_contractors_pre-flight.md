# Pre-Flight: gh749_add_service_states_to_contractors

**Migration**: gh749_add_service_states_to_contractors.sql
**Date**: 2026-08-21
**Author**: Code lane sub-agent (automated), run-work orchestration
**GitHub**: #749 (contractor pre-approval — structured service_states column)
**Tier**: 3A — purely additive: one new nullable column + a one-time backfill
UPDATE that writes only that new column. Nothing existing is dropped,
narrowed, or rewritten. Per the #916 tier-test precedent
(`issuecomment-5346544316`): "purely additive (new nullable columns, new
tables, indexes) … is Tier 3A and autonomous." This clears that test.
**Autonomous: no R-097 24-hour notice, no D-182 approval gate for this
step.**
**Status**: DRAFT — same-session apply path (Tier 3A), per this repo's own
gh1150/gh1021 precedent from earlier this session.

---

## Change Summary

Adds `service_states text[] NULL` to `public.contractors` for structured,
queryable state coverage (enables admin filtering/matching by state without
parsing free text), then backfills it for every row with derivable state
data from either legacy source (`service_area_description` free text,
`service_counties` array). `service_area_description` and `service_counties`
are left untouched — this is additive, not a cutover.

---

## Live Pre-Verification (captured fresh this session, 2026-08-21, against project `yeszghaspzwwstvsrioa`)

Re-verified from scratch before touching anything, per this lane's
verification-first rail — the issue (filed 2026-08-12, last updated
2026-08-18) is over a week old and its premises were checked against
current state, not assumed:

1. **`information_schema.columns` for `public.contractors`** — confirms
   `service_area_description` exists (`text`, nullable) and `service_states`
   does **not** exist yet. Matches the issue's premise.

2. **Contractor census**: `total_contractors=11`, `active_status=5`,
   `with_service_area (non-null/non-empty service_area_description)=6`.
   **This contradicts the issue's stated "0 active contractors as of
   filing"** — there are now 5 active contractors, not 0. This does not
   change scope or block the migration (it's still purely additive), but it
   does mean the backfill below is now populating real, non-test coverage
   data rather than an empty column, which is a materially better outcome
   than the issue anticipated.

3. **Row-level inspection of all 11 contractors** (`service_area_description`,
   `service_counties`):
   - 6 rows carry `service_area_description = 'IN'` (never multi-value/
     comma-joined in live data, though the backfill handles that shape too).
   - 3 more rows carry no `service_area_description` but do carry
     `service_counties = ['IN:*']`.
   - 2 rows carry neither (both `pending_approval`, one with `service_counties
     = []`, one with both fields NULL) — these are left NULL by the backfill,
     nothing to derive.
   - **Format correction vs. existing code assumption**: `admin-contractors.html`
     (pre-change) contains a comment claiming state can be derived from
     `service_counties` by taking the suffix after a hyphen (e.g.
     `"Marion-IN"` → `"IN"`). Live data does not match that shape — it's
     `"STATE:county"` / `"STATE:*"`, colon-separated, state as the **prefix**,
     not a hyphen suffix (e.g. `"IN:*"`). That existing derivation is
     effectively dead/broken code today (`split('-').pop()` on `"IN:*"`
     returns `"IN:*"` unchanged, not `"IN"`). The admin-contractors.html
     change in this PR replaces that broken derivation with a direct read of
     the new `service_states` column, using the same colon-prefix logic
     (correctly) only inside the migration's SQL backfill.
   - All live state coverage today is Indiana only — consistent with
     OtterQuote's current single-state launch footprint.

4. **`ls supabase/migrations_drafts/`** — 11 files present pre-change (none
   named `gh749*`), confirming a fresh draft, not a review of prior work.

Rail satisfied: the issue's core premise (additive `service_states` column,
`admin-contractors.html` update) holds. Two of its stated details are stale
(active contractor count, county-string format) — noted above, both
strengthen rather than block the case for shipping this.

---

## Row Count Estimate

| Table | Row Count | Source |
|-------|-----------|--------|
| contractors | 11 | `execute_sql` this session, 2026-08-21 |

---

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|--------------------|
| `ADD COLUMN service_states text[] NULL` (no DEFAULT, nullable) | `ACCESS EXCLUSIVE`, brief — metadata-only, no table rewrite for a nullable column with no default | < 5ms on an 11-row table |
| Backfill `UPDATE` (≤9 rows touched) | Row-level locks only | < 5ms on an 11-row table |

---

## Danger Pattern Check

| # | Pattern | Triggered? | Override? |
|---|---------|-----------|-----------|
| 1 | NOT NULL column without DEFAULT | No — `service_states` is nullable, no default needed | — |
| 2 | NOT NULL on table > 100K rows | No | — |
| 3 | DROP COLUMN | No (forward migration adds only; rollback drops only the new column, nothing else) | — |
| 4 | Type change requiring table rewrite | No | — |
| 5 | Index without CONCURRENTLY on hot table | No — no index added | — |
| 6 | RENAME TABLE or RENAME COLUMN | No | — |
| 7 | TRUNCATE or DELETE all rows | No — backfill is UPDATE on ≤9 of 11 rows, writing only the new column | — |
| 8 | CASCADE DROP | No | — |

**All 8 patterns clear. No overrides required.**

---

## Code Path Impact Analysis

- No application code, Edge Function, RLS policy, or view reads or writes
  `service_states` today — this migration is the first thing to populate it.
- `admin-contractors.html`'s "States" display (Service Area card section) is
  updated in this same PR to read `c.service_states` directly instead of
  deriving from `service_counties` suffix-splitting (which did not match
  live data format — see pre-verification #3 above). The existing "Counties"
  display and the license-board state derivation (also county-suffix based,
  used for `openLicenseBoard`) are left as-is — out of scope per the issue's
  AC, which names only the free-text state display.
- `service_area_description` and `service_counties` are not modified,
  dropped, or stopped being written by any existing code path.

---

## Supabase Branch Test Results

**Not run.** Two single-statement-shaped DDL/DML operations (`ADD COLUMN`,
then a scoped `UPDATE`) on an 11-row table, additive-only shape (new
nullable column, backfill touches only that column). A branch test is
judged unnecessary; the post-apply verification queries below serve the
same confirmatory purpose directly against the real result, consistent with
this repo's own gh1150/gh1021 precedent from earlier this session.

---

## Post-Apply Verification (run immediately after `apply_migration`)

1. `information_schema.columns` for `contractors` — must show
   `service_states` (`ARRAY`/`text[]`, nullable).
2. `SELECT count(*) FILTER (WHERE service_states IS NOT NULL) FROM
   contractors` — expected 9 (of 11).
3. `SELECT service_states FROM contractors WHERE service_states IS NOT
   NULL` — expected all `{IN}`.
4. Read the applied version from `supabase_migrations.schema_migrations`
   directly — not the git filename.
5. `service_area_description` and `service_counties` values unchanged
   (spot-check the same rows against the pre-verification snapshot above).

---

## Deploy Notes

- **Tier**: 3A, autonomous. No R-097 24-hour notice; no D-182 approval gate
  for this step — per the #916 tier-test precedent and this repo's own
  gh1150/gh1021 Tier-3A same-session-apply precedent from earlier this
  session.
- **Deploy path**: apply directly via `apply_migration` against
  `yeszghaspzwwstvsrioa` this session (Tier 3A autonomy), then include the
  migration files in the same PR as the `admin-contractors.html` change for
  git history / review record. Applying does not wait on PR merge for a
  purely additive Tier-3A change, consistent with this session's own
  precedent.
- **Rollback pre-authorized**: yes —
  `gh749_add_service_states_to_contractors_rollback.sql`. No guard needed
  (see rollback file header) — dropping `service_states` cannot destroy data
  in either legacy source column.
- **Monitoring**: watch Postgres logs / Sentry for ~15 minutes post-apply
  for unexpected errors touching `contractors`. Given the change is
  additive-only with one new consuming read path (admin-contractors.html
  display only, no writes), no behavior change elsewhere is expected.
- **Follow-on work**: none required by #749's AC. A future nice-to-have
  (not filed): teach `contractor-pre-approval.html`'s states-selector to
  write `service_states` directly at intake time, so future contractors get
  it without relying on this one-time backfill. Left as a NOTE FOR THE
  BRIDGE rather than filed unilaterally.

---

## Danger Overrides

None.
