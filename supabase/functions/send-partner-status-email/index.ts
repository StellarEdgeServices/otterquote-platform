/**
 * OtterQuote Edge Function: send-partner-status-email
 *
 * #856 — 5-stage partner referral status email series.
 *
 * Sends the referring partner ("referral_agent") a short progress update
 * as their referred claim advances. Replaces the payout-timing promise
 * (#850) with progress transparency, per Dustin's decision on #856:
 * "We won't commit to anything [on timing]. But we will develop a series
 * of emails to keep them up to date on the claim and tell them when they
 * get paid in the email." Direction confirmed us -> partner (#856 comment
 * 2026-08-15, not #868 — that issue governs the unrelated partner-composed
 * mailto: invite only).
 *
 * ── Trigger wiring ─────────────────────────────────────────────────────
 * Wired from ONE call site: `mark-job-complete/index.ts` calls this
 * function (no `stage` — catch-up mode) after it non-fatally advances the
 * claim's referral to `job_completed`. Because catch-up mode sends every
 * currently-eligible-and-unsent stage, that single call site also delivers
 * any earlier stages (1 claim_submitted / 3 bid_accepted / 4 contract_signed)
 * that were never sent, in addition to stage 5 itself.
 *
 * Still NOT wired — a partner will not get stage 1/3/4 progressively as
 * they happen, only retroactively at job completion:
 *   - claim_submitted : DB trigger `claims_advance_referral()`   (migration — Tier 3B, out of scope here)
 *   - contract_signed : DB trigger `apply_referral_commission()` (migration — Tier 3B, out of scope here)
 * `bid_received` has NO write path anywhere in the live schema today (see
 * stage-2 detection below — inferred, not read from referrals.status) and
 * is not expected to ever fire via any wiring.
 * `commission_paid` (approve-payout/index.ts) deliberately has no wiring —
 * #856 names only 5 stages and stage 5's copy already carries the payment
 * message.
 * Progressive (not just retroactive) delivery of stages 1/3/4 requires a
 * migration and is flagged as a follow-up `dependency` in the task report.
 *
 * ── Contract ────────────────────────────────────────────────────────────
 * Input:  POST { referral_id: string, stage?: 1|2|3|4|5 }
 *   - If `stage` is omitted, the function detects every stage that is
 *     currently eligible (per the live claims/quotes state) AND not yet
 *     sent, and sends all of them in ascending order — a catch-up mode,
 *     matching the process-payout-reminders / process-bid-expirations
 *     "poll and catch up" precedent in this codebase.
 *   - If `stage` is given, only that stage is considered.
 * Output: { ok: true, sent: [{stage, mailgun_id}], skipped: [{stage, reason}] }
 *
 * ── Stage -> live-schema mapping (#856 AC: "do not invent state names") ──
 * `referrals.status` already has a 7-value CHECK constraint:
 *   clicked, registered, claim_submitted, bid_received, contract_signed,
 *   job_completed, commission_paid
 * clicked/registered are pre-claim and deliberately have no email (2 of 7).
 * The remaining 5 line up exactly with #856's 5 stages, but this function
 * does NOT write referrals.status itself — that column's writes are already
 * owned by claims_advance_referral(), apply_referral_commission(),
 * mark-job-complete, and approve-payout (listed above), and none of the
 * live code ever sets it to 'bid_received' (dead enum value as of this
 * build — confirmed empty by SELECT DISTINCT status FROM referrals). Rather
 * than fight those owners for control of referrals.status, this function
 * detects stage eligibility itself, straight from claims/quotes, and
 * records its OWN idempotency stamps in referrals.metadata (see below) so
 * it can never race or conflict with the existing status writers:
 *   stage 1 claim_submitted : a claims row exists with this referral_id
 *   stage 2 bid_received    : >=1 quotes row exists for that claim
 *   stage 3 bid_accepted    : claims.selected_contractor_id IS NOT NULL
 *   stage 4 contract_signed : claims.contract_signed_at IS NOT NULL
 *   stage 5 job_completed   : claims.completion_date IS NOT NULL
 * commission_paid (referrals' 7th, final status) deliberately has NO email
 * in this series — #856 names only 5 stages, and its stage 5 copy already
 * carries the "payment is on its way" message at job completion.
 *
 * ── Privacy (#856 AC — flagged to Dustin, not yet ruled on) ───────────────
 * No dollar amount, no contractor name, no scope/damage detail. Referral is
 * named by first name + last initial only (formatReferralDisplayName in
 * templates.ts). See templates.ts header for the full rationale.
 *
 * ── Idempotency (#856 AC: "a state transition that fires twice sends one
 * email") ───────────────────────────────────────────────────────────────
 * Guarded via referrals.metadata.partner_status_series.stage{N}_sent_at,
 * written with a compare-and-swap UPDATE ... WHERE that path IS NULL. If a
 * second call for the same stage races the first, the second's guarded
 * UPDATE affects 0 rows and it skips — no duplicate send. (Known, accepted
 * limitation: metadata is JS-merged-then-replaced, not jsonb_set at the SQL
 * layer, so a genuinely concurrent write to an unrelated metadata key from
 * ANOTHER process could be lost. No other process writes this key today.)
 *
 * Auth: service-role bearer only (mirrors notify-partner-w9) — this is an
 * internal function, not called from a browser client.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAILGUN_API_KEY, MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  formatReferralDisplayName,
  renderStageEmail,
  type Stage,
} from "./templates.ts";

const FUNCTION_NAME = "send-partner-status-email";
const ALL_STAGES: Stage[] = [1, 2, 3, 4, 5];

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function jsonResponse(data: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface ClaimRow {
  id: string;
  selected_contractor_id: string | null;
  contract_signed_at: string | null;
  completion_date: string | null;
}

interface ReferralRow {
  id: string;
  referral_agent_id: string | null;
  homeowner_name: string | null;
  // deno-lint-ignore no-explicit-any
  metadata: Record<string, any> | null;
}

interface AgentRow {
  id: string;
  first_name: string | null;
  email: string | null;
  agent_type: string | null;
}

/** Determines which stages are currently eligible given live claim/quote state. */
function eligibleStages(claim: ClaimRow, hasBid: boolean): Set<Stage> {
  const eligible = new Set<Stage>();
  eligible.add(1); // a claims row exists at all => intake happened
  if (hasBid) eligible.add(2);
  if (claim.selected_contractor_id) eligible.add(3);
  if (claim.contract_signed_at) eligible.add(4);
  if (claim.completion_date) eligible.add(5);
  return eligible;
}

