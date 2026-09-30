/**
 * Otter Quotes Edge Function: send-referral-out-email  (gh-2019 / D-324)
 *
 * Admin-triggered, once-per-recipient send of the approved D-324 referral-out
 * email ("The contractors you asked for") to a homeowner who was screened out
 * of the arm-E router and asked for contractor contact information. Dustin
 * supplies the three names (from OUTSIDE our own network, D-249) in the request.
 *
 * Request (POST, Authorization: Bearer <admin session JWT>):
 *   { "lead_id": "<uuid of the leads row, variant e-referral-out>",
 *     "contractors": [ {name, phone, website} x3 ] }
 *
 * Auth: identical to admin-contractor-action -- verify_jwt=false at the gateway
 * (config.toml) and the caller's JWT is verified IN the handler with
 * supabase.auth.getUser(), then compared to the single primary admin identity.
 * Nothing is read or written before that gate passes.
 *
 * What is sent, and to whom, is decided in send-core.ts / templates.ts (pure,
 * unit-tested). This file is wiring only.
 *
 * Environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  isPrimaryAdmin,
  NOTIF_TYPE_REFERRAL_OUT,
  PRIMARY_ADMIN_EMAIL,
  runSend,
  type SendDeps,
} from "./send-core.ts";

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

const FROM = "Otter Quotes <notifications@mail.otterquote.com>";

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

async function mailgunSend(
  apiKey: string,
  domain: string,
  msg: { to: string; subject: string; text: string; html: string },
): Promise<{ ok: boolean; mailgunId?: string }> {
  const form = new URLSearchParams();
  form.append("from", FROM);
  form.append("to", msg.to);
  form.append("subject", msg.subject);
  form.append("text", msg.text);
  form.append("html", msg.html);
  try {
    const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
      body: form,
    });
    if (!res.ok) {
      console.error(`send-referral-out-email: Mailgun error (${res.status}):`, await res.text());
      return { ok: false };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, mailgunId: typeof data?.id === "string" ? data.id : undefined };
  } catch (err) {
    console.error("send-referral-out-email: Mailgun request failed:", err);
    return { ok: false };
  }
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return json(401, { error: "Missing or invalid Authorization header" });
    }
    const token = authHeader.substring(7);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) throw new Error("Supabase credentials not configured");
    const sb = createClient(supabaseUrl, supabaseKey);

    // Admin gate: verified JWT -> primary admin identity. Nothing below runs otherwise.
    const { data: user, error: userError } = await sb.auth.getUser(token);
    if (userError || !isPrimaryAdmin(user?.user?.email)) {
      return json(403, { error: "Unauthorized" });
    }

    const mailgunKey = Deno.env.get("MAILGUN_API_KEY");
    const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN");
    if (!mailgunKey || !mailgunDomain) throw new Error("Mailgun credentials not configured");

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json(400, { error: "JSON body required" });

    const deps: SendDeps = {
      async getLead(leadId) {
        const { data, error } = await sb.from("leads").select("id, name, email, variant").eq("id", leadId).maybeSingle();
        if (error) throw error;
        return data ?? null;
      },
      async listSendRecords(recipient) {
        const { data, error } = await sb
          .from("notifications")
          .select("id, delivered")
          .eq("notification_type", NOTIF_TYPE_REFERRAL_OUT)
          .eq("recipient", recipient)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true });
        if (error) throw error;
        return data ?? [];
      },
      async insertClaim(recipient, preview) {
        const { data, error } = await sb
          .from("notifications")
          .insert({
            user_id: null,
            claim_id: null,
            channel: "email",
            notification_type: NOTIF_TYPE_REFERRAL_OUT,
            recipient,
            message_preview: preview,
            delivered: false,
          })
          .select("id")
          .single();
        if (error) throw error;
        return data.id as string;
      },
      async deleteRecord(id) {
        const { error } = await sb.from("notifications").delete().eq("id", id);
        if (error) console.error("send-referral-out-email: failed to remove claim row", id, error);
      },
      async markDelivered(id, mailgunId) {
        const { data, error } = await sb
          .from("notifications")
          .update({ delivered: true, mailgun_id: mailgunId, sent_at: new Date().toISOString() })
          .eq("id", id)
          .select("id");
        if (error) throw error;
        // gh-2105: a zero-row match is not "success" -- runSend reports record_incomplete.
        if (!data || data.length === 0) throw new Error(`no notifications row matched claim ${id}`);
      },
      sendToRequester: (msg) => mailgunSend(mailgunKey, mailgunDomain, msg),
      async sendAdminAlert(msg) {
        return (await mailgunSend(mailgunKey, mailgunDomain, { to: PRIMARY_ADMIN_EMAIL, ...msg })).ok;
      },
    };

    const result = await runSend(body as Record<string, unknown>, deps);
    return json(result.status, result.body);
  } catch (err) {
    console.error("send-referral-out-email error:", err);
    return json(500, { error: "internal error" });
  }
});
