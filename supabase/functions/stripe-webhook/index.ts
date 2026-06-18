// supabase/functions/stripe-webhook/index.ts
// D-228: charge.dispute.created handler
// Tier 3 deploy — payment logic. Staging only until Dustin production approval.
//
// Required Supabase secrets (set before first invocation):
//   STRIPE_WEBHOOK_SIGNING_SECRET  — test-mode signing secret for staging
//   STRIPE_SECRET_KEY_TEST         — already set
//   STRIPE_SECRET_KEY              — already set (do not use until prod approval)
//   CLICKUP_API_KEY                — ClickUp personal API token (set before staging test)
//
// D-228 routing logic:
//   dispute.amount < $500 AND reason != 'product_not_received'
//     → auto-submit D-215 evidence stack via Stripe Disputes API
//   dispute.amount >= $500 OR reason == 'product_not_received'
//     → create ClickUp task in list 901711730553 + insert into admin_dispute_queue
//   ALL events → log to disputes table + activity_log

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const AMOUNT_THRESHOLD_CENTS = 50_000; // $500.00 — D-228 routing threshold
const CLICKUP_LIST_ID = "901711730553";
const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";
const STRIPE_API_BASE = "https://api.stripe.com/v1";
const FN_NAME = "stripe-webhook";

// Stripe dispute reason codes that always route to manual queue (D-228: non-delivery)
const NON_DELIVERY_REASONS = new Set(["product_not_received"]);

// ---------------------------------------------------------------------------
// Stripe types (minimal — only fields we use)
// ---------------------------------------------------------------------------
interface StripeDispute {
  id: string;
  object: "dispute";
  amount: number;
  currency: string;
  charge: string;
  payment_intent: string | null;
  reason: string;
  status: string;
  livemode: boolean;
  evidence_details: {
    due_by: number;
    has_evidence: boolean;
    past_due: boolean;
    submission_count: number;
  };
  metadata: Record<string, string>;
}

interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: StripeDispute };
}

// ---------------------------------------------------------------------------
// Supabase row types (minimal)
// ---------------------------------------------------------------------------
interface ClaimRow {
  id: string;
  user_id: string;
  platform_fee_stripe_id: string | null;
  platform_fee_amount: number | null;
  selected_contractor_id: string | null;
  contract_signed_at: string | null;
  completion_date: string | null;
  homeowner_name: string | null;
  property_address: string | null;
}

interface QuoteRow {
  id: string;
  claim_id: string;
  contractor_id: string;
  payment_intent_id: string | null;
  fee_amount: number | null;
}

interface FeeAcceptanceRow {
  id: string;
  contractor_id: string;
  claim_id: string;
  bid_id: string;
  fee_pct: number;
  fee_amount: number;
  fee_text_displayed: string;
  accepted_at: string;
  ip_address: string | null;
  user_agent: string | null;
  invoice_url: string | null;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 Stripe signature verification
// ref: https://stripe.com/docs/webhooks/signatures
// ---------------------------------------------------------------------------
async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  try {
    const parts = sigHeader.split(",").reduce((acc, part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx !== -1) acc[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
      return acc;
    }, {} as Record<string, string>);

    const timestamp = parts["t"];
    const v1Sig = parts["v1"];
    if (!timestamp || !v1Sig) return false;

    // Reject events older than 5 minutes (replay attack guard)
    const tolerance = 300;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > tolerance) {
      console.warn(`[${FN_NAME}] Stale webhook timestamp: ${timestamp}`);
      return false;
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(signedPayload),
    );

