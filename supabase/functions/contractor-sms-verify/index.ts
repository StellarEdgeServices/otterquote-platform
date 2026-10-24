/**
 * contractor-sms-verify -- D-391 layer 2 (#2875). Wiring only; the logic and the safe defaults are in handler.ts.
 *
 * Secrets read by name (never logged): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * TWILIO_VERIFY_SERVICE_SID (absent until the Verify service is created -> the function answers 503 verify_not_configured),
 * TWILIO_VERIFY_TEMPLATE_SID (optional; set only after Twilio approves a custom template).
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { type Deps, handle } from "./handler.ts";
import { isSmsPaused } from "../_shared/sms-pause.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const deps: Deps = {
  env: (n) => Deno.env.get(n),
  fetch: (url, init) => fetch(url, init),
  now: () => new Date(),
  getUser: async (token) => {
    const { data, error } = await sb.auth.getUser(token);
    return error || !data?.user ? null : { id: data.user.id };
  },
  getContractor: async (id) => {
    const { data } = await sb.from("contractors").select("id, user_id").eq("id", id).maybeSingle();
    return data ?? null;
  },
  getCurrentDisclosure: async () => {
    const { data } = await sb
      .from("sms_disclosure_versions")
      .select("id, disclosure_text")
      .is("retired_at", null)
      .lte("effective_at", new Date().toISOString())
      .order("effective_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ?? null;
  },
  isSuppressed: async (phone) => {
    const { data, error } = await sb.from("sms_suppression_list").select("id").eq("phone_e164", phone).is("released_at", null).limit(1);
    // Unknown is treated as suppressed: when in doubt, send nothing.
    return error ? true : (data?.length ?? 0) > 0;
  },
  isPaused: async (phone) => (await isSmsPaused(sb, phone)).paused,
  rateLimit: async (fn, bucket) => {
    const { data, error } = await sb.rpc("check_rate_limit", { p_function_name: fn, p_user_id: bucket });
    if (error) return "error";
    return data?.allowed === true ? "allowed" : "denied";
  },
  findVerified: async (contractorId, phone) => {
    const { data } = await sb.from("contractor_sms_numbers").select("id")
      .eq("contractor_id", contractorId).eq("phone_e164", phone).eq("status", "verified").maybeSingle();
    return data ?? null;
  },
  hasPrimary: async (contractorId) => {
    const { data } = await sb.from("contractor_sms_numbers").select("id")
      .eq("contractor_id", contractorId).eq("is_primary", true).limit(1);
    return (data?.length ?? 0) > 0;
  },
  insertNumber: async (row) => {
    const { data, error } = await sb.from("contractor_sms_numbers").insert(row).select("id").single();
    if (!error && data) return { id: data.id };
    if (error?.code === "23505") {
      return { conflict: /one_primary/.test(error.message ?? "") ? "primary" : "live" };
    }
    return { error: error?.message ?? "insert returned no row" };
  },
  bumpConfirmed: async (numberId, at) => {
    const { data, error } = await sb.from("contractor_sms_numbers")
      .update({ last_confirmed_at: at }).eq("id", numberId).select("id");
    return !error && (data?.length ?? 0) === 1;
  },
  insertDefaultPreference: async (numberId) => {
    // Default is the column default {all}; a failure here is logged, never blocks the verified record.
    const { error } = await sb.from("contractor_sms_number_preferences").insert({ number_id: numberId });
    if (error) console.error(`[contractor-sms-verify] default preference insert failed: ${error.message}`);
  },
};

serve((req) => handle(req, deps));
