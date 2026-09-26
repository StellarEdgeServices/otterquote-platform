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
 *   HOMEOWNER_OPTOUT_SECRET (gh-2013 / D-320 — REQUIRED to send; with it
 *   unset this function sends nothing rather than send a commercial email
 *   with no working opt-out. Same env var, same fail-closed contract as
 *   send-homeowner-next-steps.)
 *   HOMEOWNER_OPTOUT_SECRET_PREVIOUS (optional, verification only, rotation)
 *
 * Authorization:
 *   Accepts requests with no Authorization header (cron invocation via pg_net).
 *   Validates X-Cron-Secret header when called from cron to prevent open invocation.
 *   mark-job-complete passes its own service-role bearer to authorize.
 *   External (unauthenticated) calls with no secret header → 401.
 *
 * gh-2013 (this change) — CAN-SPAM footer + opt-out (fail-closed)
 * ─────────────────────────────────────────────────────────────────────────
 * This function's email previously had no physical postal address and no
 * working opt-out mechanism — a commercial/promotional nudge (D-231), not a
 * transactional receipt, so CAN-SPAM's address + opt-out requirements apply
 * to it. gh-1786 / D-320 already built and shipped this exact fix for the
 * sibling function send-homeowner-next-steps; this change imports the SAME
 * three modules (colocated per this repo's no-`_shared/`-imports deploy
 * constraint, same as the rest of this file) rather than writing a second
 * implementation:
 *   - ./email-footer.ts       — the resolved D-237 postal address (verbatim
 *                                reuse of the string already ruled on for
 *                                #1824 / #1944; not a new legal decision).
 *   - ./optout-token.ts       — signed per-claim opt-out token + URL builder,
 *                                same HOMEOWNER_OPTOUT_SECRET, same endpoint
 *                                (homeowner-email-optout) and same
 *                                activity_log event type
 *                                (homeowner_nudge_opt_out) send-homeowner-
 *                                next-steps already uses — one opt-out click
 *                                stops BOTH nudge series for that claim.
 *   - ./optout-filter.ts      — canSendWithOptOut() (fail-closed gate) and
 *                                fetchOptedOutClaimIds() (bounded, filtered
 *                                suppression read — see that file for why an
 *                                unfiltered read is a truncation hazard).
 * No new customer-facing copy is introduced: the postal address, the
 * "Stop these updates" link text, and the opt-out confirmation page are all
 * already-shipped, already-approved strings from #1786/#1944/#1824. The
 * RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers on the
 * Mailgun send point at the SAME per-claim signed URL the footer link uses
 * — same link, a second place it appears, no new secret or endpoint.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  footerPostalAddressHtml,
  footerPostalAddressText,
} from "./email-footer.ts";
import {
  canSendWithOptOut,
  fetchOptedOutClaimIds,
  type OptOutQueryClient,
} from "./optout-filter.ts";
import {
  buildOptOutUrl,
  OPTOUT_SECRET_ENV,
  signOptOutToken,
} from "./optout-token.ts";

// gh-2013: verbatim reuse of D-320's already-approved footer copy (same
// strings send-homeowner-next-steps/email-content.ts already ships).
const OPTOUT_LINK_TEXT = "Stop these updates";
const OPTOUT_TEXT_LINE = "Don't want these emails? Stop these updates:";

const FUNCTION_NAME = "send-home-profile-prompt";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 50;
// gh-2069: this function's `notification_type` in the `notifications` table
// — same table, same columns (recipient/channel/mailgun_id/delivered) the
// admin digest in send-homeowner-next-steps already writes to.
export const HOME_PROFILE_PROMPT_TEMPLATE = "home_profile_prompt";

export interface NotificationRow {
  user_id: string;
  claim_id: string;
  channel: "email";
  notification_type: string;
  recipient: string;
  message_preview: string;
  delivered: boolean;
  mailgun_id: string | null;
}

// gh-2069: durable per-send record, written for every attempt (accepted or
// rejected). A minimal Supabase-client shape rather than the concrete
// `createClient` return type so a test can hand this a fake without
// importing @supabase/supabase-js. Failure to write is logged, never thrown
// — the email has already gone out (or definitively failed) by the time
// this is called.
export interface NotificationClient {
  from(table: string): {
    insert(row: NotificationRow): PromiseLike<{ error: { message: string } | null }>;
  };
}

