/**
 * OtterQuote Edge Function: platform-health-check
 *
 * Dual-purpose platform monitoring function (Thread 2C, ClickUp 86e112rak):
 *
 * 1. Edge Function silent failure detection
 *    Pings each critical Edge Function with { health_check: true }.
 *    All target functions return { status: 'ok' } immediately on this payload.
 *    Records each result in cron_health (ef-{function-name} keys).
 *    Alerts via Mailgun if any function returns non-200 or times out (>5s).
 *
 * 2. Cron job staleness detection
 *    Reads all rows from cron_health and checks last_run_at against
 *    per-job thresholds. Alerts if stale or if last_run_status = 'error'.
 *
 * 3. Alert deduplication
 *    Skips sending a Mailgun alert if an unacknowledged platform_alerts_log
 *    row for the same function_name was inserted in the last 15 minutes.
 *
 * Scheduled: every 15 minutes via pg_cron (schedule: "* /15 * * * *")
 * Auth: no JWT required — invoked by pg_cron service-role bearer.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// =============================================================================
// CONSTANTS
// =============================================================================

const ALERT_EMAIL   = "dustinstohler1@gmail.com";
const PING_TIMEOUT_MS = 5000;

// CORS: origin-allowlisted per standard OtterQuote pattern
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
];

// Edge Functions to health-ping (order matters for reporting)
const EDGE_FUNCTIONS_TO_PING: string[] = [
  "notify-contractors",
  "create-payment-intent",
  "process-dunning",
  "send-support-email",
  "admin-contractor-action",
  "send-incomplete-onboarding-reminders",
];

// Cron job staleness thresholds (milliseconds)
const CRON_STALENESS_THRESHOLDS: Record<string, number> = {
  "process-bid-expirations":       2 * 60 * 60 * 1000,   // 2 hours
  "check-siding-design-completion": 45 * 60 * 1000,       // 45 minutes
  "process-coi-reminders":         25 * 60 * 60 * 1000,  // 25 hours
  "process-payout-reminders":      25 * 60 * 60 * 1000,  // 25 hours
};

// Dedup window: don't re-alert for the same function within 15 minutes
const ALERT_DEDUP_MS = 15 * 60 * 1000;

// =============================================================================
// HELPERS
// =============================================================================

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function jsonResponse(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Send a plain-text Mailgun alert email.
 */
