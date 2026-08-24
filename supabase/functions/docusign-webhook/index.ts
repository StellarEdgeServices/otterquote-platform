/**
 * OtterQuote Edge Function: docusign-webhook
 *
 * [D-274 / #631, 2026-08-13] Re-platformed from DocuSign Connect to BoldSign.
 * File path/name intentionally UNCHANGED for this PR (keeps the webhook URL
 * stable; a follow-up rename to a vendor-neutral name is recommended at
 * cutover, not bundled with this functional swap — see the D-274 build
 * report on issue #631). Everything downstream of "the envelope/document is
 * complete" — payment charging, dunning, D-269 acknowledgment backstop,
 * D-149 counter-sign nudges, D-215 invoice fan-out, homeowner/contractor
 * notifications — is UNCHANGED business logic. Only the vendor-specific
 * edges changed: signature verification, payload parsing, and the
 * authoritative-state API fallback (ack-verify.ts).
 *
 * Receives BoldSign webhook notifications when a document's signing status
 * changes. Updates claims table on signing completion, decline, or revoke.
 *
 * Environment variables:
 *   BOLDSIGN_WEBHOOK_HMAC_SECRET — per-webhook signing secret from the BoldSign
 *     dashboard (Webhooks -> this webhook -> "Reveal"). NOT account-wide; each
 *     webhook endpoint you register in BoldSign has its own secret.
 *   BOLDSIGN_API — BoldSign API key (X-API-KEY), used only for the ack-verify
 *     authoritative-state fallback call (GET /v1/document/properties).
 *   SUPABASE_URL — auto-provided by Supabase.
 *   EF_OPERATOR_TOKEN — dedicated shared secret for the server-to-server call to
 *     create-invoice (see the [D-274] comment block below the imports).
 *
 * Credential pattern: this function reads the Supabase service-role-equivalent
 * value via SUPABASE_SECRET_KEYS (JSON.parse(...)['default']) per the D-274
 * mandatory key pattern, NOT the legacy auto-injected SUPABASE_SERVICE_ROLE_KEY
 * — see getServiceRoleKey() below. Falls back to the legacy var only if
 * SUPABASE_SECRET_KEYS is not yet populated in this environment (defensive;
 * should not trigger once the parallel key-rotation workstream lands here).
 *
 * BoldSign sends JSON payloads to this endpoint. The webhook URL is:
 *   https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/docusign-webhook
 * (This URL must be registered as a BoldSign webhook manually in the BoldSign
 * dashboard — see the D-274 build report for the exact cutover checklist.)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parsePayload } from "./payload-parser.ts";
import { evaluateAcknowledgment, fetchDocumentSignerStatus } from "./ack-verify.ts";

// ── 86e1tz17j: best-effort Sentry reporter for swallowed audit-write failures ──
// Inlined (not imported from _shared) because the EF body-deploy path does not
// resolve _shared imports — same precedent as create-docusign-envelope's inlined
// getHomeownerName. No-ops to console.error until SENTRY_DSN is set, so it is safe
// to deploy before the secret exists. Never throws; callers stay non-fatal.
async function reportToSentry(
  error: unknown,
  ctx: { fn: string; op?: string; extra?: Record<string, unknown> },
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[sentry:${ctx.fn}${ctx.op ? ":" + ctx.op : ""}]`, message, ctx.extra ?? "");
  const dsn = Deno.env.get("SENTRY_DSN");
  if (!dsn) return; // graceful no-op until the secret is configured
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, "");
    if (!projectId) return;
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const sentAt = new Date().toISOString();
    const event = {
      event_id: eventId, timestamp: sentAt, platform: "javascript", level: "error",
      logger: `edge.${ctx.fn}`,
      environment: Deno.env.get("SENTRY_ENVIRONMENT") || "production",
      tags: { fn: ctx.fn, ...(ctx.op ? { op: ctx.op } : {}) },
      extra: ctx.extra ?? {},
      exception: { values: [{ type: error instanceof Error ? error.name : "EdgeFunctionError", value: message }] },
    };
    const envelope =
      JSON.stringify({ event_id: eventId, sent_at: sentAt }) + "\n" +
      JSON.stringify({ type: "event" }) + "\n" + JSON.stringify(event) + "\n";
    await fetch(`${u.protocol}//${u.host}/api/${projectId}/envelope/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=otterquote-ef/1.0, sentry_key=${u.username}` },
      body: envelope,
    });
  } catch (postErr) {
    console.error("[sentry] post failed (non-fatal):", postErr);
  }
}

// CORS tightened (Session 254): origin-allowlisted instead of wildcard.
// Webhook traffic is server-to-server (no Origin header); browser probes
// fall back to the first allowed origin.
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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-boldsign-signature",
    "Vary": "Origin",
  };
}

// [D-274 / #631] Service-role-equivalent credential via the new secret-key
// rotation pattern, NOT the legacy auto-injected SUPABASE_SERVICE_ROLE_KEY.
// Falls back to the legacy var if SUPABASE_SECRET_KEYS is not yet populated
// in this environment — defensive only; should not trigger once the parallel
// key-migration workstream lands on this project. Every function touched by
// this build uses this same helper (duplicated per-function, matching this
// repo's existing "inline, don't import _shared" convention — the EF
// body-deploy path does not resolve _shared imports, see
// create-docusign-envelope's inlined getHomeownerName for precedent).
function getServiceRoleKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.default) return parsed.default as string;
    } catch (_e) {
      console.warn("[docusign-webhook] SUPABASE_SECRET_KEYS present but not valid JSON — falling back to legacy key");
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

// ========== GA4 MEASUREMENT PROTOCOL ==========
async function sendGA4Event(eventName: string, params: Record<string, unknown> = {}): Promise<void> {
  const measurementId = Deno.env.get("GA4_MEASUREMENT_ID");
  const apiSecret = Deno.env.get("GA4_API_SECRET");
  if (!measurementId || !apiSecret) return;
  try {
    await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "server",
          events: [{ name: eventName, params }],
        }),
      }
    );
  } catch (_) { /* non-fatal */ }
}

