/**
 * owner-alert-sweep -- places a Twilio voice call to the owner when a real customer event happens (gh-3428, P23).
 *
 * Called every 30 seconds by pg_cron (gh3428-owner-alert-sweep, net.http_post with the service-role key from Vault). Per tick:
 *   1. rpc owner_alert_claim_batch(): enqueues new qualifying events into public.owner_alerts (unique on event_kind + source_id = the dedupe)
 *      and leases the ones due for a call. The event rules and every is_test check live in that SQL function.
 *   2. For each leased row, one Twilio Programmable Voice call from TWILIO_PHONE_NUMBER to OWNER_ALERT_PHONE; the spoken message is the event
 *      kind, the state and the claim id, repeated three times. No name, address, phone or e-mail is read, spoken, stored or logged.
 *   3. rpc owner_alert_mark(): called, or retryable (30 s x attempt), or failed_final after 3 attempts. A failure is reported to Sentry.
 *
 * Test call: POST {"test_call": true} with the service-role key places ONE Twilio call whose spoken text says it is a test; it reads and writes no row.
 * It does NOT touch stripe-webhook, create-measurement-order, or any payment table: the only table it writes is public.owner_alerts.
 * A fault anywhere in here returns a JSON error to pg_cron and nothing else.
 *
 * Auth: service-role key only (verify_jwt = false in config.toml, exact-key check in-handler; the public anon key is also a valid JWT).
 * Secrets (read by name, never logged): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, OWNER_ALERT_PHONE; optional SENTRY_DSN.
 * Unit tests: supabase/functions/owner-alert-sweep/sweep.test.ts (deno test; no network, no Twilio, no call).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { authorizeServiceOnly, isTestCallRequest, MAX_ATTEMPTS, placeCall, runSweep, TEST_CALL_KIND, type LeasedAlert } from "./sweep.ts";

const FUNCTION_NAME = "owner-alert-sweep";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Inlined from _shared/sentry.ts (the EF body-deploy path does not resolve _shared imports). No-ops to console.error while SENTRY_DSN is unset.
async function reportToSentry(error: unknown, ctx: { fn: string; op?: string; extra?: Record<string, unknown> }): Promise<void> {
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
      headers: { "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=otterquote-ef/1.0, sentry_key=${u.username}` },
      body: envelope,
    });
  } catch (postErr) {
    console.error("[sentry] post failed (non-fatal):", postErr);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return json({ ok: false, error: "Server configuration error" }, 500);

    const gate = authorizeServiceOnly(req.headers.get("authorization") ?? "", serviceRoleKey);
    if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);

    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
    const from = Deno.env.get("TWILIO_PHONE_NUMBER") ?? "";
    const to = Deno.env.get("OWNER_ALERT_PHONE") ?? "";
    if (!accountSid || !authToken || !from || !to) {
      // Names only. Nothing is leased, so nothing is spent: the events wait (pending) until the secrets exist.
      const missing = [["TWILIO_ACCOUNT_SID", accountSid], ["TWILIO_AUTH_TOKEN", authToken], ["TWILIO_PHONE_NUMBER", from], ["OWNER_ALERT_PHONE", to]]
        .filter(([, v]) => !v).map(([n]) => n);
      await reportToSentry(new Error("owner alert secrets missing"), { fn: FUNCTION_NAME, op: "config", extra: { missing } });
      return json({ ok: false, error: "Alert channel not configured", missing }, 503);
    }

    // Owner-only test call (gh-3428, Ben ruling 6668057340). Past the exact-key gate above; before any Supabase client exists, so no rpc, no table, no row.
    if (await isTestCallRequest(req)) {
      try {
        const sid = await placeCall({ accountSid, authToken, from, to },
          { id: "test", event_kind: TEST_CALL_KIND, claim_id: "", state: null, attempts: 0 }, fetch);
        return json({ ok: true, test_call: true, sid }, 200);
      } catch (e) {
        return json({ ok: false, test_call: true, error: (e as { code?: string })?.code ?? "call_failed" }, 502);
      }
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const result = await runSweep({
      claimBatch: async () => {
        const { data, error } = await supabase.rpc("owner_alert_claim_batch", { p_max_attempts: MAX_ATTEMPTS });
        if (error) throw new Error(`owner_alert_claim_batch: ${error.code ?? "error"}`);
        return (data ?? []) as LeasedAlert[];
      },
      place: (alert) => placeCall({ accountSid, authToken, from, to }, alert, fetch),
      mark: async (id, ok, sid, errorCode) => {
        const { data, error } = await supabase.rpc("owner_alert_mark", {
          p_id: id, p_ok: ok, p_sid: sid, p_error: errorCode, p_max_attempts: MAX_ATTEMPTS,
        });
        if (error) throw new Error(`owner_alert_mark: ${error.code ?? "error"}`);
        return (data ?? null) as string | null;
      },
      report: (err, ctx) => reportToSentry(err, { fn: FUNCTION_NAME, ...ctx }),
    });
    console.log(`[${FUNCTION_NAME}] leased=${result.leased} called=${result.called} retry=${result.retry} failed_final=${result.failed_final}`);
    return json({ ok: !result.error, ...result }, result.error ? 500 : 200);
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] unexpected:`, (err as Error)?.name ?? "error");
    return json({ ok: false, error: "Unexpected error" }, 500);
  }
});
