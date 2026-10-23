/**
 * OtterQuote Edge Function: ga4-mp-conversion (gh-3051)
 *
 * Sends the three homeowner conversions to GA4 server-side via the Measurement Protocol, so browser privacy settings, GPC and
 * blockers cannot drop them. Ruling: #1940 DECIDED 6369440672 (CTO RUN 77). Evidence: 6369429483 -- 1 of 4 real claims reached GA4.
 *
 * Callers: the three AFTER INSERT triggers in supabase/migrations_drafts/gh3051_ga4_mp_conversion_triggers.sql (leads ->
 * router_contact_submitted, profiles -> sign_up, claims -> claim_started) via pg_net, with the service-role key as bearer and a body of
 * {event_type, id} ONLY -- no row content crosses pg_net. This function reads the row itself and sends a payload with no personal data.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GA4_MP_API_SECRET or the existing GA4_API_SECRET (names only; value never in the repo or in logs).
 * Optional JSON body field debug:true sends to /debug/mp/collect (records nothing) and returns validationMessages.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";
import { handleRequest } from "./handler.ts";
import type { ConversionKind, ConversionRow } from "./ga4-mp.ts";

const url = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

async function loadRow(kind: ConversionKind, id: string): Promise<ConversionRow | null> {
  if (kind === "lead") {
    const { data } = await sb.from("leads")
      .select("id,email,source,variant,utm_source,utm_medium,is_synthetic,created_at").eq("id", id).maybeSingle();
    // Only front-door router leads are the router_contact_submitted conversion (partner / agent leads are not).
    if (!data || data.source !== "router") return null;
    return { kind, id, email: data.email, variant: data.variant, utmSource: data.utm_source, utmMedium: data.utm_medium, isSynthetic: data.is_synthetic, createdAt: data.created_at };
  }
  if (kind === "profile") {
    const { data } = await sb.from("profiles").select("id,email,is_test,utm_source,utm_medium,created_at").eq("id", id).maybeSingle();
    if (!data) return null;
    let method: string | null = null;
    try { method = (await sb.auth.admin.getUserById(id)).data.user?.app_metadata?.provider ?? null; } catch { /* method is optional */ }
    return { kind, id, userId: id, email: data.email, isTest: data.is_test, utmSource: data.utm_source, utmMedium: data.utm_medium, method, createdAt: data.created_at };
  }
  const { data: c } = await sb.from("claims").select("id,user_id,is_test,utm_source,utm_medium,created_at").eq("id", id).maybeSingle();
  if (!c) return null;
  const { data: p } = await sb.from("profiles").select("email,is_test").eq("id", c.user_id).maybeSingle();
  return { kind, id, userId: c.user_id, email: p?.email ?? null, isTest: c.is_test === true || p?.is_test === true, utmSource: c.utm_source, utmMedium: c.utm_medium, createdAt: c.created_at };
}

serve((req: Request) =>
  handleRequest(req, {
    serviceRoleKey: serviceKey,
    // GA4_MP_API_SECRET if set, else GA4_API_SECRET: the property already has one MP secret ("otterquote-ef-server-2") and it is already in
    // Doppler prd + the EF store under GA4_API_SECRET (create-invoice / create-docusign-envelope / docusign-webhook read it), so no new secret is needed.
    apiSecret: Deno.env.get("GA4_MP_API_SECRET") || Deno.env.get("GA4_API_SECRET") || undefined,
    loadRow,
    claimMarker: async (eventName, rowId) => {
      const { error } = await sb.from("ga4_mp_sent").insert({ event_name: eventName, row_id: rowId });
      if (!error) return "claimed";
      return error.code === "23505" ? "duplicate" : "error";
    },
    releaseMarker: async (eventName, rowId) => {
      await sb.from("ga4_mp_sent").delete().eq("event_name", eventName).eq("row_id", rowId);
    },
  })
);
