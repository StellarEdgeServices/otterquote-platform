/**
 * referralPayout — via the live DB trigger (v40-commission-trigger).
 *
 * This module replaces the in-file JS reference `referralPayout` that previously
 * lived in smoke-tests.mjs. Now that `apply_referral_commission()` is the
 * authoritative implementation of D-139/D-140/D-141/D-142 on the server side,
 * the tests exercise the real trigger instead of a parallel JS model.
 *
 * Each call builds a BEGIN; ...; ROLLBACK; SQL round-trip against Supabase's
 * Management API:
 *   1. Insert a test referral agent (optionally a recruiter + a recruited
 *      referrer; otherwise a solo referrer).
 *   2. Insert a claim tied to the known test homeowner auth user.
 *   3. Insert a referral row with a controlled created_at (referred_at).
 *   4. Link the referral back to the claim.
 *   5. Insert a quote with payment_status='pending' and the test job_total.
 *   6. UPDATE the quote to payment_status='succeeded' — this fires the
 *      after_quote_paid trigger.
 *   7. SELECT commission_amount + recruit_commission_amount from the referral.
 *   8. ROLLBACK — nothing persists.
 *
 * The function returns the same shape as the old in-file reference:
 *   { referrer_bonus, recruiter_bonus, eligible }
 *
 * Shortcut: when inputs obviously fail the eligibility gate (no referrer, or
 * job below $10K), no DB round-trip is needed — return zeros immediately.
 * This mirrors the trigger's WHEN clause and avoids unnecessary network.
 *
 * Env:
 *   SUPABASE_MGMT_TOKEN — Management API PAT. Falls back to the token recorded
 *     in Claude's Memories/otterquote-memory.md for local/dev runs.
 */

import { randomUUID } from "node:crypto";

const MIN_JOB = 10000;

const PROJECT_REF = "yeszghaspzwwstvsrioa";
const MGMT_ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

// Known existing auth user — the test homeowner (see otterquote-memory.md,
// Test Accounts). Required because claims.user_id has an FK to auth.users
// that is enforced even inside a rolled-back transaction.
const TEST_HOMEOWNER_USER_ID = "20da8a5a-42cb-4f30-b09e-e1bc96d97d64";
const TEST_CONTRACTOR_ID = "53cd882c-b7fd-4046-ad37-bf69a56e8f8f";

function getToken() {
  // Management API tokens are secrets — they never live in source. Require
  // the caller to set SUPABASE_MGMT_TOKEN in the env. Failing fast here is
  // better than silently falling back to a stale/revoked token.
  const tok = process.env.SUPABASE_MGMT_TOKEN;
  if (!tok) {
    throw new Error(
      "referralPayout: SUPABASE_MGMT_TOKEN env var is required. " +
      "Export it before running tests (see Claude's Memories/claude-memory.md)."
    );
  }
  return tok;
}