export async function insertNotification(
  supabase: NotificationClient,
  row: NotificationRow,
): Promise<void> {
  const { error } = await supabase.from("notifications").insert(row);
  if (error) {
    console.warn(`[${FUNCTION_NAME}] send recorded but notifications insert failed for claim ${row.claim_id}:`, error.message);
  }
}

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
  result:
    | "sent"
    | "too_early"
    | "already_sent"
    | "already_has_profile"
    | "no_email"
    | "error"
    // gh-2013 / D-320: this homeowner asked for the series to stop.
    | "opted_out";
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
  roofYear: number | null,
  optOutUrl: string
): { subject: string; textBody: string; htmlBody: string } {
  if (!optOutUrl) {
    // gh-2013: fail closed rather than emit a commercial email with no
    // opt-out — same contract send-homeowner-next-steps/email-content.ts's
    // buildEmailContent already enforces for D-320.
    throw new Error("buildEmailContent: optOutUrl is required (gh-2013 / D-320)");
  }
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
    "",
    `${OPTOUT_TEXT_LINE} ${optOutUrl}`,
    "",
    footerPostalAddressText(),
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
                &nbsp;·&nbsp;
                <a href="${optOutUrl}" style="color:#9CA3AF;">${OPTOUT_LINK_TEXT}</a>
                ${footerPostalAddressHtml()}
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

// gh-2069: a minimal structural interface covering exactly what processClaim
// calls on `supabase` — narrower than `ReturnType<typeof createClient>` so a
// test can hand it a plain fake object (no real Supabase client, no network)
// and TypeScript still checks the shape.
export interface ProcessClaimSupabase extends NotificationClient {
  from(table: string): {
    select(columns: string): {
      // PromiseLike, not Promise: the real supabase-js PostgrestBuilder is
      // thenable but not a full Promise (no .catch/.finally), and this
      // interface exists so a plain fake object satisfies it too.
      eq(column: string, value: unknown): { maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null }> };
    };
    update(row: Record<string, unknown>): { eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }> };
    insert(row: NotificationRow): PromiseLike<{ error: { message: string } | null }>;
  };
  auth: {
    admin: {
      getUserById(id: string): PromiseLike<{ data: { user: { email?: string; user_metadata?: { full_name?: string } } | null } }>;
    };
  };
}

