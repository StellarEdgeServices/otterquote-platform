# Pre-flight: 20261003011500_gh1925_ad_sharing_opt_out_source_in_page_button

NOT APPLIED. Refs #1925. Authority: CEO ruling #2304 comment 5963898698, item 2 ("yes, tier 3A, same PR or its own").

## What it does
Replaces `profiles_ad_sharing_opt_out_source_check` (gh-2107) with a strict superset that also allows `in_page_button`.
NOT VALID + VALIDATE split (gh-1387 / gh-1532 pattern). No column, data, grant or RLS change.

## Tier note
CLAUDE.md lists "DROP/ALTER/RLS changes" as Tier 3B. DROP + ADD of a CHECK is technically an ALTER, so by the letter this is 3B
(24h risk brief). It is strictly widening, reversible and touches no data, and the CEO ruled 3A explicitly, which controls.

## Danger-pattern check
No column drop/rename/retype, no index, no truncate/cascade, no new function. The constraint is dropped and re-added in one transaction:
other sessions see the old or the new check, never none. `SET LOCAL lock_timeout = '5s'` fails fast instead of queueing.
Every pre-existing value (NULL, gpc_header, gpc_client, support_email) satisfies the new check, so VALIDATE cannot fail.

## Precheck (read-only, before apply)
`SELECT ad_sharing_opt_out_source, count(*) FROM public.profiles GROUP BY 1;` expect only NULL / gpc_header / gpc_client / support_email.

## Applier runbook
1. Deploy order does not matter for correctness. The privacy.html section 12 PATCH sends `in_page_button`; if the old CHECK rejects it
   (PostgREST code 23514) it retries ONCE without the source and logs a console.warn, so the opt-out flag always lands. This migration
   only adds source attribution: until it is applied, signed-in opt-outs are recorded with a NULL source (today's behaviour).
2. Verify: `SELECT pg_get_constraintdef(oid), convalidated FROM pg_constraint WHERE conname='profiles_ad_sharing_opt_out_source_check';` shows `in_page_button` and convalidated = true.
3. After merge, with an `is_test` account click the section 12 button and confirm the row shows `ad_sharing_opt_out_source = 'in_page_button'`.

Rollback: `supabase/migrations_rollbacks/20261003011500_gh1925_ad_sharing_opt_out_source_in_page_button_rollback.sql` (refuses while any row records in_page_button).
