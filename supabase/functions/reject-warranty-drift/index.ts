/**
 * OtterQuote Edge Function: reject-warranty-drift
 * D-202 Phase 3 — Admin rejects or skips a warranty_manifest_drift row.
 *
 * Reject: status → 'rejected', rejection_reason required. No change to warranty_options.
 * Skip:   status → 'skipped', no rejection_reason required.
 *         Use when admin manually checked the source and confirmed no changes needed.
 *
 * Request body: { drift_id: string, action: 'reject' | 'skip', rejection_reason?: string }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "https://otterquote.com",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  // Verify caller is an admin
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  const callerToken = authHeader.slice(7);

  const sbCaller = createClient(SUPABASE_URL, callerToken);
  const { data: { user }, error: authErr } = await sbCaller.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const isAdmin = await checkAdminRole(user.id, user.email ?? "");
  if (!isAdmin) {
    return new Response(JSON.stringify({ error: "Forbidden: admin role required" }), { status: 403 });
  }

  const adminEmail = user.email ?? "unknown";

  // Parse request
  let driftId: string;
  let action: "reject" | "skip";
  let rejectionReason: string | null = null;
  try {
    const body = await req.json();
    driftId = body.drift_id;
    action = body.action;
    rejectionReason = body.rejection_reason ?? null;
    if (!driftId) throw new Error("drift_id required");
    if (action !== "reject" && action !== "skip") throw new Error("action must be 'reject' or 'skip'");
    if (action === "reject" && !rejectionReason) throw new Error("rejection_reason required for reject action");
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 400 });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Load drift row
  const { data: drift, error: driftErr } = await sb
    .from("warranty_manifest_drift")
    .select("id, status, manufacturer, tier, change_type, warranty_option_id")
    .eq("id", driftId)
    .maybeSingle();

  if (driftErr || !drift) {
    return new Response(JSON.stringify({ error: "Drift row not found" }), { status: 404 });
  }
  if (drift.status !== "pending_review") {
    return new Response(
      JSON.stringify({ error: `Row is already ${drift.status}` }),
      { status: 409 }
    );
  }

  const now = new Date().toISOString();
  const newStatus = action === "reject" ? "rejected" : "skipped";

  try {
    const { error: updateErr } = await sb
      .from("warranty_manifest_drift")
      .update({
        status: newStatus,
        reviewed_by: adminEmail,
        reviewed_at: now,
        ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
      })
      .eq("id", driftId);

    if (updateErr) throw new Error(`Failed to update drift row: ${updateErr.message}`);

    // Log activity
    try {
      await sb.from("activity_log").insert({
        action: `warranty_manifest_drift_${newStatus}`,
        metadata: {
          drift_id: driftId,
          manufacturer: drift.manufacturer,
          tier: drift.tier,
          change_type: drift.change_type,
          reviewed_by: adminEmail,
          ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
        },
      });
    } catch (e) {
      console.error("[reject-warranty-drift] activity_log insert failed:", e);
    }

    return new Response(
      JSON.stringify({ status: newStatus, drift_id: driftId }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[reject-warranty-drift] Error: ${message}`);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});

async function checkAdminRole(userId: string, email: string): Promise<boolean> {
  if (email === "dustinstohler1@gmail.com") return true;
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await sb
    .from("contractors")
    .select("template_review_role")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.template_review_role === "admin";
}
