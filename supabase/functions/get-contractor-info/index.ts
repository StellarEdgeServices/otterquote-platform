import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

const ALLOWED_ORIGINS = [
  "https://stellaredgeservices.com",
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, corsHeaders);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, 401, corsHeaders);
  }
  const token = authHeader.slice(7);

  const sb = createClient(supabaseUrl, serviceRoleKey);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) {
    return json({ error: "Unauthorized" }, 401, corsHeaders);
  }
  const callerId = user.id;

  let claim_id: string, contractor_id: string;
  let notifyNoPaymentMethod = false;
  try {
    const body = await req.json();
    claim_id = body.claim_id;
    contractor_id = body.contractor_id;
    notifyNoPaymentMethod = body.notify_no_payment_method === true;
  } catch {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  if (!claim_id || !contractor_id) {
    return json({ error: "Missing required fields: claim_id, contractor_id" }, 400, corsHeaders);
  }

  // Load the claim + contractor up front so authorization can accept EITHER
  // party. (E2E walk fix 2026-07-08: previously homeowner-only, which 403'd the
  // contractor's own signing page — the contractor cannot load contract-signing
  // to sign first.)
  const { data: claim, error: claimErr } = await sb
    .from("claims")
    .select("id, user_id, selected_contractor_id")
    .eq("id", claim_id)
    .single();

  if (claimErr || !claim) {
    return json({ error: "Forbidden" }, 403, corsHeaders);
  }

  // Service-role read bypasses RLS
  const { data: contractor, error: contractorErr } = await sb
    .from("contractors")
    .select("company_name, user_id, stripe_payment_method_id, has_payment_method, contract_templates, contract_pdf_url")
    .eq("id", contractor_id)
    .single();

  if (contractorErr || !contractor) {
    return json({ error: "Contractor not found" }, 404, corsHeaders);
  }

  // (a) Caller must be the claim owner (homeowner) OR the contractor being queried
  //     (contractor reading its own record for the signing page).
  const isHomeowner = claim.user_id === callerId;
  const isTheContractor = contractor.user_id === callerId;
  if (!isHomeowner && !isTheContractor) {
    return json({ error: "Forbidden" }, 403, corsHeaders);
  }

  // (b) Contractor must be linked to the claim via selected_contractor_id or a quote
  const linkedViaSelected = claim.selected_contractor_id === contractor_id;
  let linkedViaQuote = false;
  if (!linkedViaSelected) {
    const { data: quote } = await sb
      .from("quotes")
      .select("id")
      .eq("claim_id", claim_id)
      .eq("contractor_id", contractor_id)
      .maybeSingle();
    linkedViaQuote = !!quote;
  }

  if (!linkedViaSelected && !linkedViaQuote) {
    return json({ error: "Forbidden" }, 403, corsHeaders);
  }

  // gh-1387: the gate now requires BOTH an id and the verified flag.
  //
  // The id alone is not evidence. Three production contractors rows carried a
  // real-looking pm_… that resolves only in Stripe TEST mode, written by a
  // card-capture flow that never checked. On an id-only gate those contractors
  // pass, the homeowner awards the job, DocuSign fires, and the charge fails
  // later against the live key — the worst possible place to discover it.
  //
  // has_payment_method is written in exactly one place: verify-payment-method,
  // after re-reading the SetupIntent with the key this platform charges with.
  // Requiring both means an unverifiable method fails closed, here, before any
  // money-path side effect has run.
  const hasPaymentMethod = !!(
    contractor.has_payment_method === true &&
    contractor.stripe_payment_method_id &&
    contractor.stripe_payment_method_id !== ""
  );

  // #486: when the homeowner's selection attempt finds no payment method on
  // file, create the contractor's in-app notification SERVER-SIDE (service
  // role). The old client-side insert wrote another user's notifications row
  // from a homeowner session — RLS rightly blocked it and no one was notified.
  if (notifyNoPaymentMethod && !hasPaymentMethod && isHomeowner && contractor.user_id) {
    try {
      const { data: existing } = await sb
        .from("notifications")
        .select("id")
        .eq("user_id", contractor.user_id)
        .eq("claim_id", claim_id)
        .eq("notification_type", "payment_method_needed")
        .is("read_at", null)
        .maybeSingle();
      if (!existing) {
        await sb.from("notifications").insert({
          user_id: contractor.user_id,
          claim_id: claim_id,
          notification_type: "payment_method_needed",
          channel: "dashboard",
          recipient: "",
          message_preview:
            "A homeowner wants to select you, but you don't have a payment method on file. Please add one in Settings.",
        });
      }
    } catch (notifyErr) {
      console.error("[get-contractor-info] payment_method_needed notification failed:", notifyErr);
    }
  }

  // Return only safe fields; never expose Stripe IDs
  return json({
    company_name: contractor.company_name,
    user_id: contractor.user_id,
    has_payment_method: hasPaymentMethod,
    contract_templates: contractor.contract_templates,
    contract_pdf_url: contractor.contract_pdf_url,
  }, 200, corsHeaders);
});
