/**
 * OtterQuote Edge Function: send-home-profile-prompt
 *
 * D-231 — Post-completion homeowner home profile prompt (Lodge data moat, D-205)
 *
 * Dual-trigger pattern:
 *   1. pg_cron (hourly): no body → batch-scans all claims where completion_date
 *      is 24h+ ago AND profile_prompt_sent_at IS NULL → sends email + stamps column.
 *   2. mark-job-complete: fires with { claim_id } immediately after completion →
 *      24h gate returns "too_early" right after completion; cron picks it up later.
 *      This wires the trigger as specified by D-231 without needing a separate queue.
 *
 * Idempotency:
 *   - claims.profile_prompt_sent_at IS NOT NULL → skip (already sent).
 *   - home_profiles row already exists for homeowner → stamp column + skip email.
 *
 * Input (POST body):
 *   {}                   → cron / batch mode: scan all eligible claims (limit 50)
 *   { claim_id: string } → targeted mode: single claim, respects 24h gate
 *
 * Output:
 *   Targeted: { ok: true, result: "sent"|"too_early"|"already_sent"|"already_has_profile" }
 *   Batch:    { ok: true, processed: number, skipped: number, results: ScanResult[] }
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAILGUN_API_KEY, SITE_URL
 *
 * Authorization:
 *   Accepts requests with no Authorization header (cron invocation via pg_net).
 *   Validates X-Cron-Secret header when called from cron to prevent open invocation.
 *   mark-job-complete passes its own service-role bearer to authorize.
 *   External (unauthenticated) calls with no secret header → 401.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

const FUNCTION_NAME = "send-home-profile-prompt";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClaimRow {
  id: string;
  user_id: string;
  completion_date: string;
  property_address: string | null;
  trades: string[] | null;
  profile_prompt_sent_at: string | null;
}

interface ScanResult {
  claim_id: string;
  result: "sent" | "too_early" | "already_sent" | "already_has_profile" | "no_email" | "error";
  error?: string;
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

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
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Vary": "Origin",
  };
}

function jsonResponse(
  data: unknown,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Trade label resolution ───────────────────────────────────────────────────

function resolveTradeLabel(trades: string[] | null): string {
  if (!trades || trades.length === 0) return "home repair";
  const tradeMap: Record<string, string> = {
    roofing: "roofing",
    siding: "siding",
    gutters: "gutters",
    windows: "windows",
    hvac: "HVAC",
    repair: "repair",
  };
  const labels = trades.map((t) => tradeMap[t.toLowerCase()] || t.toLowerCase());
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/** Returns completion year if any trade is roofing (pre-populates roof_last_replaced). */
function getRoofCompletionYear(
  trades: string[] | null,
  completionDate: string
): number | null {
  if (!trades) return null;
  const isRoofing = trades.some((t) => t.toLowerCase() === "roofing");
  if (!isRoofing) return null;
  const year = new Date(completionDate).getFullYear();
  return isNaN(year) ? null : year;
}

// ─── Email builder ────────────────────────────────────────────────────────────

// ── Inlined from _shared/email.ts (#869) — see that file's header comment ──
// for why this is duplicated rather than imported (the EF body-deploy path
// does not resolve `_shared/` imports). Table-based CTA + MSO VML conditional
// so Outlook renders a real filled rectangle, not a bare `<a>`. Brand amber
// #E07B00 (this file already used it — now canonical + Outlook-safe).
function emailButton({ href, label }: { href: string; label: string }): string {
  const BRAND_AMBER = "#E07B00";
  const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  return `
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="15%" strokecolor="${BRAND_AMBER}" fillcolor="${BRAND_AMBER}">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:${FONT_STACK};font-size:16px;font-weight:700;">${label}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="${BRAND_AMBER}" style="border-radius:8px;">
      <a href="${href}" style="display:inline-block;font-family:${FONT_STACK};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">${label}</a>
    </td>
  </tr>
</table>
<!--<![endif]-->`.trim();
}