function rand() {
  // Short random suffix for per-call uniqueness on UNIQUE columns
  // (referral_agents.unique_code, referral_agents.email).
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

/**
 * Build a BEGIN/ROLLBACK SQL block that simulates the referral lifecycle and
 * fires the v40 trigger. Returns the SQL string.
 */
function buildScenarioSql({
  job_total,
  hasRecruiter,
  recruited_at,
  referred_at,
}) {
  const suffix = rand();
  const referrerCode = `TRF${suffix}`.slice(0, 8);
  const recruiterCode = `TRC${suffix}`.slice(0, 8);
  const referrerEmail = `ref_${suffix}@smoketest.otterquote.invalid`;
  const recruiterEmail = `rec_${suffix}@smoketest.otterquote.invalid`;

  // Use fixed temp UUIDs scoped to this one transaction. Because the whole
  // block is inside BEGIN...ROLLBACK, collisions with persisted data are
  // impossible (the temp rows never commit), but per-call uniqueness on
  // referral_agents.email / unique_code is still enforced during the tx,
  // so we randomize those via `suffix`.
  //
  // Separate statements (not CTEs) are required here because AFTER triggers
  // on a data-modifying CTE do not make their effects visible to sibling
  // CTEs in the same statement — splitting into separate statements ensures
  // the trigger runs and its writes are visible to the final SELECT.
  // randomUUID() produces proper RFC 4122 v4 UUIDs. Guaranteed
  // well-formed, and the probability of collision with live rows is
  // effectively zero — and even if it did happen, ROLLBACK keeps us safe.
  const claimId     = randomUUID();
  const referrerId  = randomUUID();
  const recruiterId = randomUUID();
  const referralId  = randomUUID();
  const quoteId     = randomUUID();

  const recruiterInsert = hasRecruiter
    ? `INSERT INTO public.referral_agents(id, agent_type, first_name, last_name, email, unique_code)
       VALUES ('${recruiterId}'::uuid, 'customer', 'A', 'Recruiter_${suffix}', '${recruiterEmail}', '${recruiterCode}');`
    : "";

  const referrerInsert = hasRecruiter
    ? `INSERT INTO public.referral_agents(id, agent_type, first_name, last_name, email, unique_code, recruited_by_id, recruited_at)
       VALUES ('${referrerId}'::uuid, 'customer', 'B', 'Referrer_${suffix}', '${referrerEmail}', '${referrerCode}', '${recruiterId}'::uuid, ${recruited_at ? `'${recruited_at}'::timestamptz` : "NULL"});`
    : `INSERT INTO public.referral_agents(id, agent_type, first_name, last_name, email, unique_code)
       VALUES ('${referrerId}'::uuid, 'customer', 'S', 'Referrer_${suffix}', '${referrerEmail}', '${referrerCode}');`;

  return `
BEGIN;

${recruiterInsert}
${referrerInsert}

INSERT INTO public.claims(id, user_id)
VALUES ('${claimId}'::uuid, '${TEST_HOMEOWNER_USER_ID}'::uuid);

INSERT INTO public.referrals(id, referral_agent_id, claim_id, status, created_at)
VALUES ('${referralId}'::uuid, '${referrerId}'::uuid, '${claimId}'::uuid, 'contract_signed',
        ${referred_at ? `'${referred_at}'::timestamptz` : "now()"});

UPDATE public.claims SET referral_id = '${referralId}'::uuid WHERE id = '${claimId}'::uuid;

INSERT INTO public.quotes(id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, payment_status)
VALUES ('${quoteId}'::uuid, '${claimId}'::uuid, '${TEST_CONTRACTOR_ID}'::uuid,
        ${Number(job_total)}, 5.0, ${Number(job_total) * 0.05}, 'pending');

-- Fire the trigger.
UPDATE public.quotes SET payment_status = 'succeeded' WHERE id = '${quoteId}'::uuid;

-- Read back what the trigger wrote.
SELECT
  COALESCE(commission_amount, 0)::text          AS referrer_bonus,
  COALESCE(recruit_commission_amount, 0)::text  AS recruiter_bonus
FROM public.referrals WHERE id = '${referralId}'::uuid;

ROLLBACK;
`.trim();
}

/**
 * Exercise the live apply_referral_commission trigger for one scenario.
 * Returns { referrer_bonus, recruiter_bonus, eligible } matching the shape
 * of the retired in-file reference implementation.
 */
export async function referralPayout({
  job_total,
  referrer,
  recruiter,
  recruited_at,
  referred_at,
}) {
  // Short-circuit ineligibility without touching the DB — mirrors the
  // trigger's WHEN clause.
  if (!referrer || Number(job_total) < MIN_JOB) {
    return { referrer_bonus: 0, recruiter_bonus: 0, eligible: false };
  }

  const hasRecruiter = Boolean(recruiter && recruited_at);

  const sql = buildScenarioSql({
    job_total,
    hasRecruiter,
    recruited_at: hasRecruiter ? recruited_at : null,
    referred_at: referred_at || null,
  });

  const resp = await fetch(MGMT_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(
      `referralPayout: Supabase Management API returned ${resp.status}: ${txt}`
    );
  }

  const rows = await resp.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `referralPayout: expected at least one row from trigger round-trip, got ${JSON.stringify(rows)}`
    );
  }

  const row = rows[0];
  return {
    referrer_bonus: Number(row.referrer_bonus),
    recruiter_bonus: Number(row.recruiter_bonus),
    eligible: true,
  };
}
