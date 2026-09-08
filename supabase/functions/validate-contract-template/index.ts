// D-199 validate-contract-template Edge Function
// Scans a contractor's uploaded PDF for required signature-placement/anchor markers
// (per trade x funding_type) and updates contractor_templates.status with the result.
//
// [D-274 / #631, 2026-08-13] Re-grammared for BoldSign. DocuSign's `anchorString`
// mechanism could locate a field anywhere ORDINARY pre-existing text appeared (e.g.
// the literal word "Name" already printed in a contractor's PDF) — no special markup
// needed. BoldSign has NO equivalent. Confirmed against the live OpenAPI spec
// (api.boldsign.com/swagger/v1/swagger.json) and developer docs
// (developers.boldsign.com/text-tags/*): BoldSign's only text-based placement
// mechanism is "Text Tags" — a literal `{{FieldType|SignerIndex|Required|Label|FieldID}}`
// bracket string that must be typed into the document as its own contiguous, single-line
// run of text. There is no API-callable "find this arbitrary string and place a field
// near it" feature (BoldSign's "Anchor Text" is a human-driven web-UI-only feature in
// their template editor, not exposed via the REST API at all).
//
// Practical effect: every contractor-uploaded template that was previously validated
// under the v2 manifest (DocuSign anchors like "/Customer/", "/Contractor/", "Name",
// "Address:") is validated against the WRONG markers now — those strings no longer do
// anything at send time. Every contractor must add the new bracket tags to their PDF
// before their template will place fields correctly under BoldSign. This is a real
// operational migration (contractor communication + re-upload), not something this
// function can paper over. See the D-274 build report on issue #631 for the full
// rollout plan question this raises for Dustin.
//
// Scope-reduction decision (keeps the re-tagging burden as small as it can be):
// only anchors that ALSO drive live field PLACEMENT (the 4 signature/date anchors,
// plus the header fields that create-docusign-envelope's buildTextTabs equivalent
// auto-fills — customer_name, customer_address, contract_price, job_description,
// material_type, estimated_start, decking_per_sheet, insurance_company,
// claim_number, deductible) are converted to BoldSign bracket tags. Anchors that were
// PURE content-presence checks (e.g. "Manufacturer's Warranty:", "Wall Substrate:",
// "Linear Feet:" — proving required boilerplate/labels exist in the document, never
// wired to an auto-fill value) are UNCHANGED plain-text checks: this file's job of
// scanning extracted PDF text for a required substring is independent of BoldSign's
// API and works identically regardless of e-sign vendor. Each requirement below
// carries `mechanism: "boldsign_tag" | "label_text"` making this explicit.
//
// FRAGILE COUPLING (flagged, not solved, here): a Text Tag's SignerIndex is
// POSITIONAL — it refers to whichever signer occupies that slot in the `Signers`
// array of the send() call that uses this exact document, not a named role. This
// manifest bakes in SignerIndex 1 = contractor, 2 = homeowner, matching the fixed
// Signers order create-docusign-envelope's handleContractorSign always uses for the
// contractor_sign flow (the only flow these D-199 templates are used by — legacy
// "contract" document_type uses a different, unvalidated template path). If that
// signer order ever changes, every contractor template's baked-in tags break
// silently and would need re-tagging again. DocuSign's role-named anchors
// (/Customer/, /Contractor/) never had this coupling.
//
// 3-tier escalation per D-199 (unchanged):
//   Tier 1 (auto):    no manualOverrides supplied → "auto_validated" or "manual_mapping_pending"
//   Tier 2 (manual):  manualOverrides supplied   → "manual_validated" or "manual_mapping_pending"
//   Tier 3 (admin):   set by admin-template-review.html (manualOverrides === "admin" string)
//
// Auth gate (unchanged, added 2026-05-10, fixes Architect finding 86e1adykz):
//   All non-health-check calls require Authorization: Bearer <token>.
//   Contractor path (Tier 1 + 2): JWT verified + caller must own the template.
//   Admin path (manualOverrides === "admin"): JWT verified + caller must have app_metadata.role === "admin".
//
// Inputs (JSON POST body):
//   { contractor_template_id: uuid }                          — Tier 1 auto-validate
//   { contractor_template_id: uuid, manualOverrides: {...} }  — Tier 2 manual mapping submission
//   { contractor_template_id: uuid, manualOverrides: "admin" } — Tier 3 admin path
//   { health_check: true }                                    — keepalive ping (no auth required)
//   { revalidate_all: true, dry_run?: bool, force?: bool, template_ids?: [uuid] }
//                                                             — gh-1315 re-validation pass (service role / admin);
//                                                               dry_run defaults to TRUE; see ./revalidate.ts
//
// Outputs:
//   { ok: true, status: "auto_validated" | "manual_validated" | "manual_mapping_pending",
//     validation_result: {...} }
//
// ClickUp: 86e15abkr · Decisions: D-199, D-274 (#631) · Manifest source: ./manifest.ts (v3; version constant in _shared/template-validity.ts)

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.104.0";
import { extractPdfText } from "./pdf-text.ts";
import { MANIFEST, scanRequiredAnchors, scanOptionalAnchors } from "./manifest.ts";
import { revalidateTemplates } from "./revalidate.ts";
import {
  describeMissingMarkers,
  detectFilledProposal,
  cancellationNoticeState,
  buildExecutionPagePdf,
  appendExecutionPage,
} from "./starter-template.ts";

