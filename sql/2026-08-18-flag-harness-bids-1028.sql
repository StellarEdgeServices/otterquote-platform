-- ============================================================================
-- OtterQuote Internal E2E Harness — Flag Contaminated Rows — GitHub #1028
-- ============================================================================
-- Created: 2026-08-18
-- Executed: 2026-08-18 via Supabase MCP (run-work code, rw-f22-20260818T203358-9b4e)
--
-- Purpose (Dustin-approved 2026-08-18, Board Q7 — "flag + exclude, do NOT delete"):
--   An internal E2E harness account has been writing bid_submitted (and related)
--   activity_log events into PRODUCTION since at least 2026-06-08. This corrects
--   #945, which attributed the resulting activity spike to bots.
--
-- PREFLIGHT EVIDENCE (live prod, 2026-08-18T20:46Z):
--   Harness account: test-contractor@otterquote-internal.test
--     auth.users.id    = 189b85ad-0ab0-4e54-9083-c51c3ef42a1d
--     contractors.id   = bb07fc40-3607-4f3f-ac44-dffd4ca95111 ("Test Roofing Co (E2E)")
--
--   *** Correction to #1028's own premise (AC3 — reporting the mismatch, not
--   silently proceeding past it): the issue states the harness account is
--   "absent from contractors" and cites "232 bid_submitted rows in 7 days".
--   Neither holds at investigation time:
--     - The account DOES have a contractors row (status='active', created
--       2026-07-07) — it was not always absent, or the issue's source read
--       was stale.
--     - activity_log rows for this account: 1027 total (all event_types),
--       of which 661 are event_type='bid_submitted' (659 referencing a
--       claim_id with no matching row in claims), spanning 2026-06-08 through
--       2026-08-17 22:57:56 — i.e. the true contamination window is ~2.5
--       months, not 7 days. A strict last-7-days-from-now slice returns 217
--       bid_submitted rows, closer to but still not exactly 232 (the harness
--       stopped ~22h before this was run, so a rolling 7-day window no longer
--       contains the same slice #1028's author saw).
--   Net: the predicate below flags the FULL contamination (all 1027 rows from
--   this account, every event_type), not a 232-row or 7-day subset — a partial
--   flag would leave real gaps in "every reporting view returns the same
--   numbers with and without the harness rows" (AC4's own bar).
--
--   Harness activity: MAX(created_at) = 2026-08-17T22:57:56Z; DB now() at
--   investigation time = 2026-08-18T20:46:04Z — 22h50m of silence. Combined
--   with GitHub #945/#1028 being filed today describing it as "still going" as
--   of ~19:10Z, the harness appears to have stopped independently sometime in
--   that window (separately confirmed/investigated under item 4 of today's
--   lane — see that item's report for the actual stop mechanism, if found).
--   AC6 gate: re-verify MAX(created_at) has not advanced before closing #1028.
--
--   quotes table: this harness/contractor pair has exactly 2 REAL quotes rows
--   (2026-08-11, both referencing valid, existing claim_ids — i.e. these two
--   did NOT hit the dangling-claim condition that blocks most of its fake
--   activity_log noise from ever becoming a real quote via bid_can_submit).
--   Both currently is_test=false. quotes.is_test already exists (v104,
--   2026-08-10) — no schema change needed there, backfill only.
--
--   Other accounts with dangling-claim bid_submitted activity_log rows: 3,
--   all matching the `dustinstohler1+...@gmail.com` E2E-fixture pattern used
--   elsewhere in this repo (1 dangling, 2 non-dangling) — NOT flagged here;
--   out of this issue's stated predicate (harness account specifically), left
--   for whoever owns E2E fixture hygiene broadly.
-- ============================================================================

-- ── activity_log: flag every row from the harness account, all event_types ──
UPDATE public.activity_log
   SET is_test = true
 WHERE user_id = '189b85ad-0ab0-4e54-9083-c51c3ef42a1d'
   AND is_test = false;

-- Verification: expect exactly 1027 rows affected (see preflight above).

-- ── quotes: flag the 2 real quote rows this harness account actually created ─
UPDATE public.quotes
   SET is_test = true
 WHERE contractor_id = 'bb07fc40-3607-4f3f-ac44-dffd4ca95111'
   AND is_test = false;

-- Verification: expect exactly 2 rows affected.

-- ── Final verification (read-only) ──────────────────────────────────────────
-- SELECT count(*) FROM public.activity_log
--  WHERE user_id = '189b85ad-0ab0-4e54-9083-c51c3ef42a1d' AND is_test = false;
--   → expected 0
-- SELECT count(*) FROM public.quotes
--  WHERE contractor_id = 'bb07fc40-3607-4f3f-ac44-dffd4ca95111' AND is_test = false;
--   → expected 0
-- ============================================================================