// ========== HMAC VERIFICATION ==========
// [D-274 / #631] BoldSign's webhook signature scheme (confirmed against
// developers.boldsign.com/webhooks/verify-webhook-events/) differs from
// DocuSign Connect's on every axis: header name, message construction, and
// encoding.
//   Header:  X-BoldSign-Signature: t=<unix_epoch>, s0=<hex_hmac_sha256>
//            (optionally also s1=<...> during BoldSign-side key rotation —
//            accept a match against ANY sN value present, same posture
//            Stripe/similar webhook schemes use for rotation windows)
//   Message: "{timestamp}.{raw_request_body}"  — NOT the raw body alone.
//   Digest:  HMAC-SHA256, HEX-encoded — NOT base64 (DocuSign's scheme).
//   Secret:  per-webhook, provisioned in the BoldSign dashboard on that
//            webhook's overview page (Reveal button) — NOT an account-wide
//            secret. BOLDSIGN_WEBHOOK_HMAC_SECRET must be the secret for
//            THIS specific webhook registration.
// The doc's own implementation note: verification must use the RAW request
// body — any JSON re-serialization invalidates the signature. This function
// is called with `rawBody` (the unparsed req.text() result) for exactly that
// reason, mirroring the DocuSign implementation's same care.
function parseSignatureHeader(header: string): { timestamp: string | null; digests: string[] } {
  const parts = header.split(",").map((p) => p.trim());
  let timestamp: string | null = null;
  const digests: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (/^s\d+$/.test(key)) digests.push(value);
  }
  return { timestamp, digests };
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function verifyHmacSignature(
  payload: string,
  signatureHeader: string | null,
  hmacKey: string
): Promise<boolean> {
  if (!signatureHeader || !hmacKey) {
    console.warn("Missing signature header or HMAC key — skipping verification");
    // In development/sandbox, allow unsigned requests
    // In production, return false to reject unsigned requests
    return !hmacKey; // Allow if no key configured, reject if key exists but no signature
  }

  const { timestamp, digests } = parseSignatureHeader(signatureHeader);
  if (!timestamp || digests.length === 0) {
    console.warn("X-BoldSign-Signature header did not parse (expected 't=...,s0=...')");
    return false;
  }

  const message = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(hmacKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  const computedSignature = hexEncode(new Uint8Array(signatureBuffer));

  return digests.some((d) => constantTimeEqual(computedSignature, d));
}

// ========== MAIN HANDLER ==========
serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only accept POST
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = getServiceRoleKey();
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Read raw body for HMAC verification
    const rawBody = await req.text();

    // Verify HMAC signature if configured
    const hmacKey = Deno.env.get("BOLDSIGN_WEBHOOK_HMAC_SECRET") || "";
    const signatureHeader = req.headers.get("x-boldsign-signature");

    // U15-3 (carried forward): HMAC fail-CLOSED behind a flag. When
    // BOLDSIGN_REQUIRE_SIGNATURE === 'true', a valid signature is MANDATORY
    // regardless of key presence — reject (401) if the HMAC key is unset, the
    // x-boldsign-signature header is missing, OR verification fails. When the
    // flag is unset/'false' (default), behavior is fail-OPEN (verify only when
    // a key is configured), so this PR is safe to merge/deploy before the
    // secret is confirmed; flipping to fail-closed is then a pure config
    // change. Renamed from DOCUSIGN_REQUIRE_SIGNATURE — same semantics.
    const requireSignature =
      Deno.env.get("BOLDSIGN_REQUIRE_SIGNATURE") === "true";

    if (requireSignature) {
      const isValid =
        !!hmacKey &&
        !!signatureHeader &&
        (await verifyHmacSignature(rawBody, signatureHeader, hmacKey));
      if (!isValid) {
        console.error(
          "HMAC signature verification failed (fail-closed: DOCUSIGN_REQUIRE_SIGNATURE=true)"
        );
        return new Response(
          JSON.stringify({ error: "Invalid signature" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.log("HMAC signature verified (fail-closed)");
    } else if (hmacKey) {
      const isValid = await verifyHmacSignature(rawBody, signatureHeader, hmacKey);
      if (!isValid) {
        console.error("HMAC signature verification failed");
        return new Response(
          JSON.stringify({ error: "Invalid signature" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.log("HMAC signature verified");
    }

    // Parse the payload
    const payload = JSON.parse(rawBody);

    // [D-274 / #631] BoldSign sends a single documented payload shape
    // (event/context/data, data.documentId, data.status, data.signerDetails[])
    // — see payload-parser.ts's header comment for the confirmed shape and
    // the status-vocabulary mapping (BoldSign's "Revoked"/"Expired" -> this
    // codebase's "voided"). parsePayload (./payload-parser.ts) is a pure,
    // unit-tested helper; historical note preserved for context: the
    // DocuSign-era version of this function had three payload variants
    // (rich/flat/lean) and a real production bug (Phase 18, "0 fees ever")
    // from the lean variant being dropped as unrecognized — BoldSign has no
    // known lean/metadata-only variant, but parsePayload stays defensive
    // (recognized:false on any malformed input) on the same principle.
    const parsed = parsePayload(payload);
    if (!parsed.recognized) {
      console.warn("Unrecognized payload format:", JSON.stringify(payload).slice(0, 500));
      return new Response(
        JSON.stringify({ received: true, warning: "Unrecognized payload format" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const {
      envelopeId,
      status,
      recipientEmail,
      completedDateTime,
      declinedDateTime,
      voidedDateTime,
      event,
    } = parsed;

    if (!envelopeId) {
      console.warn("No envelopeId in payload");
      return new Response(
        JSON.stringify({ received: true, warning: "No envelopeId" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Webhook received: envelope=${envelopeId}, status=${status}, event=${event}`);

    // ========== FIND THE CLAIM ==========
    // [D-274 / #631, carried forward from closed #421 as an explicit acceptance
    // criterion] Look up claim by docusign_envelope_id, color_confirmation_envelope_id,
    // OR project_confirmation_envelope_id. The prior implementation omitted the third
    // column — a completed project_confirmation envelope could never be found here at
    // all, so its signature was silently never persisted. This is the fix.
    const { data: claim, error: claimError } = await supabase
      .from("claims")
      // Merge resolution, 2026-08-24 (Bridge). Two independent additions to
      // the same two lines, both kept:
      //   main     — `is_test` (gh-1028, activity_log test-row propagation)
      //   BoldSign — `project_confirmation_envelope_id` in BOTH the select and
      //              the .or(), which is the #421/#631 acceptance criterion:
      //              without it a completed project_confirmation envelope
      //              could never be found, let alone persisted.
      // Dropping either one silently breaks the thing it was added for.
      .select(
        "id, status, docusign_envelope_id, color_confirmation_envelope_id, project_confirmation_envelope_id, contract_signed_at, is_test"
      )
      .or(
        `docusign_envelope_id.eq.${envelopeId},color_confirmation_envelope_id.eq.${envelopeId},project_confirmation_envelope_id.eq.${envelopeId}`
      )
      .limit(1)
      .single();

    if (claimError || !claim) {
      console.warn(`No claim found for envelope ${envelopeId}:`, claimError?.message);
      // Return 200 anyway — BoldSign will retry on non-2xx
      return new Response(
        JSON.stringify({ received: true, warning: "No matching claim found" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isContract = claim.docusign_envelope_id === envelopeId;
    const isColorConfirmation = claim.color_confirmation_envelope_id === envelopeId;
    const isProjectConfirmation = claim.project_confirmation_envelope_id === envelopeId;

    console.log(
      `Matched claim ${claim.id} (${
        isContract ? "contract" : isColorConfirmation ? "color_confirmation" : "project_confirmation"
      })`
    );

    // ========== SIGNER STATUS (D-274 / #631) ==========
    // BoldSign's webhook payload DOES carry per-signer status directly
    // (data.signerDetails — confirmed against developers.boldsign.com's
    // sample-event-data page, unlike the shorter event-metadata page which
    // only shows the bare `event` block). payload-parser.ts's `parsed.signerDetails`
    // is that array, normalized to { clientUserId, status: lowercase,
    // signedDateTime: null, email } so the `s.clientUserId === "contractor_1"` /
    // `"homeowner_1"` matching further down is UNCHANGED from the DocuSign
    // implementation — create-docusign-envelope sets signers[].id to exactly
    // those two strings at send time (see handleContractorSign), the same
    // convention DocuSign's clientUserId used. No live API call needed for
    // this coarse status (unlike the D-269 ack backstop below, which DOES need
    // one — BoldSign's webhook payload never includes per-field formFields
    // data, only signer-level status).
    const signerStatusList: any[] = parsed.signerDetails;

    // ========== CONTRACTOR SIGNING TRACKING ==========
    // On every contract envelope event, check signer status. If the contractor
    // signer (clientUserId: "contractor_1") has completed, write contractor_signed_at
    // to the matching quote. Covers both intermediate events (contractor signed,
    // homeowner pending) and the final completed event (all signed). Idempotent
    // via IS NULL guard.
    if (isContract) {
      const allSigners: any[] = signerStatusList;
      const contractorSigner = allSigners.find(
        (s: any) => s.clientUserId === "contractor_1" && s.status === "completed"
      );
      if (contractorSigner) {
        const { data: contractorQuote } = await supabase
          .from("quotes")
          .select("id, contractor_signed_at")
          .eq("docusign_envelope_id", envelopeId)
          .is("contractor_signed_at", null)
          .maybeSingle();
        if (contractorQuote) {
          const { error: csErr } = await supabase
            .from("quotes")
            .update({
              contractor_signed_at: contractorSigner.signedDateTime || new Date().toISOString(),
            })
            .eq("id", contractorQuote.id);
          if (csErr) {
            console.error(`Failed to write contractor_signed_at for quote ${contractorQuote.id}:`, csErr);
          } else {
            console.log(`contractor_signed_at written for quote ${contractorQuote.id} (claim ${claim.id})`);
          }
        }
      }
    }

    // ========== D-149 COUNTER-SIGNATURE NUDGE (86e1gabf4) ==========
    // Immediate Mailgun nudge to the CONTRACTOR at the homeowner-signed
    // transition: homeowner_1 completed while contractor_1 has not. The check
    // is routing-order-agnostic, so it covers both signer orderings used by
    // create-docusign-envelope. Runs AFTER HMAC verification and AFTER the
    // contractor_signed_at tracking write above — nothing upstream changes.
    //
    // Entirely NON-FATAL: every failure logs and falls through so DocuSign
    // Connect always receives the normal success response (never an error
    // because Mailgun or a lookup hiccuped).
    //
    // State marker: a `notifications` row (channel 'system',
    // notification_type 'countersign_nudge_pending') is inserted BEFORE the
    // send. It is (a) the idempotency guard for this immediate nudge across
    // repeated webhook events, and (b) the work queue drained by the scheduled
    // counter-sig-reminders EF for the 2-hour business-hours cadence.
    // activity_log is deliberately NOT used: its live schema has NOT NULL
    // user_id + title and an event_type CHECK, which reject webhook-context
    // inserts (86e1tz17j audit-write class).
    if (isContract && status !== "completed" && status !== "declined" && status !== "voided") {
      try {
        const nudgeSigners: any[] = signerStatusList;
        const homeownerCompleted = nudgeSigners.find(
          (s: any) => s.clientUserId === "homeowner_1" && s.status === "completed"
        );
        const contractorCompleted = nudgeSigners.find(
          (s: any) => s.clientUserId === "contractor_1" && s.status === "completed"
        );

        if (homeownerCompleted && !contractorCompleted) {
          // Idempotency: at most one pending-marker (and one immediate nudge)
          // per envelope, no matter how many webhook events repeat this state.
          const { data: existingMarker } = await supabase
            .from("notifications")
            .select("id")
            .eq("notification_type", "countersign_nudge_pending")
            .like("message_preview", `envelope=${envelopeId};%`)
            .limit(1)
            .maybeSingle();

          if (!existingMarker) {
            // Resolve the awaiting quote + contractor. Contact data comes from
            // the PRIVATE contractors table — contractors_public has no
            // contact columns.
            const { data: nudgeQuote } = await supabase
              .from("quotes")
              .select("id, contractor_id")
              .eq("docusign_envelope_id", envelopeId)
              .is("contractor_signed_at", null)
              .maybeSingle();

            if (nudgeQuote?.contractor_id) {
              const { data: nudgeContractor } = await supabase
                .from("contractors")
                .select("id, contact_name, company_name, email, notification_emails")
                .eq("id", nudgeQuote.contractor_id)
                .single();

              const nudgeRecipients: string[] = [];
              if (nudgeContractor?.email) nudgeRecipients.push(nudgeContractor.email);
              if (Array.isArray(nudgeContractor?.notification_emails)) {
                for (const e of nudgeContractor.notification_emails) {
                  if (e && !nudgeRecipients.includes(e)) nudgeRecipients.push(e);
                }
              }

              if (nudgeRecipients.length > 0) {
                const homeownerSignedAt =
                  homeownerCompleted.signedDateTime || new Date().toISOString();

                // Marker FIRST (claim the send) so a crash after Mailgun cannot
                // produce duplicate immediate nudges on the next webhook event.
                const { error: markerErr } = await supabase.from("notifications").insert({
                  claim_id: claim.id,
                  channel: "system",
                  notification_type: "countersign_nudge_pending",
                  recipient: nudgeRecipients[0],
                  message_preview: `envelope=${envelopeId};homeowner_signed_at=${homeownerSignedAt}`,
                });
                if (markerErr) {
                  // Loud: without the marker the scheduled reminder cadence
                  // will not see this envelope. The immediate email still goes
                  // out below.
                  console.error(
                    `[D-149] countersign_nudge_pending marker insert failed for envelope ${envelopeId}:`,
                    markerErr
                  );
                  await reportToSentry(markerErr, {
                    fn: "docusign-webhook",
                    op: "notifications.insert",
                    extra: { notification_type: "countersign_nudge_pending", claim_id: claim.id },
                  });
                }

                // Property address + Job # for the email body (same
                // derivations as the D-225 C5 homeowner fan-out below).
                let nudgeAddress = "your project";
                const { data: nudgeClaimRow } = await supabase
                  .from("claims")
                  .select("property_address")
                  .eq("id", claim.id)
                  .single();
                if (nudgeClaimRow?.property_address) nudgeAddress = nudgeClaimRow.property_address;
                const nudgeJobNumber = `Job #${(claim.id || "").slice(-8).toUpperCase()}`;
                const contractorDashboardUrl = "https://otterquote.com/contractor-dashboard.html";
                const nudgeName = nudgeContractor?.contact_name || "Contractor";

                const nudgeSubject = "The homeowner has signed — your counter-signature is needed";
                const nudgeText =
                  `Hi ${nudgeName},\n\n` +
                  `Good news — the homeowner has signed the contract for ${nudgeAddress} (${nudgeJobNumber}).\n\n` +
                  `The contract is now waiting on your counter-signature. Once you sign, the agreement is fully executed and the project can move forward.\n\n` +
                  `Counter-sign from your dashboard:\n${contractorDashboardUrl}\n\n` +
                  `We'll send you a reminder every couple of hours during business hours until the contract is fully executed.\n\n` +
                  `Questions? Reply to this email or call (844) 875-3412.\n\n` +
                  `— The Otter Quotes Team`;
                const nudgeHtml =
                  `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">` +
                  `<p>Hi ${nudgeName},</p>` +
                  `<p>Good news — the homeowner has signed the contract for <strong>${nudgeAddress}</strong> (${nudgeJobNumber}).</p>` +
                  `<p>The contract is now waiting on <strong>your counter-signature</strong>. Once you sign, the agreement is fully executed and the project can move forward.</p>` +
                  `<p><a href="${contractorDashboardUrl}" style="color:#0066cc;">Counter-sign from your dashboard</a></p>` +
                  `<p>We'll send you a reminder every couple of hours during business hours until the contract is fully executed.</p>` +
                  `<p>Questions? Reply to this email or call (844) 875-3412.</p>` +
                  `<p>— The Otter Quotes Team</p></body></html>`;

                const nudgeApiKey = Deno.env.get("MAILGUN_API_KEY") || "";
                // MAILGUN_DOMAIN with a fallback to the domain already
                // hardcoded in this file's D-225 C5 block — this EF's secrets
                // may predate the MAILGUN_DOMAIN var.
                const nudgeDomain = Deno.env.get("MAILGUN_DOMAIN") || "mail.otterquote.com";
                if (nudgeApiKey) {
                  for (const recipient of nudgeRecipients) {
                    const fd = new FormData();
                    fd.append("from", `Otter Quotes <notifications@${nudgeDomain}>`);
                    fd.append("to", recipient);
                    fd.append("subject", nudgeSubject);
                    fd.append("text", nudgeText);
                    fd.append("html", nudgeHtml);
                    const nudgeResp = await fetch(
                      `https://api.mailgun.net/v3/${nudgeDomain}/messages`,
                      {
                        method: "POST",
                        headers: { Authorization: `Basic ${btoa(`api:${nudgeApiKey}`)}` },
                        body: fd,
                      }
                    );
                    console.log(
                      `[D-149] immediate counter-sign nudge Mailgun status=${nudgeResp.status} to=${recipient} envelope=${envelopeId}`
                    );
                  }
                } else {
                  console.warn("[D-149] MAILGUN_API_KEY not configured — immediate counter-sign nudge skipped");
                }
              } else {
                console.warn(`[D-149] contractor ${nudgeQuote.contractor_id} has no email — nudge skipped`);
              }
            } else {
              console.warn(`[D-149] no un-countersigned quote for envelope ${envelopeId} — nudge skipped`);
            }
          }
        }
      } catch (nudgeErr) {
        // Non-fatal by contract: the webhook must still return its normal
        // success response to DocuSign Connect.
        console.error("[D-149] immediate counter-sign nudge failed (non-fatal):", nudgeErr);
      }
    }

    // ========== UPDATE CLAIM BASED ON STATUS ==========
    const updateData: Record<string, any> = {};
    let shouldNotifyContractor = false;

    if (status === "completed") {
      // Envelope fully signed by all parties
      await sendGA4Event("envelope_signed", { envelope_id: envelopeId, claim_id: claim.id });
      if (isContract) {
        // ========== D-269 ACKNOWLEDGMENT BACKSTOP (#550) ==========
        // Field-level enforcement is the inline sign-type Text Tag on the
        // generated compliance addendum (D-274 equivalent of the D-123
        // signHere swap in create-docusign-envelope); this is the
        // completion-side backstop. Invariant (CEO decision D-269,
        // 2026-07-13): no silently-accepted contract without the
        // otterquote_acknowledgment field satisfied — a defective envelope
        // must NOT reach the clean contract_signed/charge path below.
        //
        // [D-274 / #631] Unlike the DocuSign version, there is no
        // "payload sometimes has tab data" fast path to try first —
        // BoldSign's webhook payload never includes per-field formFields
        // (confirmed, see payload-parser.ts header comment). This always
        // calls the authoritative API.
        try {
          let ackEval = evaluateAcknowledgment(await fetchDocumentSignerStatus(envelopeId));
          if (ackEval.state === "indeterminate") {
            // The API answered but returned no field data at all — treat as
            // missing: acknowledgment cannot be demonstrated.
            ackEval = { state: "defect", via: "field_missing", detail: ackEval.detail };
          }

          if (ackEval.state === "defect") {
            console.error(
              `[D-269] acknowledgment defect on completed envelope ${envelopeId} (claim ${claim.id}): ${ackEval.detail}`
            );
            // (1) Ops alert — existing incident convention.
            try {
              await supabase.from("platform_alerts_log").insert({
                alert_type: "ack_defect_on_completed",
                function_name: "docusign-webhook",
                message:
                  `D-269: envelope ${envelopeId} completed WITHOUT a satisfied otterquote_acknowledgment ` +
                  `field (claim ${claim.id}; ${ackEval.detail}). Clean completion halted — contract_signed ` +
                  `not set, no fee charge. Manual review: void/resend the envelope or record GC disposition.`,
              });
            } catch (alertErr) {
              await reportToSentry(alertErr, {
                fn: "docusign-webhook",
                op: "platform_alerts_log.insert",
                extra: { alert_type: "ack_defect_on_completed", claim_id: claim.id },
              });
            }
            // (2) Sentry — the defect itself, not just insert failures.
            await reportToSentry(
              new Error(`D-269 acknowledgment defect: envelope ${envelopeId} (${ackEval.detail})`),
              { fn: "docusign-webhook", op: "ack-backstop", extra: { envelope_id: envelopeId, claim_id: claim.id } }
            );
            // (3) Claim-keyed defect record (idempotent marker — same
            // notifications convention as countersign_nudge_pending; the
            // activity_log NOT-NULL/CHECK constraints reject webhook-context
            // inserts, per 86e1tz17j).
            try {
              const { data: existingDefect } = await supabase
                .from("notifications")
                .select("id")
                .eq("notification_type", "ack_defect_pending")
                .like("message_preview", `envelope=${envelopeId};%`)
                .limit(1)
                .maybeSingle();
              if (!existingDefect) {
                await supabase.from("notifications").insert({
                  claim_id: claim.id,
                  channel: "system",
                  notification_type: "ack_defect_pending",
                  recipient: "ops",
                  message_preview: `envelope=${envelopeId};via=${ackEval.via};detail=${ackEval.detail}`,
                });
              }
            } catch (recErr) {
              await reportToSentry(recErr, {
                fn: "docusign-webhook",
                op: "notifications.insert",
                extra: { notification_type: "ack_defect_pending", claim_id: claim.id },
              });
            }
            // Halt: 200 so Connect does not retry forever — the defect is
            // recorded and alerted; remediation is manual by design.
            return new Response(
              JSON.stringify({ received: true, defect: "otterquote_acknowledgment", claim_id: claim.id }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          console.log(`[D-269] acknowledgment verified for envelope ${envelopeId} (via ${ackEval.via})`);
        } catch (ackErr) {
          // Verification INFRASTRUCTURE failure (BoldSign auth/API). Loud but
          // fail-open: the inline sign-type field already enforced the
          // requirement at signing time, and halting completion on an API
          // blip would strand legitimately signed contracts (payment never
          // charged, claim never marked).
          console.error("[D-269] acknowledgment verification errored (proceeding, alerted):", ackErr);
          try {
            await supabase.from("platform_alerts_log").insert({
              alert_type: "ack_verify_error",
              function_name: "docusign-webhook",
              message:
                `D-269: could not verify otterquote_acknowledgment for envelope ${envelopeId} ` +
                `(claim ${claim.id}): ${ackErr instanceof Error ? ackErr.message : String(ackErr)}. ` +
                `Completion proceeded on the field's signing-time requirement; verify manually.`,
            });
          } catch (alertErr) {
            console.error("platform_alerts_log insert failed:", alertErr);
          }
          await reportToSentry(ackErr, {
            fn: "docusign-webhook",
            op: "ack-backstop-verify",
            extra: { envelope_id: envelopeId, claim_id: claim.id },
          });
        }

        // ========== HANDLE PAYMENT CHARGING (D-127) ==========
        // Contract signed → charge contractor → release to contractor (if payment succeeds)
        // This is the critical D-127 flow: payment AFTER signing, not at selection

        if (!claim.contract_signed_at) {
          // Not yet marked signed — time to charge
          console.log(`Contract signed for claim ${claim.id}. Attempting payment charge...`);

          // U15-2: hoisted so the de-blinding `catch (paymentErr)` below can name the
          // contractor/quote even though both are looked up inside the try block.
          let quoteIdForAlert: string | null = null;
          let contractorIdForAlert: string | null = null;

          try {
            // Look up the winning quote to get contractor ID and amount
            const { data: quote, error: quoteErr } = await supabase
              .from("quotes")
              .select("id, contractor_id, total_price, payment_status, platform_fee_pct")
              .eq("claim_id", claim.id)
              .eq("status", "selected")
              .single();

            if (quoteErr || !quote) {
              throw new Error(
                `Could not find awarded quote for claim ${claim.id}: ${quoteErr?.message || "not found"}`
              );
            }
            // U15-2: capture identifiers for the de-blinding alert (catch below).
            quoteIdForAlert = quote.id;
            contractorIdForAlert = quote.contractor_id;

            // Get contractor's Stripe info
            const { data: contractor, error: contractorErr } = await supabase
              .from("contractors")
              .select(
                "id, stripe_customer_id, stripe_payment_method_id, company_name"
              )
              .eq("id", quote.contractor_id)
              .single();

            if (contractorErr || !contractor) {
              throw new Error(
                `Could not find contractor ${quote.contractor_id}: ${contractorErr?.message || "not found"}`
              );
            }

            if (
              !contractor.stripe_customer_id ||
              !contractor.stripe_payment_method_id
            ) {
              // U15-2: distinct signed-but-unbilled state. No card on file at signing
              // (pre-charge) — record 'no_method' on the selected quote so this stall is
              // queryable and distinct from 'dunning' (a charge was attempted + declined).
              // Leave payment_intent_id null and do NOT set contract_signed_at; the throw
              // below is then de-blinded by the augmented catch (alert + activity_log).
              await supabase
                .from("quotes")
                .update({ payment_status: "no_method" })
                .eq("id", quote.id);
              throw new Error(
                `Contractor ${contractor.id} does not have payment method on file`
              );
            }

            // Fetch platform fee percentage (fallback only — per-bid fee takes precedence per D-214/D-215)
            const { data: platformSettings } = await supabase
              .from("platform_settings")
              .select("value")
              .eq("key", "platform_fee_percentage")
              .single();

            // D-214: use the fee accepted at bid submission (quote.platform_fee_pct).
            // Fall back to platform_settings only for pre-D-214 quotes where platform_fee_pct was not recorded.
            // Never fabricate a rate — throw if both sources are absent.
            const platformFeePercent = quote.platform_fee_pct ?? platformSettings?.value;
            if (platformFeePercent == null) {
              throw new Error(
                `[docusign-webhook] D-214 violation: no fee_pct on quote ${quote.id} and platform_settings unavailable — aborting payment to prevent fabricated rate charge`
              );
            }
            const feeAmount = Math.round(
              quote.total_price * (platformFeePercent / 100) * 100
            );

            // Call create-payment-intent via internal function invocation
            console.log(
              `Charging contractor ${contractor.id} ${feeAmount} cents for platform fee...`
            );

            const paymentResponse = await fetch(
              `${supabaseUrl}/functions/v1/create-payment-intent`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${supabaseKey}`,
                },
                body: JSON.stringify({
                  amount: feeAmount,
                  currency: "usd",
                  description: `Otter Quotes platform fee (${platformFeePercent}%) for claim ${claim.id}`,
                  metadata: {
                    claim_id: claim.id,
                    contractor_id: quote.contractor_id,
                    type: "platform_fee",
                  },
                  contractor_id: quote.contractor_id,
                  off_session: true,
                }),
              }
            );

            // #480: a non-200 from create-payment-intent is a HARD charge
            // failure (Stripe API error, amount-below-minimum, …), not a
            // webhook error. Route it into the same signed-but-unpaid dunning
            // path as a declined charge instead of throwing — the old throw
            // skipped dunning, left the claim un-signed, and mislabeled the
            // alert as "no_method".
            let paymentResult: Record<string, unknown>;
            if (!paymentResponse.ok) {
              const paymentError = await paymentResponse.text();
              console.error(
                `Payment function returned ${paymentResponse.status}: ${paymentError}`
              );
              paymentResult = {
                succeeded: false,
                status: "hard_failure",
                payment_intent_id: null,
                error: `create-payment-intent ${paymentResponse.status}: ${paymentError.slice(0, 500)}`,
              };
            } else {
              paymentResult = await paymentResponse.json();
            }
            console.log(
              `Payment result: status=${paymentResult.status}, id=${paymentResult.payment_intent_id}`
            );

            // gh-948: Stripe's 'processing' (ACH in flight) is NOT success and must
            // not run fulfillment logic. Three outcomes now instead of a binary flag:
            //   succeeded -> existing success path (fee charged, contractor notified)
            //   pending   -> NEW: signing recorded, fee NOT marked charged, contractor
            //                NOT notified. stripe-webhook's payment_intent.succeeded /
            //                payment_intent.payment_failed listeners finalize this later.
            //   failed    -> existing dunning path (unchanged)
            const paymentOutcome: "succeeded" | "pending" | "failed" =
              paymentResult.succeeded === true
                ? "succeeded"
                : paymentResult.pending === true
                ? "pending"
                : "failed";

            if (paymentOutcome === "failed") {
              // ── Payment FAILED — #480: the signing is a FACT; record it. ──
              // Collection moves to dunning. Retries won't re-charge: the outer
              // `if (!claim.contract_signed_at)` idempotency guard now holds
              // because contract_signed_at is set on this path too.
              console.error(
                `Payment failed for quote ${quote.id}: ${paymentResult.status}`
              );

              // Store payment info and mark as dunning
              await supabase
                .from("quotes")
                .update({
                  payment_intent_id: paymentResult.payment_intent_id,
                  payment_status: "dunning",
                })
                .eq("id", quote.id);

              // #480: mark the claim signed (platform_fee_charged stays false)
              await supabase
                .from("claims")
                .update({
                  contract_signed_at: completedDateTime || new Date().toISOString(),
                  contract_signed_by: recipientEmail || null,
                  status: "contract_signed",
                })
                .eq("id", claim.id);

              // #480: durable failure record for dunning/audit
              try {
                await supabase.from("payment_failures").insert({
                  quote_id: quote.id,
                  contractor_id: quote.contractor_id,
                  claim_id: claim.id,
                  amount_cents: feeAmount,
                  stripe_error: String(paymentResult.error || paymentResult.status || "charge failed"),
                });
              } catch (pfErr) {
                console.error("payment_failures insert failed:", pfErr);
              }

              // #480: correct alert taxonomy — a card WAS on file; this is a
              // hard/declined charge, not "no_method".
              try {
                await supabase.from("platform_alerts_log").insert({
                  alert_type: "payment_failed_hard",
                  function_name: "docusign-webhook",
                  message: `Claim ${claim.id} contract signed, charge FAILED (quote ${quote.id}, contractor ${quote.contractor_id}): ${String(paymentResult.error || paymentResult.status)}`,
                  sent_at: new Date().toISOString(),
                });
              } catch (alertErr) {
                console.error("platform_alerts_log insert failed:", alertErr);
              }

              // Trigger dunning sequence
              try {
                const dunningResponse = await fetch(
                  `${supabaseUrl}/functions/v1/process-dunning`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${supabaseKey}`,
                    },
                    body: JSON.stringify({
                      quote_id: quote.id,
                      contractor_id: quote.contractor_id,
                      claim_id: claim.id,
                      amount_cents: feeAmount,
                      stripe_error:
                        paymentResult.error || "Payment failed after signing",
                    }),
                  }
                );
                console.log(`Dunning sequence triggered: ${dunningResponse.status}`);
              } catch (dunningErr) {
                console.error("Failed to trigger dunning:", dunningErr);
              }

              // Return early — do NOT update claim status or notify contractor
              return new Response(
                JSON.stringify({
                  received: true,
                  envelope_id: envelopeId,
                  status,
                  claim_id: claim.id,
                  payment_failed: true,
                  message: "Contract signed but payment failed. Dunning initiated.",
                }),
                {
                  status: 200,
                  headers: { ...corsHeaders, "Content-Type": "application/json" },
                }
              );
            }

            if (paymentOutcome === "pending") {
              // ── Payment PENDING (ACH processing, gh-948) ──
              // The charge is in flight, not settled. Signing is a fact (same
              // precedent as #480) so it is recorded, but fulfillment (fee-charged
              // flag, contractor notification / agreement release) is withheld
              // until stripe-webhook's payment_intent.succeeded / payment_failed
              // listener confirms the final outcome.
              console.log(`Payment PENDING (ACH processing) for quote ${quote.id}`);

              await supabase
                .from("quotes")
                .update({
                  payment_intent_id: paymentResult.payment_intent_id,
                  payment_status: "pending",
                })
                .eq("id", quote.id);

              updateData.contract_signed_at =
                completedDateTime || new Date().toISOString();
              updateData.contract_signed_by = recipientEmail || null;
              updateData.status = "contract_signed";
              // platform_fee_charged intentionally left false — not yet settled.

              try {
                await supabase.from("platform_alerts_log").insert({
                  alert_type: "payment_pending_ach",
                  function_name: "docusign-webhook",
                  message: `Claim ${claim.id} contract signed, platform fee charge PENDING (ACH processing) for quote ${quote.id}, contractor ${quote.contractor_id}, payment_intent ${paymentResult.payment_intent_id}. Awaiting stripe-webhook settlement (gh-948).`,
                  sent_at: new Date().toISOString(),
                });
              } catch (alertErr) {
                console.error("platform_alerts_log insert failed:", alertErr);
              }

              // shouldNotifyContractor stays false here — the contractor is notified
              // only once the fee is CONFIRMED charged (stripe-webhook success handler).
            } else {
              // ── Payment SUCCEEDED — mark contract as signed and notify contractor ──
              console.log(`Payment succeeded for quote ${quote.id}`);

              // Update quote with payment success
              await supabase
                .from("quotes")
                .update({
                  payment_intent_id: paymentResult.payment_intent_id,
                  payment_status: "succeeded",
                })
                .eq("id", quote.id);

              // Now update claim status
              updateData.contract_signed_at =
                completedDateTime || new Date().toISOString();
              updateData.contract_signed_by = recipientEmail || null;
              updateData.status = "contract_signed";
              // Phase 18: record fee-charged on confirmed payment success.
              // claims.platform_fee_charged is boolean DEFAULT false; v53 never
              // wrote it. Set only on the succeeded path, alongside the status flip.
              updateData.platform_fee_charged = true;

              // Flag for contractor notification (only after successful payment)
              shouldNotifyContractor = true;
            }
          } catch (paymentErr) {
            const paymentErrReason =
              paymentErr instanceof Error ? paymentErr.message : "Unknown payment error";
            console.error(
              "Error processing payment after contract signing:",
              paymentErr
            );

            // U15-2: de-blind the signed-but-unbilled stall. Previously EVERY pre-charge
            // throw (quote-not-found, contractor-not-found, no card on file, create-payment-intent
            // non-OK, D-214 fee-absent) landed here and returned 200 with NO state write and
            // NO alert — a signed claim stalled silently (the default today: 0/6 contractors
            // have a card). Record a distinct alert + activity_log row so the stall is visible.
            // Both writes are best-effort (own try/catch -> Sentry) so an audit-write failure
            // cannot itself re-silence the webhook. We still return 200 — no BoldSign retry-storm.
            try {
              await supabase.from("platform_alerts_log").insert({
                alert_type: "signed_unbilled_no_method",
                function_name: "docusign-webhook",
                message:
                  `Claim ${claim.id} contract signed but not billed` +
                  (contractorIdForAlert ? `, contractor ${contractorIdForAlert}` : "") +
                  (quoteIdForAlert ? `, quote ${quoteIdForAlert}` : "") +
                  `: ${paymentErrReason}`,
                sent_at: new Date().toISOString(),
              });
            } catch (alertErr) {
              await reportToSentry(alertErr, {
                fn: "docusign-webhook",
                op: "platform_alerts_log.insert",
                extra: { alert_type: "signed_unbilled_no_method", claim_id: claim.id },
              });
            }
            try {
              await supabase.from("activity_log").insert({
                event_type: "signed_unbilled_no_method",
                is_test: claim.is_test ?? false,
                metadata: {
                  claim_id: claim.id,
                  contractor_id: contractorIdForAlert,
                  quote_id: quoteIdForAlert,
                  reason: paymentErrReason,
                },
              });
            } catch (activityErr) {
              await reportToSentry(activityErr, {
                fn: "docusign-webhook",
                op: "activity_log.insert",
                extra: { event_type: "signed_unbilled_no_method", claim_id: claim.id },
              });
            }

            // #480: the claim IS marked signed below (signing is a fact) while
            // platform_fee_charged stays false; return 200 (no BoldSign retry-storm).
            // The distinct state ('no_method' on the quote, when reached) + the alert
            // above keep the unbilled stall visible.
            try {
              await supabase
                .from("claims")
                .update({
                  contract_signed_at: completedDateTime || new Date().toISOString(),
                  contract_signed_by: recipientEmail || null,
                  status: "contract_signed",
                })
                .eq("id", claim.id);
            } catch (signErr) {
              await reportToSentry(signErr, {
                fn: "docusign-webhook",
                op: "claims.update.signed_unbilled",
                extra: { claim_id: claim.id },
              });
            }
            return new Response(
              JSON.stringify({
                received: true,
                envelope_id: envelopeId,
                status,
                claim_id: claim.id,
                error: paymentErrReason,
              }),
              {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              }
            );
          }
        }
      } else if (isColorConfirmation) {
        updateData.color_confirmed_at =
          completedDateTime || new Date().toISOString();
      } else if (isProjectConfirmation) {
        // [D-274 / #631 — the #421 acceptance-criterion fix] Persist the
        // completed project_confirmation signature. claims.project_confirmation_signed_at
        // is new (migration v111) — if it hasn't been applied yet in a given
        // environment this update will error on the unknown column; caught and
        // logged below (Object.keys(updateData).length > 0 branch already wraps
        // the .update() call in error handling that returns 200 regardless, so
        // this cannot break the webhook response even before the migration lands).
        updateData.project_confirmation_signed_at =
          completedDateTime || new Date().toISOString();
      }
    } else if (status === "declined") {
      // A signer declined
      if (isContract) {
        updateData.contract_declined_at =
          declinedDateTime || new Date().toISOString();
        // Don't change claim status — homeowner may re-sign or choose another contractor
      }
    } else if (status === "voided") {
      // Envelope was voided (cancelled)
      if (isContract) {
        updateData.contract_voided_at =
          voidedDateTime || new Date().toISOString();
      }
    } else if (status === "sent" || status === "delivered") {
      // Informational — envelope was sent or viewed. No claim update needed.
      console.log(`Informational status: ${status} for envelope ${envelopeId}`);
    }

    // Apply updates if any
    if (Object.keys(updateData).length > 0) {
      const { error: updateError } = await supabase
        .from("claims")
        .update(updateData)
        .eq("id", claim.id);

      if (updateError) {
        console.error(`Failed to update claim ${claim.id}:`, updateError);
        // Still return 200 to avoid BoldSign retries
      } else {
        console.log(`Updated claim ${claim.id}:`, JSON.stringify(updateData));
      }

      // ── Notify contractor ONLY after payment succeeds ──
      if (shouldNotifyContractor) {
        try {
          // Fire-and-forget notification to contractor
          const notifyResponse = await fetch(
            `${supabaseUrl}/functions/v1/notify-contractors`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${supabaseKey}`,
              },
              body: JSON.stringify({
                claim_id: claim.id,
                event_type: "contract_signed",
                message:
                  "A homeowner has signed your contract! Contact them within 48 hours.",
              }),
            }
          );
          console.log(`Contractor notification sent: ${notifyResponse.status}`);
        } catch (notifyErr) {
          // Non-critical — don't fail the webhook
          console.error("Failed to notify contractor:", notifyErr);
        }

        // ── [D-225 Phase 2C C5] Homeowner contract-signed Mailgun fan-out ──
        // Sends "your project is in motion" email to the homeowner. Direct
        // Mailgun call (not via notify-contractors) — non-fatal on failure.
        try {
          // Resolve homeowner email + name via claim.user_id -> profiles
          const { data: claimFull } = await supabase
            .from("claims")
            .select("id, user_id, property_address")
            .eq("id", claim.id)
            .single();
          let homeownerEmail: string | null = null;
          let homeownerName: string = "Homeowner";
          if (claimFull?.user_id) {
            const { data: prof } = await supabase
              .from("profiles")
              .select("email, full_name")
              .eq("id", claimFull.user_id)
              .single();
            homeownerEmail = prof?.email || null;
            homeownerName = prof?.full_name || homeownerName;
          }
          // Resolve contractor company name from the awarded quote
          let contractorCompany = "your contractor";
          const { data: awardedQuote } = await supabase
            .from("quotes")
            .select("contractor_id")
            .eq("claim_id", claim.id)
            .eq("status", "selected")
            .maybeSingle();
          if (awardedQuote?.contractor_id) {
            const { data: contractorRow } = await supabase
              .from("contractors")
              .select("company_name")
              .eq("id", awardedQuote.contractor_id)
              .single();
            if (contractorRow?.company_name) contractorCompany = contractorRow.company_name;
          }
          // D-216 Job # identifier
          const jobNumber = `Job #${(claim.id || "").slice(-8).toUpperCase()}`;
          const dashboardUrl = "https://otterquote.com/dashboard.html";
          const propertyAddress = claimFull?.property_address || "your property";

          if (homeownerEmail) {
            const subject = "Your Otter Quotes contract is signed and your project is in motion";
            const textBody =
              `Hi ${homeownerName},\n\n` +
              `Great news — your contract with ${contractorCompany} for ${propertyAddress} is fully executed.\n\n` +
              `${jobNumber}\n\n` +
              `What happens next:\n` +
              `• ${contractorCompany} will contact you within 48 hours to coordinate next steps.\n` +
              `• You can track your project status anytime on your dashboard: ${dashboardUrl}\n\n` +
              `Questions? Reply to this email or contact support@otterquote.com.\n\n` +
              `— The Otter Quotes Team`;
            const htmlBody =
              `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">` +
              `<p>Hi ${homeownerName},</p>` +
              `<p>Great news — your contract with <strong>${contractorCompany}</strong> for <strong>${propertyAddress}</strong> is fully executed.</p>` +
              `<p style="font-size:1.05rem;font-weight:bold;color:#0066cc;">${jobNumber}</p>` +
              `<p><strong>What happens next:</strong></p>` +
              `<ul><li>${contractorCompany} will contact you within 48 hours to coordinate next steps.</li>` +
              `<li>You can track your project status anytime on your <a href="${dashboardUrl}" style="color:#0066cc;">dashboard</a>.</li></ul>` +
              `<p>Questions? Reply to this email or contact <a href="mailto:support@otterquote.com">support@otterquote.com</a>.</p>` +
              `<p>— The Otter Quotes Team</p></body></html>`;

            const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY") || "";
            if (mailgunApiKey) {
              const fd = new FormData();
              fd.append("from", "Otter Quotes <noreply@mail.otterquote.com>");
              fd.append("to", homeownerEmail);
              fd.append("subject", subject);
              fd.append("text", textBody);
              fd.append("html", htmlBody);
              const mgResp = await fetch(
                "https://api.mailgun.net/v3/mail.otterquote.com/messages",
                {
                  method: "POST",
                  headers: { Authorization: `Basic ${btoa(`api:${mailgunApiKey}`)}` },
                  body: fd,
                }
              );
              console.log(`Homeowner contract-signed email Mailgun status=${mgResp.status} to=${homeownerEmail}`);
              const { error: hcsLogError } = await supabase.from("activity_log").insert({
                event_type: "homeowner_contract_signed_email_sent",
                is_test: claim.is_test ?? false,
                metadata: { claim_id: claim.id, job_number: jobNumber, mailgun_status: mgResp.status },
              });
              if (hcsLogError) {
                // 86e1tz17j: de-blind — report, but keep non-fatal (email already sent).
                await reportToSentry(hcsLogError, {
                  fn: "docusign-webhook",
                  op: "activity_log.insert",
                  extra: { event_type: "homeowner_contract_signed_email_sent", claim_id: claim.id },
                });
              }
            } else {
              console.warn("MAILGUN_API_KEY not configured — homeowner email skipped");
            }
          } else {
            console.warn(`No homeowner email for claim ${claim.id} — fan-out skipped`);
          }
        } catch (homeownerEmailErr) {
          console.error("[D-225 C5] Homeowner email fan-out failed (non-fatal):", homeownerEmailErr);
        }

        // ── [D-215 Layer 3] create-invoice fan-out ──
        // After payment success on contract-signed, fire create-invoice to:
        //   (1) email contractor a platform-fee invoice via Mailgun
        //   (2) write activity_log row 'invoice_created' (UETA Layer 3 evidence)
        // Service-role bearer matches the notify-contractors call pattern above.
        // Non-fatal on failure — webhook still returns 200 so BoldSign does not retry.
        // Idempotency: outer guard `if (!claim.contract_signed_at)` already ensures
        // this path runs at most once per envelope completion.
        try {
          // Resolve the quote that just got paid for this claim
          const { data: paidQuote } = await supabase
            .from("quotes")
            .select("id, contractor_id")
            .eq("claim_id", claim.id)
            .eq("payment_status", "succeeded")
            .maybeSingle();

          if (!paidQuote || !paidQuote.contractor_id) {
            console.warn(
              `[D-215 L3] No paid quote found for claim ${claim.id} — invoice skipped`
            );
          } else {
            // Resolve homeowner name + property address from claim + profile
            const { data: claimRow } = await supabase
              .from("claims")
              .select("user_id, property_address")
              .eq("id", claim.id)
              .single();
            let invoiceHomeownerName = "Homeowner";
            if (claimRow?.user_id) {
              const { data: prof } = await supabase
                .from("profiles")
                .select("full_name")
                .eq("id", claimRow.user_id)
                .single();
              if (prof?.full_name) invoiceHomeownerName = prof.full_name;
            }
            const invoicePropertyAddress =
              claimRow?.property_address || "Property address on file";
            const invoiceContractSignedAt =
              (updateData.contract_signed_at as string | undefined) ||
              completedDateTime ||
              new Date().toISOString();

            // [D-274 / #631] Operator-token gate — see create-invoice/index.ts's
            // matching block for the full rationale. This is the ONE call this
            // build converts off "the credential being a valid JWT"; the other
            // three service-role-bearer calls in this file (create-payment-intent,
            // process-dunning, notify-contractors below) are left UNCHANGED and
            // flagged in the D-274 build report as the same pattern, not yet
            // converted — scoped this way because the brief named create-invoice
            // specifically. X-Operator-Token is sent in ADDITION to the
            // Authorization header (unchanged) so this call keeps working even
            // before EF_OPERATOR_TOKEN is provisioned in every environment.
            const operatorToken = Deno.env.get("EF_OPERATOR_TOKEN") || "";
            const invoiceResponse = await fetch(
              `${supabaseUrl}/functions/v1/create-invoice`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${supabaseKey}`,
                  ...(operatorToken ? { "X-Operator-Token": operatorToken } : {}),
                },
                body: JSON.stringify({
                  quote_id: paidQuote.id,
                  contractor_id: paidQuote.contractor_id,
                  homeowner_name: invoiceHomeownerName,
                  property_address: invoicePropertyAddress,
                  contract_signed_at: invoiceContractSignedAt,
                }),
              }
            );
            console.log(
              `[D-215 L3] create-invoice status=${invoiceResponse.status} quote=${paidQuote.id}`
            );
          }
        } catch (invoiceErr) {
          // Non-critical — don't fail the webhook
          console.error(
            "[D-215 L3] Invoice fan-out failed (non-fatal):",
            invoiceErr
          );
        }
      }
    }

    // ========== LOG THE EVENT ==========
    try {
      await supabase.from("notifications").insert({
        claim_id: claim.id,
        channel: "webhook",
        // [D-274 / #631] Renamed from `docusign_${status}` — no other code
        // path in this repo queries the old prefix (verified via repo-wide
        // grep before renaming), so this is a safe rename, not a compat break.
        notification_type: `boldsign_${status}`,
        recipient: recipientEmail || "unknown",
        message_preview: `Envelope ${envelopeId} status: ${status}`,
      });
    } catch (logErr) {
      // Non-critical
      console.error("Failed to log webhook event:", logErr);
    }

    // ========== SUCCESS ==========
    return new Response(
      JSON.stringify({
        received: true,
        envelope_id: envelopeId,
        status,
        claim_id: claim.id,
        updated: Object.keys(updateData).length > 0,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("docusign-webhook error:", error);

    // Always return 200 to prevent BoldSign from retrying on parse errors
    return new Response(
      JSON.stringify({
        received: true,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
