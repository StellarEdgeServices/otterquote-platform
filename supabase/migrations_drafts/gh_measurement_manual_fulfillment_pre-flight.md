# Pre-Flight: gh_measurement_manual_fulfillment

**Migration**: `gh_measurement_manual_fulfillment.sql`
**Rollback**: `gh_measurement_manual_fulfillment_rollback.sql`
**Date**: 2026-08-24
**Author**: Bridge `bridge-20260824T2008Z` (Cowork, Opus), Dustin-directed dump item 2
**Tier**: **3A — purely additive.** Nine nullable columns, one partial index, one
`INSERT ... ON CONFLICT DO NOTHING` seed row. Nothing dropped, renamed, retyped or
narrowed; no CHECK constraint touched; no existing row rewritten. Clears the tier
test stated on #916 (`issuecomment-5346544316`): "purely additive (new nullable
columns, new tables, indexes) … is Tier 3A and autonomous."
**Status**: **DRAFT — NOT APPLIED.** Held deliberately, see Deploy Notes.

---

## Why

Dustin, 2026-08-24: *"Make sure we are able to purchase measurements from
[our vendor]. We have measurements mailed to us and entered manually for the
first few runs."*

The existing `create-hover-order` path calls a vendor API synchronously and has
no way to express **"paid, a human will order it, not yet delivered."** These
columns give that lifecycle a home on the table that already models measurement
orders, and record the two numbers that make the unit economics visible:
what the buyer paid, and what we paid the vendor.

## Pricing context this migration encodes

Dustin's ruling the same day: *"For roofs, we are only going to make the
homeowner pay for the $15 measurement… It should be enough to bid on for most
jobs. If contractors need the full measurement, they can pay for it."*

The seeded catalog is exactly that: `roof_basic` is buyable by a homeowner at
$15 against an expected vendor cost of $11 (RoofScopeX's published condensed-report
price). `roof_full` and `exterior_full` are seeded with
`homeowner_price_cents = null` **on purpose** — charging a contractor is a money
flow Dustin has not priced, so those arrive as unpriced requests an admin quotes
by hand rather than as a price this migration invented.

## Live pre-verification (captured fresh 2026-08-24, project `yeszghaspzwwstvsrioa`)

1. `public.hover_orders` has **28 columns**, none of the nine added here.
2. `select count(*) from public.hover_orders` → **0**. The table has never held a
   row. There is no data to migrate, corrupt, or back-fill.
3. `platform_settings` primary key is `PRIMARY KEY (key)` — the `ON CONFLICT (key)`
   clause is valid.
4. `platform_settings` currently holds `hover_measurement_price = 1500`. See the
   price-drift note below.
5. Storage bucket `claim-documents` exists (private, no size limit) and is the
   destination for uploaded report PDFs at `measurements/<claim_id>/<order_id>.pdf`.
   **No new bucket is created by this change.**

## Forward + rollback both proven against the live schema

Run 2026-08-24 as a single `BEGIN … ROLLBACK` transaction against
`yeszghaspzwwstvsrioa`: the forward half, an assertion query, the rollback half,
then a final assertion — all inside one transaction that was rolled back, so
production was never modified.

| Assertion | Result |
|---|---|
| new columns present after forward | **9** |
| partial index present after forward | **1** |
| `measurement_products` row after forward | **1**, with **3** SKUs |
| new columns present after rollback | **0** |
| index present after rollback | **0** |
| catalog row after rollback | **0** |
| `hover_orders` column count after rollback | **28** (unchanged) |

Post-transaction re-read confirmed production unchanged: 28 columns, no index,
no catalog row.

## Known seam — two price sources, deliberately made loud

`create-payment-intent` prices the Stripe charge from
`platform_settings.hover_measurement_price` (D-181). `create-measurement-order`
prices the ORDER from `platform_settings.measurement_products`. Today both say
**1500** and purchases work. If an operator edits one and not the other, every
purchase would fail with a generic "amount does not match" 402 and nobody would
know why.

`create-measurement-order` therefore carries an explicit drift check
(`detectPriceDrift`) that refuses with **409 and a named reason** when the two
disagree, and logs both values. **This is a seam, not a fix.** The fix is
repointing `create-payment-intent` at the catalog, which is a Tier 3B change to a
live money function and is deliberately not bundled here.

## Deploy notes

This migration is **inert on its own** — nothing reads or writes the new columns
until `create-measurement-order` and `admin-measurements.html` are live. It is
nonetheless held rather than self-applied, because the Bridge is a Cowork session
and applying schema to production from here bypasses the D-221 Path A review the
rest of this work is going through. Apply order:

1. Merge the PR (this migration moves `migrations_drafts/` → `migrations/`).
2. Apply the migration.
3. Deploy `create-measurement-order` (`--no-verify-jwt`, matching every other
   function in this project; the handler verifies the JWT itself).
4. Confirm `admin-measurements.html` loads for an admin — it is covered by the
   existing `path = "/admin-*.html"` `admin-auth-gate` glob in `netlify.toml`,
   so **no Netlify config change is required**. Verify rather than assume.

## Rollback safety

Dropping these columns destroys any fulfillment data an admin has entered. The
rollback file carries the guard query to run first. Safe unconditionally today
(0 rows); NOT safe once orders exist.
