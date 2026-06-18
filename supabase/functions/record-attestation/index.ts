/**
 * OtterQuote Edge Function: record-attestation
 *
 * D-210 — Server-side recording of contractor attestations
 *
 * Called from the frontend when a contractor submits:
 *   1. WCE-1 exemption (workers' comp exemption attestation)
 *   2. No-license required attestation
 *
 * Records the attestation server-side with timestamp and metadata,
 * ensuring integrity and auditability.
 *
 * ── Request body ──────────────────────────────────────────────────────────
 * {
 *   contractor_id: string (UUID),
 *   attestation_type: 'wce1_exempt' | 'no_license_required',
 *   ip_address?: string (optional, captured by function if not provided),
 *   user_agent?: string (optional, captured by function if not provided)
 * }
 *
 * ── Behavior ──────────────────────────────────────────────────────────────
 * 1. Validate contractor_id exists in contractors table
 * 2. Update contractors table based on attestation_type:
 *    - 'wce1_exempt': set wc_cert_file_ref = 'WCE-1-EXEMPT', wc_cert_uploaded_at = NOW()
 *    - 'no_license_required': set license_attestation_signed_at = NOW()
 * 3. Insert audit entry into activity_log with attestation_type and metadata
 * 4. Return { success: true, attestation_type, recorded_at }
 *
 * ── Auth ──────────────────────────────────────────────────────────────────
 * verify_jwt=true: a valid Supabase JWT is required (enforced at the platform
 * edge and re-checked in-handler). The token is validated via auth.getUser
 * (signature + expiry), and the resolved user MUST own the contractor record
 * being attested for. There is no unauthenticated path.
 *
 * ── CORS ───────────────────────────────────────────────────────────────────
 * Allow:
 *   - https://otterquote.com
 *   - https://app.otterquote.com
 *   - https://app-staging.otterquote.com
 *   - https://jade-alpaca-b82b5e.netlify.app
 *   - https://staging--jade-alpaca-b82b5e.netlify.app
 *   - http://localhost:* (dev)
 *
 * ── Returns ────────────────────────────────────────────────────────────────
 * {
 *   success: true,
 *   attestation_type: 'wce1_exempt' | 'no_license_required',
 *   recorded_at: ISO 8601 timestamp,
 *   contractor_id: string
 * }
 *
 * Errors:
 * - 400: Invalid request (missing fields, invalid attestation_type)
 * - 401: Authentication required (missing token) or invalid/expired session
 * - 404: Contractor not found
 * - 403: Ownership mismatch (authenticated user doesn't own the contractor)
 * - 500: Database or server error
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "record-attestation";

// CORS allowlist
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

// Regex for localhost with any port
const LOCALHOST_REGEX = /^http:\/\/localhost:\d+$/;

// =============================================================================
// CORS HELPER
// =============================================================================

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  
  let allowedOrigin = ALLOWED_ORIGINS[0]; // default
  if (ALLOWED_ORIGINS.includes(origin)) {
    allowedOrigin = origin;
  } else if (LOCALHOST_REGEX.test(origin)) {
    allowedOrigin = origin;
  }

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Vary": "Origin",
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  corsHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// =============================================================================
// REQUEST VALIDATION
// =============================================================================

interface AttestationRequest {
  contractor_id: string;
  attestation_type: "wce1_exempt" | "no_license_required";
  ip_address?: string;
  user_agent?: string;
}

function validateRequest(body: unknown): [valid: boolean, error?: string] {
  if (!body || typeof body !== "object") {
    return [false, "Request body must be a JSON object"];
  }

  const req = body as Record<string, unknown>;

  if (!req.contractor_id || typeof req.contractor_id !== "string") {
    return [false, "contractor_id is required and must be a string"];
  }

  if (
    !req.attestation_type ||
    typeof req.attestation_type !== "string" ||
    !["wce1_exempt", "no_license_required"].includes(req.attestation_type as string)
  ) {
    return [
      false,
      "attestation_type is required and must be 'wce1_exempt' or 'no_license_required'",
    ];
  }

  return [true];
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  // ── Parse request body ──────────────────────────────────────────────────
  let requestBody: AttestationRequest;
  try {
    const body = await req.json();
    const [valid, error] = validateRequest(body);
    if (!valid) {
      return jsonResponse({ error }, 400, corsHeaders);
    }
    requestBody = body as AttestationRequest;
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Request body parse failed:`, err);
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const { contractor_id, attestation_type, ip_address, user_agent } = requestBody;

  // ── Require a Bearer token ───────────────────────────────────────────────
  // D-220 / Phase 16: attestations must be made by the authenticated owner.
  // A missing token is rejected outright — there is no unauthenticated path.
  const authHeader = req.headers.get("Authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/);
  const accessToken = bearerMatch?.[1];

  if (!accessToken) {
    return jsonResponse({ error: "Authentication required" }, 401, corsHeaders);
  }

  // ── Set up Supabase client ──────────────────────────────────────────────
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!supabaseUrl || !serviceKey) {
    console.error(`[${FUNCTION_NAME}] Missing Supabase config`);
    return jsonResponse({ error: "Server configuration error" }, 500, corsHeaders);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // ── Verify the token resolves to a real user ─────────────────────────────
  // auth.getUser validates the JWT signature + expiry against the Auth server,
  // so a forged or expired token cannot pass (closes the prior base64-only gap).
  const { data: u, error: ue } = await supabase.auth.getUser(accessToken);
  if (ue || !u?.user) {
    return jsonResponse({ error: "Invalid or expired session" }, 401, corsHeaders);
  }

  // ── Check contractor exists ─────────────────────────────────────────────
  const { data: contractor, error: contractorError } = await supabase
    .from("contractors")
    .select("id, user_id")
    .eq("id", contractor_id)
    .single();

  if (contractorError || !contractor) {
    console.warn(
      `[${FUNCTION_NAME}] Contractor not found: ${contractor_id}`
    );
    return jsonResponse({ error: "Contractor not found" }, 404, corsHeaders);
  }

  // ── Ownership check (required) ───────────────────────────────────────────
  // The authenticated user must own the contractor record being attested for.
  if (contractor.user_id !== u.user.id) {
    console.warn(
      `[${FUNCTION_NAME}] Ownership mismatch: auth user ${u.user.id} ` +
        `vs contractor user ${contractor.user_id}`
    );
    return jsonResponse({ error: "Unauthorized" }, 403, corsHeaders);
  }

  const now = new Date().toISOString();
  const capturedIp = ip_address || req.headers.get("x-forwarded-for") || "unknown";
  const capturedUserAgent = user_agent || req.headers.get("user-agent") || "unknown";

  // ── Update contractors table based on attestation_type ──────────────────
  let updateData: Record<string, unknown> = {};

  if (attestation_type === "wce1_exempt") {
    updateData = {
      wc_cert_file_ref: "WCE-1-EXEMPT",
      wc_cert_uploaded_at: now,
    };
  } else if (attestation_type === "no_license_required") {
    updateData = {
      license_attestation_signed_at: now,
    };
  }

  const { error: updateError } = await supabase
    .from("contractors")
    .update(updateData)
    .eq("id", contractor_id);

  if (updateError) {
    console.error(
      `[${FUNCTION_NAME}] Update contractors failed for ${contractor_id}:`,
      updateError.message
    );
    return jsonResponse(
      { error: "Failed to record attestation", detail: updateError.message },
      500,
      corsHeaders
    );
  }

  // ── Log to activity_log ──────────────────────────────────────────────────
  const { error: logError } = await supabase.from("activity_log").insert({
    event_type: "attestation_recorded",
    title: "attestation_recorded",
    user_id: contractor.user_id,
    metadata: {
      contractor_id,
      attestation_type,
      ip_address: capturedIp,
      user_agent: capturedUserAgent,
    },
  });

  if (logError) {
    console.warn(
      `[${FUNCTION_NAME}] Activity log insert failed for ${contractor_id}:`,
      logError.message
    );
    // Don't fail the request — attestation is already recorded in contractors table
  }

  // ── Return success response ──────────────────────────────────────────────
  const response = {
    success: true,
    attestation_type,
    recorded_at: now,
    contractor_id,
  };

  console.log(
    `[${FUNCTION_NAME}] Attestation recorded for contractor ${contractor_id}: ${attestation_type}`
  );

  return jsonResponse(response, 200, corsHeaders);
});
