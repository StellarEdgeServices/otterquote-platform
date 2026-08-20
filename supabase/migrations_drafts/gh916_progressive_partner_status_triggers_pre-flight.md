# Pre-Flight: gh916_progressive_partner_status_triggers

**Migration**: gh916_progressive_partner_status_triggers.sql
**Date**: 2026-08-18
**Author**: Code lane sub-agent (automated), run-work orchestration
**D-numbers**: D-182 (Tier 3)
**GitHub**: #916 AC2 ("A migration (through migration-author, Dustin-approved) adds the stage-1/2/3 trigger calls, including a real write signal for bid_received"); also closes the "not progressive" gap restated on #856 (comment 2026-08-18T18:27:18Z).
**Status**: DRAFT ONLY — NOT APPLIED. Requires a D-182 approval task before execution.

---

## Change Summary

`send-partner-status-email` (#856/#905, deployed v1) is wired to fire only from
`mark-job-complete` in catch-up mode (#923) — a partner referral currently only
gets any status email retroactively, all at once, when the job completes. This
migration adds three progressive trigger sites so partners hear about earlier
milestones (intake, bid submitted, contract/commission) as they actually happen:

1. **`claims_advance_referral()`** (existing function, modified) — after it
   advances a referral to `claim_submitted`, fires `send-partner-status-email`
   in catch-up mode (no explicit `stage` — the function's own live
   claims/quotes-state detection decides what's eligible).
2. **`notify_partner_status_on_bid_submitted()`** (new function) + a new
   `AFTER INSERT ON quotes` trigger — the "bid submitted / bid_received"
   signal #916 found had **no live write path anywhere in the schema**.
3. **`apply_referral_commission()`** (existing function, modified) — adds the
   same catch-up call alongside its existing `notify-payout-pending` call,
   reusing the already-resolved Vault key where possible.

All three additions are non-fatal, independently wrapped in their own
`BEGIN/EXCEPTION` blocks, and use the same Vault (`cron_service_role_key`)
key-resolution pattern Dustin already approved and this repo already runs in
production via gh-752 (2026-08-17) — not the unset `app.*` GUCs.

**Not a stage-number-precise design.** Every call site sends only
`{referral_id}` and lets `send-partner-status-email`'s own eligibility
detection and compare-and-swap idempotency guard decide what to actually
send. This means the exact DB event each trigger fires on does not have to
line up perfectly with the function's 5-stage semantics — it can never
double-send or send a stage before its real preconditions are met, because
that logic already lives entirely inside the Edge Function, not in these
triggers.

---

## Row Count Estimate (live, checked 2026-08-18)

| Table | Row Count | Source |
|-------|-----------|--------|
| claims | 12 | `execute_sql` this session |
| quotes | 4 | `execute_sql` this session |
| referrals | 8 | `execute_sql` this session |
| claims with `referral_id` set | 1 | `execute_sql` this session |

All three tables are tiny. This is a `CREATE OR REPLACE FUNCTION` /
`CREATE TRIGGER` migration — it does not touch table structure or existing
rows at all, so table size is irrelevant to lock risk; it is included per the
pre-flight template's standard section.

---

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|--------------------|
| `CREATE OR REPLACE FUNCTION` ×2 | none (function definition swap, not a table lock) | negligible |
| `CREATE FUNCTION` ×1 (new) | none | negligible |
| `CREATE TRIGGER` on `quotes` | `ACCESS EXCLUSIVE`, briefly, to attach the trigger | < 5ms on a 4-row table |

No `ALTER TABLE`, no index build, no data migration. This is the lowest-risk
migration shape available for adding trigger behavior.

---

## Danger Pattern Check

| # | Pattern | Triggered? | Override? |
|---|---------|-----------|-----------|
| 1 | NOT NULL column without DEFAULT | No — no columns added | — |
| 2 | NOT NULL on table > 100K rows | No | — |
| 3 | DROP COLUMN | No | — |
| 4 | Type change requiring table rewrite | No | — |
| 5 | Index without CONCURRENTLY on hot table | No — no index added | — |
| 6 | RENAME TABLE or RENAME COLUMN | No | — |
| 7 | TRUNCATE or DELETE all rows | No | — |
| 8 | CASCADE DROP | No | — |

**All 8 patterns clear. No overrides required.**

Additional risk not on the standard 8-item list, called out explicitly
because two of the three sites are payment/commission-adjacent:

- **`apply_referral_commission()` is on the real payment path** (fires on
  `quotes.payment_status -> succeeded` for jobs >= $10K). The new block is
  appended strictly *after* the existing commission/payout_approvals logic,
  in its own `EXCEPTION WHEN OTHERS` block, and the function's own outer
  `EXCEPTION WHEN OTHERS` (unchanged) still wraps everything. A failure in
  the new block cannot roll back the commission write or the payment itself
  — same guarantee gh-752 already relies on for the adjacent
  `notify-payout-pending` call in the same function.
- **New trigger fires on every `quotes` INSERT**, not just claims with a
  referral. It resolves `referral_id` via `claims` first and returns
  immediately (no Vault lookup, no `pg_net` call) when the claim has no
  referral attached — this is the common case (only 1 of 12 claims is
  referral-linked today) and adds one cheap indexed-lookup-free `SELECT`
  from `claims` per bid, which is negligible at current volume.
- **`send-partner-status-email` itself already rate-limits** (`rate_limit_config`
  row, 10/hr — confirmed live via #976). A burst of trigger-fired calls
  beyond that limit degrades to 429s inside the Edge Function, not a DB-side
  failure; the calling trigger doesn't inspect the response.

---

## Code Path Impact Analysis

- **`claims_advance_referral()` callers**: only the existing
  `trg_claims_advance_referral AFTER INSERT OR UPDATE OF referral_id ON claims`
  trigger. No other caller. Behavior for referrals already at
  `claim_submitted` or later is unchanged (the `WHERE status IN ('clicked',
  'registered')` guard still no-ops the UPDATE, so `v_rows_updated = 0` and
  the new notify block is skipped entirely — no extra pg_net calls on
  already-advanced referrals).
- **`apply_referral_commission()` callers**: only the existing
  `after_quote_paid` trigger (`quotes.payment_status -> succeeded`,
  `total_price >= $10,000`). No change to the commission math, the
  `payout_approvals` insert, or the existing `notify-payout-pending` call —
  those five numbered sections (1-7 plus the original half of section 8) are
  byte-identical to the live gh-752 body.
- **New `quotes AFTER INSERT` trigger**: does not interact with the four
  existing `quotes`-table triggers (`quotes_enforce_bid_can_submit`,
  `quotes_normalize_fee_amount`, `trg_enforce_bid_window_expiry`,
  `trg_set_bid_window_on_first_bid`, `trg_log_bid_submitted`) — Postgres
  fires all `AFTER INSERT` triggers on a table in name order for the same
  event; none of them mutate columns this trigger reads (`claim_id`), so
  ordering is not a correctness concern here.
- **`send-partner-status-email` itself**: unmodified. It already handles
  being called multiple times for the same referral safely (idempotency
  guard) and already handles being called before a claim exists at all
  (`no claim linked to this referral yet` skip path) — both are exercised
  today by the existing `mark-job-complete` catch-up call, so this migration
  introduces no new code path inside the Edge Function, only new callers.

---

## Supabase Branch Test Results

**Not run.** This migration is draft-only (no DB writes of any kind,
including branch tests) per the standing rule that migrations are Tier 3 /
D-182 and this lane does not self-execute them. Run a branch test — apply
this migration on a Supabase branch, insert a synthetic referral-linked
claim + quote, and confirm `net._http_response` / `rate_limits` show the
expected calls with no errors — as part of the D-182 approval workflow
before applying to production.

---

## Deploy Notes

- **D-182 Tier**: 3 — SQL migration touching a payment-adjacent trigger
  function (`apply_referral_commission`). Requires explicit Dustin approval
  before execution.
- **Deploy path**: GitHub PR → merge → approved manual `apply_migration`
  (matches the `v88` precedent — merging the PR does NOT apply this
  migration; there is no auto-run pipeline for `supabase/migrations` in this
  repo).
- **Rollback pre-authorized**: yes — run
  `gh916_progressive_partner_status_triggers_rollback.sql` if unexpected
  errors appear post-apply. The rollback restores both modified functions to
  their exact current live bodies and drops the new function/trigger; it
  does not destroy any `send-partner-status-email` idempotency data written
  in the meantime (that lives in `referrals.metadata`, untouched by this
  migration or its rollback).
- **Monitoring**: watch Postgres logs (`RAISE LOG` lines from all three
  sites are prefixed with the function name) and Mailgun send volume for the
  first 30 minutes post-apply. Given current live volume (1 of 12 claims
  referral-linked, 4 quotes total), no meaningful send-volume spike is
  expected.
- **Follow-on work**: none required by this migration alone — closes #916
  AC2 in full, including the `bid_received` write-path gap. #916 AC3 is
  otherwise already resolved (mark-job-complete wired via #923;
  approve-payout wiring confirmed a deliberate non-goal, PR #965 closed
  unmerged).

---

## Danger Overrides

None.
