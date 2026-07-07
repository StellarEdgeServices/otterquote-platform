// D-199 validate-contract-template Edge Function
// Scans a contractor's uploaded PDF for required DocuSign anchor strings (per trade × funding_type)
// and updates contractor_templates.status with the result.
//
// 3-tier escalation per D-199:
//   Tier 1 (auto):    no manualOverrides supplied → "auto_validated" or "manual_mapping_pending"
//   Tier 2 (manual):  manualOverrides supplied   → "manual_validated" or "manual_mapping_pending"
//   Tier 3 (admin):   set by admin-template-review.html (manualOverrides === "admin" string)
//
// Auth gate (added 2026-05-10, fixes Architect finding 86e1adykz):
//   All non-health-check calls require Authorization: Bearer <token>.
//   Contractor path (Tier 1 + 2): JWT verified + caller must own the template.
//   Admin path (manualOverrides === "admin"): JWT verified + caller must have app_metadata.role === "admin".
//
// Inputs (JSON POST body):
//   { contractor_template_id: uuid }                          — Tier 1 auto-validate
//   { contractor_template_id: uuid, manualOverrides: {...} }  — Tier 2 manual mapping submission
//   { contractor_template_id: uuid, manualOverrides: "admin" } — Tier 3 admin path
//   { health_check: true }                                    — keepalive ping (no auth required)
//
// Outputs:
//   { ok: true, status: "auto_validated" | "manual_validated" | "manual_mapping_pending",
//     validation_result: {...} }
//
// ClickUp: 86e15abkr · Decision: D-199 · Manifest source: data/contract-anchor-manifest.json (v2)

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.104.0";
import * as pdfjsLib from "npm:pdfjs-dist@4.0.379/legacy/build/pdf.mjs";
// Deno cannot spawn pdfjs web workers; importing the worker module sets
// globalThis.pdfjsWorker so the "fake worker" path works. Without this,
// EVERY validation failed 422 "Setting up fake worker failed" (E2E walk fix
// 2026-07-07 — no real contractor template could ever validate).
import "npm:pdfjs-dist@4.0.379/legacy/build/pdf.worker.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Inlined D-199 anchor manifest v2 (APPROVED April 30, 2026)
// Authoritative source: data/contract-anchor-manifest.json + Docs/D-199-D-202-design-artifacts/D-199-anchor-manifest-v2.md
// Update this constant when the manifest changes; do NOT fetch at runtime (avoid IO dependency).
const MANIFEST: any = {
  version: "v2",
  approvedDate: "2026-04-30",
  decision: "D-199",
  anchorOptions: { caseSensitive: true },
  trades: {
    roofing: {
      retail: {
        slot: "roofing/retail",
        requiredCount: 13,
        required: [
          { anchor: "/Customer/", field: "Homeowner signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Customer_Date/", field: "Homeowner sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "/Contractor/", field: "Contractor signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Contractor_Date/", field: "Contractor sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "Name", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: "Address:", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: "Contract Price:", field: "Total contract amount", tabType: "text", source: "Financial term" },
          { anchor: "Description:", field: "Job description / See Exhibit A", tabType: "text", source: "Scope reference (D-186)" },
          { anchor: "Material:", field: "Shingle product/brand", tabType: "text", source: "Material commitment" },
          { anchor: "Manufacturer's Warranty:", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
          { anchor: "Decking/Sheet:", field: "Per-sheet decking replacement price", tabType: "text", source: "Roofing contingency" },
          { anchor: "Start Date:", field: "Estimated start date", tabType: "text", source: "Scheduling commitment" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Single Manufacture", "Shingle Type:", "Shingle Color:", "Drip Edge Color:", "Vents", "Satellite", "Skylights", "Full Redeck:", "Permit Fee:", "Dumpster Fee:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Structures:", "Structure Names:", "Valley Type:", "Bad Decking:", "Project Notes:"],
      },
      insurance: {
        slot: "roofing/insurance",
        requiredCount: 14,
        required: [
          { anchor: "/Customer/", field: "Homeowner signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Customer_Date/", field: "Homeowner sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "/Contractor/", field: "Contractor signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Contractor_Date/", field: "Contractor sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "Name", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: "Address:", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: "Contract Price:", field: "Total contract amount (RCV-based)", tabType: "text", source: "Financial term" },
          { anchor: "Insurance Co", field: "Insurance carrier", tabType: "text", source: "Insurance-specific" },
          { anchor: "Claim #", field: "Carrier claim number", tabType: "text", source: "Insurance-specific" },
          { anchor: "DEDUCTIBLE:", field: "Homeowner deductible amount", tabType: "text", source: "Financial term" },
          { anchor: "Material:", field: "Shingle product/brand", tabType: "text", source: "Material commitment" },
          { anchor: "Manufacturer's Warranty:", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
          { anchor: "Decking/Sheet:", field: "Per-sheet decking replacement price", tabType: "text", source: "Roofing contingency" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Single Manufacture", "Shingle Type:", "Shingle Color:", "Drip Edge Color:", "Vents", "Satellite", "Skylights", "Full Redeck:", "Permit Fee:", "Dumpster Fee:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Structures:", "Structure Names:", "Valley Type:", "Bad Decking:", "Project Notes:", "Non-Recoverable Dep:", "Work Not Done:", "Description:"],
      },
    },
    siding: {
      retail: {
        slot: "siding/retail",
        requiredCount: 13,
        required: [
          { anchor: "/Customer/", field: "Homeowner signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Customer_Date/", field: "Homeowner sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "/Contractor/", field: "Contractor signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Contractor_Date/", field: "Contractor sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "Name", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: "Address:", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: "Contract Price:", field: "Total contract amount", tabType: "text", source: "Financial term" },
          { anchor: "Description:", field: "Job description / See Exhibit A", tabType: "text", source: "Scope reference (D-186)" },
          { anchor: "Siding Product:", field: "Siding product/brand", tabType: "text", source: "Material commitment" },
          { anchor: "Manufacturer's Warranty:", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
          { anchor: "Wall Substrate:", field: "Per-sheet sheathing replacement contingency", tabType: "text", source: "Siding contingency" },
          { anchor: "Start Date:", field: "Estimated start date", tabType: "text", source: "Scheduling commitment" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Siding Color:", "Siding Profile:", "Trim Color:", "Trim Material:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
      insurance: {
        slot: "siding/insurance",
        requiredCount: 14,
        required: [
          { anchor: "/Customer/", field: "Homeowner signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Customer_Date/", field: "Homeowner sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "/Contractor/", field: "Contractor signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Contractor_Date/", field: "Contractor sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "Name", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: "Address:", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: "Contract Price:", field: "Total contract amount (RCV-based)", tabType: "text", source: "Financial term" },
          { anchor: "Insurance Co", field: "Insurance carrier", tabType: "text", source: "Insurance-specific" },
          { anchor: "Claim #", field: "Carrier claim number", tabType: "text", source: "Insurance-specific" },
          { anchor: "DEDUCTIBLE:", field: "Homeowner deductible amount", tabType: "text", source: "Financial term" },
          { anchor: "Siding Product:", field: "Siding product/brand", tabType: "text", source: "Material commitment" },
          { anchor: "Manufacturer's Warranty:", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
          { anchor: "Wall Substrate:", field: "Per-sheet sheathing replacement contingency", tabType: "text", source: "Siding contingency" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Start Date:", "Siding Color:", "Siding Profile:", "Trim Color:", "Trim Material:", "Description:", "Non-Recoverable Dep:", "Work Not Done:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
    },
    gutters: {
      retail: {
        slot: "gutters/retail",
        requiredCount: 12,
        required: [
          { anchor: "/Customer/", field: "Homeowner signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Customer_Date/", field: "Homeowner sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "/Contractor/", field: "Contractor signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Contractor_Date/", field: "Contractor sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "Name", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: "Address:", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: "Contract Price:", field: "Total contract amount", tabType: "text", source: "Financial term" },
          { anchor: "Linear Feet:", field: "Gutter run linear footage", tabType: "text", source: "Scope measurement" },
          { anchor: "Gutter Size:", field: "Gutter size", tabType: "text", source: "Specification" },
          { anchor: "Downspout Count:", field: "Number of downspouts", tabType: "text", source: "Scope measurement" },
          { anchor: "Manufacturer's Warranty:", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Start Date:", "Description:", "Gutter Color:", "Gutter Guards:", "Splash Block Count:", "Hanger Spacing:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
      insurance: {
        slot: "gutters/insurance",
        requiredCount: 13,
        required: [
          { anchor: "/Customer/", field: "Homeowner signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Customer_Date/", field: "Homeowner sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "/Contractor/", field: "Contractor signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Contractor_Date/", field: "Contractor sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "Name", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: "Address:", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: "Contract Price:", field: "Total contract amount (RCV-based)", tabType: "text", source: "Financial term" },
          { anchor: "Insurance Co", field: "Insurance carrier", tabType: "text", source: "Insurance-specific" },
          { anchor: "Claim #", field: "Carrier claim number", tabType: "text", source: "Insurance-specific" },
          { anchor: "DEDUCTIBLE:", field: "Homeowner deductible amount", tabType: "text", source: "Financial term" },
          { anchor: "Linear Feet:", field: "Gutter run linear footage", tabType: "text", source: "Scope measurement" },
          { anchor: "Gutter Size:", field: "Gutter size", tabType: "text", source: "Specification" },
          { anchor: "Downspout Count:", field: "Number of downspouts", tabType: "text", source: "Scope measurement" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Start Date:", "Manufacturer's Warranty:", "Workmanship Warranty:", "Gutter Color:", "Gutter Guards:", "Splash Block Count:", "Hanger Spacing:", "Description:", "Non-Recoverable Dep:", "Work Not Done:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
    },
    windows: {
      retail: {
        slot: "windows/retail",
        requiredCount: 11,
        required: [
          { anchor: "/Customer/", field: "Homeowner signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Customer_Date/", field: "Homeowner sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "/Contractor/", field: "Contractor signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Contractor_Date/", field: "Contractor sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "Name", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: "Address:", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: "Contract Price:", field: "Total contract amount", tabType: "text", source: "Financial term" },
          { anchor: "Window Manufacturer:", field: "Window manufacturer", tabType: "text", source: "Specification" },
          { anchor: "Window Count:", field: "Number of windows", tabType: "text", source: "Scope measurement" },
          { anchor: "Manufacturer's Warranty:", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Start Date:", "Description:", "Window Series:", "Glass Package:", "Frame Color:", "Trim Notes:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
      insurance: {
        slot: "windows/insurance",
        requiredCount: 12,
        required: [
          { anchor: "/Customer/", field: "Homeowner signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Customer_Date/", field: "Homeowner sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "/Contractor/", field: "Contractor signature", tabType: "signHere", source: "HICA" },
          { anchor: "/Contractor_Date/", field: "Contractor sign date", tabType: "dateSigned", source: "HICA" },
          { anchor: "Name", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: "Address:", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: "Contract Price:", field: "Total contract amount (RCV-based)", tabType: "text", source: "Financial term" },
          { anchor: "Insurance Co", field: "Insurance carrier", tabType: "text", source: "Insurance-specific" },
          { anchor: "Claim #", field: "Carrier claim number", tabType: "text", source: "Insurance-specific" },
          { anchor: "DEDUCTIBLE:", field: "Homeowner deductible amount", tabType: "text", source: "Financial term" },
          { anchor: "Window Manufacturer:", field: "Window manufacturer", tabType: "text", source: "Specification" },
          { anchor: "Window Count:", field: "Number of windows", tabType: "text", source: "Scope measurement" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Start Date:", "Manufacturer's Warranty:", "Workmanship Warranty:", "Window Series:", "Glass Package:", "Frame Color:", "Trim Notes:", "Description:", "Non-Recoverable Dep:", "Work Not Done:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────

// CORS — D-211 Phase 16 Unit 4: matched-origin allow-list replaces wildcard "*".
// Mirrors record-attestation (D-210). Only these production origins are echoed back;
// any other Origin falls back to the canonical apex (effectively denied for browsers).
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(body: any, status = 200, corsHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  // Disable worker (Deno serverless can't spawn pdfjs workers)
  // @ts-ignore — runtime property
  pdfjsLib.GlobalWorkerOptions.workerSrc = "";
  const loadingTask = pdfjsLib.getDocument({
    data: pdfBytes,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  let fullText = "";
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str ?? "").join(" ");
    fullText += pageText + "\n";
  }
  return fullText;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // Keepalive — no auth required
    if (body.health_check === true) {
      return jsonResponse({ ok: true, function: "validate-contract-template", manifestVersion: MANIFEST.version }, 200, corsHeaders);
    }

    const { contractor_template_id } = body;
    // Use let so the admin path can clear this after role verification
    let manualOverrides = body.manualOverrides;

    if (!contractor_template_id) {
      return jsonResponse({ error: "Missing contractor_template_id" }, 400, corsHeaders);
    }

    // ─── Auth Gate ────────────────────────────────────────────────────────────
    // All non-health-check paths require a valid caller JWT.
    // Contractor path: caller must own the template (contractor_id match).
    // Admin path (manualOverrides === "admin"): caller must have app_metadata.role === "admin".
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Missing or invalid Authorization header" }, 401, corsHeaders);
    }
    const bearerToken = authHeader.slice(7);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Verify the caller's JWT
    const { data: { user }, error: authErr } = await supabase.auth.getUser(bearerToken);
    if (authErr || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
    }

    // Determine path: admin vs contractor
    const isAdminPath = manualOverrides === "admin";

    if (isAdminPath) {
      // Admin path: verify admin role in JWT claims
      const callerRole = (user.app_metadata as any)?.role;
      if (callerRole !== "admin") {
        return jsonResponse({ error: "Forbidden: admin role required" }, 403, corsHeaders);
      }
      // Clear admin flag — not used as anchor overrides downstream
      manualOverrides = undefined;
    }
    // ─── End Auth Gate ────────────────────────────────────────────────────────

    // Load template row
    const { data: tmpl, error: loadErr } = await supabase
      .from("contractor_templates")
      .select("id, contractor_id, trade, funding_type, pdf_storage_path, status")
      .eq("id", contractor_template_id)
      .single();
    if (loadErr || !tmpl) {
      return jsonResponse({ error: "Template not found", details: loadErr?.message }, 404, corsHeaders);
    }

    // Contractor path ownership check (runs after template load to avoid extra round-trip)
    if (!isAdminPath) {
      const { data: contractorRec, error: contractorErr } = await supabase
        .from("contractors")
        .select("id")
        .eq("user_id", user.id)
        .single();
      if (contractorErr || !contractorRec) {
        return jsonResponse({ error: "Forbidden: no contractor record for this user" }, 403, corsHeaders);
      }
      if (tmpl.contractor_id !== contractorRec.id) {
        return jsonResponse({ error: "Forbidden: you do not own this template" }, 403, corsHeaders);
      }
    }

    // Manifest lookup
    const tradeManifest = MANIFEST.trades?.[tmpl.trade]?.[tmpl.funding_type];
    if (!tradeManifest) {
      return jsonResponse({ error: `No manifest for ${tmpl.trade}/${tmpl.funding_type}` }, 400, corsHeaders);
    }

    // Download PDF from Supabase Storage
    const { data: pdfBlob, error: downloadErr } = await supabase.storage
      .from("contractor-templates")
      .download(tmpl.pdf_storage_path);
    if (downloadErr || !pdfBlob) {
      return jsonResponse({ error: "PDF not found in storage", path: tmpl.pdf_storage_path, details: downloadErr?.message }, 404, corsHeaders);
    }

    // Extract text
    let pdfText: string;
    try {
      const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
      pdfText = await extractPdfText(pdfBytes);
    } catch (parseErr: any) {
      return jsonResponse({ error: "Failed to parse PDF", details: parseErr.message }, 422, corsHeaders);
    }

    // Scan required anchors (case-sensitive substring match per manifest)
    // manualOverrides values may be:
    //   "alt label"  — contractor's actual PDF text for this anchor; re-scanned against the PDF
    //   anything else — not overridden
    // NOTE (D-211 Phase 16 Unit 4 — evidence integrity): a bare boolean `true` is NO LONGER
    // accepted. Previously `override === true` marked an anchor "found" with no PDF check,
    // letting a contractor self-validate a template containing none of the required anchors.
    // An override is now honored ONLY when the contractor-supplied string is actually present
    // in the PDF (stringOverrideMatch). Verified no client sends bare `true` — both contractor
    // callers (js/contract-template-validation.js, react d199-validation.tsx) build string-only
    // override maps, and the admin path clears manualOverrides before this scan.
    const anchorResults = tradeManifest.required.map((req: any) => {
      const literalMatch = pdfText.includes(req.anchor);
      const override = manualOverrides ? manualOverrides[req.anchor] : undefined;
      const stringOverride = (typeof override === "string" && override.trim().length > 0)
        ? override.trim()
        : null;
      const stringOverrideMatch = stringOverride !== null && pdfText.includes(stringOverride);
      const overridden = stringOverrideMatch;
      return {
        anchor: req.anchor,
        field: req.field,
        tabType: req.tabType,
        source: req.source,
        found: literalMatch || overridden,
        manualOverride: overridden && !literalMatch,
        manualOverrideValue: stringOverride,
      };
    });

    const optionalResults = tradeManifest.optional.map((anchor: string) => ({
      anchor,
      found: pdfText.includes(anchor),
    }));

    const requiredFoundCount = anchorResults.filter((a: any) => a.found).length;
    const allRequiredFound = requiredFoundCount === tradeManifest.required.length;

    const validationResult = {
      manifestVersion: MANIFEST.version,
      trade: tmpl.trade,
      funding_type: tmpl.funding_type,
      requiredCount: tradeManifest.requiredCount,
      requiredFoundCount,
      allRequiredFound,
      anchors: anchorResults,
      optional: optionalResults,
      validatedAt: new Date().toISOString(),
    };

    // Determine new status per D-199 state machine
    let newStatus: string;
    if (allRequiredFound) {
      newStatus = manualOverrides ? "manual_validated" : "auto_validated";
    } else {
      newStatus = "manual_mapping_pending";
    }

    const { error: updateErr } = await supabase
      .from("contractor_templates")
      .update({
        validation_result: validationResult,
        manual_overrides: manualOverrides ?? null,
        status: newStatus,
      })
      .eq("id", contractor_template_id);

    if (updateErr) {
      return jsonResponse({ error: "Failed to update template", details: updateErr.message }, 500, corsHeaders);
    }

    return jsonResponse({
      ok: true,
      status: newStatus,
      validation_result: validationResult,
    }, 200, corsHeaders);
  } catch (e: any) {
    console.error("validate-contract-template error:", e);
    return jsonResponse({ error: "Server error", message: e.message }, 500, corsHeaders);
  }
});