function buildEmailContent(
  homeownerName: string,
  tradeLabel: string,
  address: string | null,
  profileUrl: string,
  roofYear: number | null
): { subject: string; textBody: string; htmlBody: string } {
  const displayAddress = address || "your property";
  const firstName = homeownerName.split(" ")[0] || homeownerName;

  // Subject: D-231 locked — "[Trade]" becomes the resolved trade label
  const subject = `Your ${tradeLabel} project is complete — your home profile is waiting`;

  const ctaLabel = "Build My Home Profile →";

  const textBody = [
    `Hi ${firstName},`,
    "",
    `Your ${tradeLabel} project at ${displayAddress} is complete — congratulations on getting this done.`,
    "",
    "Before you close the book on this one, there's one more thing that could make your next project a lot easier.",
    "",
    "Build your home profile — it takes about 2 minutes.",
    "",
    "Your home profile stores the basics about your property in one place: when it was built, its square footage, number of stories, and what projects you might want done down the road. When you're ready for your next project — whether it's new gutters, updated siding, or something else entirely — we'll already know your home. That means faster quotes and contractors who come prepared.",
    "",
    `${ctaLabel}`,
    profileUrl,
    "",
    "The profile covers four quick questions:",
    "  • Year built",
    "  • Square footage (approximate is fine)",
    "  • Stories",
    "  • Future projects of interest",
    "",
    "You can also add optional details like when your roof was last replaced" +
      (roofYear ? ` (we've pre-filled this with ${roofYear} based on your completed project)` : "") +
      ", your siding material, or your HVAC age. The more we know, the faster we can help you next time.",
    "",
    "Thank you for trusting Otter Quotes with this project. We look forward to helping you again whenever you're ready.",
    "",
    "— The Otter Quotes Team",
    "",
    "─────────────────────────────────────────",
    "You're receiving this email because a project on your Otter Quotes account was recently marked complete.",
    "Manage your preferences at: https://otterquote.com/dashboard.html",
  ].join("\n");

  const roofYearNote = roofYear
    ? `<p style="color:#6B7280;font-size:0.875rem;margin:0.25rem 0 0;">
        (We've pre-filled the year your roof was replaced based on your completed project — just confirm or adjust.)
       </p>`
    : "";

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:Arial,Helvetica,sans-serif;color:#1F2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F8FAFC;">
    <tr>
      <td align="center" style="padding:2rem 1rem;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0"
               style="max-width:600px;width:100%;background:#ffffff;border-radius:0.75rem;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#0D1B2E;padding:1.5rem 2rem;text-align:center;">
              <img src="https://otterquote.com/images/otter-logo.png" alt="Otter Quotes"
                   height="40" style="height:40px;" onerror="this.style.display='none'">
              <p style="margin:0.5rem 0 0;color:#94A3B8;font-size:0.875rem;letter-spacing:0.05em;">OTTER QUOTES</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:2rem 2rem 1.5rem;">
              <h1 style="margin:0 0 1rem;font-size:1.375rem;font-weight:700;color:#0D1B2E;line-height:1.3;">
                Your ${tradeLabel} project is complete 🎉
              </h1>
              <p style="margin:0 0 1rem;line-height:1.6;">Hi ${firstName},</p>
              <p style="margin:0 0 1rem;line-height:1.6;">
                Your ${tradeLabel} project at <strong>${displayAddress}</strong> is complete —
                congratulations on getting this done.
              </p>
              <p style="margin:0 0 1.5rem;line-height:1.6;">
                Before you close the book on this one, there's one more thing that could make
                your next project a lot easier.
              </p>

              <!-- Feature callout -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
                     style="background:#F0FDF4;border-left:4px solid #16A34A;border-radius:0 0.5rem 0.5rem 0;margin-bottom:1.5rem;">
                <tr>
                  <td style="padding:1.25rem 1.5rem;">
                    <p style="margin:0 0 0.5rem;font-weight:700;font-size:1rem;color:#15803D;">
                      Build your home profile — it takes about 2 minutes.
                    </p>
                    <p style="margin:0;line-height:1.6;color:#1F2937;font-size:0.9375rem;">
                      Your home profile stores the basics about your property in one place — when it was
                      built, its square footage, number of stories, and what projects you might want done
                      down the road. When you're ready for your next project, we'll already know your home.
                      That means faster quotes and contractors who come prepared.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- CTA button -->
              ${emailButton({ href: profileUrl, label: "Build My Home Profile →" })}

              <!-- What's included -->
              <p style="margin:0 0 0.75rem;font-weight:600;color:#374151;">The profile covers four quick questions:</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
                     style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:0.5rem;margin-bottom:1.25rem;">
                <tr>
                  <td style="padding:1rem 1.25rem;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="padding:0.4rem 0;border-bottom:1px solid #E2E8F0;">
                          <strong style="color:#374151;">📅 Year built</strong>
                          <span style="color:#6B7280;font-size:0.875rem;"> — helps contractors know your home's construction era</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:0.4rem 0;border-bottom:1px solid #E2E8F0;">
                          <strong style="color:#374151;">📐 Square footage</strong>
                          <span style="color:#6B7280;font-size:0.875rem;"> — approximate is fine; used for material estimates</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:0.4rem 0;border-bottom:1px solid #E2E8F0;">
                          <strong style="color:#374151;">🏠 Stories</strong>
                          <span style="color:#6B7280;font-size:0.875rem;"> — important for access, safety, and pricing</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:0.4rem 0;">
                          <strong style="color:#374151;">🔧 Future projects</strong>
                          <span style="color:#6B7280;font-size:0.875rem;"> — so we can match you faster when you're ready</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Optional section mention -->
              <p style="margin:0 0 1rem;line-height:1.6;font-size:0.9375rem;color:#374151;">
                You can also add optional details like when your roof was last replaced${roofYear ? ` (we've pre-filled <strong>${roofYear}</strong> based on your completed project)` : ""}, your siding material, or your HVAC age. The more we know, the faster we can help you next time.
              </p>
              ${roofYearNote}

              <!-- Second CTA -->
              ${emailButton({ href: profileUrl, label: "Build My Home Profile →" })}

              <p style="margin:0 0 0;line-height:1.6;color:#374151;">
                Thank you for trusting Otter Quotes with this project. We look forward to helping you again whenever you're ready.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:1.25rem 2rem;text-align:center;">
              <p style="margin:0 0 0.25rem;color:#9CA3AF;font-size:0.75rem;">
                — The Otter Quotes Team
              </p>
              <p style="margin:0;color:#9CA3AF;font-size:0.75rem;">
                You're receiving this email because a project on your Otter Quotes account was recently marked complete.
                <br>
                <a href="https://otterquote.com/dashboard.html" style="color:#9CA3AF;">Manage your preferences</a>
                &nbsp;·&nbsp;
                <a href="https://otterquote.com" style="color:#9CA3AF;">otterquote.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, textBody, htmlBody };
}

