// gh-2154 P-4: a byte-exact quoted copy of
// claim_partner_onboarding_stage()'s function body from
// ../../migrations/20260925183000_gh2154_p4_switchon_retry_cap_uncertain_alert.sql
// (the CURRENT, latest CREATE OR REPLACE of this function — supersedes the
// 20260924210000 version this same constant used to quote), kept here so
// claim-stage-sql-proof.test.ts can assert — as an actual, automated test,
// not just a code-review claim — both (a) that the SQL still contains NO
// stale-pending reclaim path (the ruling-c invariant this file originally
// existed to prove), and (b) the new switch-on-hardening retry cap
// (attempt_count < 5 AND NOT terminal_failure) is actually present in the
// 'failed'-branch WHERE clause, not just described in a comment.
//
// WHY A QUOTED COPY, NOT A LIVE FILE READ: this repo's CI-scoped Deno suite
// runs `deno test --allow-read=supabase/functions,supabase/migrations_drafts
// supabase/functions/` — supabase/migrations/ (where the real, applied-later
// migration lives) is deliberately OUTSIDE that allow-read scope, and a test
// that tries to Deno.readTextFile() it fails with NotCapable under BOTH that
// command and this worker's own bare `deno test supabase/functions/...`
// invocation (verified empirically, unchanged from the original fix round).
// This is the same "duplicated, not cross-referenced" constraint this
// directory already lives with for bot-pattern.ts/optout.ts/email-footer.ts.
//
// KEEPING THIS IN SYNC: this string MUST be updated, by hand, in the same
// commit as any future change to claim_partner_onboarding_stage()'s
// function body in the real migration file. Verified byte-identical to
// 20260925183000's CREATE OR REPLACE body as of this switch-on hardening
// round via direct diff (see the PR body).
export const CLAIM_PARTNER_ONBOARDING_STAGE_FUNCTION_BODY = `
  INSERT INTO public.partner_onboarding_sends (partner_id, stage, status, created_at, attempt_count)
  VALUES (p_partner_id, p_stage, 'pending', now(), 1)
  ON CONFLICT (partner_id, stage) DO UPDATE
    SET status = 'pending',
        created_at = now(),
        error = NULL,
        mailgun_id = NULL,
        uncertain_alerted_at = NULL,
        attempt_count = partner_onboarding_sends.attempt_count + 1
    WHERE partner_onboarding_sends.status = 'failed'
      AND NOT partner_onboarding_sends.terminal_failure
      AND partner_onboarding_sends.attempt_count < 5;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
`;
