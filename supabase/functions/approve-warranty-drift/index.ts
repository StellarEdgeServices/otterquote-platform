/**
 * OtterQuote Edge Function: approve-warranty-drift
 * D-202 Phase 3 — Admin approves a warranty_manifest_drift row.
 *
 * Actions per change_type:
 *   modified   → UPDATE warranty_options with proposed_value fields
 *   added      → INSERT new warranty_options row from proposed_value
 *   deprecated → SET warranty_options.active = false; notify affected contractors
 *   no_source  → Admin confirmed they reviewed manually; if proposed_value is
 *                provided, treat as 'modified'. If null, treat as 'skipped' (no changes).
 *
 * On success: sets status='applied', logs activity_log entry.
 * For deprecated: sends Mailgun notifications to affected contractors.
 *
 * Request body: { drift_id: string }
 * Auth: service_role key (called from admin-warranty-drift.html with admin guard)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY")!;
const MAILGUN_DOMAIN = "mail.otterquote.com";

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

  // Use caller's token to verify admin role
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
  let proposedValueOverride: Record<string, unknown> | null = null;
  try {
    const body = await req.json();
    driftId = body.drift_id;
    proposedValueOverride = body.proposed_value ?? null;
    if (!driftId) throw new Error("drift_id required");
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 400 });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Load drift row
  const { data: drift, error: driftErr } = await sb
    .from("warranty_manifest_drift")
    .select("*")
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

  try {
    // Resolve effective change type
    // no_source with a proposed_value provided → treat as modified
    const effectiveChangeType =
      drift.change_type === "no_source" && (proposedValueOverride ?? drift.proposed_value)
        ? "modified"
        : drift.change_type;

    const effectiveProposed = proposedValueOverride ?? drift.proposed_value;

    // ── Apply change to warranty_options ──────────────────────────────────
    switch (effectiveChangeType) {
      case "modified": {
        if (!effectiveProposed) {
          return new Response(
            JSON.stringify({ error: "proposed_value required for modified change type" }),
            { status: 400 }
          );
        }
        if (!drift.warranty_option_id) {
          return new Response(
            JSON.stringify({ error: "warranty_option_id required for modified update" }),
            { status: 400 }
          );
        }
        const { error: updateErr } = await sb
          .from("warranty_options")
          .update(effectiveProposed)
          .eq("id", drift.warranty_option_id);
        if (updateErr) throw new Error(`warranty_options update failed: ${updateErr.message}`);
        break;
      }

      case "added": {
        if (!effectiveProposed) {
          return new Response(
            JSON.stringify({ error: "proposed_value required for added change type" }),
            { status: 400 }
          );
        }
        const { error: insertErr } = await sb
          .from("warranty_options")
          .insert(effectiveProposed);
        if (insertErr) throw new Error(`warranty_options insert failed: ${insertErr.message}`);
        break;
      }

      case "deprecated": {
        if (!drift.warranty_option_id) {
          return new Response(
            JSON.stringify({ error: "warranty_option_id required for deprecated change type" }),
            { status: 400 }
          );
        }
        const { error: deactivateErr } = await sb
          .from("warranty_options")
          .update({ active: false })
          .eq("id", drift.warranty_option_id);
        if (deactivateErr) throw new Error(`warranty_options deactivate failed: ${deactivateErr.message}`);

        // Notify affected contractors
        await notifyDeprecatedContractors(sb, drift.warranty_option_id, drift.manufacturer, drift.tier);
        break;
      }

      case "no_source": {
        // Admin approved with no proposed changes — nothing to apply to warranty_options.
        // Mark as skipped instead of applied (no change was made).
        await sb.from("warranty_manifest_drift").update({
          status: "skipped",
          reviewed_by: adminEmail,
          reviewed_at: now,
        }).eq("id", driftId);

        await logActivity(sb, adminEmail, drift, "warranty_manifest_drift_skipped");

        return new Response(
          JSON.stringify({ status: "skipped", drift_id: driftId }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // ── Mark drift row as applied ─────────────────────────────────────────
    const { error: markErr } = await sb
      .from("warranty_manifest_drift")
      .update({
        status: "applied",
        reviewed_by: adminEmail,
        reviewed_at: now,
        applied_at: now,
        ...(effectiveProposed ? { proposed_value: effectiveProposed } : {}),
      })
      .eq("id", driftId);
    if (markErr) throw new Error(`Failed to mark drift row applied: ${markErr.message}`);

    // ── Log activity ──────────────────────────────────────────────────────
    await logActivity(sb, adminEmail, drift, "warranty_manifest_drift_applied");

    return new Response(
      JSON.stringify({ status: "applied", drift_id: driftId }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[approve-warranty-drift] Error: ${message}`);
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

async function logActivity(
  sb: ReturnType<typeof createClient>,
  adminEmail: string,
  drift: Record<string, unknown>,
  action: string
) {
  try {
    await sb.from("activity_log").insert({
      action,
      metadata: {
        drift_id: drift.id,
        manufacturer: drift.manufacturer,
        tier: drift.tier,
        change_type: drift.change_type,
        warranty_option_id: drift.warranty_option_id,
        reviewed_by: adminEmail,
      },
    });
  } catch (e) {
    console.error("[approve-warranty-drift] activity_log insert failed:", e);
  }
}

async function notifyDeprecatedContractors(
  sb: ReturnType<typeof createClient>,
  warrantyOptionId: string,
  manufacturer: string,
  tier: string
) {
  // Find contractors who have submitted quotes using this warranty_option_id
  const { data: quotes } = await sb
    .from("quotes")
    .select("contractor_id")
    .eq("warranty_option_id", warrantyOptionId);

  if (!quotes || quotes.length === 0) return;

  // Deduplicate contractor IDs
  const contractorIds = [...new Set(quotes.map((q: { contractor_id: string }) => q.contractor_id))];

  // Load contractor emails
  const { data: contractors } = await sb
    .from("contractors")
    .select("id, email, business_name")
    .in("id", contractorIds);

  if (!contractors || contractors.length === 0) return;

  for (const contractor of contractors) {
    try {
      const formData = new FormData();
      formData.append("from", "Otter Quotes Platform <no-reply@mail.otterquote.com>");
      formData.append("to", contractor.email);
      formData.append(
        "subject",
        `Warranty Program Update — ${manufacturer} ${tier}`
      );
      formData.append(
        "text",
        [
          `Hi ${contractor.business_name ?? "there"},`,
          ``,
          `We wanted to let you know that the ${manufacturer} ${tier} warranty program`,
          `has been updated in the Otter Quotes platform.`,
          ``,
          `Please log in to your contractor profile and review your saved warranty`,
          `selections to ensure they reflect the current program offerings.`,
          ``,
          `If you have any questions, reply to this email.`,
          ``,
          `— Otter Quotes Platform`,
        ].join("\n")
      );

      await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}`,
        },
        body: formData,
      });
    } catch (e) {
      console.error(`[approve-warranty-drift] Mailgun notify failed for contractor ${contractor.id}:`, e);
    }
  }
}
