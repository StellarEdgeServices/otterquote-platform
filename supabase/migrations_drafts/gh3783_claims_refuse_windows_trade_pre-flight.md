<!-- STATUS (gh-1438, as of 2026-11-16T14:15:14Z): NOT APPLIED -->
<!-- EVIDENCE: read-only production SELECT on project yeszghaspzwwstvsrioa in this session (before 2026-11-16T14:15:14Z) (CEO RUN 153, b3783) -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->
# Pre-flight: gh3783_claims_refuse_windows_trade (Tier 3B)

NOT APPLIED. Refs #3783, D-375 (#2536 comment 6039706944). R-097 24-hour notice applies before apply. Protective only (R-134).

## Rows that would violate it (read-only, SELECT only, run before 2026-11-16T14:15:14Z)
Query: `select count(*) total, count(*) filter (where exists (select 1 from unnest(trades) x where lower(x)='windows')) trades_windows, count(*) filter (where windows_bid_released_at is not null) windows_released from public.claims`
Result: total 43, trades_windows 0, windows_released 0 (non-test windows rows: 0). So 0 existing rows violate it. Re-run immediately before apply; a non-zero count means a homeowner picked Windows after this read and the apply must wait for a ruling.
`public.claims` has 20 non-internal triggers today (same read); this adds one, distinct name, shares no object with any other.

## Writers that would now be refused
- dashboard.html and react-app/app/(homeowner)/dashboard/actions.ts stamp windows_bid_released_at (guarded in the same PR, so the browser no longer attempts it).
- trade-selector (static and React) saves claims.trades; PR #3781 stops Windows being selectable. Until #3781 is published, a homeowner who still selects Windows would get a save error after apply: publish #3781 AND deploy the code of PR #3784 first (main's React submit would otherwise surface the trigger text).
- supabase/functions/notify-contractors only reads the stamp; it does not write it.

## Rollback
gh3783_claims_refuse_windows_trade_rollback.sql drops the trigger and function only.

## Proof
`bash supabase/tests/gh3783_claims_refuse_windows_trade_proof_run.sh` (throwaway Postgres: TODAY negative control, AFTER forward twice, ROLLBACK).
