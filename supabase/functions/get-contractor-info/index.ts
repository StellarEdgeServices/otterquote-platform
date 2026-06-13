import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  try {
    const body = await req.json();
    claim_id = body.claim_id;
    contractor_id = body.contractor_id;
  } catch {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  if (!claim_id || !contractor_id) {
    return json({ error: "Missing required fields: claim_id, contractor_id" }, 400, corsHeaders);
  }

  // (a) Caller must own the claim
  const { data: claim, error: claimErr } = await sb
    .from("claims")
    .select("id, user_id, selected_contractor_id")
    .eq("id", claim_id)
    .single();

  if (claimErr || !claim || claim.user_id !== callerId) {
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

  // Service-role read bypasses RLS
  const { data: contractor, error: contractorErr } = await sb
    .from("contractors")
    .select("company_name, user_id, stripe_payment_method_id, contract_templates, contract_pdf_url")
    .eq("id", contractor_id)
    .single();

  if (contractorErr || !contractor) {
    return json({ error: "Contractor not found" }, 404, corsHeaders);
  }

  // Return only safe fields; never expose Stripe IDs
  return json({
    company_name: contractor.company_name,
    user_id: contractor.user_id,
    has_payment_method: !!(contractor.stripe_payment_method_id && contractor.stripe_payment_method_id !== ""),
    contract_templates: contractor.contract_templates,
    contract_pdf_url: contractor.contract_pdf_url,
  }, 200, corsHeaders);
});
