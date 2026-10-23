<!-- STATUS (gh-1438, as of 2026-10-23T13:27:30Z): NOT APPLIED -->
# Pre-Flight: gh2997_inherit_is_test

**Migration**: `gh2997_inherit_is_test.sql` (DRAFT, this directory) / rollback `gh2997_inherit_is_test_rollback.sql`
**Issue**: #2997 (Refs). **Tier**: Tier 3 (R-097). Nothing here has been applied; production was only read, plus rolled-back proof batches on is_test rows.

## Change summary
`quotes.is_test` and `activity_log.is_test` default to false and nothing copies the claim's flag, and the bid form never sends it. Two BEFORE INSERT triggers fix that at write time: `quotes_inherit_is_test` (copies `claims.is_test` true onto the quote) and `activity_log_inherit_is_test` (inherits from `metadata.claim_id`, else `metadata.quote_id`; `activity_log` has no claim_id column, so metadata is the join key). Both only raise false to true. A one-off correction in the same file fixes existing rows. Client change: the `bid_updated` activity_log insert (HTML form and React twin) now carries `metadata.claim_id`.

## Measured 2026-10-23 (Supabase SELECT, project yeszghaspzwwstvsrioa)
| What | Value |
|---|---|
| quotes rows, total | 10 |
| activity_log rows, total | 1149 |
| quotes on is_test claims with is_test=false | 2: 403940dc-bf8d-423f-92ba-0652ce2d5f67 (claim cbf2c780, contractor bb07fc40 is_test), 471b2b5a-fb94-4558-aaf7-aa1670d000a2 (claim 374a2053, contractor 2bc792be is_test) |
| activity_log rows keyed to an is_test claim via metadata.claim_id with is_test=false | 6: a40c8ebd (bid_submitted), 1be26ffe (bid_confirmation_email_sent), 1166f749 and 326c63ee (next_steps_nudge_sent), 9ca287f8 (bid_submitted), 1db1ddb5 (bid_accepted) |
| triggers on quotes/activity_log that set is_test | none (activity_log has no triggers; quotes triggers listed in the PR body) |

The 6 activity rows are exactly what the data-correction UPDATE touches; the 2 quotes likewise. All parent claims, and both contractors, are is_test=true.

## Danger pattern check
| Pattern | Triggered? |
|---|---|
| NOT NULL without DEFAULT / on >100K rows | No (no column change) |
| Drop column / type change / RENAME / TRUNCATE / DELETE / CASCADE | No |
| Index without CONCURRENTLY | No (no index) |
| New public function (pattern 9) | Yes, 2 trigger functions: both `REVOKE ALL ... FROM PUBLIC, anon, authenticated`; proof P1 shows `has_function_privilege` false for anon and authenticated on both. Trigger firing does not need EXECUTE. |

## Lock notes
`CREATE OR REPLACE TRIGGER` takes SHARE ROW EXCLUSIVE and blocks only concurrent DDL/row-lock-conflicting writers briefly. A `DROP TRIGGER IF EXISTS ... ON public.activity_log` in the proof batch hung over 230 s (MCP timeout, nothing committed; trigger count 0 and quotes wrong-count 2 re-read afterwards) for a reason this session could not see (no blocking backend visible in pg_locks / pg_stat_activity), so the migration uses CREATE OR REPLACE TRIGGER and no DROP TRIGGER. Apply with `SET lock_timeout='5s'` and retry if it fires.

## Proof (BEGIN ... forced ROLLBACK, production, is_test fixtures only): supabase/tests/gh2997_inherit_is_test_proof.sql
BEFORE (negative control, run alone): R0 wrong_quotes=2, wrong_activity=6; T1 quote.is_test=false, bid_submitted=false, bid_accepted=false; T2 false.
AFTER (migration body + proof, same batch): R0 wrong_quotes=0, wrong_activity=0, 471b2b5a is_test=true with bid_submitted=true,bid_accepted=true; T1 true/true/true; T2 true; T3 (no key) false; T4 (claim flipped to real inside the transaction) false; T5 (explicit true, claim real) true; T6 (claim_id 'not-a-uuid') false and accepted; P1 false,false,false,false.

## closes-on amendment (proposed)
activity_log has no claim_id column. Replace the activity_log half with:
`SELECT count(*) FROM activity_log a JOIN claims c ON c.id = nullif(a.metadata->>'claim_id','')::uuid WHERE c.is_test AND NOT a.is_test` = 0 (measured today: 6; after the fix: 0).

## Corrected rows (not reverted by the rollback)
quotes 403940dc-bf8d-423f-92ba-0652ce2d5f67, 471b2b5a-fb94-4558-aaf7-aa1670d000a2; activity_log a40c8ebd-a9e1-4ad3-a039-ae011b1363ef, 1be26ffe-46b2-478b-a8f0-fafdfa19598b, 1166f749-c1c7-410d-b2f0-ce8fa835a8d5, 326c63ee-4d1e-4501-aa74-1fc00bf1903f, 9ca287f8-e852-40ae-b1ba-1eae0b672805, 1db1ddb5-c7a0-481b-a81a-a3641f8f7c50.

## Deploy notes
Rollback pre-authorised: `gh2997_inherit_is_test_rollback.sql` (drops both triggers and functions). Monitoring: Sentry/log WARNINGs `quotes_inherit_is_test failed` / `activity_log_inherit_is_test failed` (the functions never block a write). When applied, file per supabase/migrations_drafts/README.md.
