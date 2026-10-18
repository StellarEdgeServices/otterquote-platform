# Pre-flight: gh2803_selected_bid_notes_rpc (Tier 3B, DRAFT)

NOT APPLIED. Refs #2803. Decision: D-381 (Dustin, 2026-10-08): "contractor notes stay editable". Ruling: tier:3b (issue #2803, 2026-10-18T18:38Z). R-097 window ends 2026-10-19T18:37:39Z. **Apply order: gh2564 (PR #2802 is its page half), then gh2803**, only after `tier:3b-approved`.

## What it does
Adds `public.update_selected_bid_notes(p_quote_id uuid, p_notes text) RETURNS text`, SECURITY DEFINER, `search_path = public, pg_temp`. It writes `quotes.notes` only: the "Message to Homeowner" field of `contractor-bid-form.html` (`homeownerMessage`, maxlength 500, saved as `notes`). It refuses unless the caller is signed in, owns the quote through `contractors.user_id = auth.uid()`, and the quote is `status` selected/awarded with `bid_status` active. Notes are trimmed, empty becomes NULL, over 500 characters is refused. EXECUTE: revoked from PUBLIC, anon and service_role, granted to authenticated. No table, trigger, policy or data change.

## Live enumerations (production yeszghaspzwwstvsrioa, read-only SELECTs, 2026-10-18)
`public.quotes` columns (49): id, claim_id, contractor_id, total_price, estimated_days, timeline_note, scope_summary, **notes** (text, nullable), fee_percentage, fee_amount, fee_agreed, fee_agreed_at, status, created_at, updated_at, decking_price_per_sheet, full_redeck_price, supplement_acknowledged, trade_type, is_bundled_bid, bundled_trades, per_trade_breakdown, value_adds, payment_intent_id, payment_status, docusign_envelope_id, contractor_signed_at, homeowner_signed_at, is_auto_bid, payment_method_id, payment_method_type, card_fee_cents, cancelled_at, cancellation_reason, expires_at, auto_renew, renewed_from_quote_id, expired_at, bid_status, warranty_option_id, warranty_snapshot, material_selection, workmanship_warranty_years, warranty_document_url, warranty_uploaded_at, platform_fee_pct, platform_fee_basis, fee_accepted_at, is_test.

There is no separate "rationale" column. The form's final-notes box, `wizardRationale`, is stored inside `value_adds.wizard_rationale` (jsonb), and D-381 locks `value_adds`, so it is NOT editable by this path. The one editable notes column is `quotes.notes`.

Triggers on `public.quotes` (non-internal, all enabled): after_quote_refunded (AFTER UPDATE OF payment_status), quotes_enforce_bid_can_submit (BEFORE INSERT), **quotes_guard_homeowner_columns** (BEFORE INSERT OR UPDATE), **quotes_normalize_fee_amount** (BEFORE INSERT OR UPDATE; sets fee_amount = round(platform_fee_pct/100 * total_price, 2)), **set_updated_at_quotes** (BEFORE UPDATE), trg_enforce_bid_window_expiry (BEFORE INSERT), **trg_log_bid_accepted** (AFTER UPDATE; acts only on a status change to selected, so a notes write does nothing), trg_log_bid_submitted, trg_notify_partner_status_on_bid_submitted, trg_set_bid_window_on_first_bid (all AFTER INSERT).

Policies on quotes: contractor INSERT/SELECT/UPDATE own (via contractors.user_id), homeowner SELECT/UPDATE for their claims.

Counts: selected bids on real (non-test) claims **0**; selected bids total 3, all is_test; is_test quotes 7. Rows where fee_amount differs from round(platform_fee_pct/100*total_price, 2): **0** (so `quotes_normalize_fee_amount` leaves fee_amount unchanged on a notes write). Longest existing notes: none (all NULL). `update_selected_bid_notes` in pg_proc: 0.

## Why the guard does not see this write
`quotes_guard_homeowner_columns()` acts only when `current_user IN ('anon','authenticated')`. A SECURITY DEFINER body runs as its owner, so the function does its own checks (ownership, selected status, notes-only UPDATE). It composes with the gh2564 draft, which adds a selected-bid price/fee/terms lock inside that same guard: this function never writes those columns.

## Finding to weigh (not a blocker)
With gh2564 applied the guard still permits a direct client `UPDATE quotes SET notes = ...` by the owning contractor on a selected bid (notes is in the contractor allow-list and is not in the gh2564 lock list; its pre-flight says "`notes` ... stays writable"). So the database already allows a notes-only write; the new RPC adds a *narrow, auditable* path that can write nothing but notes and only on a selected, active bid. If the CTO prefers, the form block can call a direct `.update({notes})` instead and the migration is not needed. This draft follows the issue's chosen shape.

## Before applying
- gh2564 applied: `SELECT prosrc LIKE '%gh-2564%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure` is true. The proof's control B fails otherwise, by design.
- `SELECT count(*) FROM pg_proc WHERE proname = 'update_selected_bid_notes'` is 0.
- `SELECT count(*) FROM public.quotes WHERE platform_fee_pct IS NOT NULL AND fee_amount IS DISTINCT FROM round(platform_fee_pct / 100.0 * total_price, 2)` is 0.

## After applying
```sql
SELECT proacl, prosecdef, proconfig FROM pg_proc WHERE oid = 'public.update_selected_bid_notes(uuid,text)'::regprocedure;
-- expect prosecdef t, proconfig {search_path=public, pg_temp}, proacl with authenticated=X and NO anon, NO service_role, NO PUBLIC (=X/)
```
Then run `supabase/tests/gh2803_selected_bid_notes_proof.sql` (ends in ROLLBACK).

## Proof plan (supabase/tests/gh2803_selected_bid_notes_proof.sql, BEGIN ... ROLLBACK, is_test quote only)
- A: the selected contractor saves notes through the function; a SELECT shows the trimmed value.
- B (negative control): the same contractor's direct `UPDATE quotes SET total_price = total_price + 1` is refused 42501.
- B2: a different contractor calling the function on this quote is refused 42501. B3: anon has no EXECUTE. B4: 501 characters refused.
- C: an md5 of price, fee_amount, fee_percentage, platform_fee_pct, platform_fee_basis, card_fee_cents, decking/redeck prices, per_trade_breakdown, trade_type, bundled_trades, value_adds, warranty_option_id, warranty_snapshot, workmanship_warranty_years, scope_summary, status and bid_status is identical before and after.
Status of this proof: written, NOT run. The authoring session had no scratch Postgres and may not run write SQL on production during the R-097 window.

## Rollback
`supabase/migrations_drafts/gh2803_selected_bid_notes_rpc_rollback.sql` drops the function. No data is lost.