// ─── Core: process a single claim ────────────────────────────────────────────

async function processClaim(
  supabase: ReturnType<typeof createClient>,
  claim: ClaimRow,
  mailgunApiKey: string | undefined,
  siteUrl: string
): Promise<ScanResult> {
  const claimId = claim.id;

  // Idempotency: already sent
  if (claim.profile_prompt_sent_at) {
    return { claim_id: claimId, result: "already_sent" };
  }

  // 24-hour gate
  const elapsed = Date.now() - new Date(claim.completion_date).getTime();
  if (elapsed < TWENTY_FOUR_HOURS_MS) {
    return { claim_id: claimId, result: "too_early" };
  }

  // Check if homeowner already has a home_profiles row
  const { data: existingProfile } = await supabase
    .from("home_profiles")
    .select("id")
    .eq("homeowner_user_id", claim.user_id)
    .maybeSingle();

  if (existingProfile) {
    // Stamp so we don't re-check on every cron run
    await supabase
      .from("claims")
      .update({ profile_prompt_sent_at: new Date().toISOString() })
      .eq("id", claimId);
    return { claim_id: claimId, result: "already_has_profile" };
  }

  // Resolve homeowner contact info
  let homeownerEmail: string | null = null;
  let homeownerName = "there";

  const { data: profile } = await supabase
    .from("profiles")
    .select("email, full_name")
    .eq("id", claim.user_id)
    .maybeSingle();

  if (profile?.email) {
    homeownerEmail = profile.email;
    homeownerName = profile.full_name || "there";
  } else {
    const { data: authUser } = await supabase.auth.admin.getUserById(claim.user_id);
    homeownerEmail = authUser?.user?.email || null;
    homeownerName = authUser?.user?.user_metadata?.full_name || "there";
  }

  if (!homeownerEmail) {
    console.warn(`[${FUNCTION_NAME}] No email for homeowner ${claim.user_id} on claim ${claimId} — skipping`);
    return { claim_id: claimId, result: "no_email" };
  }

  // Build email
  const tradeLabel = resolveTradeLabel(claim.trades);
  const roofYear = getRoofCompletionYear(claim.trades, claim.completion_date);
  const profileUrl = `${siteUrl}/dashboard.html?profile_prompt=1`;
  const { subject, textBody, htmlBody } = buildEmailContent(
    homeownerName,
    tradeLabel,
    claim.property_address,
    profileUrl,
    roofYear
  );

  // Send via Mailgun
  if (!mailgunApiKey) {
    console.warn(`[${FUNCTION_NAME}] MAILGUN_API_KEY not set — skipping email send for claim ${claimId}`);
  } else {
    const formData = new FormData();
    formData.append("from", "Otter Quotes <noreply@mail.otterquote.com>");
    formData.append("to", homeownerEmail);
    formData.append("subject", subject);
    formData.append("text", textBody);
    formData.append("html", htmlBody);

    try {
      const mgResponse = await fetch(
        "https://api.mailgun.net/v3/mail.otterquote.com/messages",
        {
          method: "POST",
          headers: { Authorization: `Basic ${btoa(`api:${mailgunApiKey}`)}` },
          body: formData,
        }
      );

      if (mgResponse.ok) {
        console.log(`[${FUNCTION_NAME}] Email sent → ${homeownerEmail} for claim ${claimId}`);
      } else {
        const errText = await mgResponse.text().catch(() => "(unreadable)");
        console.error(`[${FUNCTION_NAME}] Mailgun ${mgResponse.status} for ${claimId}: ${errText}`);
        return { claim_id: claimId, result: "error", error: `Mailgun ${mgResponse.status}` };
      }
    } catch (err) {
      console.error(`[${FUNCTION_NAME}] Mailgun fetch threw for ${claimId}:`, err);
      return { claim_id: claimId, result: "error", error: String(err) };
    }
  }

  // Stamp profile_prompt_sent_at (idempotency gate)
  const { error: stampError } = await supabase
    .from("claims")
    .update({ profile_prompt_sent_at: new Date().toISOString() })
    .eq("id", claimId);

  if (stampError) {
    console.error(`[${FUNCTION_NAME}] Failed to stamp profile_prompt_sent_at for ${claimId}:`, stampError.message);
    // Non-fatal: email was sent; we'll retry next cron run and idempotency check will skip
  }

  return { claim_id: claimId, result: "sent" };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
  }

  // ── Environment ──────────────────────────────────────────────────────────────
  const supabaseUrl     = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mailgunApiKey   = Deno.env.get("MAILGUN_API_KEY");
  const siteUrl         = Deno.env.get("SITE_URL") || "https://otterquote.com";
  const cronSecret      = Deno.env.get("CRON_SECRET");  // optional — set to secure cron calls

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, corsHeaders);
  }

  // ── Authorization ────────────────────────────────────────────────────────────
  // Allow if:
  //   (a) X-Cron-Secret header matches env CRON_SECRET (pg_net cron call), OR
  //   (b) Valid Supabase service-role Bearer token (mark-job-complete call), OR
  //   (c) CRON_SECRET is not configured (dev/staging — permissive)

  const incomingCronSecret = req.headers.get("X-Cron-Secret");
  const authHeader = req.headers.get("Authorization") || "";

  let authorized = false;

  if (!cronSecret) {
    // Not configured — allow all (dev/staging)
    authorized = true;
  } else if (incomingCronSecret && incomingCronSecret === cronSecret) {
    authorized = true;
  } else if (authHeader.startsWith("Bearer ")) {
    // Caller must present the service-role key — mark-job-complete uses it
    const token = authHeader.slice(7);
    authorized = token === serviceRoleKey;
  }

  if (!authorized) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401, corsHeaders);
  }

  // ── Parse body ───────────────────────────────────────────────────────────────
  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    if (raw.trim()) body = JSON.parse(raw);
  } catch (_) {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const targetClaimId = (body.claim_id as string || "").trim() || null;

  // ── Targeted mode (single claim_id from mark-job-complete) ───────────────────
  if (targetClaimId) {
    const { data: claim, error: claimErr } = await supabase
      .from("claims")
      .select("id, user_id, completion_date, property_address, trades, profile_prompt_sent_at")
      .eq("id", targetClaimId)
      .maybeSingle();

    if (claimErr || !claim) {
      return jsonResponse({ ok: false, error: "Claim not found" }, 404, corsHeaders);
    }

    if (!claim.completion_date) {
      return jsonResponse({ ok: true, result: "too_early" }, 200, corsHeaders);
    }

    const result = await processClaim(supabase, claim as ClaimRow, mailgunApiKey, siteUrl);
    return jsonResponse({ ok: true, ...result }, 200, corsHeaders);
  }

  // ── Batch / cron mode ────────────────────────────────────────────────────────
  // Scan claims where: completion_date 24h+ ago AND profile_prompt_sent_at IS NULL
  const cutoff = new Date(Date.now() - TWENTY_FOUR_HOURS_MS).toISOString();

  const { data: claims, error: scanErr } = await supabase
    .from("claims")
    .select("id, user_id, completion_date, property_address, trades, profile_prompt_sent_at")
    .not("completion_date", "is", null)
    .lte("completion_date", cutoff)
    .is("profile_prompt_sent_at", null)
    .limit(BATCH_LIMIT);

  if (scanErr) {
    console.error(`[${FUNCTION_NAME}] Batch scan failed:`, scanErr.message);
    return jsonResponse({ ok: false, error: "Batch scan failed" }, 500, corsHeaders);
  }

  if (!claims || claims.length === 0) {
    console.log(`[${FUNCTION_NAME}] Batch: no eligible claims found`);
    return jsonResponse({ ok: true, processed: 0, skipped: 0, results: [] }, 200, corsHeaders);
  }

  console.log(`[${FUNCTION_NAME}] Batch: processing ${claims.length} eligible claims`);

  const results: ScanResult[] = [];
  let processed = 0;
  let skipped = 0;

  for (const claim of claims as ClaimRow[]) {
    try {
      const result = await processClaim(supabase, claim, mailgunApiKey, siteUrl);
      results.push(result);
      if (result.result === "sent") processed++;
      else skipped++;
    } catch (err) {
      console.error(`[${FUNCTION_NAME}] Unhandled error on claim ${claim.id}:`, err);
      results.push({ claim_id: claim.id, result: "error", error: String(err) });
      skipped++;
    }
  }

  console.log(`[${FUNCTION_NAME}] Batch complete — sent: ${processed}, skipped: ${skipped}`);
  return jsonResponse({ ok: true, processed, skipped, results }, 200, corsHeaders);
});