async function sendMailgunAlert(
  apiKey: string,
  domain: string,
  subject: string,
  body: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const auth = btoa(`api:${apiKey}`);
    const formData = new FormData();
    formData.append("from", `OtterQuote Monitoring <alerts@${domain}>`);
    formData.append("to", ALERT_EMAIL);
    formData.append("subject", subject);
    formData.append("text", body);

    const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      return { success: false, error: errText };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Check whether an unacknowledged alert for this function was logged
 * in the last ALERT_DEDUP_MS milliseconds. Returns true if we should skip.
 */
async function isDuplicate(
  supabase: ReturnType<typeof createClient>,
  functionName: string,
  alertType: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - ALERT_DEDUP_MS).toISOString();
  const { data } = await supabase
    .from("platform_alerts_log")
    .select("id")
    .eq("function_name", functionName)
    .eq("alert_type", alertType)
    .is("acknowledged_at", null)
    .gte("sent_at", cutoff)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/**
 * Send an alert: Mailgun email + log to platform_alerts_log.
 * Skips if duplicate within dedup window.
 */
async function fireAlert(
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  alertType: string,
  functionName: string,
  subject: string,
  message: string,
): Promise<{ alerted: boolean; deduplicated: boolean }> {
  // Dedup check
  const dup = await isDuplicate(supabase, functionName, alertType);
  if (dup) {
    console.log(`[platform-health-check] Dedup: skipping alert for ${functionName} (${alertType})`);
    return { alerted: false, deduplicated: true };
  }

  // Send email
  const emailResult = await sendMailgunAlert(mailgunApiKey, mailgunDomain, subject, message);
  if (!emailResult.success) {
    console.error(`[platform-health-check] Mailgun failed for ${functionName}:`, emailResult.error);
  }

  // Always log to platform_alerts_log regardless of email success
  // (so admin panel reflects the issue even if Mailgun is down)
  try {
    await supabase.from("platform_alerts_log").insert({
      alert_type:    alertType,
      function_name: functionName,
      message:       message,
      sent_at:       new Date().toISOString(),
    });
  } catch (logErr) {
    console.error("[platform-health-check] Failed to log alert to DB:", logErr);
  }

  return { alerted: true, deduplicated: false };
}

/**
 * 2-strikes gate (added Apr 30, 2026 — ClickUp 86e15mcmw):
 * Before sending a Mailgun alert for an Edge Function failure, check whether
 * a prior 'ef_failure_pending' row exists in platform_alerts_log within
 * TWO_STRIKES_WINDOW_MS. If yes, this is the 2nd consecutive failure across
 * two cron runs ~15 min apart — fire the real alert. If no, this is the 1st
 * failure — INSERT a pending placeholder and suppress the email so a single
 * transient timeout does not page Dustin.
 *
 * Window is 25 min — covers the next 15-min cron tick + jitter, but expires
 * before an unrelated 30-min-later failure can chain. Recovery is implicit:
 * when the function returns ok again, no row is inserted and the window
 * naturally expires. No cleanup needed.
 */
const TWO_STRIKES_WINDOW_MS = 25 * 60 * 1000;

async function hasPendingFailure(
  supabase: ReturnType<typeof createClient>,
  functionName: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - TWO_STRIKES_WINDOW_MS).toISOString();
  const { data } = await supabase
    .from("platform_alerts_log")
    .select("id")
    .eq("function_name", functionName)
    .eq("alert_type", "ef_failure_pending")
    .gte("sent_at", cutoff)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function logPendingFailure(
  supabase: ReturnType<typeof createClient>,
  functionName: string,
  errorText: string,
): Promise<void> {
  try {
    await supabase.from("platform_alerts_log").insert({
      alert_type:    "ef_failure_pending",
      function_name: functionName,
      message:       `1st-strike failure suppressed (2-strikes gate): ${errorText}`,
      sent_at:       new Date().toISOString(),
    });
  } catch (err) {
    console.error("[platform-health-check] Failed to log pending failure:", err);
  }
}

// =============================================================================
// PHASE 1 — Edge Function health pings
// =============================================================================

interface PingResult {
  functionName: string;
  status:       "ok" | "error" | "timeout";
  httpStatus?:  number;
  error?:       string;
}

async function pingEdgeFunction(
  supabaseUrl: string,
  serviceRoleKey: string,
  functionName: string,
): Promise<PingResult> {
  const url = `${supabaseUrl}/functions/v1/${functionName}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
      },
      body:   JSON.stringify({ health_check: true }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status === 200) {
      return { functionName, status: "ok", httpStatus: res.status };
    }
    return {
      functionName,
      status:     "error",
      httpStatus: res.status,
      error:      `HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    return {
      functionName,
      status: isTimeout ? "timeout" : "error",
      error:  isTimeout ? "Timeout after 5s" : String(err),
    };
  }
}

