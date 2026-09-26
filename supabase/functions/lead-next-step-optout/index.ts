/**
 * OtterQuote Edge Function: lead-next-step-optout
 *
 * gh-2121 (LRS HO-1 S21) — the endpoint behind the "Stop these updates" link
 * in send-lead-next-step-reminder's one reminder email. Unauthenticated by
 * necessity, same as homeowner-email-optout (D-320's claims-side
 * equivalent): a pre-signup lead has no session at all.
 *
 * Mirrors homeowner-email-optout's own write-only, non-enumerating shape
 * (see that file's header for the full "why it is not an enumeration
 * oracle" reasoning — unchanged here): ONE response, ONE status (200), for
 * a missing token, an invalid token, a forged signature, or a token for a
 * lead id that does not exist — all identical bytes. The one difference
 * from the claims-side version: there is no owner row to resolve first
 * (`leads` has no user_id until conversion) — the UPDATE targets `leads.id`
 * directly, still write-only and idempotent (a second click updates zero
 * additional rows and returns the same page either way).
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   HOMEOWNER_OPTOUT_SECRET, HOMEOWNER_OPTOUT_SECRET_PREVIOUS (optional)
 *   (same secrets send-lead-next-step-reminder signs with — see
 *   lead-optout-token.ts's header for why they are shared.)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  LEAD_OPTOUT_SECRET_ENV,
  LEAD_OPTOUT_SECRET_PREVIOUS_ENV,
  verifyLeadOptOutToken,
} from "./lead-optout-token.ts";

const FUNCTION_NAME = "lead-next-step-optout";

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
              <h1 style="margin:0 0 1rem;font-size:20px;">You're all set</h1>
              <p style="margin:0;line-height:1.6;">We've stopped this next-step reminder. Dustin's callback isn't affected.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

const FAILURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Something went wrong</title>
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
      Deno.env.get(LEAD_OPTOUT_SECRET_ENV) || "",
      Deno.env.get(LEAD_OPTOUT_SECRET_PREVIOUS_ENV) || "",
    ].filter((s) => s.length > 0);

    if (secrets.length === 0) {
      console.error(`[${FUNCTION_NAME}] ${LEAD_OPTOUT_SECRET_ENV} is not set — cannot verify any opt-out token`);
      return page();
    }

    const leadId = await verifyLeadOptOutToken(token, secrets);
    if (!leadId) {
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

    // Idempotent, write-only: unconditional UPDATE, no prior SELECT — a
    // second click (or a lead id that never existed) touches zero or one row
    // either way and this endpoint never varies its response on the result.
    const { error: updateErr } = await supabase
      .from("leads")
      .update({ next_step_reminder_opted_out_at: new Date().toISOString() })
      .eq("id", leadId)
      .is("next_step_reminder_opted_out_at", null);
    if (updateErr) {
      console.error(`[${FUNCTION_NAME}] failed to record opt-out for lead ${leadId}: ${updateErr.message}`);
      return failurePage();
    }
    console.log(`[${FUNCTION_NAME}] recorded opt-out for lead ${leadId}`);
    return page();
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] unexpected failure (response unchanged): ${String(err)}`);
    return page();
  }
});
