/**
 * OtterQuote Edge Function: process-bid-expirations
 *
 * D-150 — Bid Expiration System (Sessions 213 + 219, Apr 17, 2026)
 *
 * Invoked hourly via pg_cron (schedule: "0 * * * *").
 * May also be POST-ed manually with an optional claim_id to scope to one claim.
 *
 * ── What it does ───────────────────────────────────────────────────────────
 *
 * Phase 1 — Mark expired bids
 *   Finds all quotes where:
 *     - bid_status = 'active'
 *     - expires_at <= NOW()
 *     - NOT exempt (see exemption criteria below)
 *   Sets bid_status = 'expired', expired_at = NOW().
 *   For each expired bid:
 *     a. Writes a contractor dashboard notification (bid_expired).
 *     b. Sends a Mailgun email to the contractor with a one-click renew CTA.
 *     c. If auto_renew = true AND renewals_count < 3:
 *        - Clones the bid with a fresh 14-day window (renewed_from_quote_id set).
 *        - Marks old bid bid_status = 'superseded'.
 *        - Sends contractor a "bid auto-renewed" confirmation email.
 *     d. If auto_renew = true AND renewals_count >= 3:
 *        - Marks bid bid_status = 'expired' (cap reached — no renewal).
 *        - Sends contractor a "renewal cap reached — review pricing" email.
 *
 * Phase 2 — Homeowner notification on full bid-window expiry
 *   Finds all claims where:
 *     - bid_window_expires_at <= NOW()
 *     - bid_window_notified_at IS NULL (not yet notified)
 *     - status IN ('bidding', 'submitted') — still active
 *   For each:
 *     - Sends homeowner a Mailgun email (all bids expired, action required).
 *     - Writes a homeowner dashboard notification.
 *     - Sets claims.bid_window_notified_at = NOW() (idempotency guard).
 *
 * ── Exemption criteria (a bid is NEVER expired if ANY of these apply) ──────
 *   1. The claim's status is 'contract_signed' or 'awarded' — work already
 *      moving forward. Voiding the bid would create a DocuSign conflict.
 *   2. The quote has payment_status IN ('succeeded', 'dunning') — either paid
 *      or actively in dunning. Leave payment lifecycle alone.
 *   3. The claim has an open payment_failures row with dunning_status IN
 *      ('active', 'warning_sent', 'homeowner_notified') — active dunning.
 *   4. The quote's own bid_status is not 'active' — already handled.
 *
 * ── Renewals cap ─────────────────────────────────────────────────────────
 *   renewals_count is derived by counting quotes with the same
 *   original_quote_id chain. Max 3 renewals (42 days total).
 *   After cap: expiry is final; contractor must manually re-bid if desired.
 *
 * ── Returns ──────────────────────────────────────────────────────────────
 *   { expired: N, autoRenewed: N, windowsNotified: N, errors: [...] }
 *
 * ── Auth ──────────────────────────────────────────────────────────────────
 *   No JWT required — invoked by pg_cron service-role bearer token.
 *   No user-accessible endpoint. CORS allows otterquote.com for defense-in-depth.
 *
 * ── Env vars required ─────────────────────────────────────────────────────
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { checkRowsWritten, zeroRowWriteMessage } from "../_shared/zero-row-update-guard.ts";
import {
  buildBidExpiredEmail,
  buildAutoRenewedEmail,
  buildRenewalCapEmail,
  buildBidWindowExpiredHomeownerEmail,
} from "./templates.ts"; // gh-1824: email bodies moved to templates.ts (testable, no serve() import)

// =============================================================================
// CONSTANTS
// =============================================================================

const BID_EXPIRY_DAYS = 14;
const MAX_AUTO_RENEWALS = 3;

// Claims in these statuses have active contracts — never expire their bids.
const EXEMPT_CLAIM_STATUSES = ["contract_signed", "awarded"];

// Quotes in these payment_status values are exempt from expiration.
const EXEMPT_PAYMENT_STATUSES = ["succeeded", "dunning", "refunded"];

// Active dunning statuses in payment_failures table — bids exempt while open.
const ACTIVE_DUNNING_STATUSES = ["active", "warning_sent", "homeowner_notified"];

// CORS — defense-in-depth (cron caller doesn't need it, but browsers might hit this).
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

// =============================================================================
// CORS HELPER
// =============================================================================

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Vary": "Origin",
  };
}

function jsonResponse(body: unknown, status = 200, corsHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// =============================================================================
// MAILGUN HELPER
// =============================================================================

async function sendMailgunEmail(
  apiKey: string,
  domain: string,
  to: string,
  from: string,
  subject: string,
  text: string,
  html?: string
): Promise<boolean> {
  const basicAuth = btoa(`api:${apiKey}`);
  const formData = new URLSearchParams();
  formData.append("from", from);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", text);
  if (html) formData.append("html", html);

  const response = await fetch(
    `https://api.mailgun.net/v3/${domain}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${basicAuth}` },
      body: formData,
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[process-bid-expirations] Mailgun error (${response.status}):`, errText);
    return false;
  }
  return true;
}

// =============================================================================
// TRADE LABEL HELPER
// =============================================================================

function tradeLabel(trades: string[] | null): string {
  if (!trades || trades.length === 0) return "general";
  if (trades.length === 1) return trades[0].toLowerCase();
  if (trades.length === 2) return trades.map((t) => t.toLowerCase()).join(" & ");
  return "multi-trade";
}

// =============================================================================
// RENEWAL CHAIN DEPTH COUNTER
// =============================================================================

/**
 * Counts how many times a bid has already been renewed by walking
 * renewed_from_quote_id back to the root.
 * Returns the depth: 0 = original bid, 1 = first renewal, etc.
 * Caps walk at MAX_AUTO_RENEWALS + 1 to avoid infinite loops on bad data.
 */
