/**
 * OtterQuote Edge Function: watch-template-mapping
 *
 * gh-1313 closes-on (a) — the `manual_mapping_pending` watcher.
 *
 * WHY: validate-contract-template sets contractor_templates.status to
 * `manual_mapping_pending` when a contractor's PDF is missing required D-199
 * markers (index.ts:666) and then does nothing else — no activity_log row,
 * no notify, no platform_alerts_log row (grep confirmed on the 2026-09-04
 * RUN 22 read). The row is visible only to someone who opens
 * admin-template-review.html. In production one such row has sat since
 * 2026-08-21 with nothing watching it — the same shape as gh-1570, where a
 * real claim sat 43 days because no code looked at it.
 *
 * WHAT: runs on pg_cron (recommended: hourly, sql/v114-watch-template-mapping-
 * cron.sql) with an empty POST body. Reads every contractor_templates row in
 * a watched status (manual_mapping_pending / pending_validation /
 * submitted_for_admin_review — see ./select-stale.ts for what each means),
 * keeps those older than TEMPLATE_WATCH_THRESHOLD_HOURS (default 24), and:
 *
 *   1. writes ONE platform_alerts_log row per stale template per rolling 24h
 *      (alert_type 'template_stuck', function_name 'watch-template-mapping',
 *      message beginning `template=<uuid>` — the dedup key), exactly the way
 *      platform-health-check's fireAlert dedups by (function_name, alert_type)
 *      inside a window, narrowed here to the template;
 *   2. returns the full stale list as JSON on every call, deduplicated or
 *      not, so the response itself is the proof the watcher sees the row;
 *   3. OPTIONALLY emails the admin a plain-text digest of the templates that
 *      got a NEW alert row this run — gated by TEMPLATE_WATCH_EMAIL_ENABLED
 *      === "true", which is NOT set anywhere today. Default OFF. With the
 *      flag off this function never calls Mailgun. Recipient + transport are
 *      the platform-health-check pattern (ALERT_EMAIL, alerts@MAILGUN_DOMAIN).
 *
 * Body options (all optional):
 *   { health_check: true }      -> 200 {status:"ok"} before the auth gate (probe pattern)
 *   { dry_run: true }           -> select + dedup evaluation only; writes nothing (not even cron_health), emails nothing
 *   { threshold_hours: number } -> override TEMPLATE_WATCH_THRESHOLD_HOURS for this call (>= 0)
 *
 * Auth: same three-way gate as send-homeowner-next-steps / send-home-profile-
 * prompt — X-Cron-Secret header, or a service-role Bearer, or permissive when
 * CRON_SECRET is unset. verify_jwt = false in supabase/config.toml so pg_cron
 * can reach it with the vault-backed service-role Bearer.
 *
 * Writes: platform_alerts_log (service_role INSERT policy, sql/v52b) and
 * cron_health via record_cron_health (self-reporting, like counter-sig-
 * reminders). Nothing on contractor_templates — this function never changes
 * a template's state; it only tells someone the state has not changed.
 *
 * is_test rows are NOT excluded: the row this watcher exists to catch today
 * belongs to an is_test contractor, and the message marks them "[is_test]".
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET,
 *   TEMPLATE_WATCH_THRESHOLD_HOURS (default 24),
 *   TEMPLATE_WATCH_EMAIL_ENABLED ("true" to send; anything else = off),
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN (only read when the email flag is on)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  ALERT_DEDUP_MS,
  ALERT_TYPE,
  buildAlertMessage,
  DEFAULT_THRESHOLD_HOURS,
  partitionForAlerting,
  type PriorAlert,
  selectStale,
  type StaleTemplate,
  type TemplateRowInput,
  WATCHED_STATUSES,
} from "./select-stale.ts";

const FUNCTION_NAME = "watch-template-mapping";
const BATCH_LIMIT = 500;
// Inlined, not imported, from _shared/admin.ts / platform-health-check — the
// EF body-deploy path does not resolve _shared/ imports (see _shared/admin.ts
// header). Same single recipient platform-health-check alerts go to.
const ALERT_EMAIL = "dustinstohler1@gmail.com";

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

// ─── Email (flag-gated, plain text, platform-health-check transport) ────────

function buildDigest(newlyAlerted: StaleTemplate[], thresholdHours: number): { subject: string; text: string } {
  const n = newlyAlerted.length;
  const subject = `OtterQuote — ${n} contract template${n === 1 ? "" : "s"} waiting on mapping/review > ${thresholdHours}h`;
  const lines = [
    `${n} contractor template${n === 1 ? " has" : "s have"} sat in a pending state longer than ${thresholdHours} hours ` +
      `and nobody has acted (gh-1313 watcher).`,
    "",
    ...newlyAlerted.map((t) =>
      `- ${t.company_name ?? "(unknown contractor)"}${t.is_test ? " [is_test]" : ""} — ${t.trade} × ${t.funding_type} — ` +
      `${t.status} for ${t.age_hours}h (since ${t.since}) — template ${t.template_id}`
    ),
    "",
    "Review: https://otterquote.com/admin-template-review.html",
    "",
    `Sent by ${FUNCTION_NAME}. One email per template per 24h.`,
  ];
  return { subject, text: lines.join("\n") };
}

async function sendMailgunAlert(
  apiKey: string,
  domain: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const formData = new FormData();
    formData.append("from", `OtterQuote Monitoring <alerts@${domain}>`);
    formData.append("to", ALERT_EMAIL);
    formData.append("subject", subject);
    formData.append("text", body);
    const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
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

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = await req.clone().json().catch(() => ({}));
  } catch (_) {
    body = {};
  }

  // Health-check bypass — runs BEFORE the CRON_SECRET gate (probe pattern).
  if (body?.health_check === true) {
    return jsonResponse({ status: "ok", function: FUNCTION_NAME }, 200, corsHeaders);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cronSecret = Deno.env.get("CRON_SECRET");
  const emailEnabled = Deno.env.get("TEMPLATE_WATCH_EMAIL_ENABLED") === "true";
  const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY");
  const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, corsHeaders);
  }

  // ── Authorization (same three-way gate as send-homeowner-next-steps) ─────
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

  // ── Threshold: body override > env > default ─────────────────────────────
  let thresholdHours = DEFAULT_THRESHOLD_HOURS;
  const envThreshold = Number(Deno.env.get("TEMPLATE_WATCH_THRESHOLD_HOURS"));
  if (Number.isFinite(envThreshold) && envThreshold >= 0) thresholdHours = envThreshold;
  if (typeof body?.threshold_hours === "number" && Number.isFinite(body.threshold_hours) && body.threshold_hours >= 0) {
    thresholdHours = body.threshold_hours;
  }
  const dryRun = body?.dry_run === true;

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // ── Candidate scan: every row in a watched status ────────────────────────
  const { data: rows, error: scanErr } = await supabase
    .from("contractor_templates")
    .select("id, contractor_id, status, trade, funding_type, created_at, updated_at, contractors:contractor_id(company_name, email, is_test)")
    .in("status", [...WATCHED_STATUSES])
    .order("updated_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (scanErr) {
    console.error(`[${FUNCTION_NAME}] contractor_templates scan failed:`, scanErr.message);
    if (!dryRun) await recordHealth(supabase, "error", `scan failed: ${scanErr.message}`);
    return jsonResponse({ ok: false, error: "Candidate scan failed" }, 500, corsHeaders);
  }

  const stale = selectStale((rows || []) as unknown as TemplateRowInput[], now, thresholdHours);

  // ── Prior alerts inside the dedup window (this function's rows only) ─────
  const cutoffIso = new Date(now - ALERT_DEDUP_MS).toISOString();
  const { data: prior, error: priorErr } = await supabase
    .from("platform_alerts_log")
    .select("message, sent_at")
    .eq("function_name", FUNCTION_NAME)
    .eq("alert_type", ALERT_TYPE)
    .gte("sent_at", cutoffIso);

  if (priorErr) {
    // Fail closed on dedup: if we cannot read prior alerts we must not write
    // new ones, or a flapping read would spam one row per tick.
    console.error(`[${FUNCTION_NAME}] platform_alerts_log read failed:`, priorErr.message);
    if (!dryRun) await recordHealth(supabase, "error", `platform_alerts_log read failed: ${priorErr.message}`);
    return jsonResponse({ ok: false, error: "Prior-alert read failed", stale }, 500, corsHeaders);
  }

  const { toAlert, deduplicated } = partitionForAlerting(stale, (prior || []) as PriorAlert[], now);

  // ── Write one alert row per newly-stale template ─────────────────────────
  const logged: string[] = [];
  const logFailed: { template_id: string; error: string }[] = [];
  if (!dryRun) {
    for (const t of toAlert) {
      const { error: insErr } = await supabase.from("platform_alerts_log").insert({
        alert_type: ALERT_TYPE,
        function_name: FUNCTION_NAME,
        message: buildAlertMessage(t, thresholdHours),
        sent_at: nowIso,
      });
      if (insErr) {
        console.error(`[${FUNCTION_NAME}] platform_alerts_log insert failed for template ${t.template_id}:`, insErr.message);
        logFailed.push({ template_id: t.template_id, error: insErr.message });
        continue;
      }
      logged.push(t.template_id);
    }
  }

  // ── Optional admin email — OFF unless TEMPLATE_WATCH_EMAIL_ENABLED=true ──
  let email: "disabled" | "dry_run" | "nothing_new" | "sent" | "failed" | "not_configured" = "disabled";
  let emailError: string | undefined;
  if (emailEnabled) {
    const newlyAlerted = toAlert.filter((t) => logged.includes(t.template_id));
    if (dryRun) {
      email = "dry_run";
    } else if (newlyAlerted.length === 0) {
      email = "nothing_new";
    } else if (!mailgunApiKey || !mailgunDomain) {
      email = "not_configured";
      console.warn(`[${FUNCTION_NAME}] TEMPLATE_WATCH_EMAIL_ENABLED=true but MAILGUN_API_KEY/MAILGUN_DOMAIN unset — no email sent`);
    } else {
      const { subject, text } = buildDigest(newlyAlerted, thresholdHours);
      const r = await sendMailgunAlert(mailgunApiKey, mailgunDomain, subject, text);
      email = r.ok ? "sent" : "failed";
      emailError = r.error;
      if (!r.ok) console.error(`[${FUNCTION_NAME}] Mailgun send failed:`, r.error);
    }
  }

  // dry_run writes nothing at all — not even the cron_health heartbeat.
  if (!dryRun) await recordHealth(supabase, "success", null);

  const result = {
    ok: true,
    function: FUNCTION_NAME,
    checked_at: nowIso,
    threshold_hours: thresholdHours,
    dry_run: dryRun,
    watched_statuses: [...WATCHED_STATUSES],
    candidates: (rows || []).length,
    stale_count: stale.length,
    stale: stale.map((t) => ({
      ...t,
      alert: dryRun
        ? (deduplicated.some((d) => d.template_id === t.template_id) ? "would_dedup" : "would_log")
        : logged.includes(t.template_id)
        ? "logged"
        : deduplicated.some((d) => d.template_id === t.template_id)
        ? "deduplicated"
        : "log_failed",
    })),
    alerts_logged: logged.length,
    alerts_deduplicated: deduplicated.length,
    alerts_failed: logFailed,
    email,
    ...(emailError ? { email_error: emailError } : {}),
  };

  console.log(`[${FUNCTION_NAME}] candidates=${result.candidates} stale=${result.stale_count} logged=${logged.length} dedup=${deduplicated.length} email=${email}${dryRun ? " (dry run)" : ""}`);
  return jsonResponse(result, 200, corsHeaders);
});

async function recordHealth(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  status: "success" | "error",
  error: string | null,
): Promise<void> {
  // Self-reporting cron_health row (same as counter-sig-reminders /
  // process-coi-reminders). Non-fatal: a health-write failure must not turn
  // a successful watch into a 500.
  try {
    await supabase.rpc("record_cron_health", {
      p_job_name: FUNCTION_NAME,
      p_status: status,
      p_error: error,
    });
  } catch (healthErr) {
    console.warn(`[${FUNCTION_NAME}] record_cron_health write failed (non-fatal):`, healthErr);
  }
}
