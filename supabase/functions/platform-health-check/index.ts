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
 * 4. Auto-acknowledge resolved 1st-strike entries (added May 6, 2026 — ClickUp 86e18dv22):
 *    When an Edge Function confirms healthy (status = 200 OK), automatically
 *    acknowledge any open ef_failure_pending entries for that function.
 *    This prevents transient failures from accumulating noise in the alerts table.
 *    Important: ef_failure_alert (2nd-strike) entries are NOT auto-acknowledged.
 *
 * 5. Public-path probe hardening (added Aug 2026 — GitHub #551, per R-097 Bridge
 *    ruling posted on the issue 2026-08-10):
 *    - Phase 3 public-path probes now retry once (~5s delay) in-run before
 *      recording a failure, so a single transient timeout/error from one
 *      vantage point does not get recorded as a failed tick at all.
 *    - Phase 2 (cron staleness / error-status) now applies the same 2-strikes
 *      pending-gate pattern used by Phase 1 EF pings (mirrored, not shared
 *      code — see hasPendingCronFailure/logPendingCronFailure/
 *      autoAckPendingCronFailures): a single stale/error tick is suppressed,
 *      two consecutive ticks (~15 min apart) page. Per the Bridge ruling, the
 *      2-strikes gate is intentionally NOT applied to the Phase 3 probes
 *      themselves (an availability probe should not delay a real outage
 *      signal by a full cron cycle) — Phase 3 uses the in-run retry instead.
 *    - Execution order changed to Phase 1 -> Phase 3 -> Phase 2 so Phase 2's
 *      staleness read sees the freshly-written Phase 3 result for the same
 *      tick, instead of re-alerting on rows Phase 3 is about to flip back to
 *      success seconds later.
 *    - Alert email bodies now include both UTC and US/Eastern timestamps
 *      (a UTC-only timestamp previously caused a human to misread a 9pm ET
 *      event as "~1am ET" — see #527).
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
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
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
// ARCHITECTURE NOTE — "self-reporting" vs "externally-written" cron_health rows:
//   Jobs listed here that are NOT in EDGE_FUNCTIONS_TO_PING and NOT in PUBLIC_PATHS
//   must call supabase.rpc("record_cron_health", ...) themselves at the end of every
//   successful run. If that call is dropped (e.g., in a deploy), this monitor will
//   fire false stale-cron alerts within the threshold window.
//   Self-reporting jobs: process-coi-reminders, process-bid-expirations,
//                        process-payout-reminders, check-siding-design-completion
//   (86e194gtz — 2026-05-07: process-coi-reminders writer was missing; fixed)
const CRON_STALENESS_THRESHOLDS: Record<string, number> = {
  "process-bid-expirations":       2 * 60 * 60 * 1000,   // 2 hours
  "check-siding-design-completion": 45 * 60 * 1000,       // 45 minutes
  "process-coi-reminders":         25 * 60 * 60 * 1000,  // 25 hours
  "process-payout-reminders":      25 * 60 * 60 * 1000,  // 25 hours
  "public-path-home":              30 * 60 * 1000,        // 30 minutes
  "public-path-get-started":       30 * 60 * 1000,        // 30 minutes
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
 * Format a timestamp as both UTC and US/Eastern for alert email bodies (#551).
 * A UTC-only timestamp previously caused a human to misread a 9pm ET event
 * ("2026-07-12T01:00:00Z") as "~1am ET" instead of correctly matching it to
 * 9:00 PM ET the prior evening. Always show both so no conversion is required.
 */
function formatDualTimestamp(date: Date): string {
  const utc = date.toISOString();
  let et: string;
  try {
    et = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(date);
  } catch (err) {
    console.warn("[platform-health-check] ET timestamp formatting failed:", err);
    et = "unavailable";
  }
  return `${utc} UTC (${et})`;
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

/**
 * Auto-acknowledge open ef_failure_pending entries for a function (May 6, 2026 — ClickUp 86e18dv22).
 * Called when a function confirms healthy (200 OK). This prevents transient 1st-strike
 * entries from accumulating noise in the alerts table.
 *
 * IMPORTANT: Only ef_failure_pending (1st-strike) is auto-acknowledged.
 * ef_failure_alert (2nd-strike) entries are NOT touched and must remain visible
 * until manually acknowledged by an operator.
 */
async function autoAckPendingFailures(
  supabase: ReturnType<typeof createClient>,
  functionName: string,
): Promise<void> {
  try {
    const { error: ackError } = await supabase
      .from("platform_alerts_log")
      .update({ acknowledged_at: new Date().toISOString() })
      .eq("function_name", functionName)
      .eq("alert_type", "ef_failure_pending")
      .is("acknowledged_at", null);
    
    if (ackError) {
      console.error(`[auto-ack] error for ${functionName}:`, ackError.message);
    } else {
      console.log(`[auto-ack] acknowledged pending 1st-strike entries for ${functionName}`);
    }
  } catch (err) {
    console.error(`[auto-ack] exception for ${functionName}:`, err);
  }
}

/**
 * 2-strikes gate for cron-staleness / cron-error checks (added Aug 2026 —
 * GitHub #551, per R-097 Bridge ruling posted 2026-08-10 on the issue).
 * Mirrors hasPendingFailure/logPendingFailure/autoAckPendingFailures above
 * (Phase 1's ef_failure_pending pattern), replicated rather than shared so
 * a bug in one phase's gate can't affect the other. Uses its own alert_type
 * ("cron_failure_pending") and the same TWO_STRIKES_WINDOW_MS window.
 *
 * IMPORTANT: this gate applies to Phase 2 (staleness/error-status checks on
 * cron_health rows) ONLY. Per the Bridge ruling, it must NOT be applied to
 * Phase 3's public-path availability probes themselves — an availability
 * probe delaying a real outage signal by a full cron cycle to avoid a false
 * page is the wrong trade; Phase 3 uses an in-run retry instead (see
 * probePublicPath below). The 2-strikes trade is correct for staleness
 * checks on a fixed cron cadence, where a single missed tick is far more
 * likely to be noise than an outage.
 */
async function hasPendingCronFailure(
  supabase: ReturnType<typeof createClient>,
  jobName: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - TWO_STRIKES_WINDOW_MS).toISOString();
  const { data } = await supabase
    .from("platform_alerts_log")
    .select("id")
    .eq("function_name", jobName)
    .eq("alert_type", "cron_failure_pending")
    .gte("sent_at", cutoff)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function logPendingCronFailure(
  supabase: ReturnType<typeof createClient>,
  jobName: string,
  errorText: string,
): Promise<void> {
  try {
    await supabase.from("platform_alerts_log").insert({
      alert_type:    "cron_failure_pending",
      function_name: jobName,
      message:       `1st-strike cron failure suppressed (2-strikes gate): ${errorText}`,
      sent_at:       new Date().toISOString(),
    });
  } catch (err) {
    console.error("[platform-health-check] Failed to log pending cron failure:", err);
  }
}

async function autoAckPendingCronFailures(
  supabase: ReturnType<typeof createClient>,
  jobName: string,
): Promise<void> {
  try {
    const { error: ackError } = await supabase
      .from("platform_alerts_log")
      .update({ acknowledged_at: new Date().toISOString() })
      .eq("function_name", jobName)
      .eq("alert_type", "cron_failure_pending")
      .is("acknowledged_at", null);

    if (ackError) {
      console.error(`[auto-ack-cron] error for ${jobName}:`, ackError.message);
    } else {
      console.log(`[auto-ack-cron] acknowledged pending 1st-strike entries for ${jobName}`);
    }
  } catch (err) {
    console.error(`[auto-ack-cron] exception for ${jobName}:`, err);
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

    // If function is healthy, auto-acknowledge any pending 1st-strike entries
    // (May 6, 2026 — ClickUp 86e18dv22)
    if (result.status === "ok") {
      await autoAckPendingFailures(supabase, result.functionName);
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
          `Checked at: ${formatDualTimestamp(new Date())}`,
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

    // Immediate alert if last run errored — gated by 2-strikes (#551)
    if (lastStatus === "error") {
      results.push({ jobName, status: "error_status", lastRunAt, ageMs });

      const isSecondStrike = await hasPendingCronFailure(supabase, jobName);
      if (!isSecondStrike) {
        // 1st-strike: log pending row, suppress email. The next cron tick
        // (~15 min) will either find this pending row and escalate, or skip
        // because the job recovered.
        await logPendingCronFailure(supabase, jobName, lastError ?? "last run status = error");
        console.log(
          `[platform-health-check] 1st-strike cron error (suppressed) for ${jobName}: ${lastError ?? "unknown error"}`,
        );
        continue;
      }

      const subject = `OtterQuote Health Alert — cron job "${jobName}" last run failed (2 consecutive failures)`;
      const message = [
        `Cron Job: ${jobName}`,
        `Last Run: ${lastRunAt}`,
        `Status: ERROR`,
        lastError ? `Error: ${lastError}` : null,
        `Checked at: ${formatDualTimestamp(new Date())}`,
        "",
        "Two consecutive failed runs across two cron ticks (~15 min apart) — first failure was suppressed by the 2-strikes gate; this is the second.",
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

    // Alert if stale — gated by 2-strikes (#551)
    if (ageMs > thresholdMs) {
      // WRITER-GAP DIAGNOSTIC: if a self-reporting job (one not written by this function's
      // Phase 1 or Phase 3) is stale, the most likely cause is that the job's EF no longer
      // calls record_cron_health(). Check the job's EF for that call before investigating
      // the cron schedule itself. (86e194gtz — 2026-05-07)
      console.warn(
        `[platform-health-check] STALE: ${jobName} — age ${Math.round(ageMs / 60000)}min ` +
        `(threshold ${Math.round(thresholdMs / 60000)}min). ` +
        `If this is a self-reporting job, verify it calls record_cron_health() on success.`
      );
      results.push({ jobName, status: "stale", lastRunAt, ageMs });

      const thresholdHuman = thresholdMs >= 3600000
        ? `${Math.round(thresholdMs / 3600000)} hours`
        : `${Math.round(thresholdMs / 60000)} minutes`;

      const isSecondStrike = await hasPendingCronFailure(supabase, jobName);
      if (!isSecondStrike) {
        await logPendingCronFailure(
          supabase, jobName,
          `stale — age ${Math.round(ageMs / 60000)}min (threshold ${thresholdHuman})`,
        );
        console.log(
          `[platform-health-check] 1st-strike stale (suppressed) for ${jobName}: age ${Math.round(ageMs / 60000)}min`,
        );
        continue;
      }

      const subject = `OtterQuote Health Alert — cron job "${jobName}" is stale (2 consecutive ticks)`;
      const message = [
        `Cron Job: ${jobName}`,
        `Last Run: ${lastRunAt ?? "never"}`,
        `Age: ${Math.round(ageMs / 60000)} minutes (threshold: ${thresholdHuman})`,
        `Checked at: ${formatDualTimestamp(new Date())}`,
        "",
        "This cron job has not run within its expected window across two consecutive checks (~15 min apart) — first miss was suppressed by the 2-strikes gate; this is the second.",
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

    // Recovered / healthy — auto-acknowledge any pending 1st-strike entries (#551)
    await autoAckPendingCronFailures(supabase, jobName);
    results.push({ jobName, status: "ok", lastRunAt, ageMs });
  }

  return { checked: Object.keys(CRON_STALENESS_THRESHOLDS).length, alertsFired, results };
}


// =============================================================================
// PHASE 3 — Public path availability probe
// =============================================================================

const PUBLIC_PATHS: Array<{ url: string; jobName: string; expectedBody: string }> = [
  {
    url:          "https://otterquote.com/",
    jobName:      "public-path-home",
    expectedBody: "Stop chasing contractors",
  },
  {
    url:          "https://otterquote.com/get-started.html",
    jobName:      "public-path-get-started",
    expectedBody: "Get Started",
  },
];

const PUBLIC_PATH_TIMEOUT_MS = 10000; // 10s — external fetch, more generous than internal EF ping

// In-run retry (added Aug 2026 — GitHub #551, per R-097 Bridge ruling 2026-08-10):
// a lone 10s timeout/error from one vantage point must not page. Rather than a
// cross-tick 2-strikes gate (which the Bridge ruling reserved for Phase 2
// staleness checks — an availability probe should not delay a real-outage
// signal by a full ~15min cron cycle), Phase 3 retries once in-run after a
// short delay before recording a failure at all.
const PUBLIC_PATH_RETRY_DELAY_MS = 5000; // 5s

interface PublicPathResult {
  path:    string;
  jobName: string;
  status:  "ok" | "error" | "timeout";
  error?:  string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptPublicPathFetch(
  url: string,
  jobName: string,
  expectedBody: string,
): Promise<PublicPathResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLIC_PATH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (res.status !== 200) {
      return { path: url, jobName, status: "error", error: `HTTP ${res.status}` };
    }

    const body = await res.text();
    if (!body.includes(expectedBody)) {
      return {
        path:    url,
        jobName,
        status:  "error",
        error:   `Body missing expected string: "${expectedBody}"`,
      };
    }

    return { path: url, jobName, status: "ok" };
  } catch (err: unknown) {
    clearTimeout(timer);
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    return {
      path:    url,
      jobName,
      status:  isTimeout ? "timeout" : "error",
      error:   isTimeout ? "Timeout after 10s" : String(err),
    };
  }
}

/**
 * Probe a public path, retrying once (after a short delay) before recording
 * a failure. This is the in-run alternative to a 2-strikes gate for Phase 3
 * (#551) — a single transient blip from this vantage point (e.g. the
 * 2026-07-12 #527 incident, where BetterStack's independent checks and the
 * probes immediately before/after this one all stayed green) is absorbed
 * here instead of firing an alert or even being recorded as an error tick.
 */
async function probePublicPath(
  url: string,
  jobName: string,
  expectedBody: string,
): Promise<PublicPathResult> {
  const first = await attemptPublicPathFetch(url, jobName, expectedBody);
  if (first.status === "ok") {
    return first;
  }

  console.log(
    `[platform-health-check] ${jobName} failed first attempt (${first.error ?? first.status}); ` +
    `retrying once after ${PUBLIC_PATH_RETRY_DELAY_MS}ms before recording a failure.`,
  );
  await sleep(PUBLIC_PATH_RETRY_DELAY_MS);
  return attemptPublicPathFetch(url, jobName, expectedBody);
}

async function runPublicPathProbes(
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
): Promise<{ probed: number; alertsFired: number; results: PublicPathResult[] }> {
  const results = await Promise.all(
    PUBLIC_PATHS.map(({ url, jobName, expectedBody }) =>
      probePublicPath(url, jobName, expectedBody),
    ),
  );

  let alertsFired = 0;

  for (const result of results) {
    // Write to cron_health — Phase 2 staleness check will also cover these going forward
    try {
      await supabase.rpc("record_cron_health", {
        p_job_name: result.jobName,
        p_status:   result.status === "ok" ? "success" : "error",
        p_error:    result.error ?? null,
      });
    } catch (err) {
      console.warn(`[platform-health-check] cron_health write failed for ${result.jobName}:`, err);
    }

    if (result.status !== "ok") {
      const subject = `OtterQuote Health Alert — public path unavailable: ${result.path}`;
      const message = [
        `Public Path: ${result.path}`,
        `Job: ${result.jobName}`,
        `Status: ${result.status}`,
        result.error ? `Error: ${result.error}` : null,
        `Checked at: ${formatDualTimestamp(new Date())}`,
        "",
        "This failure survived one in-run retry (~5s later) before being recorded.",
        "The OtterQuote public site may be unreachable or serving incorrect content.",
        "This is an automated alert from OtterQuote platform monitoring.",
        "Resolve this alert at: https://otterquote.com/admin-contractors.html",
      ].filter(Boolean).join("\n");

      const { alerted } = await fireAlert(
        supabase, mailgunApiKey, mailgunDomain,
        "public_path_failure", result.jobName, subject, message,
      );
      if (alerted) alertsFired++;
    }
  }

  return { probed: PUBLIC_PATHS.length, alertsFired, results };
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

  // ── Phase 3: Public path probes ─────────────────────────────────────────────
  // Runs BEFORE Phase 2 (#551): Phase 2's staleness/error-status check reads
  // cron_health, which Phase 3 also writes for the public-path-* job names.
  // Running Phase 3 first means Phase 2 sees this tick's fresh result instead
  // of re-alerting on a stale/error row that Phase 3 is about to flip back to
  // success seconds later (the root cause of #527 reading as a "15-minute
  // outage" when it was a single failed probe cycle).
  const phase3 = await runPublicPathProbes(supabase, mailgunApiKey, mailgunDomain);

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
    probedPaths:        phase3.probed,
    pathAlertsCount:    phase3.alertsFired,
    pathResults:        phase3.results,
    totalAlerts:        phase1.alertsFired + phase2.alertsFired + phase3.alertsFired,
    elapsedMs:          elapsed,
    ranAt:              new Date().toISOString(),
  };

  console.log("[platform-health-check] Run complete:", JSON.stringify(result));

  return jsonResponse(result, 200, corsHeaders);
});
