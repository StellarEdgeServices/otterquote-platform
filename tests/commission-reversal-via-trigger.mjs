/**
 * commissionReversal — via the live DB trigger (v42-commission-reversal-trigger).
 *
 * Builds a BEGIN; ...; ROLLBACK; SQL round-trip against Supabase's Management
 * API that exercises v40 (forward-write) then v42 (reversal) on the same
 * referral/claim/quote, snapshots the referral ledger before AND after the
 * refund, and returns both states so the harness can assert on the delta.
 *
 *   1. Insert a test referrer (and optionally a recruiter, linked via
 *      recruited_by_id + recruited_at so the v40 forward trigger credits
 *      both tiers per D-142 forward-only).
 *   2. Insert a claim tied to the known test homeowner auth user.
 *   3. Optionally insert a referral tying the referrer to the claim
 *      (skipped in the no-referral scenario).
 *   4. Insert a quote with payment_status='pending'.
 *   5. UPDATE to 'succeeded' — fires v40, writes the ledger.
 *   6. Optionally set commission_paid_at = now() to simulate an already-paid
 *      commission (the only case v42 must refuse to reverse).
 *   7. CREATE TEMP TABLE snapshot of the pre-refund state (captures both
 *      referrals columns and the recruiter's running recruit_earnings).
 *   8. UPDATE to 'refunded' — fires v42, reverses the ledger.
 *   9. Optionally fire a second refund transition (failed -> refunded) to
 *      exercise v42's idempotency guard.
 *  10. Final SELECT: UNION ALL of the pre-snapshot and the current post-state.
 *  11. ROLLBACK — nothing persists.
 *
 * Returns { pre, post } where each is { commission_amount,
 *   recruit_commission_amount, status, recruit_earnings }. For the
 *   no-referral scenario, the three referral-sourced fields come back as
 *   null on both sides.
 *
 * Env:
 *   SUPABASE_MGMT_TOKEN — Management API PAT. Fail fast if not set.
 */

import { randomUUID } from "node:crypto";

const PROJECT_REF = "yeszghaspzwwstvsrioa";
const MGMT_ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

// Known existing auth user — the test homeowner (see otterquote-memory.md,
// Test Accounts). claims.user_id FK to auth.users is enforced even inside a
// rolled-back transaction, so we cannot invent a random UUID here.
const TEST_HOMEOWNER_USER_ID = "f6c14b57-59dc-43ce-b510-04277a71f5af"; // Fixed May 5, 2026: valid test user
const TEST_CONTRACTOR_ID = "53cd882c-b7fd-4046-ad37-bf69a56e8f8f";

function getToken() {
  const tok = process.env.SUPABASE_MGMT_TOKEN;
  if (!tok) {
    throw new Error(
      "commissionReversal: SUPABASE_MGMT_TOKEN env var is required. " +
      "Export it before running tests (see Claude's Memories/claude-memory.md)."
    );
  }
  return tok;
}

function rand() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

/**
 * Run a reversal scenario against the live DB.
 *
 * @param {object} opts
 * @param {number}  opts.job_total      Quote total_price. $10K+ to clear v40's floor.
 * @param {boolean} opts.hasRecruiter   Whether to include a recruiter for the referrer.
 * @param {boolean} opts.markPaid       If true, set commission_paid_at before the refund.
 * @param {boolean} opts.skipReferral   If true, do NOT insert a referral row.
 * @param {boolean} opts.doubleFire     If true, fire the refund trigger twice (refunded -> failed -> refunded).
 * @returns {Promise<{pre:object|null, post:object|null}>}
 */
