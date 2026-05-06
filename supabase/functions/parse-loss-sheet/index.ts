/**
 * OtterQuote Edge Function: parse-loss-sheet
 *
 * Extracts structured line items from an insurance loss sheet PDF
 * using Claude claude-sonnet-4-6 vision API. All PII is stripped before storing.
 * The parsed data is stored in claims.parsed_line_items (JSONB) and a
 * contractor-safe text summary in claims.contractor_scope_summary.
 *
 * Usage:
 *   POST /functions/v1/parse-loss-sheet
 *   Body: {
 *     "claim_id": "uuid",
 *     "document_id": "uuid" (optional — for logging),
 *     "storage_path": "claim-documents/user_id/claim_id/filename.pdf"
 *   }
 *
 * Auth: --no-verify-jwt (consistent with all OtterQuote Edge Functions)
 *
 * Rate limit: 10/day, 50/month per claim (via check_rate_limit RPC).
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY
 *
 * ClickUp: 86e0tt3ku — Session 75, April 8, 2026
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "parse-loss-sheet";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

// CORS tightened (Session 254): origin-allowlisted instead of wildcard.
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
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

// ── Extraction prompt ──────────────────────────────────────────────────────────
const EXTRACTION_PROMPT = `You are processing an insurance loss sheet / damage estimate PDF. Your job is two-fold:
1. Extract all line items as structured JSON
2. Identify and EXCLUDE all personal information

DETECT FORMAT: Determine if this is Xactimate, CoreLogic/ITEL, or another carrier format based on column headers and layout.

EXTRACT the following fields:

{
  "carrier_name": "string — e.g. Tower Hill, Liberty Mutual, USAA",
  "date_of_loss": "string — month/year only, e.g. 'March 2024' — NEVER include the full date or year alone",
  "pricing_database": "string or null — e.g. 'CoreLogic Indiana, Sep 2023'",
  "format_detected": "xactimate | corelogic_itel | carrier_proprietary | unknown",
  "sections": [
    {
      "section_name": "string — e.g. 'EXTERIOR PLAN', 'ROOFPLAN', 'SHINGLES'",
      "area_name": "string or null — subsection label if present, e.g. 'Roof', 'Roof 2', 'gazebo roof'",
      "measurements": {
        "roof_area_sf": number or null,
        "squares": number or null,
        "eaves_lf": number or null,
        "ridge_lf": number or null,
        "hip_lf": number or null,
        "valley_lf": number or null,
        "rake_lf": number or null,
        "soffit_sf": number or null
      },
      "line_items": [
        {
          "line_number": number or null,
          "description": "string — the work description, e.g. 'Remove Comp Shingles'",
          "coverage": "string or null — e.g. 'Coverage A', 'Building', 'Appurtenant structure'",
          "quantity": number or null,
          "unit": "string or null — e.g. 'SQ', 'LF', 'EA', 'SF'",
          "unit_price": number or null,
          "op": number or null,
          "taxes": number or null,
          "rc": number or null,
          "depreciation": number or null,
          "acv": number or null,
          "notes": "string or null — waste %, ITEL material allowance notes, etc."
        }
      ],
      "subtotal_rc": number or null,
      "subtotal_acv": number or null
    }
  ],
  "summary": {
    "total_materials": number or null,
    "total_labor": number or null,
    "total_equipment": number or null,
    "subtotal": number or null,
    "sales_tax": number or null,
    "rcv": number or null,
    "total_depreciation": number or null,
    "acv": number or null,
    "deductible": number or null,
    "net_estimate": number or null,
    "net_if_depreciation_recovered": number or null
  }
}

IMPORTANT RULES:
- DO NOT include in output: insured name, home address, phone number, email address, policy number, claim number, member number, adjuster name, adjuster phone, adjuster email, claim rep name, claim rep contact info, estimator name, contact name/phone/email, loss address (city/state OK to omit entirely), any handwritten annotations.
- If you see a claim number, policy number, or any identifier tied to a specific person — OMIT IT.
- Date of loss: include month and year ONLY (e.g. "May 2024" not "May 15, 2024").
- If this document has a cover page with handwritten notes, EXCLUDE the handwritten content entirely.
- If the document appears to be a summary-only format (no line items visible), still capture all summary totals and set sections to an empty array.
- Return ONLY valid JSON — no markdown, no explanation, no surrounding text.`;

// ── Contractor scope summary builder ──────────────────────────────────────────
function buildScopeSummary(parsed: any): string {
  const lines: string[] = [];

  if (parsed.carrier_name) lines.push(`Carrier: ${parsed.carrier_name}`);
  if (parsed.date_of_loss) lines.push(`Date of Loss: ${parsed.date_of_loss}`);
  if (parsed.pricing_database) lines.push(`Pricing Basis: ${parsed.pricing_database}`);
  if (parsed.format_detected) lines.push(`Format: ${parsed.format_detected}`);

  lines.push("");

  // Section measurements and line items
  // Note: Claude's extraction may return field names as either the prompt schema
  // (section_name, line_items, rc) or common variants (name, items, rcv).
  // Handle both to be resilient to LLM output variation.
  if (parsed.sections && parsed.sections.length > 0) {
    for (const section of parsed.sections) {
      const sectionName = section.section_name || section.name;
      const label = [sectionName, section.area_name].filter(Boolean).join(" — ");
      lines.push(`SECTION: ${label}`);

      const m = section.measurements;
      if (m) {
        const measureParts = [];
        if (m.roof_area_sf) measureParts.push(`${m.roof_area_sf.toLocaleString()} SF`);
        if (m.squares) measureParts.push(`${m.squares} SQ`);
        if (m.eaves_lf) measureParts.push(`Eaves ${m.eaves_lf} LF`);
        if (m.ridge_lf) measureParts.push(`Ridge ${m.ridge_lf} LF`);
        if (measureParts.length > 0) {
          lines.push(`  Measurements: ${measureParts.join(", ")}`);
        }
      }

      const sectionItems = section.line_items || section.items || [];
      if (sectionItems.length > 0) {
        lines.push(`  Line Items (${sectionItems.length}):`);
        for (const item of sectionItems) {
          const parts = [];
          if (item.description) parts.push(item.description);
          if (item.quantity && item.unit) parts.push(`${item.quantity} ${item.unit}`);
          const rcVal = item.rc ?? item.rcv;
          if (rcVal) parts.push(`RC $${rcVal.toLocaleString()}`);
          if (item.depreciation) parts.push(`Dep -$${item.depreciation.toLocaleString()}`);
          if (item.acv) parts.push(`ACV $${item.acv.toLocaleString()}`);
          lines.push(`    • ${parts.join(" | ")}`);
          if (item.notes) lines.push(`      Note: ${item.notes}`);
        }
      }

      if (section.subtotal_rc || section.rcv) {
        lines.push(`  Section RC Total: $${(section.subtotal_rc || section.rcv).toLocaleString()}`);
      }
      if (section.subtotal_acv || section.acv) {
        lines.push(`  Section ACV Total: $${(section.subtotal_acv || section.acv).toLocaleString()}`);
      }
      lines.push("");
    }
  }

  // Summary — only RCV, Depreciation, ACV, Deductible (Session 226 cleanup per 86e0yybjc)
  const s = parsed.summary;
  if (s) {
    lines.push("CLAIM SUMMARY");
    if (s.rcv) lines.push(`  RCV: $${s.rcv.toLocaleString()}`);
    if (s.total_depreciation) lines.push(`  Depreciation: -$${s.total_depreciation.toLocaleString()}`);
    if (s.acv) lines.push(`  ACV: $${s.acv.toLocaleString()}`);
    if (s.deductible) lines.push(`  Deductible: $${s.deductible.toLocaleString()}`);
  }

  return lines.join("\n");
}

// ── Main handler ───────────────────────────────────────────────────────────────
serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");

  if (!anthropicKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY secret not configured" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // ── Parse request ──────────────────────────────────────────────
    const body = await req.json();
    const { claim_id, document_id, storage_path } = body;

    if (!claim_id || !storage_path) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: claim_id, storage_path" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[parse-loss-sheet] claim_id=${claim_id}, storage_path=${storage_path}`);

    // ── Rate limit ─────────────────────────────────────────────────
    const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_user_id: null,
    });

    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(
        JSON.stringify({ error: "Rate limit check failed" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!rateLimitResult?.allowed) {
      console.warn(`[parse-loss-sheet] Rate limited for claim ${claim_id}: ${rateLimitResult?.reason}`);
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded", reason: rateLimitResult?.reason }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Fetch PDF from Supabase Storage ────────────────────────────
    // storage_path format: "user_id/claim_id/filename.pdf"
    // The bucket is "claim-documents"
    console.log(`[parse-loss-sheet] Fetching PDF from storage: ${storage_path}`);
    const { data: fileData, error: storageError } = await supabase.storage
      .from("claim-documents")
      .download(storage_path);

    if (storageError || !fileData) {
      console.error("Storage fetch failed:", storageError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch document from storage", detail: storageError?.message }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Convert to base64 ──────────────────────────────────────────
    const arrayBuffer = await fileData.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Encode to base64 in chunks (avoid call stack overflow on large files)
    let binary = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const base64Pdf = btoa(binary);

    console.log(`[parse-loss-sheet] PDF size: ${bytes.length} bytes, base64 length: ${base64Pdf.length}`);

    // ── Call Claude claude-sonnet-4-6 vision API ──────────────────────────────
    const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 8000,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: base64Pdf,
                },
              },
              {
                type: "text",
                text: EXTRACTION_PROMPT,
              },
            ],
          },
        ],
      }),
    });

    if (!anthropicResponse.ok) {
      const errorText = await anthropicResponse.text();
      console.error(`Anthropic API error: ${anthropicResponse.status} ${errorText}`);
      return new Response(
        JSON.stringify({
          error: "Anthropic API call failed",
          status: anthropicResponse.status,
          detail: errorText,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const anthropicData = await anthropicResponse.json();
    const rawText = anthropicData?.content?.[0]?.text;

    if (!rawText) {
      console.error("No text in Anthropic response:", JSON.stringify(anthropicData));
      return new Response(
        JSON.stringify({ error: "Empty response from Anthropic API" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Parse and validate JSON output ─────────────────────────────
    let parsed: any;
    try {
      // Strip markdown code fences if Claude wrapped the JSON
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("Failed to parse Anthropic JSON output:", rawText);
      return new Response(
        JSON.stringify({
          error: "Failed to parse JSON from Anthropic response",
          raw_output: rawText.substring(0, 500),
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Basic schema validation
    if (!parsed.carrier_name && !parsed.summary && !parsed.sections) {
      console.error("Parsed JSON missing expected fields:", JSON.stringify(parsed).substring(0, 300));
      return new Response(
        JSON.stringify({ error: "Parsed JSON does not match expected schema", raw: parsed }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(
      `[parse-loss-sheet] Parsed OK. carrier=${parsed.carrier_name}, format=${parsed.format_detected}, ` +
      `sections=${parsed.sections?.length ?? 0}, rcv=${parsed.summary?.rcv ?? "n/a"}`
    );

    // ── Build contractor scope summary ─────────────────────────────
    const scopeSummary = buildScopeSummary(parsed);

    // ── Store results in claims table ──────────────────────────────
    // Extract RCV and ACV from summary for direct column storage (F-005 fix)
    const rcvAmount = parsed.summary?.rcv ?? null;
    const acvAmount = parsed.summary?.acv ?? null;

    const { error: updateError } = await supabase
      .from("claims")
      .update({
        parsed_line_items: parsed,
        contractor_scope_summary: scopeSummary,
        loss_sheet_parsed_at: new Date().toISOString(),
        rcv_amount: rcvAmount,
        acv_amount: acvAmount,
      })
      .eq("id", claim_id);

    if (updateError) {
      console.error("Failed to update claims table:", updateError);
      return new Response(
        JSON.stringify({ error: "Failed to store parsed data", detail: updateError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Log to activity_log ────────────────────────────────────────
    const { error: logError } = await supabase
      .from("activity_log")
      .insert({
        claim_id,
        action_type: "loss_sheet_parsed",
        description: `Loss sheet parsed via ${FUNCTION_NAME}. Carrier: ${parsed.carrier_name || "unknown"}. Format: ${parsed.format_detected || "unknown"}. RCV: ${parsed.summary?.rcv ? "$" + parsed.summary.rcv.toLocaleString() : "n/a"}. Sections: ${parsed.sections?.length ?? 0}.`,
        created_at: new Date().toISOString(),
      });

    if (logError) {
      // Non-fatal — log the error but don't fail the request
      console.error("Failed to write activity_log:", logError);
    }

    console.log(`[parse-loss-sheet] Done for claim ${claim_id}.`);

    return new Response(
      JSON.stringify({
        success: true,
        claim_id,
        carrier_name: parsed.carrier_name,
        format_detected: parsed.format_detected,
        sections_count: parsed.sections?.length ?? 0,
        rcv: parsed.summary?.rcv ?? null,
        net_estimate: parsed.summary?.net_estimate ?? null,
        rate_limit_counts: rateLimitResult?.counts,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error(`[${FUNCTION_NAME}] Unexpected error:`, error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
      