// ─────────────────────────────────────────────────────────────────────────────

// CORS — D-211 Phase 16 Unit 4: matched-origin allow-list replaces wildcard "*".
// Mirrors record-attestation (D-210). Only these production origins are echoed back;
// any other Origin falls back to the canonical apex (effectively denied for browsers).
// gh-1536: app-staging.otterquote.com removed — it is a Netlify DOMAIN ALIAS
// on the PRODUCTION app site, not a staging environment.
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
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

function base64FromBytes(bytes: Uint8Array): string {
  // Chunked so a multi-megabyte template does not blow the argument limit on
  // String.fromCharCode. btoa is the only base64 encoder available here.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function jsonResponse(body: any, status = 200, corsHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
    // Set by the assisted path below; reported on the validation result so the
    // contractor is told his file was rewritten and where the original went.
    let assistApplied: { archivedOriginalPath: string; pagesAdded: boolean } | null = null;

    // [#1584] The #1313 starter path (body.starter === true, below) builds a
    // blank pre-tagged PDF for a trade/funding slot straight from MANIFEST —
    // it never touches a specific contractor_template_id row, so it must not
    // be blocked by this guard. Every other path (Tier 1/2/3 validation)
    // still requires contractor_template_id exactly as before; the starter
    // request still has to clear the Auth Gate below before it can run.
    // [gh-1315] The revalidate_all path (below, service-role/admin only) walks
    // every row itself and carries no single template id either.
    if (!contractor_template_id && body.starter !== true && body.revalidate_all !== true) {
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

    // ─── gh-1315: re-validation pass (service role or admin JWT only) ────────
    // { revalidate_all: true, dry_run?: boolean (default TRUE), force?: boolean,
    //   template_ids?: uuid[] }
    // Re-runs the identical scan over every row whose validation_result is
    // missing or was produced under a manifest version other than the deployed
    // one, and reports per template what would change. Writes ONLY when
    // dry_run === false. Bearer must be the service-role key or a JWT carrying
    // app_metadata.role === "admin"; a contractor JWT is refused (403) — a
    // contractor re-validates his own row through the normal path.
    if (body.revalidate_all === true) {
      let authorized = bearerToken === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!authorized) {
        const { data: { user: rvUser }, error: rvErr } = await supabase.auth.getUser(bearerToken);
        if (rvErr || !rvUser) return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
        authorized = (rvUser.app_metadata as any)?.role === "admin";
      }
      if (!authorized) {
        return jsonResponse({ error: "Forbidden: service role or admin role required for revalidate_all" }, 403, corsHeaders);
      }
      const dryRun = body.dry_run !== false;
      const report = await revalidateTemplates({
        supabase,
        dryRun,
        force: body.force === true,
        templateIds: Array.isArray(body.template_ids) ? body.template_ids.map(String) : undefined,
        extractPdfText,
      });
      return jsonResponse(report, 200, corsHeaders);
    }

    // Verify the caller's JWT
    const { data: { user }, error: authErr } = await supabase.auth.getUser(bearerToken);
    if (authErr || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
    }

    // ─── #1313 piece 1: the pre-tagged starter ──────────────────────────────
    // "Rename the ask. 'Upload your blank contract template' - with a
    // downloadable pre-tagged starter for each trade/funding slot, because most
    // roofers will not hand-place 12 text tags in a PDF." (#1313)
    //
    // Generated FROM this file's own MANIFEST rather than kept beside it as a
    // static asset, so the starter and the validator cannot drift: every marker
    // the scan below requires is a marker the starter draws. A static PDF would
    // have been correct on the day it was made and silently wrong at the next
    // manifest revision, which is the whole reason v2 templates are all
    // invalid today.
    if (body.starter === true) {
      const sTrade = String(body.trade || "").toLowerCase();
      const sFunding = String(body.funding_type || "").toLowerCase();
      const slot = MANIFEST.trades?.[sTrade]?.[sFunding];
      if (!slot) {
        return jsonResponse({ error: `No manifest for ${sTrade}/${sFunding}` }, 400, corsHeaders);
      }
      const { data: cRec } = await supabase
        .from("contractors").select("company_name").eq("user_id", user.id).maybeSingle();
      const pdf = await buildExecutionPagePdf({
        trade: sTrade,
        fundingType: sFunding,
        requirements: slot.required,
        companyName: cRec?.company_name ?? null,
        standalone: true,
        manifestVersion: MANIFEST.version,
      });
      return jsonResponse({
        ok: true,
        filename: `otterquote-${sTrade}-${sFunding}-template-${MANIFEST.version}.pdf`,
        manifestVersion: MANIFEST.version,
        pdf_base64: base64FromBytes(pdf),
      }, 200, corsHeaders);
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

    // ─── #1313 piece 4: the assisted path ───────────────────────────────────
    // "Offer the assisted path. For a contractor who cannot tag a PDF, take
    // their contract and return a tagged version. That is what was done by hand
    // here and it took about twenty minutes." (#1313)
    //
    // His pages are copied byte-for-byte and a tagged execution page is
    // appended. Nothing of his is edited, reordered or removed - Dustin,
    // 2026-08-27: "we also aren't taking terms out, either." The page carries
    // no terms of ours; it carries the signature lines and the fields the
    // platform auto-fills, all of which already exist in any contract.
    //
    // The slot path is canonical (<contractor_id>/<trade>/<funding>.pdf) and is
    // read by BOTH contractor_templates.pdf_storage_path and the legacy
    // contractors.contract_templates JSONB that create-docusign-envelope
    // actually attaches. Writing back to the same path is what keeps those two
    // from disagreeing - a new path would have updated one and left the
    // envelope attaching the old untagged file. The original is archived first,
    // so nothing the contractor uploaded is destroyed.
    if (body.assist === true) {
      if (isAdminPath) {
        return jsonResponse({ error: "The assisted path runs as the contractor, not as admin." }, 400, corsHeaders);
      }
      const { data: origBlob, error: origErr } = await supabase.storage
        .from("contractor-templates").download(tmpl.pdf_storage_path);
      if (origErr || !origBlob) {
        return jsonResponse({ error: "PDF not found in storage", path: tmpl.pdf_storage_path, details: origErr?.message }, 404, corsHeaders);
      }
      const origBytes = new Uint8Array(await origBlob.arrayBuffer());
      let taggedBytes: Uint8Array;
      try {
        taggedBytes = await appendExecutionPage(origBytes, {
          trade: tmpl.trade,
          fundingType: tmpl.funding_type,
          requirements: tradeManifest.required,
          companyName: null,
          manifestVersion: MANIFEST.version,
        });
      } catch (assistErr: any) {
        // A PDF we cannot open is a PDF we must not silently replace.
        return jsonResponse({
          error: "Could not add the execution page to this PDF.",
          details: assistErr?.message,
          hint: "The file may be password-protected or damaged. Download the blank starter template instead and paste your terms into it.",
        }, 422, corsHeaders);
      }
      const archivePath = tmpl.pdf_storage_path.replace(/\.pdf$/i, "") +
        `-original-${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`;
      const archived = await supabase.storage.from("contractor-templates")
        .upload(archivePath, origBytes, { contentType: "application/pdf", upsert: true });
      if (archived.error) {
        return jsonResponse({ error: "Could not archive your original before replacing it; nothing was changed.", details: archived.error.message }, 500, corsHeaders);
      }
      const written = await supabase.storage.from("contractor-templates")
        .upload(tmpl.pdf_storage_path, taggedBytes, { contentType: "application/pdf", upsert: true });
      if (written.error) {
        return jsonResponse({ error: "Could not write the tagged template.", details: written.error.message, archived_original: archivePath }, 500, corsHeaders);
      }
      assistApplied = { archivedOriginalPath: archivePath, pagesAdded: true };
      // Fall through: the scan below now reads the tagged file and reports the
      // real outcome, rather than this endpoint asserting success.
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


    // Scan required anchors (case-sensitive substring match per manifest) —
    // the scan itself lives in manifest.ts so revalidate-contract-templates
    // runs the identical code path (gh-1315).
    const anchorResults = scanRequiredAnchors(pdfText, tradeManifest, manualOverrides);
    const optionalResults = scanOptionalAnchors(pdfText, tradeManifest);

    const requiredFoundCount = anchorResults.filter((a: any) => a.found).length;
    const allRequiredFound = requiredFoundCount === tradeManifest.required.length;

    // ─── #1313 piece 3: make the failure legible ────────────────────────────
    // "The validator already knows exactly which of the 13 markers are missing
    // and where they belong. Say so, per marker, with an example." (#1313)
    //
    // It always knew. What it returned was the raw tag string with a red cross
    // beside it, which describes the failure and not the fix. Indy Rooftops
    // scored 0 of 12 and was told "Upload and validate it on your profile
    // before bidding."
    const missingMarkers = describeMissingMarkers(anchorResults);

    // ─── #1313 piece 2: is this a template at all? ──────────────────────────
    // The worse of the two problems. A tagless filled PROPOSAL and a tagless
    // blank TEMPLATE failed identically, so the message never named the actual
    // mistake - and a filled proposal that DID carry the tags would have sailed
    // through to a homeowner asked to sign a contract naming somebody else's
    // house and somebody else's price.
    //
    // Deliberately a warning, not a rejection. Blocking a legitimate template
    // means a contractor who cannot onboard at all; a missed filled proposal
    // means a warning he reads. Only the tag count decides auto_validated.
    // The contractor's own letterhead address is passed in so his own address
    // cannot be the thing that accuses him.
    const { data: ownRec } = await supabase
      .from("contractors")
      .select("company_name, address_line1, address_city")
      .eq("id", tmpl.contractor_id)
      .maybeSingle();
    const filledProposal = detectFilledProposal(pdfText, {
      companyName: ownRec?.company_name ?? null,
      addressLine1: ownRec?.address_line1 ?? null,
      addressCity: ownRec?.address_city ?? null,
    });

    // IC 24-5-11-10 requires the Notice of Cancellation be furnished. Since C1
    // retired the platform-generated Document 3 (Dustin, 2026-08-27: "I don't
    // want us adding ... the notice of cancellation form"), it has to be in the
    // contractor's own template - and a template whose terms cite "the attached
    // Notice of Cancellation", as Indy Rooftops' section 11 does, now cites an
    // attachment nothing carries. Reported, never supplied.
    const cancellationNotice = cancellationNoticeState(pdfText);

    const validationResult = {
      manifestVersion: MANIFEST.version,
      trade: tmpl.trade,
      funding_type: tmpl.funding_type,
      requiredCount: tradeManifest.requiredCount,
      requiredFoundCount,
      allRequiredFound,
      anchors: anchorResults,
      optional: optionalResults,
      missingMarkers,
      filledProposal,
      cancellationNotice,
      assistApplied,
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
