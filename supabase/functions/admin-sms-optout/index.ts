/**
 * admin-sms-optout -- #3761. Wiring only; logic is in handler.ts (see its header for the store and the rules).
 * Secrets read by name (never logged): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (+ SUPABASE_ANON_KEY for the admin gate).
 * Sends nothing: no Twilio, no e-mail. Tier 3A (new Edge Function, no external side effects). NOT DEPLOYED by this PR.
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { type Deps, handle } from "./handler.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const deps: Deps = {
  gate: (req) => requireAdmin(req),
  now: () => new Date(),
  listNumbers: async (contractorId) => {
    const { data, error } = await sb.from("contractor_sms_numbers").select("id, phone_e164, status").eq("contractor_id", contractorId);
    return error ? null : (data ?? []);
  },
  suppress: async (phone, keyword, channel, at, sourceNumberId) => {
    const { error } = await sb.from("sms_suppression_list").insert({
      phone_e164: phone,
      suppressed_at: at,
      keyword,
      channel,
      source_number_id: sourceNumberId,
    });
    // 23505 = an open row already exists for this number: that is the state we want.
    return !error || error.code === "23505";
  },
  markOptedOut: async (contractorId, keyword, channel, at) => {
    const { error } = await sb.from("contractor_sms_numbers")
      // update-no-select-ok: zero rows is legitimate (every number already opted_out/disabled/removed); the suppression row is the write that matters.
      .update({ status: "opted_out", opted_out_at: at, opt_out_keyword: keyword, opt_out_channel: channel })
      .eq("contractor_id", contractorId).eq("status", "verified");
    return !error;
  },
  openSuppressions: async (phones) => {
    const { data, error } = await sb.from("sms_suppression_list").select("id, phone_e164, channel")
      .in("phone_e164", phones).is("released_at", null);
    return error ? null : (data ?? []);
  },
  release: async (ids, at) => {
    const { error } = await sb.from("sms_suppression_list")
      // update-no-select-ok: a row released a moment ago by the contractor's own START is the state we want.
      .update({ released_at: at, released_keyword: "START" })
      .in("id", ids).is("released_at", null);
    return !error;
  },
  audit: async (row) => {
    const { error } = await sb.from("activity_log").insert(row);
    return !error;
  },
};

serve((req) => handle(req, deps));
