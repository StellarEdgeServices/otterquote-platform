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
 * twice as often as this comment claimed until gh-1786 corrected it. From
 * 2026-09-07 to 2026-09-16 that job was `active = false` — disabled
 * deliberately (D-320's own recommendation, Dustin's word) so nothing sent
 * until the opt-out below was DEPLOYED. gh-2069 CORRECTION: the opt-out
 * shipped and `select cron.alter_job(20, active := true);` was run on
 * 2026-09-16T11:41Z (CRO RUN 24, on Dustin's "Go" in #1944) — the job has
 * been ACTIVE, and sending, ever since (confirmed 343/343 successful runs
 * through 2026-09-21 in `In Flight/reports/ceo57-nudge-pipeline-20260921.md`).
 * This comment previously kept claiming the job was off for nine days after
 * it was turned back on; do not repeat that mistake — check
 * `select active from cron.job where jobid = 20;` rather than trusting this
 * paragraph's own memory of the date. Invoked with an empty POST body.
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
 *
 * gh-1933 follow-up: whenever this scan finds a homeowner at the '48h' stage
 * (documents_needed, no measurements, no hover order, the claim itself >= 48h
 * old, AND no activity ever recorded on the homeowner's ACCOUNT since the
 * claim was created — see ./select-stage.ts's real_activity_since_created;
 * it is not a 48-hour activity window, the 48h figure is the claim's AGE —
 * the exact condition selectStage already screens for), it also sends ONE
 * admin digest email to Dustin listing every such homeowner found this run
 * (masked email, claim id, days stalled, dashboard link), reusing this
 * function's own screening rather than a second query. See
 * ./admin-digest-executor.ts for the injected-dependency executor (gh-1933
 * review fix D1) that decides what a dry run vs. a real run does with that
 * list, and ./admin-digest.ts for the pure render/mask/day-bucket functions
 * it calls. A plain dry run sends and writes nothing, same as the rest of
 * this function; the opt-in `admin_digest_preview: true` request-body flag
 * (honoured only alongside `dry_run: true` — gh-1933 D2) is the one way to
 * preview the digest without a live cron invocation. The real digest is
 * independent of cron.job 20's active state — it fires whenever this
 * function is invoked and finds a match, same as the homeowner nudge it
 * rides alongside.
 *
 * gh-1786 follow-up (this change): the Mailgun send now also carries the
 * RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers, pointed at
 * the SAME per-claim signed URL the footer link already uses (./optout-token.ts
 * buildOptOutUrl). This is the mailbox-provider-facing one-click surface
 * (the Gmail/Outlook "Unsubscribe" affordance next to the sender); the footer
 * link already satisfied the in-body CAN-SPAM requirement, so this adds no
 * new secret, no new endpoint and no new recipient-facing copy — same link,
 * a second place it appears. `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 * is what makes a mail client's one-click button call the URL with a bare
 * POST instead of opening it in a browser; homeowner-email-optout/index.ts
 * already accepts a POST with no body (reading `t` from the query string
 * either way), so no endpoint change was needed for this to work.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  type ActivityLogRow,
  NUDGE_ELIGIBLE_STATUS,
  NUDGE_EXCLUDED_STATUS,
  type NudgeStage,
  reduceActivityRows,
  screenClaim,
  TWO_HOURS_MS,
} from "./select-stage.ts";
import { buildEmailContent } from "./email-content.ts";
import {
  buildCandidateQuery,
  candidateIsTestFlag,
  dryRunAuthorized,
  parseDryRun,
} from "./dry-run.ts";
import { deliverStage, type PreviewRow } from "./deliver-stage.ts";
import {
  canSendWithOptOut,
  fetchOptedOutClaimIds,
} from "./optout-filter.ts";
import {
  buildOptOutUrl,
  OPTOUT_EVENT_TYPE,
  OPTOUT_SECRET_ENV,
  signOptOutToken,
} from "./optout-token.ts";
import { ADMIN_DIGEST_EMAIL, ADMIN_DIGEST_NOTIFICATION_TYPE } from "./admin-digest.ts";
import {
  type AdminDigestDeps,
  type AdminDigestResult,
  type ScreenedCandidate,
  parseAdminDigestPreview,
  runAdminDigest,
} from "./admin-digest-executor.ts";
import {
  buildWelcomeEmailContent,
  deliverWelcome,
  HOMEOWNER_WELCOME_FRESHNESS_MS,
  HOMEOWNER_WELCOME_SETTING_KEY,
  HOMEOWNER_WELCOME_TEMPLATE,
  isProfileFreshEnough,
  isWelcomeEnabled,
  type WelcomeDeps,
} from "./welcome-hook.ts";
import {
  buildChecklistCompleteEmailContent,
  CHECKLIST_COMPLETE_EVENT_TYPE,
  CHECKLIST_COMPLETE_NUDGE_EVENT_TYPE,
  CHECKLIST_COMPLETE_STAGE,
  type ChecklistCompleteRow,
  deliverChecklistCompleteStage,
  reduceChecklistCompleteActivity,
  screenChecklistCompleteClaim,
} from "./checklist-complete-stage.ts";

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
  // gh-1859 review fix (blocker 3): a previewed claim used to land here as
  // {stages_sent: []}, indistinguishable from "selectStage returned null".
  stages_previewed?: NudgeStage[];
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

// gh-1933 review fix (D2) — shared response-shaping for runAdminDigest's
// result, used at both call sites (the "no candidates at all" early return
// and the end-of-handler path) so the two can never drift into different
// response shapes for the same (dryRun, previewSend) combination.
function buildDigestResponseFields(
  outcome: AdminDigestResult,
  dryRun: boolean,
  previewSend: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    // gh-1933: count of homeowners newly included in a sent digest — real or
    // preview. 0 is correct and expected on a plain dry run (nothing sends),
    // whenever nobody is at the '48h' stage, or everyone found was already
    // digested today.
    admin_digest_sent: outcome.sent,
    ...(outcome.error ? { admin_digest_error: outcome.error } : {}),
  };
  if (dryRun && previewSend) {
    // gh-1933 D2 — this is the branch that produces #1933's closing artifact.
    return { ...base, admin_digest_preview: true };
  }
  if (dryRun && !previewSend) {
    // gh-1933 D2 — unchanged zero-send/zero-write dry run, plus a preview of
    // what a real run would include (never a real recipient address).
    return { ...base, would_digest: outcome.wouldDigest ?? [] };
  }
  return base;
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
): Promise<{ ok: boolean; mailgunId?: string; error?: string }> {
  const { subject, textBody, htmlBody } = buildEmailContent(homeownerName, measurementsUrl, colorUrl, optOutUrl);
  const formData = new URLSearchParams();
  formData.append("from", "Otter Quotes <notifications@mail.otterquote.com>");
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", textBody);
  formData.append("html", htmlBody);
  // gh-1786 follow-up: RFC 8058 mailbox-provider one-click unsubscribe, same
  // signed link the footer already carries — see the file header. Mailgun
  // passes any `h:<Header-Name>` form field through as a literal MIME header.
  formData.append("h:List-Unsubscribe", `<${optOutUrl}>`);
  formData.append("h:List-Unsubscribe-Post", "List-Unsubscribe=One-Click");

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
    // gh-2069: copy sendAdminDigestMail's own pattern (below) — parse the
    // response body and return Mailgun's message id instead of discarding
    // it. This was the whole first defect in #2069: the admin digest already
    // did this; the homeowner path never did.
    const data = await res.json().catch(() => ({}));
    return { ok: true, mailgunId: (data as { id?: string })?.id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// gh-1933: sends the one stalled-homeowner digest email to Dustin. Separate
// from sendMailgunEmail above — different recipient, different content, no
// opt-out link (this is an internal admin notice, not a homeowner-facing
// commercial email; D-320's opt-out mechanism does not apply to it).
async function sendAdminDigestMail(
  apiKey: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): Promise<{ ok: boolean; mailgunId?: string; error?: string }> {
  const formData = new URLSearchParams();
  formData.append("from", "Otter Quotes <notifications@mail.otterquote.com>");
  formData.append("to", ADMIN_DIGEST_EMAIL);
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
    const data = await res.json().catch(() => ({}));
    return { ok: true, mailgunId: (data as { id?: string })?.id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// gh-2069 (e): sends the homeowner_welcome first-touch email. Same Mailgun
// call shape as sendAdminDigestMail (parses `data.id`), different recipient
// and content, and — unlike the D-320 homeowner nudge — no opt-out link:
// this is a single transactional first-touch message, not part of the
// recurring commercial series D-320's opt-out mechanism governs.
async function sendWelcomeMailgunEmail(
  apiKey: string,
  to: string,
  homeownerName: string,
  dashboardUrl: string,
): Promise<{ ok: boolean; mailgunId?: string; error?: string }> {
  const { subject, textBody, htmlBody } = buildWelcomeEmailContent(homeownerName, dashboardUrl);
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
    const data = await res.json().catch(() => ({}));
    return { ok: true, mailgunId: (data as { id?: string })?.id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// gh-1570 Part 2: sends the `checklist_complete_not_submitted` stage's one
// email. Same Mailgun call shape as sendMailgunEmail above (parses
// `data.id`, same List-Unsubscribe headers pointed at the same signed
// opt-out link — this stage is part of the same D-320-governed series), one
// fewer link than the '2h'/'48h' template because there is nothing left to
// upload or choose at this stage — the CTA is "go back and click Submit for
// Bids".
async function sendChecklistCompleteMailgunEmail(
  apiKey: string,
  to: string,
  homeownerName: string,
  dashboardUrl: string,
  optOutUrl: string,
): Promise<{ ok: boolean; mailgunId?: string; error?: string }> {
  const { subject, textBody, htmlBody } = buildChecklistCompleteEmailContent(homeownerName, dashboardUrl, optOutUrl);
  const formData = new URLSearchParams();
  formData.append("from", "Otter Quotes <notifications@mail.otterquote.com>");
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", textBody);
  formData.append("html", htmlBody);
  formData.append("h:List-Unsubscribe", `<${optOutUrl}>`);
  formData.append("h:List-Unsubscribe-Post", "List-Unsubscribe=One-Click");

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
    const data = await res.json().catch(() => ({}));
    return { ok: true, mailgunId: (data as { id?: string })?.id };
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
  const requestBody = await req.clone().json().catch(() => ({}));
  const dryRunRequested = parseDryRun(requestBody);
  // gh-1859 review fix: a dry run does NOT inherit the batch gate's permissive
  // `if (!cronSecret) authorized = true` branch. That branch fails OPEN, and a
  // dry run returns a list of claims, so it requires positive proof of
  // authorization or it does not run at all. See dryRunAuthorized().
  if (dryRunRequested && !dryRunAuthorized({
    cronSecret, incomingCronSecret, authHeader, serviceRoleKey,
  })) {
    console.warn(`[${FUNCTION_NAME}] dry_run refused — the permissive no-CRON_SECRET branch does not authorize a preview`);
    return jsonResponse(
      { ok: false, error: "dry_run requires an explicit cron secret or service-role credential" },
      401,
      corsHeaders,
    );
  }
  const dryRun = dryRunRequested;
  const scanIsTest = candidateIsTestFlag(dryRun);
  const wouldSend: PreviewRow[] = [];
  if (dryRun) {
    console.log(`[${FUNCTION_NAME}] DRY RUN — scanning is_test=true fixtures; nothing will be sent or written`);
  }
  // gh-1933 D2 — the opt-in flag that makes #1933's closing artifact
  // reachable: a dry invocation against an is_test homeowner seeded into the
  // stalled ('48h') condition can now actually produce exactly one admin
  // digest. Honoured ONLY when `dry_run: true` — see ./admin-digest-executor.ts
  // for why (a real run ignores this flag entirely; that is asserted there,
  // not just claimed here).
  const adminDigestPreviewRequested = parseAdminDigestPreview(requestBody);
  const adminDigestPreview = dryRun && adminDigestPreviewRequested;
  const adminDigestPreviewIgnored = adminDigestPreviewRequested && !dryRun;

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

  // gh-1933 review fix (D1)'s stalledForDigest array, declared HERE (rather
  // than just above the main claims loop, where it lived before gh-1570 Part
  // 2) so both the checklist-complete-stage block below and the "no main
  // candidates at all" early return further down can push into / read the
  // same array. See ./admin-digest-executor.ts for ScreenedCandidate.
  const stalledForDigest: ScreenedCandidate[] = [];
  let checklistCompleteSent = 0;
  let checklistCompleteFailed = 0;
  const checklistCompleteResults: { claim_id: string; sent: boolean; skipped_reason?: string }[] = [];
  const checklistCompleteWouldSend: {
    claim_id: string;
    stage: string;
    subject: string;
    text_first_line: string;
    has_optout_link_text: boolean;
    has_optout_link_html: boolean;
    recipient_present: boolean;
  }[] = [];

  // gh-1933 review fix (D1) — the digest's injected dependencies, wired here
  // exactly once and passed into runAdminDigest at every call site below
  // (the "no candidates found at all" early return, and the end-of-handler
  // path). See ./admin-digest-executor.ts for what each function must do;
  // this is the only place any of them touches Supabase or Mailgun.
  const adminDigestDeps: AdminDigestDeps = {
    fetchAlreadyDigestedToday: async (claimIds, todayStartIso) => {
      const { data, error } = await supabase
        .from("notifications")
        .select("claim_id")
        .eq("notification_type", ADMIN_DIGEST_NOTIFICATION_TYPE)
        .in("claim_id", claimIds)
        .gte("sent_at", todayStartIso);
      if (error) {
        console.error(`[${FUNCTION_NAME}] admin digest idempotency check failed:`, error.message);
        return { claimIds: new Set<string>(), error: error.message };
      }
      return { claimIds: new Set((data || []).map((r: { claim_id: string }) => r.claim_id)) };
    },
    sendAdminDigestMail: (subject, textBody, htmlBody) =>
      sendAdminDigestMail(mailgunApiKey as string, subject, textBody, htmlBody),
    insertNotificationRows: async (rows) => {
      const { error } = await supabase.from("notifications").insert(rows);
      if (error) {
        console.warn(`[${FUNCTION_NAME}] admin digest sent but failed to mark notifications:`, error.message);
      }
      return { error: error?.message ?? null };
    },
    mailgunConfigured: Boolean(mailgunApiKey),
    now,
  };

  // ── gh-2069 (e): homeowner_welcome first-touch hook ──────────────────────
  // Runs on every real cron tick regardless of whether any claim matches the
  // main nudge scan below — a brand-new signup has no claim yet in many
  // funnels, so this must not be nested inside "candidates were found" the
  // way the digest correctly is. Scans the SAME is_test population as the
  // main scan (scanIsTest) so a dry run never touches a real homeowner and a
  // real run never emails a fixture — same disjointness property as
  // ./dry-run.ts's candidateIsTestFlag. A dry run does not call
  // deliverWelcome at all: like the rest of this function's dry-run mode, it
  // sends and writes nothing (see ./dry-run.ts's file header).
  let welcomeSent = 0;
  let welcomeFailed = 0;
  let welcomeEnabled = false;
  if (!dryRun) {
    const { data: settingRow, error: settingErr } = await supabase
      .from("platform_settings")
      .select("value")
      .eq("key", HOMEOWNER_WELCOME_SETTING_KEY)
      .maybeSingle();
    if (settingErr) {
      console.error(`[${FUNCTION_NAME}] ${HOMEOWNER_WELCOME_SETTING_KEY} read failed — treating as disabled:`, settingErr.message);
    }
    // gh-2069: missing row (not inserted by this PR — see the PR description
    // for the SQL to add it) or any value other than a literal `true` means
    // disabled. Fails CLOSED, same convention as HOMEOWNER_OPTOUT_SECRET above.
    welcomeEnabled = isWelcomeEnabled(settingRow?.value ?? null);

    const freshCutoffIso = new Date(now - HOMEOWNER_WELCOME_FRESHNESS_MS).toISOString();
    const { data: freshProfiles, error: freshErr } = await supabase
      .from("profiles")
      .select("id, email, full_name, created_at")
      .eq("role", "homeowner")
      .eq("is_test", scanIsTest)
      .gte("created_at", freshCutoffIso);
    if (freshErr) {
      console.error(`[${FUNCTION_NAME}] welcome-hook profile scan failed:`, freshErr.message);
    } else if (freshProfiles && freshProfiles.length > 0) {
      const candidateIds = (freshProfiles as { id: string }[]).map((p) => p.id);
      const { data: alreadyWelcomed, error: alreadyErr } = await supabase
        .from("notifications")
        .select("user_id")
        .eq("notification_type", HOMEOWNER_WELCOME_TEMPLATE)
        .in("user_id", candidateIds);
      if (alreadyErr) {
        console.error(`[${FUNCTION_NAME}] welcome-hook idempotency read failed — skipping this tick to avoid a duplicate send:`, alreadyErr.message);
      } else {
        const welcomedSet = new Set((alreadyWelcomed || []).map((r: { user_id: string }) => r.user_id));
        const welcomeDeps: WelcomeDeps = {
          enabled: welcomeEnabled,
          mailgunConfigured: Boolean(mailgunApiKey),
          sendEmail: (to, name, dashboardUrl) =>
            sendWelcomeMailgunEmail(mailgunApiKey as string, to, name, dashboardUrl),
          insertNotification: async (row) => {
            const { error } = await supabase.from("notifications").insert(row);
            return { error: error?.message ?? null };
          },
          log: (level, message) => console[level](`[${FUNCTION_NAME}] ${message}`),
        };
        const dashboardUrl = `${siteUrl}/dashboard.html`;
        for (const p of freshProfiles as { id: string; email: string | null; full_name: string | null; created_at: string }[]) {
          if (welcomedSet.has(p.id)) continue;
          if (!p.email) continue;
          // Re-check freshness against `now` (not just the query's cutoff)
          // so a slow scan doesn't email a profile that aged out mid-run.
          if (!isProfileFreshEnough(p.created_at, now)) continue;
          const outcome = await deliverWelcome(
            welcomeDeps,
            { userId: p.id, email: p.email, name: p.full_name || "there" },
            dashboardUrl,
          );
          if (outcome.kind === "sent") welcomeSent++;
          else if (outcome.kind === "send_failed") welcomeFailed++;
        }
      }
    }
  }

  // ── gh-1570 Part 2 (issue #1570, comment 5764786813) — the
  // `checklist_complete_not_submitted` stage ───────────────────────────────
  // Runs on every real cron tick regardless of whether the main '2h'/'48h'
  // candidate scan below finds anything: a claim with its checklist complete
  // has has_measurements=true (or an insurance estimate on file), so it is by
  // construction EXCLUDED from that scan's has_measurements=false predicate.
  // Same placement reasoning as the welcome-hook block above. See
  // ./checklist-complete-stage.ts for the pure selection/delivery logic this
  // wires together; that file, not this block, is where the eligibility and
  // idempotence properties are tested.
  {
    const { data: ccClaims, error: ccClaimsErr } = await supabase
      .from("claims")
      .select("id, user_id, status, ready_for_bids, created_at")
      .eq("is_test", scanIsTest)
      .eq("status", NUDGE_ELIGIBLE_STATUS)
      .limit(BATCH_LIMIT);

    if (ccClaimsErr) {
      console.error(`[${FUNCTION_NAME}] checklist-complete-stage candidate scan failed:`, ccClaimsErr.message);
    } else if (ccClaims && ccClaims.length > 0) {
      const ccClaimRows = ccClaims as {
        id: string; user_id: string; status: string; ready_for_bids: boolean | null; created_at: string;
      }[];
      const ccUserIds = [...new Set(ccClaimRows.map((c) => c.user_id))];
      const ccClaimIds = ccClaimRows.map((c) => c.id);

      const { data: ccActivity, error: ccActivityErr } = await supabase
        .from("activity_log")
        .select("event_type, metadata, created_at")
        .in("user_id", ccUserIds)
        .in("event_type", [CHECKLIST_COMPLETE_EVENT_TYPE, CHECKLIST_COMPLETE_NUDGE_EVENT_TYPE]);

      // gh-1786 / D-320: same dedicated, bounded opt-out read the main scan
      // uses below — not reduced from a generic activity_log read (see
      // fetchOptedOutClaimIds's own header for why).
      const { optedOut: ccOptedOut, error: ccOptOutErr } = await fetchOptedOutClaimIds(
        supabase,
        ccUserIds,
        ccClaimIds,
      );

      if (ccActivityErr) {
        console.error(`[${FUNCTION_NAME}] checklist-complete-stage activity_log read failed:`, ccActivityErr.message);
      } else if (ccOptOutErr) {
        console.error(`[${FUNCTION_NAME}] checklist-complete-stage opt-out read failed:`, ccOptOutErr.message);
      } else {
        const ccReduced = reduceChecklistCompleteActivity((ccActivity || []) as ChecklistCompleteRow[]);

        for (const c of ccClaimRows) {
          const decision = screenChecklistCompleteClaim(
            { id: c.id, status: c.status, ready_for_bids: c.ready_for_bids },
            { optedOutClaimIds: ccOptedOut, reduced: ccReduced, now },
          );
          if (!decision.stage) {
            checklistCompleteResults.push({ claim_id: c.id, sent: false, skipped_reason: decision.skipped_reason });
            continue;
          }

          let ccHomeownerEmail: string | null = null;
          let ccHomeownerName = "there";
          const { data: ccProfile } = await supabase
            .from("profiles")
            .select("email, full_name")
            .eq("id", c.user_id)
            .maybeSingle();
          if (ccProfile?.email) {
            ccHomeownerEmail = ccProfile.email;
            ccHomeownerName = ccProfile.full_name || "there";
          } else {
            const { data: ccAuthUser } = await supabase.auth.admin.getUserById(c.user_id);
            ccHomeownerEmail = ccAuthUser?.user?.email || null;
            ccHomeownerName = ccAuthUser?.user?.user_metadata?.full_name || "there";
          }

          if (!ccHomeownerEmail) {
            checklistCompleteResults.push({ claim_id: c.id, sent: false, skipped_reason: "no_email" });
            continue;
          }

          // gh-1570 Part 2: included in the admin digest regardless of
          // activity, per Ben's spec — pushed unconditionally, same as the
          // main loop pushes every screened '2h'/'48h' claim below.
          stalledForDigest.push({
            claimId: c.id,
            userId: c.user_id,
            email: ccHomeownerEmail,
            createdAtIso: c.created_at,
            stage: CHECKLIST_COMPLETE_STAGE,
          });

          const dashboardUrl = `${siteUrl}/dashboard.html`;
          const ccOptOutUrl = buildOptOutUrl(
            functionsBaseUrl,
            await signOptOutToken(c.id, optOutSecret as string),
          );

          const ccOutcome = await deliverChecklistCompleteStage(
            {
              dryRun,
              mailgunConfigured: Boolean(mailgunApiKey),
              buildEmail: buildChecklistCompleteEmailContent,
              insertActivityLog: async (row) => {
                const { error } = await supabase.from("activity_log").insert(row);
                return { error: error ?? null };
              },
              sendEmail: (to, name, dUrl, oUrl) =>
                sendChecklistCompleteMailgunEmail(mailgunApiKey as string, to, name, dUrl, oUrl),
              insertNotification: async (row) => {
                const { error } = await supabase.from("notifications").insert(row);
                return { error: error?.message ?? null };
              },
              log: (level, message) => console[level](`[${FUNCTION_NAME}] ${message}`),
            },
            {
              claimId: c.id,
              userId: c.user_id,
              homeownerEmail: ccHomeownerEmail,
              homeownerName: ccHomeownerName,
              dashboardUrl,
              optOutUrl: ccOptOutUrl,
            },
          );

          if (ccOutcome.kind === "previewed") {
            checklistCompleteWouldSend.push(ccOutcome.preview);
            checklistCompleteResults.push({ claim_id: c.id, sent: false });
          } else if (ccOutcome.kind === "sent") {
            checklistCompleteSent++;
            checklistCompleteResults.push({ claim_id: c.id, sent: true });
          } else if (ccOutcome.kind === "already_sent") {
            checklistCompleteResults.push({ claim_id: c.id, sent: false, skipped_reason: "already_sent" });
          } else {
            checklistCompleteFailed++;
            checklistCompleteResults.push({ claim_id: c.id, sent: false, skipped_reason: ccOutcome.error });
          }
        }
      }
    }
  }

  // ── Candidate scan: is_test=false, status='documents_needed' (and never
  // 'draft' — redundant with the equality but stated explicitly per CTO RUN
  // 22 defect 1), ready_for_bids=false, has_measurements=false, created at
  // least 2h ago (nothing is eligible before then) ───────────────────────────
  const { data: claims, error: scanErr } = await buildCandidateQuery(
    // deno-lint-ignore no-explicit-any
    supabase.from("claims") as any,
    {
      // gh-1570: `false` on every production run (gh-1028 test-account
      // suppression, unchanged). `true` only under an authorized dry run —
      // the two populations are disjoint by construction, see ./dry-run.ts.
      scanIsTest,
      eligibleStatus: NUDGE_ELIGIBLE_STATUS,
      excludedStatus: NUDGE_EXCLUDED_STATUS,
      cutoffIso: twoHoursAgoIso,
      limit: BATCH_LIMIT,
    },
    // deno-lint-ignore no-explicit-any
  ) as any;

  if (scanErr) {
    console.error(`[${FUNCTION_NAME}] Candidate scan failed:`, scanErr.message);
    return jsonResponse({ ok: false, error: "Candidate scan failed" }, 500, corsHeaders);
  }

  if (!claims || claims.length === 0) {
    console.log(`[${FUNCTION_NAME}] Batch: no candidate claims found (is_test=${scanIsTest})`);
    // gh-1933: no MAIN ('2h'/'48h') claims matched, but gh-1570 Part 2's
    // checklist-complete-stage block above may still have found candidates
    // (that stage's own claims are excluded from this scan by construction —
    // see that block's header comment) — `stalledForDigest` and
    // `checklistCompleteResults` are populated independently of `claims`, so
    // they are threaded through here rather than hand-special-cased to empty.
    const emptyDigestOutcome = await runAdminDigest(adminDigestDeps, {
      dryRun,
      previewSend: adminDigestPreview,
      candidates: stalledForDigest,
      siteUrl,
    });
    return jsonResponse(
      {
        ok: true,
        processed: 0,
        scanned_is_test: scanIsTest,
        welcome_enabled: welcomeEnabled,
        welcome_sent: welcomeSent,
        welcome_failed: welcomeFailed,
        checklist_complete_sent: checklistCompleteSent,
        checklist_complete_failed: checklistCompleteFailed,
        ...(dryRun ? { dry_run: true, would_send: [], checklist_complete_would_send: checklistCompleteWouldSend } : {}),
        ...buildDigestResponseFields(emptyDigestOutcome, dryRun, adminDigestPreview),
        ...(adminDigestPreviewIgnored ? { admin_digest_preview_ignored: true } : {}),
        results: [],
        checklist_complete_results: checklistCompleteResults,
      },
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

  // Real (non-self-generated) activity per user, and the already-sent nudge
  // stages per claim. gh-1580: both reductions live in ./select-stage.ts so
  // the acceptance test on this issue can exercise them without a database;
  // this call is the only implementation, not a copy of one.
  const reduced = reduceActivityRows(
    (activity || []) as ActivityLogRow[],
    NUDGE_EVENT_TYPE,
    OPTOUT_EVENT_TYPE,
  );
  const results: ScanResult[] = [];
  // gh-1933 review fix round 2 — EVERY screened claim that reaches a
  // resolved email, carrying whichever stage selectStage() picked
  // ('2h' or '48h'), regardless of whether the homeowner email actually
  // sends (previewed under dry run, sent, or already_sent). Unfiltered on
  // purpose: the '48h'-only digest filter used to live here as a call-site
  // `if`, which a mutant could silently defeat (index.ts has no tests of
  // its own). It now lives inside the tested executor —
  // selectDigestCandidates in ./admin-digest-executor.ts, called first
  // thing by runAdminDigest — so this array is deliberately the raw,
  // unfiltered input to that function. (Declared earlier now, alongside
  // gh-1570 Part 2's checklist-complete-stage block, so both feed the same
  // array — see the comment there.)

  for (const claim of claims as ClaimRow[]) {
    // gh-1580: the whole screen — status, opt-out, hover_orders, real
    // activity since signup, then stage selection — in ./select-stage.ts's
    // screenClaim(), in this exact order (the opt-out gate must run before
    // any stage selection or stamp). Extracted so the discriminating half of
    // this issue's acceptance test ("add one activity_log row, invoke again,
    // assert ZERO further nudges") is a unit test rather than a live seed.
    const decision = screenClaim(claim, {
      optedOutClaimIds,
      claimIdsWithHoverOrder,
      reduced,
      now,
    });
    if (decision.skipped_reason) {
      results.push({ claim_id: claim.id, stages_sent: [], skipped_reason: decision.skipped_reason });
      continue;
    }
    const stage = decision.stage;
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

    // gh-1933 review fix round 2 — push EVERY screened claim (with its
    // stage) unconditionally, with NO filter here. The '48h'-only filter
    // used to be `if (isDigestCandidate(stage))` at this exact call site,
    // and a call-site mutant (`if (true)`) could silently defeat it with
    // the full suite green, because index.ts itself has no tests. The
    // filter now lives INSIDE the tested executor — selectDigestCandidates,
    // called first thing by runAdminDigest in ./admin-digest-executor.ts —
    // so every branch it reaches has already been proven to only ever see
    // '48h' candidates. Reusing the screening, not duplicating it (issue
    // body): this is still the same screenClaim()/selectStage() result,
    // just handed over unfiltered instead of pre-filtered.
    stalledForDigest.push({
      claimId: claim.id,
      userId: claim.user_id,
      email: homeownerEmail,
      createdAtIso: claim.created_at,
      stage,
    });

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
    const previewedStages: NudgeStage[] = [];
    const skippedAlreadySentStages: NudgeStage[] = [];
    for (const stage of stagesToSend) {
      // gh-1859 review fix: the stamp/send/preview decision moved to
      // ./deliver-stage.ts so its three safety properties are testable with
      // fake dependencies instead of resting on the position of one `continue`
      // in this loop. Production behaviour is unchanged.
      const outcome = await deliverStage(
        {
          dryRun,
          mailgunConfigured: Boolean(mailgunApiKey),
          buildEmail: buildEmailContent,
          insertActivityLog: async (row) => {
            const { error } = await supabase.from("activity_log").insert(row);
            return { error: error ?? null };
          },
          sendEmail: (to, name, mUrl, cUrl, oUrl) =>
            sendMailgunEmail(mailgunApiKey as string, to, name, mUrl, cUrl, oUrl),
          // gh-2069: the durable per-send record — same `notifications` table
          // the admin digest already writes to, via the same insert path.
          insertNotification: async (row) => {
            const { error } = await supabase.from("notifications").insert(row);
            return { error: error?.message ?? null };
          },
          log: (level, message) => console[level](`[${FUNCTION_NAME}] ${message}`),
        },
        {
          claimId: claim.id,
          userId: claim.user_id,
          stage,
          homeownerEmail,
          homeownerName,
          measurementsUrl,
          colorUrl,
          optOutUrl,
        },
      );

      if (outcome.kind === "previewed") {
        wouldSend.push(outcome.preview);
        previewedStages.push(stage);
      } else if (outcome.kind === "sent") {
        sentStages.push(stage);
      } else if (outcome.kind === "already_sent") {
        skippedAlreadySentStages.push(stage);
      }
      // stamp_failed / send_failed are logged inside deliverStage and counted
      // as neither sent nor previewed — unchanged from the prior behaviour.
    }

    results.push({
      claim_id: claim.id,
      stages_sent: sentStages,
      ...(previewedStages.length > 0 ? { stages_previewed: previewedStages } : {}),
      ...(skippedAlreadySentStages.length > 0 ? { stages_skipped_already_sent: skippedAlreadySentStages } : {}),
    });
  }

  // ── gh-1933: admin stalled-homeowner digest ───────────────────────────────
  // ONE email, listing every '48h'-stage claim this run found. Production
  // behaviour is unchanged from before this review fix (gh-1933 review fix
  // D1): the decision of what a dry run / real run / preview run does with
  // `stalledForDigest` now lives in ./admin-digest-executor.ts's
  // runAdminDigest, tested independently of this handler — see that file
  // and admin-digest-executor.test.ts for the properties this rests on.
  const digestOutcome = await runAdminDigest(adminDigestDeps, {
    dryRun,
    previewSend: adminDigestPreview,
    candidates: stalledForDigest,
    siteUrl,
  });

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
      // gh-2069 (e): homeowner_welcome hook stats for this tick.
      // welcome_enabled reflects platform_settings.homeowner_welcome_enabled
      // as read this run — false (including "row absent") on every run until
      // Dustin flips it, per the PR's SQL note.
      welcome_enabled: welcomeEnabled,
      welcome_sent: welcomeSent,
      welcome_failed: welcomeFailed,
      // gh-1570 Part 2: checklist_complete_not_submitted stage stats for
      // this tick — populated by the block that runs ahead of the main
      // '2h'/'48h' scan (see its header comment).
      checklist_complete_sent: checklistCompleteSent,
      checklist_complete_failed: checklistCompleteFailed,
      ...buildDigestResponseFields(digestOutcome, dryRun, adminDigestPreview),
      ...(adminDigestPreviewIgnored ? { admin_digest_preview_ignored: true } : {}),
      // gh-1570: on a dry run `processed` is 0 by construction (nothing is
      // stamped), and `would_send` carries what a real run would have done.
      ...(dryRun
        ? {
          dry_run: true,
          previewed: wouldSend.length,
          // No recipient addresses: see PreviewRow in ./deliver-stage.ts.
          would_send: wouldSend,
          checklist_complete_would_send: checklistCompleteWouldSend,
        }
        : {}),
      results,
      checklist_complete_results: checklistCompleteResults,
    },
    200,
    corsHeaders,
  );
});
