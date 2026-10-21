/**
 * twilio-sms-optout -- D-391 layer 2 (#2875). Wiring only; logic and safe defaults are in handler.ts.
 * Secrets read by name (never logged): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_AUTH_TOKEN,
 * TWILIO_INBOUND_WEBHOOK_URL (the exact public URL Twilio is configured to post to).
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { type Deps, handle } from "./handler.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const deps: Deps = {
  env: (n) => Deno.env.get(n),
  now: () => new Date(),
  suppress: async (phone, keyword, at) => {
    const { data: src } = await sb.from("contractor_sms_numbers").select("id")
      .eq("phone_e164", phone).eq("status", "verified").order("verified_at").limit(1);
    const { error } = await sb.from("sms_suppression_list").insert({
      phone_e164: phone,
      suppressed_at: at,
      keyword,
      channel: "sms_keyword",
      source_number_id: src?.[0]?.id ?? null,
    });
    // 23505 = an open row already exists for this number: that is the state we want.
    return !error || error.code === "23505";
  },
  markOptedOut: async (phone, keyword, at) => {
    const { error } = await sb.from("contractor_sms_numbers")
      // update-no-select-ok: zero rows is legitimate (a STOP from a number never verified for any contractor); the suppression row is the write that matters.
      .update({ status: "opted_out", opted_out_at: at, opt_out_keyword: keyword, opt_out_channel: "sms_keyword" })
      .eq("phone_e164", phone).eq("status", "verified");
    return !error;
  },
  release: async (phone, at) => {
    const { error } = await sb.from("sms_suppression_list")
      // update-no-select-ok: zero rows is legitimate (a START from a number with no open suppression row).
      .update({ released_at: at, released_keyword: "START" })
      .eq("phone_e164", phone).is("released_at", null);
    return !error;
  },
};

serve((req) => handle(req, deps));
