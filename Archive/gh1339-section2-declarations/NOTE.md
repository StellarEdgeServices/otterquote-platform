# gh-1339 section2_declarations draft - ARCHIVED, NOT APPLIED

Decision (CTO RUN 45, Tier A, #1339 comment 5870537770, 2026-09-28): the migration from PR #1800
(`section2_declarations` column) is NOT applied to production. It would be a second, unconsumed,
differently shaped copy of data that already ships live via `quotes.scope_summary`/`state`
(#1377/#1403). Moved out of `migrations_drafts/` and `migrations_rollbacks/` so a reader does not
mistake it for a pending apply. Same reconciliation class as #1438. Files are unchanged, moved only.
