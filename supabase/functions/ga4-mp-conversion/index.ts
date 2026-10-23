/**
 * OtterQuote Edge Function: ga4-mp-conversion (gh-3051)
 *
 * Sends two homeowner conversions (router_contact_submitted, claim_started) to GA4 server-side via the Measurement Protocol, so ad
 * blockers and dropped browser sends cannot lose them -- never to get around an opt-out (see D-NUMBERS below). Ruling: #1940 DECIDED 6369440672 (CTO RUN 77). Evidence: 6369429483 -- 1 of 4 real
 * claims reached GA4. sign_up is NOT sent server-side (CTO ruling on PR #3054 review): a profiles insert fires for contractors too.
 *
 * D-NUMBERS IMPLEMENTED: D-323 (GA4 linked to Google Ads with Personalized Advertising, so this is an ad-linked share) and D-336
 * (the privacy.html Section 12 opt-out: stored ad_sharing_opt_out flag, Global Privacy Control, Sec-GPC: 1). NOTHING is sent for a
 * person who opted out by the oq_ad_optout cookie, GPC / Sec-GPC, profiles.ad_sharing_opt_out or the support-email suppression list,
 * or whose opt-out state is unknown -- the same gate js/ga-gate.js applies to GA4 in the browser (ad-optout.ts; PR #3054
 * LEGAL-READ: FAIL 6371271800, ruling 6371298079). A blocker that is not an opt-out is still covered; an opt-out is not bypassed.
 *
 * Callers: the two AFTER INSERT triggers in supabase/migrations_drafts/gh3051_ga4_mp_conversion_triggers.sql (leads, claims) via pg_net, with
 * the service-role key as bearer and a body of {event_type, id} ONLY -- no row content crosses pg_net. This function reads the row itself and
 * sends a payload with no personal data.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GA4_MP_API_SECRET or the existing GA4_API_SECRET (names only; value never in the repo or logs).
 * Optional JSON body field debug:true sends to /debug/mp/collect (records nothing) and returns validationMessages.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";
import { handleRequest } from "./handler.ts";
import { loadRow } from "./load-row.ts";

const url = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

serve((req: Request) =>
  handleRequest(req, {
    serviceRoleKey: serviceKey,
    // GA4_MP_API_SECRET if set, else GA4_API_SECRET: the property already has one MP secret ("otterquote-ef-server-2") and it is already in
    // Doppler prd + the EF store under GA4_API_SECRET (create-invoice / create-docusign-envelope / docusign-webhook read it).
    apiSecret: Deno.env.get("GA4_MP_API_SECRET") || Deno.env.get("GA4_API_SECRET") || undefined,
    loadRow: (kind, id) => loadRow(sb, kind, id),
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
