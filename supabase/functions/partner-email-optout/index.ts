/**
 * OtterQuote Edge Function: partner-email-optout
 *
 * gh-2154 P-4 (Kevin correction Q1) — the endpoint behind the unsubscribe
 * link in send-partner-onboarding's emails, mirroring D-320's
 * homeowner-email-optout exactly in mechanism and posture. Unauthenticated
 * by necessity: it is clicked from an email client by someone who is not
 * signed in.
 *
 * ─── WHAT IT DOES ──────────────────────────────────────────────────────────
 * Accepts a signed token (`?t=` on a GET, or `{"t": "..."}` on a POST),
 * verifies it with HMAC-SHA256 against PARTNER_ONBOARDING_OPTOUT_SECRET (and,
 * for rotation, PARTNER_ONBOARDING_OPTOUT_SECRET_PREVIOUS), and on success
 * sets:
 *
 *   referral_agents.onboarding_opted_out_at = now()  (first-write-wins)
 *
 * send-partner-onboarding's selectStage reads that column and stops sending
 * to this partner, permanently — same shape as P-2's
 * app_first_signed_in_launch_at stop condition.
 *
 * THIS ENDPOINT IS FLAGGED FOR LEGAL-READ AT REVIEW (Kevin's instruction on
 * the P-4 correction round) — same review gate D-320's own opt-out endpoint
 * went through for homeowners.
 *
 * ─── WHY IT IS NOT AN ENUMERATION ORACLE ───────────────────────────────────
 * Same invariant CTO RUN 28 ruled for D-320 (#1786 comment 5572984296),
 * applied here verbatim: the endpoint is write-only. It accepts a token,
 * writes a suppression column, and returns the same page whether the token
 * matched or not. It never reads back who the token belongs to and never
 * varies its response on existence.
 *   - ONE response body, ONE status (200), for: a missing token, an invalid
 *     token, a forged signature, and a token for a partner id that does not
 *     exist — all return the identical bytes, page().
 *   - It returns nothing about the partner: no email, no name, no status.
 *   - It is idempotent: a second click is a harmless no-op (the UPDATE's
 *     `WHERE onboarding_opted_out_at IS NULL` guard) and still returns the
 *     same page.
 * A verified token whose write could not be recorded (missing config, or an
 * UPDATE error) returns a distinct failurePage() instead — same carve-out
 * D-320's own endpoint uses after its own LEGAL-READ FAIL correction (PR
 * #1810), and for the identical reason: telling a partner "unsubscribed"
 * when nothing was recorded is its own failure of the promise this endpoint
 * exists to keep. Reaching that branch requires a token that has already
 * passed HMAC verification, so it adds no enumeration surface.
 *
 * ─── AUTH ──────────────────────────────────────────────────────────────────
 * verify_jwt = false in supabase/config.toml (a recipient has no JWT). The
 * token IS the authorization, and it authorizes exactly one irreversible-in-
 * the-safe-direction act: stopping onboarding email to one partner.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   PARTNER_ONBOARDING_OPTOUT_SECRET, PARTNER_ONBOARDING_OPTOUT_SECRET_PREVIOUS (optional)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  PARTNER_OPTOUT_SECRET_ENV,
  PARTNER_OPTOUT_SECRET_PREVIOUS_ENV,
  verifyPartnerOptOutToken,
} from "./optout-token.ts";

const FUNCTION_NAME = "partner-email-optout";

const CONFIRMATION_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Updates stopped</title>
</head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:Arial,Helvetica,sans-serif;color:#1F2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F8FAFC;">
    <tr>
      <td align="center" style="padding:2rem 1rem;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0"
               style="max-width:600px;width:100%;background:#ffffff;border-radius:0.75rem;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#0D1B2E;padding:1.5rem 2rem;text-align:center;">
              <span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
            </td>
          </tr>
          <tr>
            <td style="padding:2rem;">
              <h1 style="margin:0 0 1rem;font-size:20px;">Updates stopped</h1>
              <p style="margin:0 0 1rem;line-height:1.6;">You won't receive any more onboarding emails from us.</p>
              <p style="margin:0;font-size:14px;color:#64748B;">Changed your mind, or need a hand? Email
                <a href="mailto:support@otterquote.com" style="color:#E07B00;">support@otterquote.com</a>.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

function page(): Response {
  return new Response(CONFIRMATION_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}

const FAILURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>We couldn't process that</title>
</head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:Arial,Helvetica,sans-serif;color:#1F2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F8FAFC;">
    <tr>
      <td align="center" style="padding:2rem 1rem;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0"
               style="max-width:600px;width:100%;background:#ffffff;border-radius:0.75rem;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#0D1B2E;padding:1.5rem 2rem;text-align:center;">
              <span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
            </td>
          </tr>
          <tr>
            <td style="padding:2rem;">
              <h1 style="margin:0 0 1rem;font-size:20px;">We couldn't process that</h1>
              <p style="margin:0;line-height:1.6;">We couldn't record your request &mdash; please try the link again or reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

function failurePage(): Response {
  return new Response(FAILURE_HTML, {
    status: 500,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function readToken(req: Request): Promise<string | null> {
  const fromQuery = new URL(req.url).searchParams.get("t");
  if (fromQuery) return fromQuery;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const t = body?.t;
      return typeof t === "string" && t.length > 0 ? t : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" },
    });
  }

  try {
    const token = await readToken(req);
    const secrets = [
      Deno.env.get(PARTNER_OPTOUT_SECRET_ENV) || "",
      Deno.env.get(PARTNER_OPTOUT_SECRET_PREVIOUS_ENV) || "",
    ].filter((s) => s.length > 0);

    if (secrets.length === 0) {
      console.error(`[${FUNCTION_NAME}] ${PARTNER_OPTOUT_SECRET_ENV} is not set — cannot verify any opt-out token`);
      return page();
    }

    const partnerId = await verifyPartnerOptOutToken(token, secrets);
    if (!partnerId) {
      console.warn(`[${FUNCTION_NAME}] token did not verify — no row written`);
      return page();
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error(`[${FUNCTION_NAME}] server configuration error — opt-out for a verified token was NOT recorded`);
      return failurePage();
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // First-write-wins, idempotent: the WHERE guard means a second click (or
    // a concurrent one) is a harmless no-op, not a second write.
    const { error: updateErr } = await supabase
      .from("referral_agents")
      .update({ onboarding_opted_out_at: new Date().toISOString() })
      .eq("id", partnerId)
      .is("onboarding_opted_out_at", null);
    if (updateErr) {
      console.error(`[${FUNCTION_NAME}] failed to record opt-out for partner ${partnerId}: ${updateErr.message}`);
      return failurePage();
    }

    console.log(`[${FUNCTION_NAME}] recorded opt-out for partner ${partnerId}`);
    return page();
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] unexpected failure (response unchanged): ${String(err)}`);
    return page();
  }
});
