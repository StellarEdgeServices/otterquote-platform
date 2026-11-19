/**
 * twilio-sms-optout -- D-391 layer 2 (#2875). Wiring only; logic and safe defaults are in handler.ts.
 * Secrets read by name (never logged): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_AUTH_TOKEN,
 * TWILIO_INBOUND_WEBHOOK_URL (the exact public URL Twilio is configured to post to).
 * #3770: when a STOP leaves a contractor with no textable number, index.ts e-mails the contractor and Dustin
 * (_shared/sms-last-number-notice.ts; dark unless SMS_LAST_NUMBER_EMAIL_ENABLED is "true"; needs MAILGUN_API_KEY, MAILGUN_DOMAIN).
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { type Deps, handle } from "./handler.ts";
import { hasOpenStopRow } from "./open-stop.ts";
import { noticeAfterOptOut, wireNoticeDeps } from "../_shared/sms-last-number-notice.ts";

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
    const { data, error } = await sb.from("contractor_sms_numbers")
      // zero rows is legitimate (a STOP from a number never verified for any contractor); the suppression row is the write that matters.
      .update({ status: "opted_out", opted_out_at: at, opt_out_keyword: keyword, opt_out_channel: "sms_keyword" })
      .eq("phone_e164", phone).eq("status", "verified").select("contractor_id");
    if (error) return false;
    // #3770: the suppression row is already written, so a contractor left with no textable number is detectable now. Only
    // contractors whose rows THIS call flipped are considered (a Twilio retry flips none), and nothing here can fail the STOP.
    try {
      const ids = (data ?? []).map((r: { contractor_id: string }) => r.contractor_id).filter(Boolean);
      if (ids.length) await noticeAfterOptOut(wireNoticeDeps(sb, (n) => Deno.env.get(n)), ids, "sms STOP");
    } catch (e) { console.error(`${"twilio-sms-optout"}: last-number notice failed (STOP unaffected):`, e instanceof Error ? e.message : String(e)); }
    return true;
  },
  recordStopOverStaff: async (phone, keyword, _at) => {
    // #3761: a contractor's own STOP over a staff-recorded opt-out must stay on record as the contractor's STOP.
    const staff = ["email", "support_call"];
    const a = await sb.from("sms_suppression_list")
      .update({ channel: "sms_keyword", keyword })
      .eq("phone_e164", phone).is("released_at", null).in("channel", staff).select("id");
    const b = await sb.from("contractor_sms_numbers")
      .update({ opt_out_channel: "sms_keyword", opt_out_keyword: keyword })
      .eq("phone_e164", phone).eq("status", "opted_out").in("opt_out_channel", staff).select("id");
    return !a.error && !b.error;
  },
  hasOpenStop: (phone) => hasOpenStopRow(sb, phone),
  release: async (phone, at) => {
    const { error } = await sb.from("sms_suppression_list")
      // update-no-select-ok: zero rows is legitimate (a START from a number with no open suppression row).
      .update({ released_at: at, released_keyword: "START" })
      .eq("phone_e164", phone).is("released_at", null);
    return !error;
  },
  flag: async (phone, body, keywords, messageSid, at) => {
    const { error } = await sb.from("sms_optout_review").insert({
      phone_e164: phone,
      inbound_body: body,
      matched_keywords: keywords,
      message_sid: messageSid,
      flagged_at: at,
    });
    // 23505 = this MessageSid is already queued (a Twilio retry): that is the state we want.
    return !error || error.code === "23505";
  },
};

serve((req) => handle(req, deps));
