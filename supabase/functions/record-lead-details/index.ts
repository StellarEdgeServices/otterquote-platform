/**
 * OtterQuote Edge Function: record-lead-details
 *
 * gh-2122 (Arm F, #2121 row 1.1). Called from js/router-variant-f.js on
 * /start?v=f, AFTER the `leads` row has been saved and set_lead_role() has run,
 * to store what Arm F collected that has no column on an anon insert -- the
 * funding answer, the property address, the Meta browser ids -- and the D-299
 * TCPA consent evidence, including the client IP and user agent this function
 * observes from the request.
 *
 * All request handling lives in ./handler.ts (no imports, unit-tested). This
 * file only wires it to the service-role client and the Deno server.
 *
 * Usage:
 *   POST /functions/v1/record-lead-details
 *   Body:     { lead_id, funding_type, property_address, fbc, fbp,
 *               consent: { key, given, text }, page_url, submitted_fields }
 *   Response: { ok: true }                                   200
 *             { ok: false, reason: "lead_out_of_scope" }     200  (not retryable)
 *             { ok: false, error }                           400 / 429 / 500
 *
 * verify_jwt is pinned to false in supabase/config.toml, like check-email-exists
 * (the other pre-auth, browser-called function): a visitor on /start has no
 * session, and supabase-js would send a stale expired session token, if one is in
 * the cookie, in place of the anon key -- which a verified-JWT gate would then
 * reject and silently drop a real lead's consent record. The protections instead
 * are: a per-IP rate limit (check_rate_limit + the rate_limit_config row shipped
 * in the same migration), a lead id that must already exist and be under 30
 * minutes old and not yet redeemed (enforced inside record_lead_details()), and
 * first-write-wins so nothing already stored can be overwritten.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { handleRequest } from "./handler.ts";

// Inlined copy of _shared/sentry.ts's reportToSentry (the EF body-deploy path
// does not resolve `_shared/` imports; keep in sync with that file by eye).
// No-ops to console.error until the SENTRY_DSN secret is set. Never throws.
async function reportToSentry(
  error: unknown,
  ctx: { fn: string; op?: string; extra?: Record<string, unknown> },
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[sentry:${ctx.fn}${ctx.op ? ":" + ctx.op : ""}]`, message, ctx.extra ?? "");
  const dsn = Deno.env.get("SENTRY_DSN");
  if (!dsn) return;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, "");
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const sentAt = new Date().toISOString();
    const event = {
      event_id: eventId, timestamp: sentAt, platform: "javascript", level: "error",
      logger: `edge.${ctx.fn}`,
      environment: Deno.env.get("SENTRY_ENVIRONMENT") || "production",
      tags: { fn: ctx.fn, ...(ctx.op ? { op: ctx.op } : {}) },
      extra: ctx.extra ?? {},
      exception: { values: [{ type: error instanceof Error ? error.name : "EdgeFunctionError", value: message }] },
    };
    const envelope =
      JSON.stringify({ event_id: eventId, sent_at: sentAt }) + "\n" +
      JSON.stringify({ type: "event" }) + "\n" + JSON.stringify(event) + "\n";
    await fetch(`${u.protocol}//${u.host}/api/${projectId}/envelope/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=otterquote-ef/1.0, sentry_key=${u.username}`,
      },
      body: envelope,
    });
  } catch (postErr) {
    console.error("[sentry] post failed (non-fatal):", postErr);
  }
}

const sb = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
);

serve((req: Request) =>
  handleRequest(req, {
    rpc: (name, args) => sb.rpc(name, args) as unknown as Promise<{ data: unknown; error: unknown }>,
    report: reportToSentry,
  })
);