async function getRenewalDepth(
  supabase: ReturnType<typeof createClient>,
  quoteId: string
): Promise<number> {
  let depth = 0;
  let currentId = quoteId;
  const maxWalk = MAX_AUTO_RENEWALS + 2;

  while (depth < maxWalk) {
    const { data, error } = await supabase
      .from("quotes")
      .select("renewed_from_quote_id")
      .eq("id", currentId)
      .single();

    if (error || !data || !data.renewed_from_quote_id) break;
    currentId = data.renewed_from_quote_id;
    depth++;
  }

  return depth;
}

// =============================================================================
// PHASE 1 — EXPIRE BIDS
// =============================================================================

async function expireBids(
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  scopeClaimId?: string
): Promise<{ expired: number; autoRenewed: number; errors: string[] }> {
  const errors: string[] = [];
  let expiredCount = 0;
  let autoRenewedCount = 0;

  const now = new Date().toISOString();
  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;

  // ── Fetch candidates ────────────────────────────────────────────────────────
  // Join to claims so we can filter by claim status and get homeowner address.
  // Join to contractors so we can fetch contractor contact info.
  let query = supabase
    .from("quotes")
    .select(`
      id,
      claim_id,
      contractor_id,
      total_price,
      auto_renew,
      renewed_from_quote_id,
      expires_at,
      trade_type,
      bundled_trades,
      payment_status,
      bid_status,
      claims!inner (
        id,
        status,
        property_address,
        user_id
      ),
      contractors!inner (
        id,
        user_id,
        contact_name,
        email,
        notification_emails
      )
    `)
    .eq("bid_status", "active")
    .lte("expires_at", now)
    .not("expires_at", "is", null);

  if (scopeClaimId) {
    query = query.eq("claim_id", scopeClaimId);
  }

  const { data: candidates, error: fetchError } = await query;

  if (fetchError) {
    console.error("[process-bid-expirations] Phase 1 fetch error:", fetchError.message);
    errors.push(`Phase 1 fetch: ${fetchError.message}`);
    return { expired: expiredCount, autoRenewed: autoRenewedCount, errors };
  }

  if (!candidates || candidates.length === 0) {
    console.log("[process-bid-expirations] Phase 1: no expired bids found");
    return { expired: 0, autoRenewed: 0, errors };
  }

  console.log(`[process-bid-expirations] Phase 1: ${candidates.length} candidate(s) to process`);

  for (const quote of candidates) {
    const claim = Array.isArray(quote.claims) ? quote.claims[0] : quote.claims as any;
    const contractor = Array.isArray(quote.contractors) ? quote.contractors[0] : quote.contractors as any;

    if (!claim || !contractor) {
      errors.push(`Quote ${quote.id}: missing claim or contractor join data — skipped`);
      continue;
    }

    // ── Exemption checks ──────────────────────────────────────────────────────

    // 1. Claim in post-contract status
    if (EXEMPT_CLAIM_STATUSES.includes(claim.status)) {
      console.log(`[process-bid-expirations] Quote ${quote.id}: exempt (claim status=${claim.status})`);
      continue;
    }

    // 2. Payment already resolved or in dunning
    if (quote.payment_status && EXEMPT_PAYMENT_STATUSES.includes(quote.payment_status)) {
      console.log(`[process-bid-expirations] Quote ${quote.id}: exempt (payment_status=${quote.payment_status})`);
      continue;
    }

    // 3. Active dunning entry in payment_failures
    const { data: dunningRows } = await supabase
      .from("payment_failures")
      .select("id")
      .eq("quote_id", quote.id)
      .in("dunning_status", ACTIVE_DUNNING_STATUSES)
      .limit(1);

    if (dunningRows && dunningRows.length > 0) {
      console.log(`[process-bid-expirations] Quote ${quote.id}: exempt (active dunning)`);
      continue;
    }

    // ── Determine auto-renew eligibility ─────────────────────────────────────
    const shouldAutoRenew = quote.auto_renew === true;
    let renewalDepth = 0;
    if (shouldAutoRenew) {
      renewalDepth = await getRenewalDepth(supabase, quote.id);
    }
    const canAutoRenew = shouldAutoRenew && renewalDepth < MAX_AUTO_RENEWALS;

    const address = claim.property_address || "your project address";
    // trade_type is a string (single trade); bundled_trades is an array for multi-trade bids
    const trades: string[] = quote.bundled_trades?.length
      ? quote.bundled_trades
      : (quote.trade_type ? [quote.trade_type] : []);
    const trade = tradeLabel(trades);
    const contractorEmail = contractor.email;
    const contractorName = contractor.contact_name || "Contractor";

    // Collect all notification emails
    const emailRecipients: string[] = [];
    if (contractorEmail) emailRecipients.push(contractorEmail);
    if (contractor.notification_emails && Array.isArray(contractor.notification_emails)) {
      for (const e of contractor.notification_emails) {
        if (e && !emailRecipients.includes(e)) emailRecipients.push(e);
      }
    }

    if (canAutoRenew) {
      // ── AUTO-RENEW PATH ─────────────────────────────────────────────────────

      // 1. Create renewal quote (clone with fresh window)
      const newExpiresAt = new Date(Date.now() + BID_EXPIRY_DAYS * 86400 * 1000).toISOString();
      const { data: newQuote, error: insertError } = await supabase
        .from("quotes")
        .insert({
          claim_id:                 quote.claim_id,
          contractor_id:            quote.contractor_id,
          total_price:              quote.total_price,
          auto_renew:               quote.auto_renew,
          renewed_from_quote_id:    quote.id,
          expires_at:               newExpiresAt,
          bid_status:               "active",
          trade_type:               quote.trade_type,
          // value_adds and other JSON fields are intentionally not cloned here
          // to keep the renewal lightweight. A full clone can be added later if
          // needed — the contract template and pricing are the operative data.
        })
        .select("id")
        .single();

      if (insertError || !newQuote) {
        console.error(`[process-bid-expirations] Auto-renew insert failed for quote ${quote.id}:`, insertError?.message);
        errors.push(`Auto-renew insert failed for ${quote.id}: ${insertError?.message}`);
        // Fall through to mark original expired without renewal
      } else {
        // 2. Mark original as superseded
        const { error: supersedeErr, data: supersedeRows } = await supabase
          .from("quotes")
          .update({ bid_status: "superseded", expired_at: now })
          .eq("id", quote.id)
          .select("id");
        // gh-2105 (decision a, fire-and-forget): the renewal quote already
        // exists, so no throw -- but a silent miss leaves the original live
        // next to its renewal (two live bids for one contractor/claim).
        if (supersedeErr || !checkRowsWritten(supersedeRows).wroteRows) {
          console.error(zeroRowWriteMessage("process-bid-expirations", `quotes.bid_status=superseded for quote ${quote.id}`), supersedeErr?.message ?? "");
          errors.push(`Supersede update failed for ${quote.id}: ${supersedeErr?.message ?? "zero rows matched (gh-2105)"}`);
        }

        // 3. Contractor dashboard notification (auto-renewed)
        try {
          await supabase.from("notifications").insert({
            user_id:           contractor.user_id,
            claim_id:          quote.claim_id,
            notification_type: "bid_auto_renewed",
            channel:           "dashboard",
            message_preview:   `Your ${trade} bid for ${address} was automatically renewed. It's valid for 14 more days.`,
          });
        } catch (notifErr) {
          console.warn(`[process-bid-expirations] Notification insert failed (non-fatal):`, notifErr);
        }

        // 4. Contractor email — auto-renewed confirmation
        const stopUrl = `https://otterquote.com/contractor-bid-form.html?stop_renew=${newQuote.id}`;
        const renewedAt = new Date(newExpiresAt).toLocaleDateString("en-US", {
          month: "long", day: "numeric", year: "numeric",
        });
        const renewedEmail = buildAutoRenewedEmail({
          contractorName,
          homeownerAddress: address,
          tradeLabel: trade,
          newQuoteId: newQuote.id,
          newExpiresAt: renewedAt,
          stopUrl,
          mailgunDomain,
        });

        for (const recipient of emailRecipients) {
          await sendMailgunEmail(
            mailgunApiKey, mailgunDomain,
            recipient, fromAddress,
            renewedEmail.subject, renewedEmail.text, renewedEmail.html
          );
        }

        console.log(`[process-bid-expirations] Auto-renewed quote ${quote.id} → new quote ${newQuote.id}`);
        autoRenewedCount++;
        continue; // Don't also count as expired
      }
    }

    if (shouldAutoRenew && renewalDepth >= MAX_AUTO_RENEWALS) {
      // ── AUTO-RENEW CAP PATH ─────────────────────────────────────────────────
      // Mark expired and send cap-reached email.
      const { error: capExpireErr, data: capExpireRows } = await supabase
        .from("quotes")
        .update({ bid_status: "expired", expired_at: now })
        .eq("id", quote.id)
        .select("id");
      // gh-2105 (decision a, fire-and-forget): log + surface in errors[]; the
      // cap-reached email below still goes out as before.
      if (capExpireErr || !checkRowsWritten(capExpireRows).wroteRows) {
        console.error(zeroRowWriteMessage("process-bid-expirations", `quotes.bid_status=expired (cap path) for quote ${quote.id}`), capExpireErr?.message ?? "");
        errors.push(`Cap-path expire update failed for ${quote.id}: ${capExpireErr?.message ?? "zero rows matched (gh-2105)"}`);
      }

      try {
        await supabase.from("notifications").insert({
          user_id:           contractor.user_id,
          claim_id:          quote.claim_id,
          notification_type: "bid_renewal_cap_reached",
          channel:           "dashboard",
          message_preview:   `Your ${trade} bid for ${address} reached the maximum renewal limit. Consider submitting a fresh bid.`,
        });
      } catch (notifErr) {
        console.warn(`[process-bid-expirations] Notification insert failed (non-fatal):`, notifErr);
      }

      const capEmail = buildRenewalCapEmail({
        contractorName,
        homeownerAddress: address,
        tradeLabel: trade,
        mailgunDomain,
      });

      for (const recipient of emailRecipients) {
        await sendMailgunEmail(
          mailgunApiKey, mailgunDomain,
          recipient, fromAddress,
          capEmail.subject, capEmail.text, capEmail.html
        );
      }

      expiredCount++;
      console.log(`[process-bid-expirations] Cap-reached expiry: quote ${quote.id} (depth=${renewalDepth})`);
      continue;
    }

    // ── STANDARD EXPIRY PATH (no auto-renew) ──────────────────────────────────
    const { error: updateError, data: expireRows } = await supabase
      .from("quotes")
      .update({ bid_status: "expired", expired_at: now })
      .eq("id", quote.id)
      .select("id");

    if (updateError) {
      console.error(`[process-bid-expirations] Failed to mark quote ${quote.id} expired:`, updateError.message);
      errors.push(`Expire update failed for ${quote.id}: ${updateError.message}`);
      continue;
    }
    // gh-2105 (decision a): a zero-row match means the quote was not actually
    // expired (row changed/RLS), so -- exactly like the updateError branch
    // above -- record it and skip the expiry notification/email for this quote.
    if (!checkRowsWritten(expireRows).wroteRows) {
      console.error(zeroRowWriteMessage("process-bid-expirations", `quotes.bid_status=expired for quote ${quote.id}`));
      errors.push(`Expire update failed for ${quote.id}: zero rows matched (gh-2105)`);
      continue;
    }

    // Contractor dashboard notification
    try {
      await supabase.from("notifications").insert({
        user_id:           contractor.user_id,
        claim_id:          quote.claim_id,
        notification_type: "bid_expired",
        channel:           "dashboard",
        message_preview:   `Your ${trade} bid for ${address} has expired. Renew in one click to stay in the running.`,
      });
    } catch (notifErr) {
      console.warn(`[process-bid-expirations] Notification insert failed (non-fatal):`, notifErr);
    }

    // Contractor email — bid expired
    const expiredEmail = buildBidExpiredEmail({
      contractorName,
      homeownerAddress: address,
      tradeLabel: trade,
      quoteId: quote.id,
      mailgunDomain,
    });

    for (const recipient of emailRecipients) {
      await sendMailgunEmail(
        mailgunApiKey, mailgunDomain,
        recipient, fromAddress,
        expiredEmail.subject, expiredEmail.text, expiredEmail.html
      );
    }

    expiredCount++;
    console.log(`[process-bid-expirations] Expired quote ${quote.id} for claim ${quote.claim_id}`);
  }

  return { expired: expiredCount, autoRenewed: autoRenewedCount, errors };
}