async function runEdgeFunctionPings(
  supabaseUrl: string,
  serviceRoleKey: string,
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
): Promise<{ pinged: number; alertsFired: number; results: PingResult[] }> {
  const results = await Promise.all(
    EDGE_FUNCTIONS_TO_PING.map((fn) => pingEdgeFunction(supabaseUrl, serviceRoleKey, fn)),
  );

  let alertsFired = 0;

  for (const result of results) {
    const cronKey = `ef-${result.functionName}`;

    // Record result in cron_health (reuses the existing monitoring table)
    try {
      await supabase.rpc("record_cron_health", {
        p_job_name: cronKey,
        p_status:   result.status === "ok" ? "success" : "error",
        p_error:    result.error ?? null,
      });
    } catch (err) {
      console.warn(`[platform-health-check] cron_health write failed for ${cronKey}:`, err);
    }

    // Fire alert if not ok — gated by 2-strikes (Apr 30, 2026, ClickUp 86e15mcmw)
    if (result.status !== "ok") {
      const errorText = result.error ?? `HTTP ${result.httpStatus ?? "?"}`;
      const isSecondStrike = await hasPendingFailure(supabase, result.functionName);

      if (!isSecondStrike) {
        // 1st-strike: log pending row, suppress email. The next cron tick
        // (~15 min) will either find this pending row and escalate, or skip
        // because the function recovered.
        await logPendingFailure(supabase, result.functionName, errorText);
        console.log(
          `[platform-health-check] 1st-strike (suppressed) for ${result.functionName}: ${errorText}`,
        );
      } else {
        // 2nd-strike: fire the real alert.
        const subject = `OtterQuote Health Alert — ${result.functionName} is not responding (2 consecutive failures)`;
        const message = [
          `Edge Function: ${result.functionName}`,
          `Status: ${result.status}`,
          result.httpStatus ? `HTTP Status: ${result.httpStatus}` : null,
          result.error ? `Error: ${result.error}` : null,
          `Checked at: ${new Date().toISOString()}`,
          "",
          "Two consecutive failures across two cron runs (~15 min apart) — first failure was suppressed by the 2-strikes gate; this is the second.",
          "",
          "This is an automated alert from OtterQuote platform monitoring.",
          "Resolve this alert at: https://otterquote.com/admin-contractors.html",
        ].filter(Boolean).join("\n");

        const { alerted } = await fireAlert(
          supabase, mailgunApiKey, mailgunDomain,
          "ef_silent_failure", result.functionName, subject, message,
        );
        if (alerted) alertsFired++;
      }
    }
  }

  return { pinged: results.length, alertsFired, results };
}

// =============================================================================
// PHASE 2 — Cron job staleness detection
// =============================================================================

interface StalenessResult {
  jobName:  string;
  status:   "ok" | "stale" | "error_status" | "missing";
  lastRunAt?: string;
  ageMs?:   number;
}