    const computedSig = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return computedSig === v1Sig;
  } catch (err) {
    console.error(`[${FN_NAME}] Signature verification error:`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stripe API helper
// ---------------------------------------------------------------------------
async function stripeRequest(
  path: string,
  method: "GET" | "POST",
  stripeKey: string,
  body?: Record<string, string>,
): Promise<{ ok: boolean; data: unknown; error?: string }> {
  try {
    const res = await fetch(`${STRIPE_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body
        ? new URLSearchParams(body as Record<string, string>).toString()
        : undefined,
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, data, error: (data as { error?: { message?: string } })?.error?.message ?? "Stripe API error" };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: null, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// ClickUp task creation
// ---------------------------------------------------------------------------
async function createClickUpTask(params: {
  dispute: StripeDispute;
  claim: ClaimRow | null;
  feeAcceptance: FeeAcceptanceRow | null;
  disputeUrl: string;
  clickupKey: string;
}): Promise<{ taskId: string | null; taskUrl: string | null; error?: string }> {
  const { dispute, claim, feeAcceptance, disputeUrl, clickupKey } = params;
  const amountDollars = (dispute.amount / 100).toFixed(2);
  const isNonDelivery = NON_DELIVERY_REASONS.has(dispute.reason);

  const routingReason = isNonDelivery
    ? `⚠️ Non-delivery dispute (reason: ${dispute.reason})`
    : `⚠️ High-value dispute ($${amountDollars} ≥ $500 threshold)`;

  const claimInfo = claim
    ? [
        `**Claim ID:** ${claim.id}`,
        `**Homeowner:** ${claim.homeowner_name ?? "Unknown"}`,
        `**Property:** ${claim.property_address ?? "Unknown"}`,
        `**Contract Signed:** ${claim.contract_signed_at ?? "Not yet"}`,
        `**Job Completed:** ${claim.completion_date ?? "Not yet (Mark Complete not triggered)"}`,
      ].join("\n")
    : "⚠️ Could not resolve claim from charge ID — manual lookup required.";

  const feeInfo = feeAcceptance
    ? [
        `**Fee %:** ${feeAcceptance.fee_pct}%`,
        `**Fee Amount:** $${(feeAcceptance.fee_amount / 100).toFixed(2)}`,
        `**Accepted At:** ${feeAcceptance.accepted_at}`,
        `**Fee Text Shown:** ${feeAcceptance.fee_text_displayed}`,
        `**Invoice URL:** ${feeAcceptance.invoice_url ?? "None"}`,
      ].join("\n")
    : "⚠️ No fee_acceptances record found — manual evidence gathering required.";

  const description = [
    `## Dispute Requires Manual Review`,
    ``,
    `${routingReason}`,
    ``,
    `### Stripe Dispute Details`,
    `**Dispute ID:** ${dispute.id}`,
    `**Charge ID:** ${dispute.charge}`,
    `**Amount in Dispute:** $${amountDollars}`,
    `**Reason:** ${dispute.reason}`,
    `**Status:** ${dispute.status}`,
    `**Due By:** ${dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toISOString() : "Unknown"}`,
    `**Stripe Dispute URL:** ${disputeUrl}`,
    ``,
    `### Related Claim`,
    claimInfo,
    ``,
    `### Fee Acceptance Record (D-215 Evidence Layer 1)`,
    feeInfo,
    ``,
    `### Required Actions`,
    `1. Open Stripe dispute link above and review the chargeback details`,
    `2. Gather full evidence stack (D-215 + D-228): fee_acceptances, bid confirmation email, invoice, contractor completion record, Hover report`,
    `3. Submit response before the Stripe due_by deadline`,
    `4. Update this task with outcome`,
    ``,
    `### Build Note`,
    `Contractor "Mark Complete" timestamp and homeowner acknowledgment flow are not yet built (D-228 follow-up tasks). Manual verification of job completion required for now.`,
  ].join("\n");

  try {
    const res = await fetch(`${CLICKUP_API_BASE}/list/${CLICKUP_LIST_ID}/task`, {
      method: "POST",
      headers: {
        Authorization: clickupKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `[DISPUTE] $${amountDollars} — ${dispute.reason} — ${dispute.id.slice(-8)}`,
        description,
        priority: 1, // Urgent
        tags: ["dispute", "payment"],
        notify_all: true,
      }),
    });

    const data = (await res.json()) as { id?: string; url?: string; err?: string };
    if (!res.ok) {
      return { taskId: null, taskUrl: null, error: data.err ?? `ClickUp HTTP ${res.status}` };
    }

    return {
      taskId: data.id ?? null,
      taskUrl: data.url ?? `https://app.clickup.com/t/${data.id}`,
    };
  } catch (err) {
    return { taskId: null, taskUrl: null, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Evidence builder — D-215 stack
// ---------------------------------------------------------------------------
function buildEvidencePayload(params: {
  dispute: StripeDispute;
  claim: ClaimRow | null;
  feeAcceptance: FeeAcceptanceRow | null;
}): Record<string, string> {
  const { dispute, claim, feeAcceptance } = params;

  const productDescription = [
    "Otter Quotes is a platform that facilitates roofing and exterior repair contracts.",
    "The platform collects a platform fee from contractors when a homeowner signs their contract.",
    "The homeowner pays nothing to Otter Quotes; the fee is charged to the contractor.",
    "The platform fee covers: competitive bid management, digital contract execution (DocuSign), ",
    "measurements (Hover aerial reports), and document compliance services.",
  ].join(" ");

  const serviceDocLines = [
    "TRANSACTION RECORD — Otter Quotes Platform Fee",
    `Dispute ID: ${dispute.id}`,
    `Charge ID: ${dispute.charge}`,
    `Dispute Amount: $${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}`,
    `Dispute Reason: ${dispute.reason}`,
    "",
  ];

  if (feeAcceptance) {
    serviceDocLines.push(
      "FEE ACCEPTANCE RECORD (UETA Layer 1 — D-215):",
      `  Fee Rate: ${feeAcceptance.fee_pct}%`,
      `  Fee Amount: $${(feeAcceptance.fee_amount / 100).toFixed(2)}`,
      `  Accepted At: ${feeAcceptance.accepted_at}`,
      `  IP Address: ${feeAcceptance.ip_address ?? "Not recorded"}`,
      `  Fee Text Shown to Contractor: "${feeAcceptance.fee_text_displayed}"`,
      "",
    );
  } else {
    serviceDocLines.push(
      "FEE ACCEPTANCE RECORD: Not found in database — manual lookup required.",
      "",
    );
  }

  if (claim) {
    serviceDocLines.push(
      "CLAIM RECORD:",
      `  Claim ID: ${claim.id}`,
      `  Homeowner: ${claim.homeowner_name ?? "On file"}`,
      `  Property: ${claim.property_address ?? "On file"}`,
      `  Contract Signed At: ${claim.contract_signed_at ?? "Not yet signed"}`,
    );

    if (claim.completion_date) {
      serviceDocLines.push(`  Job Completion Date: ${claim.completion_date} (contractor marked job complete)`);
    } else {
      serviceDocLines.push(
        "  Job Completion Date: PENDING — contractor 'Mark Complete' action not yet triggered.",
        "  NOTE: Mark Complete dashboard flow is a net-new build (D-228). Completion cannot be",
        "  auto-verified at this time. Manual verification of job completion required.",
      );
    }

    serviceDocLines.push(
      "  Homeowner Completion Acknowledgment: NOT AVAILABLE — homeowner acknowledgment flow is",
      "  a net-new build per D-228 and has not yet been deployed. This evidence layer will be",
      "  available after the homeowner acknowledgment feature ships.",
    );
  }

  const customerCommunication = feeAcceptance
    ? [
        "A bid confirmation email was sent to the contractor upon bid submission.",
        `The email included the accepted fee rate (${feeAcceptance.fee_pct}%), the rescission link`,
        "allowing the contractor to rescind within 24 hours, and a reference to the invoice",
        "that would be generated at contract signing.",
        feeAcceptance.invoice_url
          ? `Invoice URL (D-215 Layer 3): ${feeAcceptance.invoice_url}`
          : "Invoice URL: Not available — invoice may not have been generated yet.",
      ].join(" ")
    : "Bid confirmation email was sent upon bid submission per platform process (D-215 Layer 2). " +
      "Fee acceptance record could not be retrieved at this time.";

  const evidence: Record<string, string> = {
    "evidence[product_description]": productDescription,
    "evidence[service_documentation]": serviceDocLines.join("\n"),
    "evidence[customer_communication]": customerCommunication,
    "evidence[submit]": "true",
  };

  if (feeAcceptance?.invoice_url) {
    evidence["evidence[receipt]"] = feeAcceptance.invoice_url;
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Core dispute handler
// ---------------------------------------------------------------------------
async function handleDisputeCreated(
  event: StripeEvent,
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  const dispute = event.data.object as StripeDispute;
  const stripeKey = event.livemode
    ? Deno.env.get("STRIPE_SECRET_KEY")!
    : Deno.env.get("STRIPE_SECRET_KEY_TEST")!;

  const clickupKey = Deno.env.get("CLICKUP_API_KEY") ?? "";
  const amountDollars = (dispute.amount / 100).toFixed(2);

  console.log(
    `[${FN_NAME}] dispute.created — id=${dispute.id} amount=$${amountDollars} reason=${dispute.reason} livemode=${event.livemode}`,
  );

  let claim: ClaimRow | null = null;
  let quote: QuoteRow | null = null;
  let feeAcceptance: FeeAcceptanceRow | null = null;

  const { data: claimRows } = await supabase
    .from("claims")
    .select(
      "id, user_id, platform_fee_stripe_id, platform_fee_amount, selected_contractor_id, contract_signed_at, completion_date, homeowner_name, property_address",
    )
    .eq("platform_fee_stripe_id", dispute.charge)
    .limit(1);

  if (claimRows && claimRows.length > 0) {
    claim = claimRows[0] as ClaimRow;
  }

  if (!claim && dispute.payment_intent) {
    const { data: quoteRows } = await supabase
      .from("quotes")
      .select("id, claim_id, contractor_id, payment_intent_id, fee_amount")
      .eq("payment_intent_id", dispute.payment_intent)
      .limit(1);

    if (quoteRows && quoteRows.length > 0) {
      quote = quoteRows[0] as QuoteRow;

      const { data: claimFromQuote } = await supabase
        .from("claims")
        .select(
          "id, user_id, platform_fee_stripe_id, platform_fee_amount, selected_contractor_id, contract_signed_at, completion_date, homeowner_name, property_address",
        )
        .eq("id", quote.claim_id)
        .limit(1);

      if (claimFromQuote && claimFromQuote.length > 0) {
        claim = claimFromQuote[0] as ClaimRow;
      }
    }
  }

  if (claim) {
    const contractorId = claim.selected_contractor_id ?? quote?.contractor_id;
    if (contractorId) {
      const { data: feeRows } = await supabase
        .from("fee_acceptances")
        .select(
          "id, contractor_id, claim_id, bid_id, fee_pct, fee_amount, fee_text_displayed, accepted_at, ip_address, user_agent, invoice_url",
        )
        .eq("claim_id", claim.id)
        .eq("contractor_id", contractorId)
        .is("rescinded_at", null)
        .order("created_at", { ascending: false })
        .limit(1);

      if (feeRows && feeRows.length > 0) {
        feeAcceptance = feeRows[0] as FeeAcceptanceRow;
      }
    }
  }

  const isNonDelivery = NON_DELIVERY_REASONS.has(dispute.reason);
  const isLargeAmount = dispute.amount >= AMOUNT_THRESHOLD_CENTS;
  const routeToManualQueue = isNonDelivery || isLargeAmount;
  const routing: "auto_submit" | "manual_queue" = routeToManualQueue
    ? "manual_queue"
    : "auto_submit";

  console.log(
    `[${FN_NAME}] routing=${routing} isLargeAmount=${isLargeAmount} isNonDelivery=${isNonDelivery}`,
  );

  const stubNotes = [
    claim?.completion_date
      ? `contractor_mark_complete_at: ${claim.completion_date} (sourced from claims.completion_date)`
      : "contractor_mark_complete_at: STUB — Mark Complete flow not yet built (D-228 follow-up)",
    "homeowner_acknowledgment_at: STUB — homeowner acknowledgment flow not yet built (D-228 follow-up)",
  ].join("; ");

  const { data: disputeRows, error: disputeInsertErr } = await supabase
    .from("disputes")
    .insert({
      stripe_dispute_id: dispute.id,
      stripe_charge_id: dispute.charge,
      stripe_payment_intent_id: dispute.payment_intent,
      claim_id: claim?.id ?? null,
      quote_id: quote?.id ?? null,
      contractor_id: claim?.selected_contractor_id ?? quote?.contractor_id ?? null,
      amount: dispute.amount,
      currency: dispute.currency,
      reason: dispute.reason,
      status: dispute.status,
      livemode: event.livemode,
      routing,
      contractor_mark_complete_at: claim?.completion_date ?? null,
      homeowner_acknowledgment_at: null,
      stub_notes: stubNotes,
    })
    .select("id")
    .single();

  if (disputeInsertErr) {
    console.error(`[${FN_NAME}] Failed to insert dispute row:`, disputeInsertErr);
  }

  const disputeRowId = disputeRows?.id ?? null;

  if (!routeToManualQueue) {
    const evidencePayload = buildEvidencePayload({ dispute, claim, feeAcceptance });

    console.log(`[${FN_NAME}] Submitting evidence for dispute ${dispute.id} via Stripe API`);

    const result = await stripeRequest(
      `/disputes/${dispute.id}`,
      "POST",
      stripeKey,
      evidencePayload,
    );

    if (disputeRowId) {
      await supabase
        .from("disputes")
        .update({
          evidence_submitted_at: new Date().toISOString(),
          evidence_payload: evidencePayload,
          auto_submit_result: result.ok ? result.data : null,
          auto_submit_error: result.ok ? null : result.error,
          status: result.ok ? "evidence_submitted" : dispute.status,
        })
        .eq("id", disputeRowId);
    }

    if (result.ok) {
      console.log(`[${FN_NAME}] Evidence submitted successfully for ${dispute.id}`);
    } else {
      console.error(
        `[${FN_NAME}] Evidence submission failed for ${dispute.id}: ${result.error}`,
      );
      await supabase.from("platform_alerts_log").insert({
        alert_type: "dispute_evidence_failure",
        function_name: FN_NAME,
        message: `Auto-evidence submission failed for dispute ${dispute.id}: ${result.error}. Manual review required.`,
        sent_at: new Date().toISOString(),
      });
    }

    await supabase.from("activity_log").insert({
      user_id: claim?.user_id ?? "00000000-0000-0000-0000-000000000000",
      event_type: "dispute.auto_evidence_submitted",
      title: `Dispute evidence auto-submitted: ${dispute.id}`,
      metadata: {
        stripe_dispute_id: dispute.id,
        amount_cents: dispute.amount,
        amount_dollars: amountDollars,
        reason: dispute.reason,
        success: result.ok,
        error: result.error ?? null,
        claim_id: claim?.id ?? null,
        routing,
      },
    });
  }

  if (routeToManualQueue) {
    const disputeUrl = event.livemode
      ? `https://dashboard.stripe.com/disputes/${dispute.id}`
      : `https://dashboard.stripe.com/test/disputes/${dispute.id}`;

    let clickupTaskId: string | null = null;
    let clickupTaskUrl: string | null = null;

    if (!clickupKey) {
      console.error(`[${FN_NAME}] CLICKUP_API_KEY not set — cannot create ClickUp task`);
      await supabase.from("platform_alerts_log").insert({
        alert_type: "dispute_clickup_config_missing",
        function_name: FN_NAME,
        message: `CLICKUP_API_KEY secret not set. Dispute ${dispute.id} ($${amountDollars}, ${dispute.reason}) needs manual ClickUp task. Stripe URL: ${disputeUrl}`,
        sent_at: new Date().toISOString(),
      });
    } else {
      const cuResult = await createClickUpTask({
        dispute,
        claim,
        feeAcceptance,
        disputeUrl,
        clickupKey,
      });

      if (cuResult.error) {
        console.error(`[${FN_NAME}] ClickUp task creation failed: ${cuResult.error}`);
        await supabase.from("platform_alerts_log").insert({
          alert_type: "dispute_clickup_failure",
          function_name: FN_NAME,
          message: `ClickUp task creation failed for dispute ${dispute.id}: ${cuResult.error}. Dispute URL: ${disputeUrl}`,
          sent_at: new Date().toISOString(),
        });
      } else {
        clickupTaskId = cuResult.taskId;
        clickupTaskUrl = cuResult.taskUrl;
        console.log(
          `[${FN_NAME}] ClickUp task created: ${clickupTaskId} for dispute ${dispute.id}`,
        );
      }
    }

    const { error: queueInsertErr } = await supabase
      .from("admin_dispute_queue")
      .insert({
        dispute_id: disputeRowId,
        stripe_dispute_id: dispute.id,
        amount: dispute.amount,
        reason: dispute.reason,
        claim_id: claim?.id ?? null,
        contractor_id: claim?.selected_contractor_id ?? quote?.contractor_id ?? null,
        stripe_dispute_url: event.livemode
          ? `https://dashboard.stripe.com/disputes/${dispute.id}`
          : `https://dashboard.stripe.com/test/disputes/${dispute.id}`,
        clickup_task_id: clickupTaskId,
        clickup_task_url: clickupTaskUrl,
        status: "open",
      });

    if (queueInsertErr) {
      console.error(`[${FN_NAME}] Failed to insert admin_dispute_queue row:`, queueInsertErr);
    }

    if (disputeRowId) {
      await supabase
        .from("disputes")
        .update({
          auto_submit_result: {
            routing: "manual_queue",
            clickup_task_id: clickupTaskId,
            clickup_task_url: clickupTaskUrl,
            reason: routeToManualQueue
              ? isNonDelivery
                ? "non_delivery_reason"
                : "amount_threshold"
              : null,
          },
        })
        .eq("id", disputeRowId);
    }

    await supabase.from("activity_log").insert({
      user_id: claim?.user_id ?? "00000000-0000-0000-0000-000000000000",
      event_type: "dispute.routed_to_manual_queue",
      title: `Dispute routed to manual review: ${dispute.id}`,
      metadata: {
        stripe_dispute_id: dispute.id,
        amount_cents: dispute.amount,
        amount_dollars: amountDollars,
        reason: dispute.reason,
        routing_trigger: isNonDelivery ? "non_delivery_reason" : "amount_threshold",
        claim_id: claim?.id ?? null,
        clickup_task_id: clickupTaskId,
        clickup_task_url: clickupTaskUrl,
        stripe_dispute_url: event.livemode
          ? `https://dashboard.stripe.com/disputes/${dispute.id}`
          : `https://dashboard.stripe.com/test/disputes/${dispute.id}`,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type, stripe-signature",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const rawBody = await req.text();
    const sigHeader = req.headers.get("stripe-signature");

    if (!sigHeader) {
      return new Response(JSON.stringify({ error: "Missing Stripe-Signature header" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SIGNING_SECRET");
    if (!webhookSecret) {
      console.error(`[${FN_NAME}] STRIPE_WEBHOOK_SIGNING_SECRET not configured`);
      return new Response(JSON.stringify({ error: "Webhook signing secret not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const isValid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
    if (!isValid) {
      console.error(`[${FN_NAME}] Stripe signature verification failed`);
      return new Response(JSON.stringify({ error: "Signature verification failed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const event = JSON.parse(rawBody) as StripeEvent;
    console.log(`[${FN_NAME}] Received event: ${event.type} (livemode=${event.livemode})`);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // ---------------------------------------------------------------------------
    // Event-level idempotency guard (D-211 P15 U15-1)
    // Stripe is at-least-once and redelivers on any non-2xx response. Record the
    // event id in the stripe_webhook_events ledger BEFORE any side-effect fires;
    // a unique violation means this event was already processed — ack and stop.
    // ---------------------------------------------------------------------------
    if (event.id) {
      const { error: dedupeErr } = await supabase
        .from("stripe_webhook_events")
        .insert({ event_id: event.id, event_type: event.type });

      if (dedupeErr) {
        if (dedupeErr.code === "23505") {
          console.log(
            `[${FN_NAME}] Duplicate event ${event.id} (${event.type}) already processed — skipping side-effects`,
          );
          return new Response(JSON.stringify({ received: true, duplicate: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        console.error(
          `[${FN_NAME}] Failed to record webhook event ${event.id} in ledger:`,
          dedupeErr,
        );
        return new Response(JSON.stringify({ error: "Failed to record webhook event" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (event.type === "charge.dispute.created") {
      await handleDisputeCreated(event, supabase);
    } else {
      console.log(`[${FN_NAME}] Unhandled event type: ${event.type} — acknowledged`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`[${FN_NAME}] Unhandled error:`, err);

    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
      );
      await supabase.from("platform_alerts_log").insert({
        alert_type: "stripe_webhook_error",
        function_name: FN_NAME,
        message: `Unhandled error in ${FN_NAME}: ${String(err)}`,
        sent_at: new Date().toISOString(),
      });
    } catch {
      // Swallow — already in error handler
    }

    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
