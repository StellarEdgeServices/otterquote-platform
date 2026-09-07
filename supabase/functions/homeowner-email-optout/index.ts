/**
 * OtterQuote Edge Function: homeowner-email-optout
 *
 * gh-1786 / D-320 — the endpoint behind the "Stop these updates" link in
 * send-homeowner-next-steps' two nudge emails. Unauthenticated by necessity: it
 * is clicked from an email client by someone who is not signed in, which is what
 * CAN-SPAM requires of an opt-out mechanism.
 *
 * ─── WHAT IT DOES ──────────────────────────────────────────────────────────
 * Accepts a signed token (`?t=` on a GET, or `{"t": "..."}` on a POST), verifies
 * it with HMAC-SHA256 against HOMEOWNER_OPTOUT_SECRET (and, for rotation,
 * HOMEOWNER_OPTOUT_SECRET_PREVIOUS), and on success writes ONE activity_log row:
 *
 *   { event_type: 'homeowner_nudge_opt_out',
 *     metadata: { claim_id, source: 'email_footer_link', system_generated: true } }
 *
 * send-homeowner-next-steps reads that row and skips the claim. No migration —
 * D-320's constraint; see ./optout-filter.ts in that function for why
 * activity_log.metadata is the JSONB D-320's wording points at.
 *
 * ─── WHY IT IS NOT AN ENUMERATION ORACLE ───────────────────────────────────
 * Per CTO RUN 28's ruling (#1786 comment 5572984296): "the endpoint is
 * write-only. It accepts a token, writes a suppression row, and returns the same
 * page whether the token matched or not. It never reads back who the token
 * belongs to and never varies its response on existence."
 *
 * This implementation holds to that literally:
 *   - ONE response body, ONE status (200), for every input: a valid token, an
 *     invalid token, a forged signature, a token for a claim that does not
 *     exist, a missing token, and an internal database failure all return the
 *     identical bytes. There is no error page and no success page — there is
 *     one page.
 *   - It returns nothing about the claim: no email address, no name, no status.
 *   - It is idempotent: a second click writes nothing new and still returns the
 *     same page.
 * The cost, stated: a homeowner who somehow follows a corrupted link is told
 * they are unsubscribed when they are not. That is the accepted trade for not
 * leaking claim existence, and it is why the token is signed rather than being a
 * bare id — a corrupted link is the only path to that outcome.
 *
 * ─── AUTH ──────────────────────────────────────────────────────────────────
 * verify_jwt = false in supabase/config.toml (an email recipient has no JWT).
 * The token IS the authorization, and it authorizes exactly one irreversible-in-
 * the-safe-direction act: stopping email to one claim. There is no path here
 * that reads or writes anything else.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   HOMEOWNER_OPTOUT_SECRET, HOMEOWNER_OPTOUT_SECRET_PREVIOUS (optional)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  OPTOUT_EVENT_TYPE,
  OPTOUT_SECRET_ENV,
  OPTOUT_SECRET_PREVIOUS_ENV,
  verifyOptOutToken,
} from "./optout-token.ts";

const FUNCTION_NAME = "homeowner-email-optout";

// The ONE page. Rendered for every input, without exception — see the header.
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
              <p style="margin:0 0 1rem;line-height:1.6;">You won't receive any more next-steps update emails about this project.</p>
              <p style="margin:0 0 1rem;line-height:1.6;">You can still sign in to your account at any time to order measurements, pick your material, and review bids. Emails you ask for &mdash; and messages about a contract you have signed &mdash; are not affected.</p>
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
      // Never cached and never indexed: the URL carries a one-recipient token.
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
  // HEAD/OPTIONS answered with the same page shape; every other method too. No
  // method is rejected, because a rejection would be a second observable
  // response and this endpoint has exactly one.
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" },
    });
  }

  // Everything below is best-effort and NEVER changes the response. Any failure
  // is logged for us and invisible to the caller.
  try {
    const token = await readToken(req);
    const secrets = [
      Deno.env.get(OPTOUT_SECRET_ENV) || "",
      Deno.env.get(OPTOUT_SECRET_PREVIOUS_ENV) || "",
    ].filter((s) => s.length > 0);

    if (secrets.length === 0) {
      console.error(`[${FUNCTION_NAME}] ${OPTOUT_SECRET_ENV} is not set — cannot verify any opt-out token`);
      return page();
    }

    const claimId = await verifyOptOutToken(token, secrets);
    if (!claimId) {
      console.warn(`[${FUNCTION_NAME}] token did not verify — no row written`);
      return page();
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error(`[${FUNCTION_NAME}] server configuration error — opt-out for a verified token was NOT recorded`);
      return page();
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // activity_log rows are keyed by user_id, so the claim's owner is resolved
    // here rather than carried in the URL. This is the ONLY read, its result is
    // never returned to the caller, and a miss is logged, not surfaced.
    const { data: claim, error: claimErr } = await supabase
      .from("claims")
      .select("id, user_id, is_test")
      .eq("id", claimId)
      .maybeSingle();
    if (claimErr) {
      console.error(`[${FUNCTION_NAME}] claim lookup failed for a verified token: ${claimErr.message}`);
      return page();
    }
    if (!claim?.user_id) {
      console.warn(`[${FUNCTION_NAME}] verified token names a claim with no owner row — nothing recorded`);
      return page();
    }

    // Idempotent: a second click must not pile up rows. Checked, then inserted,
    // and a unique-violation from a concurrent double-click is treated as
    // success (matching send-homeowner-next-steps' 23505 handling).
    const { data: existing } = await supabase
      .from("activity_log")
      .select("id, metadata")
      .eq("user_id", claim.user_id)
      .eq("event_type", OPTOUT_EVENT_TYPE)
      .limit(50);
    const already = (existing || []).some((r: { metadata?: { claim_id?: string } | null }) =>
      r?.metadata?.claim_id === claimId
    );
    if (already) {
      console.log(`[${FUNCTION_NAME}] claim ${claimId} already opted out — no new row`);
      return page();
    }

    const { error: insertErr } = await supabase.from("activity_log").insert({
      user_id: claim.user_id,
      event_type: OPTOUT_EVENT_TYPE,
      title: "Homeowner stopped next-steps update emails",
      metadata: {
        claim_id: claimId,
        source: "email_footer_link",
        system_generated: true,
      },
      is_test: claim.is_test === true,
    });
    if (insertErr && insertErr.code !== "23505") {
      console.error(`[${FUNCTION_NAME}] failed to record opt-out for claim ${claimId}: ${insertErr.message}`);
      return page();
    }
    console.log(`[${FUNCTION_NAME}] recorded opt-out for claim ${claimId}`);
    return page();
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] unexpected failure (response unchanged): ${String(err)}`);
    return page();
  }
});
