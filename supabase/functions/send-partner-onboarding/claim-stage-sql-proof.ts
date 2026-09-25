// gh-2154 P-4 fix round (ruling c, REOPENED — orchestrator review of the
// first fix round): a byte-exact quoted copy of
// claim_partner_onboarding_stage()'s function body from
// ../../migrations/20260924210000_gh2154_p4_partner_onboarding_ledger.sql,
// kept here so claim-stage-sql-proof.test.ts can assert — as an actual,
// automated test, not just a code-review claim — that the SQL contains NO
// stale-pending reclaim path.
//
// WHY A QUOTED COPY, NOT A LIVE FILE READ: this repo's CI-scoped Deno suite
// runs `deno test --allow-read=supabase/functions,supabase/migrations_drafts
// supabase/functions/` — supabase/migrations/ (where the real, applied-later
// migration lives) is deliberately OUTSIDE that allow-read scope, and a test
// that tries to Deno.readTextFile() it fails with NotCapable under BOTH that
// command and this worker's own bare `deno test supabase/functions/...`
// invocation (verified empirically before choosing this approach). This is
// the same "duplicated, not cross-referenced" constraint this directory
// already lives with for bot-pattern.ts/optout.ts/email-footer.ts (the
// Supabase Edge Function deploy bundler can't resolve cross-directory
// imports either) — extended here to a migration, not just sibling function
// directories.
//
// KEEPING THIS IN SYNC: this string MUST be updated, by hand, in the same
// commit as any change to claim_partner_onboarding_stage()'s function body
// in the real migration file. This is a manual discipline, not an automated
// one — same posture onboarding-stage.ts's own top-of-file comment already
// documents for canClaimStage() being "a pure JS mirror of this WHERE
// clause... so the SQL function's WHERE clause can be reviewed against it
// for a literal match." Verified byte-identical to the real migration file
// as of this fix round via direct diff (see the build report).
export const CLAIM_PARTNER_ONBOARDING_STAGE_FUNCTION_BODY = `
  INSERT INTO public.partner_onboarding_sends (partner_id, stage, status, created_at)
  VALUES (p_partner_id, p_stage, 'pending', now())
  ON CONFLICT (partner_id, stage) DO UPDATE
    SET status = 'pending', created_at = now(), error = NULL, mailgun_id = NULL
    WHERE partner_onboarding_sends.status = 'failed';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
`;
