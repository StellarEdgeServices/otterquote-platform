/**
 * OtterQuote Edge Function: send-lead-measurement-ready (gh-2272)
 *
 * The no-account (lead) sibling of send-measurement-ready (gh-1412), built
 * as a NEW function rather than an extension of that one so the existing
 * authed path stays byte-for-byte untouched. See handler.ts for the full
 * rationale and the itemized list of copy changes.
 *
 * Called by an admin, with the admin's own JWT (same caller-token gate as
 * send-measurement-ready / approve-warranty-drift), after manually
 * fulfilling a `lead_measurement_orders` row (PR #2226's HO-3 schema — see
 * the SCHEMA DEPENDENCY note below). Does two things, in this order:
 *   1. Writes an activity_log row (event_type
 *      'lead_measurement_report_sent') BEFORE the send.
 *   2. Emails the lead, at their on-file address, that their report is
 *      ready. Idempotent per order via the `notifications` table — a
 *      re-trigger cannot double-send.
 *
 * SCHEMA DEPENDENCY (gh-2272 work order): `lead_measurement_orders` and its
 * FK target `leads` (columns email, name, is_synthetic, property_address)
 * are defined by PR #2226 (`gh-2121-ho3-lead-measurement-noauth`), which is
 * open and NOT on main as of this PR. `leads.email/name` are baseline;
 * `is_synthetic` (gh-2055) and `property_address` (gh-2122) are already on
 * main; `lead_measurement_orders` itself is not. This function is built and
 * shipped against that not-yet-merged schema (read-only reference to
 * #2226's migration file — see that PR for the exact column list) and must
 * not be deployed before #2226's migration is applied. Per #2272's go-live
 * order note (item 0c on #2226): #2226 must not merge/ship to prod until
 * THIS PR has merged, deployed, and had one verified test send.
 *
 * verify_jwt = false (config.toml) — same as send-measurement-ready: the
 * admin gate below is an in-handler check against the caller's own JWT, not
 * the platform's verify_jwt feature.
 *
 * Environment variables (all already set in Supabase secrets, same names as
 * send-measurement-ready):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  Deps,
  handleSendRequest,
  isVerifySendRequested,
  LeadOrderRow,
  LeadRow,
  NOTIFICATION_TYPE,
} from "./handler.ts";

const FUNCTION_NAME = "send-lead-measurement-ready";
// gh-1534: kept in sync with supabase/functions/_shared/admin.ts PRIMARY_ADMIN_EMAIL
// and with send-measurement-ready's own copy of the same constant — do not
// edit without updating both (deploy path does not resolve imports).
const PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com";

// CORS — same origin allow-list as send-measurement-ready / create-lead-measurement-order.
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

function json(body: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, corsHeaders);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const mailgunKey = Deno.env.get("MAILGUN_API_KEY") || "";
    const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN") || "";
    if (!supabaseUrl || !serviceRoleKey || !mailgunKey || !mailgunDomain) {
      throw new Error("Missing required environment variables");
    }

    // ── Admin gate (send-measurement-ready pattern) — BEFORE anything else ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401, corsHeaders);
    }
    const userClient = createClient(supabaseUrl, anonKey || serviceRoleKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return json({ error: "Unauthorized" }, 401, corsHeaders);
    }

    const sb = createClient(supabaseUrl, serviceRoleKey);

    let isAdmin = user.email === PRIMARY_ADMIN_EMAIL;
    if (!isAdmin) {
      const { data: adminRow } = await sb
        .from("contractors")
        .select("template_review_role")
        .eq("user_id", user.id)
        .maybeSingle();
      isAdmin = adminRow?.template_review_role === "admin";
    }

    // verifySend is computed AFTER the caller's own JWT is resolved, same
    // ordering as send-measurement-ready (gh-1538) — it can never widen who
    // may invoke this function, only whether an already-authorized call
    // bypasses the is_test send skip.
    const verifySend = isVerifySendRequested(req.headers);

    const body = await req.json().catch(() => null);
    const orderId = body?.order_id as string | undefined;

    const deps: Deps = {
      loadOrder: async (orderId: string): Promise<LeadOrderRow | null> => {
        const { data } = await sb
          .from("lead_measurement_orders")
          .select("id, lead_id, status, product_code, is_test")
          .eq("id", orderId)
          .maybeSingle();
        return (data as LeadOrderRow) ?? null;
      },
      loadLead: async (leadId: string): Promise<LeadRow | null> => {
        const { data } = await sb
          .from("leads")
          .select("email, name, is_synthetic, property_address")
          .eq("id", leadId)
          .maybeSingle();
        return (data as LeadRow) ?? null;
      },
      findExistingNotification: async (orderId: string): Promise<boolean> => {
        const { data } = await sb
          .from("notifications")
          .select("id")
          .eq("notification_type", NOTIFICATION_TYPE)
          .eq("channel", "email")
          .ilike("message_preview", `%${orderId}%`)
          .limit(1);
        return !!(data && data.length > 0);
      },
      writeActivityLog: (row) => sb.from("activity_log").insert(row),
      sendEmail: async (to, msg) => {
        const formData = new FormData();
        formData.append("from", `Otter Quotes <notifications@${mailgunDomain}>`);
        formData.append("to", to);
        formData.append("subject", msg.subject);
        formData.append("text", msg.text);
        formData.append("html", msg.html);
        const mgRes = await fetch(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
          method: "POST",
          headers: { Authorization: `Basic ${btoa(`api:${mailgunKey}`)}` },
          body: formData,
        });
        if (!mgRes.ok) {
          const errText = await mgRes.text();
          throw new Error(`Mailgun error ${mgRes.status}: ${errText}`);
        }
        const mgData = await mgRes.json();
        return { ok: true, id: mgData.id };
      },
      recordNotification: (row) => sb.from("notifications").insert(row),
      insertActivityLogFailure: (row) => sb.from("activity_log").insert(row as Record<string, unknown>),
      insertPlatformAlert: (row) => sb.from("platform_alerts_log").insert(row as Record<string, unknown>),
      verifySend,
    };

    const result = await handleSendRequest(orderId, isAdmin, deps);
    return json(result.body, result.status, corsHeaders);
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error:`, err);
    return json({ error: "Internal server error" }, 500, corsHeaders);
  }
});
