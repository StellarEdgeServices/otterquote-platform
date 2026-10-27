# ADR-010: D-215 fee_acceptances INSERT must run after quote INSERT

**Date:** 2026-05-07
**Status:** Accepted
**Supersedes:** None
**Related:** D-215 (UETA Layer 1 fee acceptance evidence)

## Context

The D-215 UETA compliance layer requires that a `fee_acceptances` record be inserted at bid submission time, capturing the contractor's acceptance of platform fees (fee_pct, fee_amount, fee_text_displayed, accepted_at, ip_address, user_agent) as legal evidence.

An implementation error placed this INSERT before the `quotes` INSERT, which made it impossible to populate `bid_id` (the resulting quote's ID) and caused a PGRST204 error (`quote_id` column — which does not exist — was sent instead). Every new bid submission failed in production.

## Decision

The `fee_acceptances` INSERT **must always run after** the `quotes` INSERT succeeds, so that `insertedQuote.id` is available for the required `bid_id` field.

### Required fields (all NOT NULL)
| Field | Source |
|---|---|
| `contractor_id` | `currentContractor.id` |
| `claim_id` | `currentClaim.id` |
| `bid_id` | `insertedQuote.id` — **only available post-quote INSERT** |
| `fee_pct` | `window._feePct` (captured at form submission time) |
| `fee_basis` | `'bid_amount'` (hardcoded — fee is a % of bid amount) |
| `fee_amount` | `window._feeAmount` |
| `fee_text_displayed` | `generateExactFeeText()` result |
| `accepted_at` | ISO timestamp captured at submission time |

### Error handling
The fee_acceptances INSERT is **non-fatal** — the quote is already committed at this point. On INSERT failure:
1. Log via `console.error('[D-215] ...')`
2. Capture to Sentry with `bid_id`, `claim_id`, `contractor_id` as extras
3. Do NOT throw — the bid has been submitted; blocking the user would be worse than a missing compliance record

Sentry visibility ensures UETA failures are auditable and do not go undetected.

### Fields that do NOT exist
- `quote_id` — this column does not exist on `fee_acceptances`. Do not reference it.

## Consequences

- D-215 compliance is preserved: fee acceptance evidence is captured at the moment the bid commits, correctly linked to the committed bid record.
- Bid submission is unblocked.
- Future developers adding to this flow must keep the fee_acceptances INSERT after `insertedQuote` is confirmed.

## Deploy Checklist Gate

Added to `Deploy_Review_Checklist.md`: verify any modification to the D-215 INSERT block preserves post-quote ordering and all required NOT NULL fields.