async function runStalenessCheck(
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
): Promise<{ checked: number; alertsFired: number; results: StalenessResult[] }> {
  // Fetch all cron_health rows (non-EF rows only — EF rows handled above)
  const { data: rows, error } = await supabase
    .from("cron_health")
    .select("job_name, last_run_at, last_run_status, last_error")
    .not("job_name", "like", "ef-%");

  if (error) {
    console.error("[platform-health-check] cron_health fetch error:", error);
    return { checked: 0, alertsFired: 0, results: [] };
  }

  const rowMap = new Map((rows ?? []).map((r: { job_name: string; last_run_at: string; last_run_status: string; last_error: string | null }) => [r.job_name, r]));
  const now    = Date.now();
  const results: StalenessResult[] = [];
  let alertsFired = 0;

  for (const [jobName, thresholdMs] of Object.entries(CRON_STALENESS_THRESHOLDS)) {
    const row = rowMap.get(jobName);

    // Job has never run (no row yet) — only alert if threshold has been long exceeded
    // (i.e., we allow 2× the threshold for brand-new jobs that may not have a first run yet)
    if (!row) {
      results.push({ jobName, status: "missing" });
      continue; // Not yet alarmed — missing row = job hasn't run once yet
    }

    const lastRunAt  = row.last_run_at;
    const lastStatus = row.last_run_status;
    const lastError  = row.last_error;
    const ageMs      = lastRunAt ? now - new Date(lastRunAt).getTime() : Infinity;

    // Immediate alert if last run errored
    if (lastStatus === "error") {
      results.push({ jobName, status: "error_status", lastRunAt, ageMs });

      const subject = `OtterQuote Health Alert — cron job "${jobName}" last run failed`;
      const message = [
        `Cron Job: ${jobName}`,
        `Last Run: ${lastRunAt}`,
        `Status: ERROR`,
        lastError ? `Error: ${lastError}` : null,
        `Checked at: ${new Date().toISOString()}`,
        "",
        "This is an automated alert from OtterQuote platform monitoring.",
        "Resolve this alert at: https://otterquote.com/admin-contractors.html",
      ].filter(Boolean).join("\n");

      const { alerted } = await fireAlert(
        supabase, mailgunApiKey, mailgunDomain,
        "cron_error", jobName, subject, message,
      );
      if (alerted) alertsFired++;
      continue;
    }

    // Alert if stale
    if (ageMs > thresholdMs) {
      results.push({ jobName, status: "stale", lastRunAt, ageMs });

      const thresholdHuman = thresholdMs >= 3600000
        ? `${Math.round(thresholdMs / 3600000)} hours`
        : `${Math.round(thresholdMs / 60000)} minutes`;

      const subject = `OtterQuote Health Alert — cron job "${jobName}" is stale`;
      const message = [
        `Cron Job: ${jobName}`,
        `Last Run: ${lastRunAt ?? "never"}`,
        `Age: ${Math.round(ageMs / 60000)} minutes (threshold: ${thresholdHuman})`,
        `Checked at: ${new Date().toISOString()}`,
        "",
        "This cron job has not run within its expected window.",
        "This is an automated alert from OtterQuote platform monitoring.",
        "Resolve this alert at: https://otterquote.com/admin-contractors.html",
      ].join("\n");

      const { alerted } = await fireAlert(
        supabase, mailgunApiKey, mailgunDomain,
        "cron_staleness", jobName, subject, message,
      );
      if (alerted) alertsFired++;
      continue;
    }

    results.push({ jobName, status: "ok", lastRunAt, ageMs });
  }

  return { checked: Object.keys(CRON_STALENESS_THRESHOLDS).length, alertsFired, results };
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ── Environment ────────────────────────────────────────────────────────────
  const supabaseUrl    = Deno.env.get("SUPABASE_URL")!;
  const serviceKey     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mailgunApiKey  = Deno.env.get("MAILGUN_API_KEY")!;
  const mailgunDomain  = Deno.env.get("MAILGUN_DOMAIN")!;

  if (!supabaseUrl || !serviceKey || !mailgunApiKey || !mailgunDomain) {
    console.error("[platform-health-check] Missing required env vars");
    return jsonResponse({ error: "Server configuration error" }, 500, corsHeaders);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const startedAt = Date.now();

  console.log("[platform-health-check] Starting run at", new Date().toISOString());

  // ── Phase 1: Edge Function health pings ────────────────────────────────────
  const phase1 = await runEdgeFunctionPings(
    supabaseUrl, serviceKey, supabase, mailgunApiKey, mailgunDomain,
  );

  // ── Phase 2: Cron job staleness ────────────────────────────────────────────
  const phase2 = await runStalenessCheck(supabase, mailgunApiKey, mailgunDomain);

  const elapsed = Date.now() - startedAt;

  const result = {
    pingedFunctions:    phase1.pinged,
    efAlertsCount:      phase1.alertsFired,
    efResults:          phase1.results.map((r) => ({ fn: r.functionName, status: r.status, err: r.error })),
    checkedCronJobs:    phase2.checked,
    cronAlertsCount:    phase2.alertsFired,
    cronResults:        phase2.results,
    totalAlerts:        phase1.alertsFired + phase2.alertsFired,
    elapsedMs:          elapsed,
    ranAt:              new Date().toISOString(),
  };

  console.log("[platform-health-check] Run complete:", JSON.stringify(result));

  return jsonResponse(result, 200, corsHeaders);
});