export async function processClaim(
  supabase: ProcessClaimSupabase,
  claim: ClaimRow,
  mailgunApiKey: string | undefined,
  siteUrl: string,
  // gh-2013 / D-320: the per-claim signed opt-out URL (built by the caller,
  // which holds HOMEOWNER_OPTOUT_SECRET) and whether this claim's homeowner
  // has already asked for the series to stop (resolved by the caller via
  // ./optout-filter.ts's fetchOptedOutClaimIds, BEFORE any send is
  // attempted — same ordering send-homeowner-next-steps' screenClaim uses).
  optOutUrl: string,
  isOptedOut: boolean
): Promise<ScanResult> {
  const claimId = claim.id;

  // Idempotency: already sent
  if (claim.profile_prompt_sent_at) {
    return { claim_id: claimId, result: "already_sent" };
  }

  // gh-2013 / D-320: opted-out claims are never emailed. Deliberately NOT
  // stamped profile_prompt_sent_at — an opt-out is not a send, and leaving
  // the stamp null costs nothing (the opt-out check itself is cheap and
  // runs before any send attempt on every future cron tick too).
  if (isOptedOut) {
    return { claim_id: claimId, result: "opted_out" };
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
    // gh-2069 REVIEW FIX (CI red on head d3637483): the real supabase-js
    // client's `.select("email, full_name")` return type resolves to `{}`
    // under this pinned esm.sh types / Deno 2.8.3 combination (the same
    // pre-existing TS2589-class mismatch documented at this file's top),
    // so `profile.email` / `profile.full_name` type-check as `{}`, not
    // `string`. These two casts assert the shape the `select()` column list
    // actually requests — they add no runtime behavior, only satisfy
    // `deno check` under the CI command
    // (`deno test --allow-read=... supabase/functions/`), which type-checks
    // every test file's imports, including this one via index.test.ts.
    homeownerEmail = profile.email as string;
    homeownerName = (profile.full_name as string | null) || "there";
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
    roofYear,
    optOutUrl
  );

  // Send via Mailgun
  // gh-2069: write a `notifications` row for every attempt (accepted or
  // rejected) — this function previously discarded Mailgun's response
  // entirely and never touched `notifications`, same defect #2069 found in
  // send-homeowner-next-steps. `insertNotification` is a plain local helper
  // (this function has no injected-dependency test harness like
  // ./deliver-stage.ts's — see index.test.ts for how the tests exercise this
  // via a fake Mailgun + a fake Supabase client instead).
  if (!mailgunApiKey) {
    console.warn(`[${FUNCTION_NAME}] MAILGUN_API_KEY not set — skipping email send for claim ${claimId}`);
    await insertNotification(supabase, {
      user_id: claim.user_id,
      claim_id: claimId,
      channel: "email",
      notification_type: HOME_PROFILE_PROMPT_TEMPLATE,
      recipient: homeownerEmail,
      message_preview: subject,
      delivered: true,
      mailgun_id: null,
    });
  } else {
    const formData = new FormData();
    formData.append("from", "Otter Quotes <noreply@mail.otterquote.com>");
    formData.append("to", homeownerEmail);
    formData.append("subject", subject);
    formData.append("text", textBody);
    formData.append("html", htmlBody);
    // gh-2013: RFC 8058 mailbox-provider one-click unsubscribe, same signed
    // link the footer already carries — see this file's header comment.
    // Mailgun passes any `h:<Header-Name>` form field through as a literal
    // MIME header.
    formData.append("h:List-Unsubscribe", `<${optOutUrl}>`);
    formData.append("h:List-Unsubscribe-Post", "List-Unsubscribe=One-Click");

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
        // gh-2069: copy sendAdminDigestMail's pattern (send-homeowner-next-steps/
        // index.ts) — parse the response body and keep Mailgun's message id
        // instead of discarding it.
        const mgData = await mgResponse.json().catch(() => ({}));
        const mailgunId = (mgData as { id?: string })?.id ?? null;
        console.log(`[${FUNCTION_NAME}] Email sent → ${homeownerEmail} for claim ${claimId}`);
        await insertNotification(supabase, {
          user_id: claim.user_id,
          claim_id: claimId,
          channel: "email",
          notification_type: HOME_PROFILE_PROMPT_TEMPLATE,
          recipient: homeownerEmail,
          message_preview: subject,
          delivered: true,
          mailgun_id: mailgunId,
        });
      } else {
        const errText = await mgResponse.text().catch(() => "(unreadable)");
        console.error(`[${FUNCTION_NAME}] Mailgun ${mgResponse.status} for ${claimId}: ${errText}`);
        await insertNotification(supabase, {
          user_id: claim.user_id,
          claim_id: claimId,
          channel: "email",
          notification_type: HOME_PROFILE_PROMPT_TEMPLATE,
          recipient: homeownerEmail,
          message_preview: `FAILED: Mailgun ${mgResponse.status}: ${errText}`,
          delivered: false,
          mailgun_id: null,
        });
        return { claim_id: claimId, result: "error", error: `Mailgun ${mgResponse.status}` };
      }
    } catch (err) {
      console.error(`[${FUNCTION_NAME}] Mailgun fetch threw for ${claimId}:`, err);
      await insertNotification(supabase, {
        user_id: claim.user_id,
        claim_id: claimId,
        channel: "email",
        notification_type: HOME_PROFILE_PROMPT_TEMPLATE,
        recipient: homeownerEmail,
        message_preview: `FAILED: ${String(err)}`,
        delivered: false,
        mailgun_id: null,
      });
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

// gh-2069: guarded so index.test.ts (new — see that file) can import this
// module for processClaim/insertNotification without serve() binding a
// port. Supabase's Edge Function runtime invokes this file as the entry
// point, so import.meta.main is still true in production/deployment; only a
// test importer sees it false.
if (import.meta.main) {
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
  // gh-2013 / D-320: the opt-out signing secret. No secret -> no verifiable
  // "stop these updates" link -> no send at all. Fails CLOSED (see
  // canSendWithOptOut in ./optout-filter.ts).
  const optOutSecret    = Deno.env.get(OPTOUT_SECRET_ENV);
  // Functions base URL for the opt-out endpoint: same project, sibling
  // function (homeowner-email-optout).
  const functionsBaseUrl = `${(supabaseUrl || "").replace(/\/$/, "")}/functions/v1`;

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

  // gh-2013 / D-320 — CAN-SPAM gate, ahead of any claim scan. A commercial
  // email with no working opt-out is the violation this issue was filed on,
  // so an unset HOMEOWNER_OPTOUT_SECRET stops the whole run rather than
  // degrading to the pre-fix behaviour. 200 with a named reason, not 500:
  // nothing is broken, the function is correctly refusing. Same contract as
  // send-homeowner-next-steps/index.ts's identical gate.
  if (!canSendWithOptOut(optOutSecret)) {
    console.error(
      `[${FUNCTION_NAME}] ${OPTOUT_SECRET_ENV} is not set — refusing to send: D-320 requires a working opt-out link in every message`,
    );
    return jsonResponse(
      { ok: true, processed: 0, skipped: 0, skipped_no_optout_secret: true, results: [] },
      200,
      corsHeaders,
    );
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

    // gh-2013 / D-320: this claim's own bounded opt-out read, and its
    // per-claim signed opt-out URL. optOutSecret is guaranteed non-empty
    // here — canSendWithOptOut() already gated the whole handler above.
    const { optedOut: targetedOptedOut, error: targetedOptOutErr } = await fetchOptedOutClaimIds(
      supabase as unknown as OptOutQueryClient,
      [(claim as ClaimRow).user_id],
      [targetClaimId],
    );
    if (targetedOptOutErr) {
      console.error(`[${FUNCTION_NAME}] opt-out read failed for claim ${targetClaimId}:`, targetedOptOutErr.message);
      return jsonResponse({ ok: false, error: "opt-out read failed" }, 500, corsHeaders);
    }
    const targetedOptOutUrl = buildOptOutUrl(
      functionsBaseUrl,
      await signOptOutToken(targetClaimId, optOutSecret as string),
    );

    // gh-2069 REVIEW FIX (CI red on head d3637483): the real SupabaseClient's
    // PostgrestBuilder chain is thenable but not a structural match for
    // ProcessClaimSupabase's PromiseLike<> methods under this Deno/TS
    // version (TS2589, same pre-existing type-instantiation-depth class
    // documented at this file's top) -- this cast is load-bearing for
    // `deno check` only; at runtime `supabase` is unchanged.
    const result = await processClaim(
      supabase as unknown as ProcessClaimSupabase,
      claim as ClaimRow,
      mailgunApiKey,
      siteUrl,
      targetedOptOutUrl,
      targetedOptedOut.has(targetClaimId),
    );
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

  // gh-2013 / D-320: ONE bounded, filtered opt-out read for the whole batch
  // (not per-claim) — same shape as send-homeowner-next-steps/index.ts's
  // fetchOptedOutClaimIds call. optOutSecret is guaranteed non-empty here;
  // canSendWithOptOut() already gated the whole handler above.
  const batchUserIds = [...new Set((claims as ClaimRow[]).map((c) => c.user_id))];
  const batchClaimIds = (claims as ClaimRow[]).map((c) => c.id);
  const { optedOut: batchOptedOutClaimIds, error: batchOptOutErr } = await fetchOptedOutClaimIds(
    supabase as unknown as OptOutQueryClient,
    batchUserIds,
    batchClaimIds,
  );
  if (batchOptOutErr) {
    console.error(`[${FUNCTION_NAME}] opt-out read failed:`, batchOptOutErr.message);
    return jsonResponse({ ok: false, error: "opt-out read failed" }, 500, corsHeaders);
  }

  const results: ScanResult[] = [];
  let processed = 0;
  let skipped = 0;

  for (const claim of claims as ClaimRow[]) {
    try {
      // gh-2013 / D-320: per-claim signed opt-out URL, built fresh for every
      // claim (the token payload is the claim id — see ./optout-token.ts).
      const optOutUrl = buildOptOutUrl(
        functionsBaseUrl,
        await signOptOutToken(claim.id, optOutSecret as string),
      );
      const result = await processClaim(
        supabase as unknown as ProcessClaimSupabase,
        claim,
        mailgunApiKey,
        siteUrl,
        optOutUrl,
        batchOptedOutClaimIds.has(claim.id),
      );
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
}
