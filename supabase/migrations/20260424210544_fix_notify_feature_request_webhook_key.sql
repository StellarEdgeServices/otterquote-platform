-- Migration: fix_notify_feature_request_webhook_key
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-24T21:05:44Z, recorded in
-- supabase_migrations.schema_migrations as version 20260424210544, name
-- "fix_notify_feature_request_webhook_key". NEVER RE-RUN.
--
-- PROVENANCE: sourced via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.
--
-- SECURITY NOTE (flagged in the gh-1438 batch-1 PR and evidence comment):
-- the statement as recorded in schema_migrations.statements contains a
-- hardcoded Supabase secret API key in the net.http_post Authorization
-- header below. That value has been REDACTED here (replaced with
-- [REDACTED-SECRET-KEY]) before filing, to avoid committing a live-looking
-- credential into git history. This redaction changes only this repo
-- file, not what already ran in production. Whether this specific key is
-- still live was not verified by this batch -- flagged for the CTO/owning
-- engineer to confirm rotation status; later migrations in this same repo
-- (gh720_move_hardcoded_secret_to_vault, gh752_move_notify_functions_to_vault)
-- suggest this class of hardcoded-secret pattern was subsequently
-- remediated, but that was not independently confirmed for this key by
-- this batch.

CREATE OR REPLACE FUNCTION public.notify_feature_request_webhook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  payload jsonb;
BEGIN
  payload := jsonb_build_object(
    'type',   'INSERT',
    'table',  'feature_requests',
    'record', row_to_json(NEW)::jsonb
  );

  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-feature-request',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer [REDACTED-SECRET-KEY]'
    ),
    body    := payload
  );

  RETURN NEW;
END;
$function$;
