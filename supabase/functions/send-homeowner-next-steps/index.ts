/**
 * OtterQuote Edge Function: send-homeowner-next-steps
 *
 * gh-1580 — Day-0/day-2 "next steps" nudge for a homeowner who signed up and
 * then went silent. The gh-1570 gate read found that the two real outside
 * homeowners who ever reached this point (Nick Mansueto, George Milberger)
 * both stalled at exactly the same spot: a claim with ready_for_bids=false,
 * has_measurements=false, no hover_orders row, and zero activity_log rows
 * since signup — and nothing notified either the homeowner or Dustin
 * (`grep -rn documents_needed supabase/functions js/` returns 0 hits).
 *
 * Runs on pg_cron. LIVE CADENCE, measured against production, not recommended:
 * `select jobid, schedule, jobname, active from cron.job where jobid = 20;`
 * -> jobid 20 | "*(slash)30 * * * *" | send-homeowner-next-steps — the literal
 * cron string is written with "(slash)" in place of "/" only because a star
 * followed by a slash would close this block comment. Every THIRTY minutes,
 * twice as often as this comment claimed until gh-1786 corrected it. As of
 * 2026-09-07 that job is `active = false`: it was disabled deliberately (D-320's
 * own recommendation, Dustin's word) so nothing sends until the opt-out below is
 * DEPLOYED. Re-enabling it is `select cron.alter_job(20, active := true);` and
 * waits on that deploy. Invoked with an empty POST body.
 * Batch-scans is_test=false claims where:
 *   - status           = 'documents_needed' (the column DEFAULT — the only
 *                        state a stalled post-signup claim sits in; `draft`
 *                        is explicitly excluded: that is a homeowner still
 *                        mid-intake, not "one step from bids". CTO RUN 22
 *                        defect 1 — the scan had no status predicate and
 *                        targeted a draft claim.)
 *   - ready_for_bids   = false
 *   - has_measurements = false
 *   - no hover_orders row for the claim
 *   - no activity_log row for the homeowner since claim.created_at, OTHER
 *     THAN a prior next_steps_nudge_sent row from this function itself
 *     (excluded so sending the +2h nudge doesn't make the claim look
 *     "active" and suppress the +48h nudge — see isRealActivity below).
 *
 * For each eligible claim, selectStage (./select-stage.ts) picks AT MOST ONE
 * stage per run — CTO RUN 22 defect 2 was that the two stages were
 * independent gates, so a first run over a >48h backlog sent BOTH emails
 * back-to-back (7 emails to 4 people):
 *   - nothing recorded, 2h <= age < 48h                      -> '2h'
 *   - nothing recorded, age >= 48h (first-run backlog)       -> '48h' only,
 *     ever — the age-appropriate stage; the '2h' stage is never back-filled
 *   - '2h' recorded, age >= 48h, '2h' stamp >= 46h old       -> '48h'
 *   - '48h' recorded                                         -> nothing
 * So the '48h' email depends on the '2h' record (steady state) and no claim
 * receives more than one email per run.
 *
 * Idempotency: activity_log has no claim_id column (see get-business-lines-
 * dashboard's lastActivityByUser reduction), so — matching the existing
 * bid_submitted / measurement_order_created convention of carrying claim_id
 * in metadata — this stamps:
 *   { event_type: 'next_steps_nudge_sent',
 *     metadata: { claim_id, nudge_stage: '2h' | '48h', system_generated: true } }
 * keyed by user_id, filtered by metadata.claim_id + nudge_stage per claim.
 * The stamp row's created_at is what selectStage reads as the '2h' send time.
 *
 * Concurrency (gh-1580 Q&A, CTO ruling 2026-09-03T21:40:09Z, "condition 2"):
 * the in-memory nudgeSentByClaim snapshot + stamp-before-send order
 * above only close the SEQUENTIAL race (one run retrying after a partial
 * failure). Two OVERLAPPING invocations (a manual trigger racing the cron
 * tick, or a retried call while the first is still mid-Mailgun-loop) would
 * each read the same "not yet sent" snapshot and each stamp+send — a real
 * homeowner emailed twice. The fix for that is a Postgres-level guard: the
 * stamp INSERT below catches a 23505 unique-violation and treats it as
 * "already sent" (not an error), so whichever invocation loses the race
 * skips its send. This depends on a unique partial index on activity_log
 * for (user_id, event_type, metadata->>'claim_id', metadata->>'stage')
 * that does NOT exist yet — it is Tier 3B, approved separately, and lands
 * as its own migration ahead of sql/v113 per the CTO's binding ordering
 * (index applied -> v113 applied -> this function is ever invoked by cron).
 * Two states, both must hold and both are true of this code as written:
 *   - INDEX ABSENT (today): no unique constraint exists, so Postgres never
 *     raises 23505 here — the INSERT always succeeds and the catch branch
 *     below is simply unreachable. Behavior is unchanged from before this
 *     comment: the sequential guard still holds, the concurrent race still
 *     exists. NOTE (gh-1786): the parenthetical that used to sit here — "there
 *     is no live cron trigger yet, so the race has no window to fire in" — was
 *     FALSE when it was written. cron.job 20 existed and was active, at
 *     "*(slash)30 * * * *" — same substitution as above. The race's window was
 *     open the whole time; it simply never
 *     fired because the candidate pool was empty. The job is now disabled
 *     (see the cadence note at the top of this file), which is what actually
 *     closes the window, and it stays disabled until this function's opt-out
 *     is deployed. Nothing here depends on
 *     the index existing, and nothing here crashes for its absence.
 *   - INDEX PRESENT (after the Tier 3B migration lands): a losing INSERT
 *     raises 23505, is caught, counted as a skip (not a silent return —
 *     see stages_skipped_already_sent below), and does NOT call Mailgun.
 *     This is what actually closes the concurrent-double-send exposure.
 * ON CONFLICT DO NOTHING ... RETURNING (the CTO's other acceptable option)
 * was not used: it requires naming the target constraint/index up front,
 * which errors at the database level (42P10, no matching unique/exclusion
 * constraint) when that index does not exist — i.e. it would crash today,
 * before the migration lands. Catching 23505 degrades safely in that state
 * instead, which is why it's the one wired up here.
 *
 * metadata.system_generated = true is the OTHER thing this stamp must do:
 * get-business-lines-dashboard's lastActivityByUser/firstActivityByUser
 * (and any future consumer of activity_log-as-movement) must not treat this
 * function acting on a stalled claim as the homeowner acting on it — that
 * would flip first_activity_at from null and silently drop the claim from
 * admin-dashboard.html's "NEW — no activity since signup" strip right after
 * the system nudges it (PR #1601 review, comment 5532211463). Any future
 * "we nagged you because nothing happened" event, in this function or a new
 * one, must set the same flag — it is a convention, not an enforced schema
 * column, because this repo's Edge Function deploy path does not resolve
 * _shared/ imports (see send-home-profile-prompt's emailButton comment), so
 * there is no shared constant to import and enforce this from.
 *
 * Test-account suppression: is_test=false at the query (gh-1028 propagated
 * claims.is_test / activity_log.is_test) — the claims-table equivalent of
 * the #543 contractor email-domain predicate, which does not apply to
 * homeowners.
 *
 * Copy is Tier B (notify-after) — no legal, pricing, or money claims. Do
 * not add marketing copy beyond what gh-1580 specifies.
 *
 * Auth: same CRON_SECRET pattern as send-incomplete-onboarding-reminders /
 * send-home-profile-prompt — X-Cron-Secret header, or a service-role
 * Bearer, or permissive when CRON_SECRET is unset (dev/staging).
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAILGUN_API_KEY, SITE_URL, CRON_SECRET,
 *   HOMEOWNER_OPTOUT_SECRET (gh-1786 / D-320 — REQUIRED to send; with it unset
 *   this function sends nothing rather than send without a working opt-out),
 *   HOMEOWNER_OPTOUT_SECRET_PREVIOUS (optional, verification only, for rotation)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  isNudgeEligibleStatus,
  NUDGE_ELIGIBLE_STATUS,
  NUDGE_EXCLUDED_STATUS,
  type NudgeStage,
  selectStage,
  TWO_HOURS_MS,
} from "./select-stage.ts";
import { buildEmailContent } from "./email-content.ts";
import { candidateIsTestFlag, parseDryRun, type WouldSend } from "./dry-run.ts";
import {
  canSendWithOptOut,
  fetchOptedOutClaimIds,
  isOptedOut,
} from "./optout-filter.ts";
import {
  buildOptOutUrl,
  OPTOUT_EVENT_TYPE,
  OPTOUT_SECRET_ENV,
  signOptOutToken,
} from "./optout-token.ts";

const FUNCTION_NAME = "send-homeowner-next-steps";
const BATCH_LIMIT = 200;
const NUDGE_EVENT_TYPE = "next_steps_nudge_sent";

interface ClaimRow {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  is_test: boolean;
}

interface ScanResult {
  claim_id: string;
  stages_sent: NudgeStage[];
  // 23505-caught duplicate stamps (concurrent/overlapping invocation lost
  // the race) — counted explicitly per condition 2, not folded silently
  // into stages_sent or dropped.
  stages_skipped_already_sent?: NudgeStage[];
  skipped_reason?:
    | "has_hover_order"
    | "real_activity_since_created"
    | "no_email"
    | "ineligible_status"
    // gh-1786 / D-320: this homeowner asked for the series to stop.
    | "opted_out";
}

// ─── CORS ───────────────────────────────────────────────────────────────────

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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Vary": "Origin",
  };
}

function jsonResponse(data: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Copy ──────────────────────────────────────────────────────────────────
// MOVED to ./email-content.ts by gh-1786 / D-320 (verbatim, plus the required
// opt-out footer) so the footer is testable without importing this file. See
// that file's header.

async function sendMailgunEmail(
  apiKey: string,
  to: string,
  homeownerName: string,
  measurementsUrl: string,
  colorUrl: string,
  optOutUrl: string
): Promise<{ ok: boolean; error?: string }> {
  const { subject, textBody, htmlBody } = buildEmailContent(homeownerName, measurementsUrl, colorUrl, optOutUrl);
  const formData = new URLSearchParams();
  formData.append("from", "Otter Quotes <notifications@mail.otterquote.com>");
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", textBody);
  formData.append("html", htmlBody);

  try {
    const res = await fetch("https://api.mailgun.net/v3/mail.otterquote.com/messages", {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
      body: formData,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "(unreadable)");
      return { ok: false, error: `Mailgun ${res.status}: ${errText}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Main handler ───────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
  }

  // Health-check bypass (matches send-incomplete-onboarding-reminders /
  // platform-health-check's probe pattern) — runs BEFORE the CRON_SECRET
  // gate so a bare {status:"ok"} probe with no data access is never 401'd.
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return jsonResponse({ status: "ok" }, 200, corsHeaders);
    }
  } catch (_) {
    // fall through to normal handling
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY");
  const siteUrl = (Deno.env.get("SITE_URL") || "https://otterquote.com").replace(/\/$/, "");
  const cronSecret = Deno.env.get("CRON_SECRET");
  // gh-1786 / D-320: the opt-out signing secret. No secret -> no verifiable
  // "stop these updates" link -> no send at all. Fails CLOSED (see
  // canSendWithOptOut in ./optout-filter.ts).
  const optOutSecret = Deno.env.get(OPTOUT_SECRET_ENV);
  // Functions base URL for the opt-out endpoint: same project, sibling function.
  const functionsBaseUrl = `${(supabaseUrl || "").replace(/\/$/, "")}/functions/v1`;

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, corsHeaders);
  }

  // ── Authorization (same three-way gate as send-home-profile-prompt) ──────
  const incomingCronSecret = req.headers.get("X-Cron-Secret");
  const authHeader = req.headers.get("Authorization") || "";
  let authorized = false;
  if (!cronSecret) {
    authorized = true;
  } else if (incomingCronSecret && incomingCronSecret === cronSecret) {
    authorized = true;
  } else if (authHeader.startsWith("Bearer ")) {
    authorized = authHeader.slice(7) === serviceRoleKey;
  }
  if (!authorized) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401, corsHeaders);
  }

  // gh-1570 / gh-1580 — dry-run fixture mode, read AFTER the authorization
  // gate so an unauthenticated caller cannot use it to enumerate fixtures.
  // See ./dry-run.ts for why it exists and what it deliberately does not do
  // (it writes no activity_log row and sends no email — it cannot manufacture
  // the artifact it is meant to help produce).
  const dryRun = parseDryRun(await req.clone().json().catch(() => ({})));
  const scanIsTest = candidateIsTestFlag(dryRun);
  const wouldSend: WouldSend[] = [];
  if (dryRun) {
    console.log(`[${FUNCTION_NAME}] DRY RUN — scanning is_test=true fixtures; nothing will be sent or written`);
  }

  // gh-1786 / D-320 — CAN-SPAM gate, ahead of any candidate scan. A commercial
  // email with no working opt-out is the violation this issue was filed on, so
  // an unset HOMEOWNER_OPTOUT_SECRET stops the whole run rather than degrading
  // to the pre-D-320 behaviour. 200 with a named reason, not 500: nothing is
  // broken, the function is correctly refusing.
  if (!canSendWithOptOut(optOutSecret)) {
    console.error(
      `[${FUNCTION_NAME}] ${OPTOUT_SECRET_ENV} is not set — refusing to send: D-320 requires a working opt-out link in every message`,
    );
    return jsonResponse(
      { ok: true, processed: 0, skipped_no_optout_secret: true, results: [] },
      200,
      corsHeaders,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const now = Date.now();
  const twoHoursAgoIso = new Date(now - TWO_HOURS_MS).toISOString();

  // ── Candidate scan: is_test=false, status='documents_needed' (and never
  // 'draft' — redundant with the equality but stated explicitly per CTO RUN
  // 22 defect 1), ready_for_bids=false, has_measurements=false, created at
  // least 2h ago (nothing is eligible before then) ───────────────────────────
  const { data: claims, error: scanErr } = await supabase
    .from("claims")
    .select("id, user_id, status, created_at, is_test")
    // gh-1570: `false` on every production run (gh-1028 test-account
    // suppression, unchanged). `true` only under dry_run — the two
    // populations are disjoint by construction, see ./dry-run.ts.
    .eq("is_test", scanIsTest)
    .eq("status", NUDGE_ELIGIBLE_STATUS)
    .neq("status", NUDGE_EXCLUDED_STATUS)
    .eq("ready_for_bids", false)
    .eq("has_measurements", false)
    .lte("created_at", twoHoursAgoIso)
    .limit(BATCH_LIMIT);

  if (scanErr) {
    console.error(`[${FUNCTION_NAME}] Candidate scan failed:`, scanErr.message);
    return jsonResponse({ ok: false, error: "Candidate scan failed" }, 500, corsHeaders);
  }

  if (!claims || claims.length === 0) {
    console.log(`[${FUNCTION_NAME}] Batch: no candidate claims found (is_test=${scanIsTest})`);
    return jsonResponse(
      { ok: true, processed: 0, scanned_is_test: scanIsTest, ...(dryRun ? { dry_run: true, would_send: [] } : {}), results: [] },
      200,
      corsHeaders,
    );
  }

  const claimIds = (claims as ClaimRow[]).map((c) => c.id);
  const userIds = [...new Set((claims as ClaimRow[]).map((c) => c.user_id))];

  // ── hover_orders: any row at all disqualifies the claim (it took the
  // self-serve measurement path even if has_measurements hasn't flipped yet) ──
  const { data: hoverOrders, error: hoverErr } = await supabase
    .from("hover_orders")
    .select("claim_id")
    .in("claim_id", claimIds);
  if (hoverErr) {
    console.error(`[${FUNCTION_NAME}] hover_orders read failed:`, hoverErr.message);
    return jsonResponse({ ok: false, error: "hover_orders read failed" }, 500, corsHeaders);
  }
  const claimIdsWithHoverOrder = new Set((hoverOrders || []).map((h: any) => h.claim_id));

  // ── activity_log: read whole for these users, reduce in JS (activity_log
  // has no claim_id column — same constraint get-business-lines-dashboard's
  // lastActivityByUser works around) ────────────────────────────────────────
  const { data: activity, error: activityErr } = await supabase
    .from("activity_log")
    .select("user_id, event_type, metadata, created_at")
    .in("user_id", userIds);
  if (activityErr) {
    console.error(`[${FUNCTION_NAME}] activity_log read failed:`, activityErr.message);
    return jsonResponse({ ok: false, error: "activity_log read failed" }, 500, corsHeaders);
  }

  // gh-1786 / D-320: claim ids whose homeowner clicked "Stop these updates".
  // Deliberately its OWN filtered, bounded query — NOT reduced from the
  // `activity` read above, which has no event_type predicate and can be
  // silently truncated by PostgREST's row cap on a user with a lot of
  // history (see optout-filter.ts for the full reasoning; this is the fix
  // for the LEGAL-READ FAIL on PR #1810 comments 5577266980 / 5577311497).
  const { optedOut: optedOutClaimIds, error: optOutErr } = await fetchOptedOutClaimIds(
    supabase,
    userIds,
    claimIds,
  );
  if (optOutErr) {
    console.error(`[${FUNCTION_NAME}] opt-out read failed:`, optOutErr.message);
    return jsonResponse({ ok: false, error: "opt-out read failed" }, 500, corsHeaders);
  }

  // Real (non-self-generated) activity per user, latest timestamp.
  const realActivityByUser = new Map<string, string>();
  // Already-sent nudge stages per claim: claim_id -> (stage -> stamp
  // created_at). The stamp time is what selectStage uses to space the '48h'
  // send after the '2h' one; if the same stage was stamped more than once
  // (pre-unique-index race) the EARLIEST stamp wins.
  const nudgeSentByClaim = new Map<string, Map<NudgeStage, string>>();

  for (const row of (activity || []) as any[]) {
    // An opt-out is not homeowner progress on the claim. Like our own nudge
    // stamp, it must never count as "real activity" — otherwise clicking the
    // opt-out link would ALSO look like movement and change what the admin
    // dashboard's "no activity since signup" strip shows.
    if (row.event_type === OPTOUT_EVENT_TYPE) continue;
    if (row.event_type === NUDGE_EVENT_TYPE) {
      const md = row.metadata || {};
      if (md.claim_id && (md.nudge_stage === "2h" || md.nudge_stage === "48h")) {
        let stages = nudgeSentByClaim.get(md.claim_id);
        if (!stages) {
          stages = new Map<NudgeStage, string>();
          nudgeSentByClaim.set(md.claim_id, stages);
        }
        const prevStamp = stages.get(md.nudge_stage as NudgeStage);
        if (!prevStamp || row.created_at < prevStamp) {
          stages.set(md.nudge_stage as NudgeStage, row.created_at);
        }
      }
      continue; // our own stamp never counts as "real" homeowner activity
    }
    const prev = realActivityByUser.get(row.user_id);
    if (!prev || row.created_at > prev) {
      realActivityByUser.set(row.user_id, row.created_at);
    }
  }

  const results: ScanResult[] = [];

  const emptySends: ReadonlyMap<NudgeStage, string> = new Map();

  for (const claim of claims as ClaimRow[]) {
    // Defense in depth for CTO RUN 22 defect 1: the query already filters on
    // status, but a claim that somehow arrives here in any other state (a
    // `draft` above all) must never be told "You're one step from bids".
    if (!isNudgeEligibleStatus(claim.status)) {
      results.push({ claim_id: claim.id, stages_sent: [], skipped_reason: "ineligible_status" });
      continue;
    }
    // gh-1786 / D-320: the homeowner asked us to stop. Checked BEFORE any
    // stage selection, contact lookup or stamp, so an opted-out claim costs no
    // reads and can never be stamped as sent.
    if (isOptedOut(optedOutClaimIds, claim.id)) {
      results.push({ claim_id: claim.id, stages_sent: [], skipped_reason: "opted_out" });
      continue;
    }
    if (claimIdsWithHoverOrder.has(claim.id)) {
      results.push({ claim_id: claim.id, stages_sent: [], skipped_reason: "has_hover_order" });
      continue;
    }
    const lastReal = realActivityByUser.get(claim.user_id);
    if (lastReal && lastReal > claim.created_at) {
      results.push({ claim_id: claim.id, stages_sent: [], skipped_reason: "real_activity_since_created" });
      continue;
    }

    // CTO RUN 22 defect 2: at most ONE stage per claim per run (see
    // ./select-stage.ts for the full decision table and its tests).
    const stage = selectStage(claim, nudgeSentByClaim.get(claim.id) ?? emptySends, now);
    if (stage === null) {
      results.push({ claim_id: claim.id, stages_sent: [] });
      continue;
    }
    const stagesToSend: NudgeStage[] = [stage];

    // Resolve homeowner contact info (profile row, falling back to auth).
    let homeownerEmail: string | null = null;
    let homeownerName = "there";
    const { data: profile } = await supabase
      .from("profiles")
      .select("email, full_name")
      .eq("id", claim.user_id)
      .maybeSingle();
    if (profile?.email) {
      homeownerEmail = profile.email;
      homeownerName = profile.full_name || "there";
    } else {
      const { data: authUser } = await supabase.auth.admin.getUserById(claim.user_id);
      homeownerEmail = authUser?.user?.email || null;
      homeownerName = authUser?.user?.user_metadata?.full_name || "there";
    }

    if (!homeownerEmail) {
      console.warn(`[${FUNCTION_NAME}] No email for homeowner ${claim.user_id} on claim ${claim.id} — skipping`);
      results.push({ claim_id: claim.id, stages_sent: [], skipped_reason: "no_email" });
      continue;
    }

    const measurementsUrl = `${siteUrl}/help-measurements.html`;
    const colorUrl = `${siteUrl}/color-selection.html?claim_id=${claim.id}`;
    // gh-1786 / D-320: per-claim signed opt-out link. Payload is the claim UUID
    // only — no email, no name, no user id; and the claim UUID is already in
    // colorUrl above, so the footer adds no identifier this message did not
    // already carry.
    const optOutUrl = buildOptOutUrl(
      functionsBaseUrl,
      await signOptOutToken(claim.id, optOutSecret as string),
    );

    const sentStages: NudgeStage[] = [];
    const skippedAlreadySentStages: NudgeStage[] = [];
    for (const stage of stagesToSend) {
      // gh-1580 review fix (PR #1601, comment 5532245612): stamp BEFORE
      // sending, not after. The prior send-then-stamp order's own comment
      // admitted the failure mode: if the stamp insert failed (or a run
      // overlapped the next 30-min cron tick), the "already sent" gate
      // stayed unset while the email had already gone out, so the next run
      // would see no stamp and send AGAIN to a real homeowner. There is no
      // unique constraint backing dedup here — checked pg_indexes on prod
      // `activity_log`: only pkey + idx_activity_log_user_id +
      // idx_activity_log_created_at + idx_activity_log_user_created, nothing
      // on (user_id, event_type, metadata) — and adding one is a Tier 3B
      // schema surface, not this PR's to add. So the row is claimed FIRST;
      // if that claim fails, the send is skipped entirely THIS run (no
      // stamp landed, so nothing went out, and the next cron run retries
      // cleanly). This deliberately trades the opposite failure mode: if
      // the stamp commits but the Mailgun send then fails, that claim does
      // NOT auto-retry (the gate is now set) — logged as an ERROR below so
      // it's visible for manual follow-up rather than silently swallowed.
      // Skipping a nudge is recoverable; double-emailing a real homeowner
      // is not — this function is asymmetric about that on purpose.
      // gh-1570 dry run: render the real message, report it, write nothing
      // and send nothing. Placed AFTER selectStage and the contact lookup so
      // the dry run exercises the same decisions a real send would, and
      // BEFORE the stamp so it can never create a `next_steps_nudge_sent`
      // row — the artifact this mode exists to help produce must come from a
      // real send, not from the tool that previews one.
      if (dryRun) {
        const preview = buildEmailContent(homeownerName, measurementsUrl, colorUrl, optOutUrl);
        wouldSend.push({
          claim_id: claim.id,
          user_id: claim.user_id,
          stage,
          to: homeownerEmail,
          subject: preview.subject,
          text_first_line: preview.textBody.split("\n")[0],
          has_optout_link: preview.textBody.includes(optOutUrl),
        });
        console.log(`[${FUNCTION_NAME}] DRY RUN — would send ${stage} nudge for claim ${claim.id} (nothing sent, nothing written)`);
        continue;
      }

      const { error: stampError } = await supabase.from("activity_log").insert({
        user_id: claim.user_id,
        event_type: NUDGE_EVENT_TYPE,
        title: stage === "2h" ? "Next-steps nudge sent (+2h)" : "Next-steps nudge sent (+48h)",
        metadata: { claim_id: claim.id, nudge_stage: stage, system_generated: true },
        is_test: false,
      });
      if (stampError) {
        // condition 2 (gh-1580 Q&A, CTO ruling 2026-09-03T21:40:09Z): a
        // unique-violation here means a concurrent/overlapping invocation
        // already won the race and stamped+sent this exact (claim, stage)
        // first — NOT a failure. Skip the send, count it explicitly, do not
        // treat it as an error. Unreachable until the Tier 3B unique
        // partial index lands (see the file-header comment) — before then,
        // no unique constraint exists on activity_log for this key, so
        // Postgres never raises 23505 and this branch is simply dead code
        // that cannot crash anything.
        if (stampError.code === "23505") {
          console.log(`[${FUNCTION_NAME}] ${stage} nudge for claim ${claim.id} already sent (23505 unique-violation — concurrent run won the race) — skipping send`);
          skippedAlreadySentStages.push(stage);
          continue;
        }
        console.error(`[${FUNCTION_NAME}] Failed to stamp ${stage} nudge for claim ${claim.id} — skipping send this run, will retry next run:`, stampError.message);
        continue; // fatal for this row this run: no stamp landed, so nothing was sent — safe to retry
      }

      if (!mailgunApiKey) {
        console.warn(`[${FUNCTION_NAME}] MAILGUN_API_KEY not set — stamp recorded, no email sent (dev/staging) for claim ${claim.id} stage ${stage}`);
        sentStages.push(stage);
        continue;
      }

      const sendResult = await sendMailgunEmail(mailgunApiKey, homeownerEmail, homeownerName, measurementsUrl, colorUrl, optOutUrl);
      if (!sendResult.ok) {
        console.error(`[${FUNCTION_NAME}] STAMPED BUT SEND FAILED for claim ${claim.id} stage ${stage} — will NOT auto-retry (stamp already committed); needs manual follow-up: ${sendResult.error}`);
        continue; // do not count as sent — the stamp is already committed, deliberately not reversed
      }
      console.log(`[${FUNCTION_NAME}] Sent ${stage} nudge -> ${homeownerEmail} for claim ${claim.id}`);
      sentStages.push(stage);
    }

    results.push({
      claim_id: claim.id,
      stages_sent: sentStages,
      ...(skippedAlreadySentStages.length > 0 ? { stages_skipped_already_sent: skippedAlreadySentStages } : {}),
    });
  }

  const processed = results.filter((r) => r.stages_sent.length > 0).length;
  // Counted output per condition 2 — never a silent return. Zero today is
  // expected and correct (no unique index yet => 23505 cannot fire); a
  // non-zero count after the Tier 3B index lands is the guard working, not
  // an error condition.
  const skippedAlreadySent = results.reduce(
    (sum, r) => sum + (r.stages_skipped_already_sent?.length || 0),
    0
  );
  return jsonResponse(
    {
      ok: true,
      processed,
      skipped_already_sent: skippedAlreadySent,
      scanned_is_test: scanIsTest,
      // gh-1570: on a dry run `processed` is 0 by construction (nothing is
      // stamped), and `would_send` carries what a real run would have done.
      ...(dryRun ? { dry_run: true, would_send: wouldSend } : {}),
      results,
    },
    200,
    corsHeaders,
  );
});