export async function commissionReversal({
  job_total,
  hasRecruiter = false,
  markPaid = false,
  skipReferral = false,
  doubleFire = false,
}) {
  const suffix = rand();
  const referrerCode  = `TRF${suffix}`.slice(0, 8);
  const recruiterCode = `TRC${suffix}`.slice(0, 8);
  const referrerEmail  = `ref_${suffix}@smoketest.otterquote.invalid`;
  const recruiterEmail = `rec_${suffix}@smoketest.otterquote.invalid`;

  const claimId     = randomUUID();
  const referrerId  = randomUUID();
  const recruiterId = randomUUID();
  const referralId  = randomUUID();
  const quoteId     = randomUUID();

  // Recruiter FKs: only meaningful when hasRecruiter is true. When false,
  // the snapshot SELECTs still reference a recruiter UUID but the subquery
  // simply returns no rows (coerced to 0 via COALESCE).
  const effectiveRecruiterId = hasRecruiter ? recruiterId : null;

  // --- Agent inserts ---
  const recruiterInsert = hasRecruiter
    ? `INSERT INTO public.referral_agents(id, agent_type, first_name, last_name, email, unique_code)
       VALUES ('${recruiterId}'::uuid, 'customer', 'A', 'Recruiter_${suffix}', '${recruiterEmail}', '${recruiterCode}');`
    : "";

  // recruited_at is in the past so v40's forward-only D-142 check passes
  // (referral created_at = now() >= recruited_at).
  const referrerInsert = hasRecruiter
    ? `INSERT INTO public.referral_agents(id, agent_type, first_name, last_name, email, unique_code, recruited_by_id, recruited_at)
       VALUES ('${referrerId}'::uuid, 'customer', 'B', 'Referrer_${suffix}', '${referrerEmail}', '${referrerCode}', '${recruiterId}'::uuid, '2026-01-01'::timestamptz);`
    : `INSERT INTO public.referral_agents(id, agent_type, first_name, last_name, email, unique_code)
       VALUES ('${referrerId}'::uuid, 'customer', 'S', 'Referrer_${suffix}', '${referrerEmail}', '${referrerCode}');`;

  // --- Referral insert (optionally skipped) ---
  const referralInsert = skipReferral
    ? ""
    : `INSERT INTO public.referrals(id, referral_agent_id, claim_id, status, created_at)
       VALUES ('${referralId}'::uuid, '${referrerId}'::uuid, '${claimId}'::uuid, 'contract_signed', now());
       UPDATE public.claims SET referral_id = '${referralId}'::uuid WHERE id = '${claimId}'::uuid;`;

  // --- Mark-paid SQL ---
  const markPaidSql = markPaid && !skipReferral
    ? `UPDATE public.referrals SET commission_paid_at = now() WHERE id = '${referralId}'::uuid;`
    : "";

  // --- Double-fire SQL ---
  const doubleFireSql = doubleFire
    ? `UPDATE public.quotes SET payment_status = 'failed'   WHERE id = '${quoteId}'::uuid;
       UPDATE public.quotes SET payment_status = 'refunded' WHERE id = '${quoteId}'::uuid;`
    : "";

  // --- Readback expression ---
  // When a referral row exists: read referrals columns directly.
  // When it doesn't: emit NULLs in the same columns so the pre/post rows
  // still have a uniform shape.
  // recruit_earnings always comes from a subquery against referral_agents
  // and is coerced to '0' when there is no recruiter.
  const referralReadCols = skipReferral
    ? `NULL::numeric AS commission_amount,
       NULL::numeric AS recruit_commission_amount,
       NULL::text    AS status`
    : `(SELECT COALESCE(commission_amount,         0) FROM public.referrals WHERE id = '${referralId}'::uuid) AS commission_amount,
       (SELECT COALESCE(recruit_commission_amount, 0) FROM public.referrals WHERE id = '${referralId}'::uuid) AS recruit_commission_amount,
       (SELECT status::text                            FROM public.referrals WHERE id = '${referralId}'::uuid) AS status`;

  const recruiterReadCol = effectiveRecruiterId
    ? `(SELECT COALESCE(recruit_earnings, 0) FROM public.referral_agents WHERE id = '${effectiveRecruiterId}'::uuid)`
    : `0::numeric`;

  const sql = `
BEGIN;

${recruiterInsert}
${referrerInsert}

INSERT INTO public.claims(id, user_id)
VALUES ('${claimId}'::uuid, '${TEST_HOMEOWNER_USER_ID}'::uuid);

${referralInsert}

INSERT INTO public.quotes(id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, payment_status)
VALUES ('${quoteId}'::uuid, '${claimId}'::uuid, '${TEST_CONTRACTOR_ID}'::uuid,
        ${Number(job_total)}, 5.0, ${Number(job_total) * 0.05}, 'pending');

-- Fire v40 (after_quote_paid) — writes the ledger.
UPDATE public.quotes SET payment_status = 'succeeded' WHERE id = '${quoteId}'::uuid;

${markPaidSql}

-- Snapshot PRE-refund state into a temp table. Dropped on ROLLBACK.
CREATE TEMP TABLE _pre_reversal ON COMMIT DROP AS
SELECT 'pre'::text AS phase,
       ${referralReadCols},
       ${recruiterReadCol} AS recruit_earnings;

-- Fire v42 (after_quote_refunded) — reverses the ledger.
UPDATE public.quotes SET payment_status = 'refunded' WHERE id = '${quoteId}'::uuid;

${doubleFireSql}

-- Final readback: union of pre-snapshot and current post-state, so a
-- single result set carries both. Management API returns the last SELECT's
-- rows; a UNION ALL guarantees both phases arrive in one payload.
SELECT phase, commission_amount::text, recruit_commission_amount::text, status, recruit_earnings::text
FROM _pre_reversal
UNION ALL
SELECT 'post'::text,
       ${skipReferral
          ? `NULL::text, NULL::text, NULL::text`
          : `(SELECT COALESCE(commission_amount,         0)::text FROM public.referrals WHERE id = '${referralId}'::uuid),
             (SELECT COALESCE(recruit_commission_amount, 0)::text FROM public.referrals WHERE id = '${referralId}'::uuid),
             (SELECT status::text                                 FROM public.referrals WHERE id = '${referralId}'::uuid)`
       },
       ${recruiterReadCol}::text;

ROLLBACK;
`.trim();

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
      `commissionReversal: Supabase Management API returned ${resp.status}: ${txt}`
    );
  }

  const rows = await resp.json();
  if (!Array.isArray(rows)) {
    throw new Error(
      `commissionReversal: expected array from API, got ${JSON.stringify(rows)}`
    );
  }

  const pre  = rows.find(r => r.phase === "pre")  ?? null;
  const post = rows.find(r => r.phase === "post") ?? null;

  function shape(row) {
    if (!row) return null;
    return {
      commission_amount: row.commission_amount == null ? null : Number(row.commission_amount),
      recruit_commission_amount: row.recruit_commission_amount == null ? null : Number(row.recruit_commission_amount),
      status: row.status ?? null,
      recruit_earnings: row.recruit_earnings == null ? null : Number(row.recruit_earnings),
    };
  }

  return { pre: shape(pre), post: shape(post) };
}