// =============================================================================
// PHASE 2 — HOMEOWNER BID-WINDOW EXPIRY NOTIFICATION
// =============================================================================

async function notifyBidWindowExpirations(
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  scopeClaimId?: string
): Promise<{ windowsNotified: number; errors: string[] }> {
  const errors: string[] = [];
  let windowsNotified = 0;
  const now = new Date().toISOString();
  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;

  // Find claims whose bid window has expired and haven't been notified yet.
  // No FK from claims.user_id → profiles.id, so profiles are fetched separately below.
  let query = supabase
    .from("claims")
    .select("id, status, property_address, user_id, bid_window_expires_at, bid_window_notified_at")
    .lte("bid_window_expires_at", now)
    .is("bid_window_notified_at", null)
    .in("status", ["bidding", "submitted"]);

  if (scopeClaimId) {
    query = query.eq("id", scopeClaimId);
  }

  const { data: expiredWindows, error: fetchError } = await query;

  if (fetchError) {
    console.error("[process-bid-expirations] Phase 2 fetch error:", fetchError.message);
    errors.push(`Phase 2 fetch: ${fetchError.message}`);
    return { windowsNotified, errors };
  }

  if (!expiredWindows || expiredWindows.length === 0) {
    console.log("[process-bid-expirations] Phase 2: no bid windows to notify");
    return { windowsNotified: 0, errors };
  }

  console.log(`[process-bid-expirations] Phase 2: ${expiredWindows.length} window(s) to notify`);

  for (const claim of expiredWindows) {
    // Fetch homeowner profile separately (no FK registered in schema cache)
    const { data: profileData } = await supabase
      .from("profiles")
      .select("full_name, email")
      .eq("id", claim.user_id)
      .single();

    if (!profileData || !profileData.email) {
      errors.push(`Claim ${claim.id}: no homeowner profile/email — skipped`);
      continue;
    }

    const homeownerName = profileData.full_name || "there";
    const propertyAddress = claim.property_address || "your property";
    const bidsUrl = `https://otterquote.com/bids.html?claim=${claim.id}`;

    // Mark claim as notified first (idempotency — don't double-send if email fails)
    const { error: updateError, data: notifiedRows } = await supabase
      .from("claims")
      .update({ bid_window_notified_at: now })
      .eq("id", claim.id)
      .select("id");

    if (updateError) {
      console.error(`[process-bid-expirations] Failed to set bid_window_notified_at for claim ${claim.id}:`, updateError.message);
      errors.push(`Window notified_at update failed for ${claim.id}: ${updateError.message}`);
      continue;
    }
    // gh-2105 (decision a): the notified_at stamp is the idempotency guard for
    // the send below. A zero-row match means it did NOT stick, so sending would
    // re-send every run -- same handling as the updateError branch above.
    if (!checkRowsWritten(notifiedRows).wroteRows) {
      console.error(zeroRowWriteMessage("process-bid-expirations", `claims.bid_window_notified_at for claim ${claim.id}`));
      errors.push(`Window notified_at update failed for ${claim.id}: zero rows matched (gh-2105)`);
      continue;
    }

    // Dashboard notification
    try {
      await supabase.from("notifications").insert({
        user_id:           claim.user_id,
        claim_id:          claim.id,
        notification_type: "bid_window_expired",
        channel:           "dashboard",
        message_preview:   `All contractor bids for your project at ${propertyAddress} have expired. Log in to request updated bids.`,
      });
    } catch (notifErr) {
      console.warn(`[process-bid-expirations] Homeowner notification insert failed (non-fatal):`, notifErr);
    }

    // Homeowner email
    const windowEmail = buildBidWindowExpiredHomeownerEmail({
      homeownerName,
      propertyAddress,
      bidsUrl,
      mailgunDomain,
    });

    const sent = await sendMailgunEmail(
      mailgunApiKey, mailgunDomain,
      profileData.email, fromAddress,
      windowEmail.subject, windowEmail.text, windowEmail.html
    );

    if (!sent) {
      errors.push(`Homeowner email failed for claim ${claim.id}`);
    }

    windowsNotified++;
    console.log(`[process-bid-expirations] Notified homeowner for claim ${claim.id} (window expired)`);
  }

  return { windowsNotified, errors };
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only POST accepted (pg_cron fires POST; manual triggers also POST)
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  // ── Environment ────────────────────────────────────────────────────────────
  const supabaseUrl    = Deno.env.get("SUPABASE_URL")!;
  const serviceKey     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mailgunApiKey  = Deno.env.get("MAILGUN_API_KEY")!;
  const mailgunDomain  = Deno.env.get("MAILGUN_DOMAIN")!;

  if (!supabaseUrl || !serviceKey || !mailgunApiKey || !mailgunDomain) {
    console.error("[process-bid-expirations] Missing required env vars");
    return jsonResponse({ error: "Server configuration error" }, 500, corsHeaders);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // ── Optional scope override ────────────────────────────────────────────────
  // Pass { "claim_id": "..." } in the body to scope to a single claim.
  // Useful for manual testing or targeted remediation.
  let scopeClaimId: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.claim_id && typeof body.claim_id === "string") {
      scopeClaimId = body.claim_id;
      console.log(`[process-bid-expirations] Scoped to claim: ${scopeClaimId}`);
    }
  } catch {
    // No body — fine, run globally
  }

  const startedAt = Date.now();
  const allErrors: string[] = [];

  // ── Phase 1: Expire bids ───────────────────────────────────────────────────
  const phase1 = await expireBids(supabase, mailgunApiKey, mailgunDomain, scopeClaimId);
  allErrors.push(...phase1.errors);

  // ── Phase 2: Notify homeowners on full bid-window expiry ──────────────────
  const phase2 = await notifyBidWindowExpirations(supabase, mailgunApiKey, mailgunDomain, scopeClaimId);
  allErrors.push(...phase2.errors);

  const elapsed = Date.now() - startedAt;

  const result = {
    expired:          phase1.expired,
    autoRenewed:      phase1.autoRenewed,
    windowsNotified:  phase2.windowsNotified,
    errors:           allErrors,
    elapsedMs:        elapsed,
    ranAt:            new Date().toISOString(),
  };

  console.log("[process-bid-expirations] Run complete:", JSON.stringify(result));

  // Write cron health record (non-fatal)
  try {
    const cronStatus = allErrors.length > 0 ? "error" : "success";
    const cronError  = allErrors.length > 0 ? allErrors.slice(0, 5).join("; ") : null;
    await supabase.rpc("record_cron_health", {
      p_job_name: "process-bid-expirations",
      p_status:   cronStatus,
      p_error:    cronError,
    });
  } catch (cronHealthErr) {
    console.warn("[process-bid-expirations] cron_health write failed (non-fatal):", cronHealthErr);
  }

  return jsonResponse(result, 200, corsHeaders);
});
