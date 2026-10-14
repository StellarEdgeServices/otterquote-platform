/**
 * Otter Quotes Edge Function: admin-reissue-contract
 *
 * [gh-2543 part 2, slice 2a] Admin-only action that detaches a claim from the
 * BoldSign document it was halted on (signed_price_verdict mismatch|unverified,
 * contract_signed_at NULL) so a corrected document can be minted by the
 * existing create-docusign-envelope path ("explicitly voided" there means
 * quotes.docusign_envelope_id = NULL).
 *
 * WHAT IT DOES NOT DO (deliberately; all of it is legal position or Part 3):
 *   - never deletes a BoldSign document (no /v1/document/delete);
 *   - never claims to void a Completed document -- BoldSign cannot revoke one;
 *     a Completed document is RETAINED and only detached;
 *   - never sends any message to either party (the notice is Part 3, Dustin's words);
 *   - never mints the corrected document (the signer's next entry does, via
 *     create-docusign-envelope, at whatever price the quote then carries).
 *
 * Request (POST, Authorization: Bearer <admin JWT>):
 *   { claim_id, expected_envelope_id, confirm?: boolean }
 * Without confirm:true it is a DRY RUN: returns the plan, writes nothing.
 *
 * Order when confirmed (each step aborts everything after it):
 *   1. pre-image of the prior values to the function log (console.error);
 *   2. vendor revoke, only when the document is not finished;
 *   3. clear quotes.docusign_envelope_id AND quotes.contractor_signed_at /
 *      homeowner_signed_at in ONE guarded update (guarded by the old id, .select()).
 *      The signing marks must go with the pointer or the corrected document cannot
 *      be signed (F1, review 6163971155);
 *   4. clear the claim's pointer + halt markers (guarded by the old id, .select());
 *   5. audit row in platform_alerts_log, written only AFTER the detach succeeded, so a
 *      mid-way failure never leaves a record saying a detach happened. It carries the
 *      prior signing timestamps (copy-then-clear). If the insert fails the response
 *      says audit_written:false and the prior values are in the step 1 log line.
 *
 * R-097: deploying this function is a 3B change (it calls BoldSign and rewrites
 * claim/quote pointers). Build is a PR; deploy waits for the 24-hour notice.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { checkRowsWritten, zeroRowWriteMessage } from "../_shared/zero-row-update-guard.ts";
import { auditMessage, normalizeDocumentStatus, planReissue } from "./reissue-plan.ts";

const FN_NAME = "admin-reissue-contract";

// gh-1534: kept in sync with supabase/functions/_shared/admin.ts PRIMARY_ADMIN_EMAIL.
// The deploy path does not resolve _shared imports for constants; same single-email
// gate admin-contractor-action uses. Do not widen without an explicit decision.
const PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com";

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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function json(corsHeaders: Record<string, string>, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function boldSignBase(): string {
  return Deno.env.get("BOLDSIGN_API_BASE") || "https://api.boldsign.com";
}

function boldSignKey(): string {
  const key = Deno.env.get("BOLDSIGN_API");
  if (!key) throw new Error("BOLDSIGN_API not configured.");
  return key;
}

async function fetchDocumentStatus(documentId: string): Promise<string> {
  const res = await fetch(
    `${boldSignBase()}/v1/document/properties?documentId=${encodeURIComponent(documentId)}`,
    { headers: { "X-API-KEY": boldSignKey() } },
  );
  if (!res.ok) throw new Error(`BoldSign document/properties failed: ${res.status}`);
  const props = await res.json();
  return String(props?.status ?? "");
}

async function revokeDocument(documentId: string, message: string): Promise<void> {
  const res = await fetch(
    `${boldSignBase()}/v1/document/revoke?documentId=${encodeURIComponent(documentId)}`,
    {
      method: "POST",
      headers: { "X-API-KEY": boldSignKey(), "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    },
  );
  if (!res.ok) throw new Error(`BoldSign document/revoke failed: ${res.status}`);
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(corsHeaders, 405, { error: "POST only" });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return json(corsHeaders, 401, { error: "Missing or invalid Authorization header" });
    }
    const token = authHeader.substring(7);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) throw new Error("Supabase credentials not configured");
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: user, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user?.user || user.user.email !== PRIMARY_ADMIN_EMAIL) {
      return json(corsHeaders, 403, { error: "Unauthorized" });
    }
    const adminEmail = user.user.email as string;

    const body = await req.json().catch(() => ({}));
    const claimId = typeof body?.claim_id === "string" ? body.claim_id : "";
    const expectedEnvelopeId = typeof body?.expected_envelope_id === "string" ? body.expected_envelope_id : null;
    const confirm = body?.confirm === true;
    if (!claimId) return json(corsHeaders, 400, { error: "Missing claim_id" });

    const { data: claim, error: claimErr } = await supabase
      .from("claims")
      .select("id, signed_price_verdict, signed_price_reason, signed_contract_price, signed_price_raw, contract_signed_at, docusign_envelope_id")
      .eq("id", claimId)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claim) return json(corsHeaders, 404, { error: "Claim not found" });

    const { data: quotes, error: quoteErr } = await supabase
      .from("quotes")
      .select("id, docusign_envelope_id, contractor_signed_at, homeowner_signed_at")
      .eq("claim_id", claimId);
    if (quoteErr) throw quoteErr;

    let documentStatus = normalizeDocumentStatus(null);
    if (claim.docusign_envelope_id) {
      try {
        documentStatus = normalizeDocumentStatus(await fetchDocumentStatus(claim.docusign_envelope_id));
      } catch (statusErr) {
        console.error(`[${FN_NAME}] document status read failed (fail-closed):`, statusErr);
      }
    }

    const plan = planReissue({ claim, quotes: quotes ?? [], documentStatus, expectedEnvelopeId });
    if (!plan.ok) return json(corsHeaders, 409, { refused: true, code: plan.code, detail: plan.detail });

    if (!confirm) {
      return json(corsHeaders, 200, {
        dry_run: true,
        envelope_id: plan.envelopeId,
        document_status: documentStatus,
        vendor_action: plan.vendorAction,
        quotes_detached: plan.quoteIds,
        note: "Nothing was written. Re-send with confirm:true to execute.",
      });
    }

    // 1. Pre-image to the log: the only record of the prior values if the audit insert (step 5) fails.
    console.error(`[${FN_NAME}] PRE-IMAGE (detach about to run) ${auditMessage({ claim, plan, adminEmail, documentStatus }).replace('detach COMPLETED', 'detach NOT YET DONE')}`);

    // 2. Vendor: revoke only a document that has not finished. Completed is retained.
    if (plan.vendorAction === "revoke") {
      // Neutral on purpose: BoldSign may email the revoke message to signers, and a
      // statement to a party about their contract is Part 3 (Dustin's words, 6015863834).
      // Do not put substantive wording here until BoldSign is confirmed NOT to send it.
      await revokeDocument(plan.envelopeId, "Document revoked by administrator");
    }

    // 3. Detach quotes (guarded by the old id so a concurrent re-mint is never clobbered).
    for (const quoteId of plan.quoteIds) {
      const { data: qRows, error: qErr } = await supabase
        .from("quotes")
        .update(plan.quoteClear)
        .eq("id", quoteId)
        .eq("docusign_envelope_id", plan.envelopeId)
        .select("id");
      if (qErr) throw qErr;
      if (!checkRowsWritten(qRows).wroteRows) {
        console.error(zeroRowWriteMessage(FN_NAME, `quotes.docusign_envelope_id for quote ${quoteId}`));
        return json(corsHeaders, 409, { error: "Quote pointer changed underneath this action; stopped", quote_id: quoteId });
      }
    }

    // 4. Detach the claim and clear the halt markers (so the admin list drops it).
    const { data: cRows, error: cErr } = await supabase
      .from("claims")
      .update(plan.claimClear)
      .eq("id", claimId)
      .eq("docusign_envelope_id", plan.envelopeId)
      .select("id");
    if (cErr) throw cErr;
    if (!checkRowsWritten(cRows).wroteRows) {
      console.error(zeroRowWriteMessage(FN_NAME, `claims pointer clear for claim ${claimId}`));
      return json(corsHeaders, 409, { error: "Claim pointer changed underneath this action; quotes were already detached", claim_id: claimId });
    }

    // 5. Audit row, only now that the detach is done.
    const { error: auditErr } = await supabase.from("platform_alerts_log").insert({
      alert_type: "contract_reissue_detach",
      function_name: FN_NAME,
      message: auditMessage({ claim, plan, adminEmail, documentStatus }),
      sent_at: new Date().toISOString(),
    });
    if (auditErr) console.error(`[${FN_NAME}] audit insert failed AFTER a successful detach; see PRE-IMAGE log line:`, auditErr);

    return json(corsHeaders, 200, {
      success: true,
      audit_written: !auditErr,
      quote_prior_marks: plan.quotePrior,
      claim_id: claimId,
      detached_envelope_id: plan.envelopeId,
      vendor_action: plan.vendorAction,
      document_deleted: false,
      quotes_detached: plan.quoteIds,
    });
  } catch (error) {
    console.error(`[${FN_NAME}] error:`, error);
    return json(corsHeaders, 500, { error: error instanceof Error ? error.message : "Unexpected error" });
  }
});