async function sendMailgunEmail(
  apiKey: string,
  domain: string,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<{ ok: boolean; mailgun_id?: string; error?: string }> {
  const formData = new URLSearchParams();
  formData.append("from", `Otter Quotes <notifications@${domain}>`);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", text);
  formData.append("html", html);

  try {
    const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
      body: formData,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "(unreadable)");
      return { ok: false, error: `Mailgun HTTP ${res.status}: ${errText}` };
    }
    const result = await res.json().catch(() => ({}));
    return { ok: true, mailgun_id: result.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
  }

  // ── Auth check — service role only (internal/trigger caller) ────────────
  const authHeader = req.headers.get("Authorization") || "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  if (!bearerToken || bearerToken !== serviceRoleKey) {
    console.error(`[${FUNCTION_NAME}] unauthorized call (bearer mismatch)`);
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401, corsHeaders);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY");
  const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN");

  if (!supabaseUrl || !mailgunApiKey || !mailgunDomain) {
    console.error(`[${FUNCTION_NAME}] missing required env vars`);
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, corsHeaders);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    // ── Rate limiting (existing RPC — no new DB objects) ───────────────────
    const { data: rlData, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_user_id: null,
    });
    if (rlError) {
      console.error(`[${FUNCTION_NAME}] rate limit RPC error (non-fatal):`, rlError.message);
    } else if (rlData?.allowed === false) {
      return jsonResponse({ ok: false, error: "Rate limit exceeded" }, 429, corsHeaders);
    }

    // ── Parse input ──────────────────────────────────────────────────────
    const body = await req.json().catch(() => null);
    const referralId = body?.referral_id as string | undefined;
    const requestedStage = body?.stage as number | undefined;

    if (!referralId) {
      return jsonResponse({ ok: false, error: "Missing required field: referral_id" }, 400, corsHeaders);
    }
    if (requestedStage !== undefined && !ALL_STAGES.includes(requestedStage as Stage)) {
      return jsonResponse({ ok: false, error: "stage must be one of 1,2,3,4,5" }, 400, corsHeaders);
    }

    // ── Load referral ────────────────────────────────────────────────────
    const { data: referral, error: referralErr } = await supabase
      .from("referrals")
      .select("id, referral_agent_id, homeowner_name, metadata")
      .eq("id", referralId)
      .single<ReferralRow>();

    if (referralErr || !referral) {
      console.error(`[${FUNCTION_NAME}] referral not found`, referralId, referralErr?.message);
      return jsonResponse({ ok: false, error: "Referral not found" }, 404, corsHeaders);
    }

    // ── AC: only the attributed referral_agent receives it ─────────────────
    if (!referral.referral_agent_id) {
      return jsonResponse({ ok: true, sent: [], skipped: [], reason: "no referral_agent_id on referral" }, 200, corsHeaders);
    }

    const { data: agent, error: agentErr } = await supabase
      .from("referral_agents")
      .select("id, first_name, email, agent_type")
      .eq("id", referral.referral_agent_id)
      .single<AgentRow>();

    if (agentErr || !agent) {
      console.error(`[${FUNCTION_NAME}] referral_agent not found`, referral.referral_agent_id, agentErr?.message);
      return jsonResponse({ ok: false, error: "Referral agent not found" }, 404, corsHeaders);
    }
    if (!agent.email) {
      console.warn(`[${FUNCTION_NAME}] agent ${agent.id} has no email — skipping`);
      return jsonResponse({ ok: true, sent: [], skipped: [], reason: "agent has no email" }, 200, corsHeaders);
    }

    // ── D-303 gate: this 5-stage series is professional-referrer copy only.
    // Homeowner referrers (agent_type='customer') get a separate, not-yet-built
    // 2-email series (signup + work completion) — tracked as its own item, not
    // sent here. Without this gate every homeowner referrer silently received
    // the full professional series (gh-856/gh-916 live defect). ────────────
    if (agent.agent_type === "customer") {
      return jsonResponse(
        { ok: true, sent: [], skipped: [], reason: "homeowner referrer (agent_type=customer) — professional status series does not apply (D-303)" },
        200,
        corsHeaders,
      );
    }

    // ── Load the linked claim (drives stage eligibility) ────────────────────
    const { data: claim, error: claimErr } = await supabase
      .from("claims")
      .select("id, selected_contractor_id, contract_signed_at, completion_date")
      .eq("referral_id", referralId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<ClaimRow>();

    if (claimErr) {
      console.error(`[${FUNCTION_NAME}] claim lookup error:`, claimErr.message);
      return jsonResponse({ ok: false, error: "Internal error resolving claim" }, 500, corsHeaders);
    }
    if (!claim) {
      // Referral exists but no claim linked yet — nothing to send.
      return jsonResponse({ ok: true, sent: [], skipped: [], reason: "no claim linked to this referral yet" }, 200, corsHeaders);
    }

    const { data: bidRows, error: bidErr } = await supabase
      .from("quotes")
      .select("id")
      .eq("claim_id", claim.id)
      .limit(1);
    if (bidErr) {
      console.error(`[${FUNCTION_NAME}] quotes lookup error (non-fatal, treated as no bids):`, bidErr.message);
    }
    const hasBid = !!(bidRows && bidRows.length > 0);

    const eligible = eligibleStages(claim, hasBid);
    const stagesToConsider: Stage[] = requestedStage
      ? [requestedStage as Stage]
      : ALL_STAGES;

    const displayName = formatReferralDisplayName(referral.homeowner_name);
    const sent: Array<{ stage: Stage; mailgun_id?: string }> = [];
    const skipped: Array<{ stage: Stage; reason: string }> = [];

    for (const stage of stagesToConsider) {
      if (!eligible.has(stage)) {
        skipped.push({ stage, reason: "not eligible yet" });
        continue;
      }

      const metaKey = `stage${stage}_sent_at`;
      const currentSeries = (referral.metadata?.partner_status_series ?? {}) as Record<string, string>;
      if (currentSeries[metaKey]) {
        skipped.push({ stage, reason: "already sent" });
        continue;
      }

      // ── Compare-and-swap idempotency guard ──────────────────────────────
      // Recompute the full metadata object from the latest known state,
      // then guard the UPDATE on the specific jsonb path still being NULL.
      // If another concurrent call already set it, this affects 0 rows and
      // we treat it as already-sent rather than sending a duplicate.
      const nowIso = new Date().toISOString();
      const newSeries = { ...currentSeries, [metaKey]: nowIso };
      const newMetadata = { ...(referral.metadata ?? {}), partner_status_series: newSeries };

      const { data: guardedRows, error: guardErr } = await supabase
        .from("referrals")
        .update({ metadata: newMetadata })
        .eq("id", referralId)
        .filter(`metadata->partner_status_series->>${metaKey}`, "is", null)
        .select("id");

      if (guardErr) {
        console.error(`[${FUNCTION_NAME}] idempotency guard update failed for stage ${stage}:`, guardErr.message);
        skipped.push({ stage, reason: `guard update failed: ${guardErr.message}` });
        continue;
      }
      if (!guardedRows || guardedRows.length === 0) {
        // Lost the race — another call already sent this stage.
        skipped.push({ stage, reason: "already sent (concurrent)" });
        continue;
      }

      // Keep local copy in sync for subsequent stages in this same loop.
      referral.metadata = newMetadata;

      const { subject, html, text } = renderStageEmail(stage, displayName);
      const result = await sendMailgunEmail(mailgunApiKey, mailgunDomain, agent.email, subject, text, html);

      if (result.ok) {
        sent.push({ stage, mailgun_id: result.mailgun_id });
        console.log(`[${FUNCTION_NAME}] stage ${stage} sent — referral=${referralId} agent=${agent.id} mailgun_id=${result.mailgun_id}`);
      } else {
        console.error(`[${FUNCTION_NAME}] stage ${stage} Mailgun send failed for referral ${referralId}:`, result.error);
        skipped.push({ stage, reason: `send failed: ${result.error}` });
        // Note: the idempotency stamp was already written above. A failed
        // send is intentionally NOT retried automatically by this function —
        // matching the fire-and-forget, non-fatal pattern used by every
        // other notification path in this codebase (e.g. mark-job-complete's
        // sendHomeownerNotification). A future caller passing an explicit
        // `stage` will still see "already sent" and must be handled by a
        // manual resend path if this needs to change.
      }
    }

    return jsonResponse({ ok: true, referral_id: referralId, sent, skipped }, 200, corsHeaders);
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] unhandled error:`, err);
    return jsonResponse({ ok: false, error: "Internal server error" }, 500, corsHeaders);
  }
});
