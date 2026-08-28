# Pre-Flight: c4_contractor_pitch_bands

**Migration**: `c4_contractor_pitch_bands.sql`
**Rollback**: `c4_contractor_pitch_bands_rollback.sql`
**Date**: 2026-08-27
**Tier**: **3A — purely additive.** One nullable JSONB column. Nothing dropped,
renamed, retyped or narrowed; no CHECK constraint touched; no existing row rewritten.
**Status**: **DRAFT — NOT APPLIED.** Every migration is Tier 3 and requires Dustin's approval.

## Why

Dustin's ruling, 2026-08-27: *"Per contractor band, but fall back to exactimate if
none is given."*

Three authorities disagree about where "steep" starts, and all three are real:

| Source | Steep threshold |
|---|---|
| Indy Rooftops' rate card | **over 5/12**, second band "Roofs from 10/12 to 12/12" |
| Xactimate | **7/12 and steeper** (confirmed) |
| RoofScope's own report | Standard 4:12-6:12, **Steep "7:12 or greater"** |

A contractor bidding retail off 5/12 while supplementing insurance off 7/12 produces
inconsistent numbers on the same roof. That is his commercial choice, so the bands
are his data, not a platform constant.

## What consumes it

`create-docusign-envelope` → `generateRetailScopeOfWorkPdf`:
- `bucketByBands()` buckets `claims.hover_measurements.areas_by_pitch` into these bands
  to break tear-off / shingles / underlayment out per band on Exhibit A.
- Area above the top priced band renders as its own row marked **"Quote required"**
  and never folds into the last band. The reference RoofScope report carries
  **2.80 SQ at 24:12** against a rate card that stops at 12/12.
- `two_story_adder` drives the two-story access contingency row.

Raw per-pitch areas are stored and bucketed **at render time**. Pre-bucketed totals
are never stored: changing a band would otherwise silently rewrite history.

## Behaviour before it is applied

`contractorData?.pitch_bands` resolves to `undefined`, `bucketByBands` falls back to
`XACTIMATE_FALLBACK_BANDS` (two bands: standard 6/12 and under, steep 7/12 and
greater), and Exhibit A renders exactly as it does today. The column is not
load-bearing for any current envelope.

**The fallback encodes only what was confirmed from a primary source: the 7/12
threshold.** The commonly-cited upper Xactimate boundaries (7-9, 10-12, over 12)
could not be confirmed and are deliberately NOT invented. Check a live Xactimate
price list before adding more bands.

## Forward + rollback proven against the live schema

Run 2026-08-27 against `yeszghaspzwwstvsrioa` as a single `BEGIN ... ROLLBACK`
transaction: forward half, assertion, rollback half, final assertion — all inside
one transaction that was rolled back, so production was never modified. See the
transcript in the session record.

## Danger-pattern check

| Pattern | Present |
|---|---|
| DROP / destructive DDL | No (forward half) |
| Column rename or retype | No |
| Constraint narrowing | No |
| NOT NULL on existing table | No |
| Data backfill / rewrite | No |
| Index on a large hot table | No |
| RLS / grant change | No |
| Trigger or function change | No |
