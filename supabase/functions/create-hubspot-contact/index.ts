/**
 * OtterQuote Edge Function: create-hubspot-contact
 *
 * Creates or updates a HubSpot contact when a homeowner completes
 * page 1 of the intake form (get-started.html). Implements D-189.
 *
 * Called fire-and-forget from get-started.html — errors are non-fatal
 * and must never surface to the user or block the magic link flow.
 *
 * Auth: no JWT required — called pre-auth (user has not yet clicked magic link)
 * Rate limiting: covered by global check_rate_limit infrastructure
 *
 * Environment variables:
 *   HUBSPOT_PRIVATE_APP_TOKEN  — pat-na2-... private app token (scopes: contacts r/w)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const HUBSPOT_API = "https://api.hubapi.com";

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  cors: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405, cors);
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid json" }, 400, cors);
  }

  // Health check shortcut (used by platform-health-check pinger)
  if (body.health_check === true) {
    return jsonResponse({ status: "ok" }, 200, cors);
  }

  const { email, firstname, lastname, phone, address } = body as Record<string, string>;

  if (!email) {
    return jsonResponse({ error: "email required" }, 400, cors);
  }

  const token = Deno.env.get("HUBSPOT_PRIVATE_APP_TOKEN");
  if (!token) {
    console.error("create-hubspot-contact: HUBSPOT_PRIVATE_APP_TOKEN not set");
    // Non-fatal — return 200 so caller doesn't surface an error
    return jsonResponse({ success: false, reason: "token_not_configured" }, 200, cors);
  }

  const authHeaders = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const properties: Record<string, string> = { email };
  if (firstname) properties.firstname = firstname;
  if (lastname)  properties.lastname  = lastname;
  if (phone)     properties.phone     = phone;
  if (address)   properties.address   = address;
  // Source tracking
  properties.hs_lead_status        = "NEW";
  properties.lead_source_detail    = "OtterQuote Get Started Form";

  // Step 1: Attempt to create contact
  const createRes = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ properties }),
  });

  if (createRes.ok) {
    const data = await createRes.json();
    console.log(`create-hubspot-contact: created contact ${data.id} for ${email}`);
    return jsonResponse({ success: true, id: data.id, action: "created" }, 200, cors);
  }

  // Step 2: Handle 409 CONTACT_EXISTS — find and update
  if (createRes.status === 409) {
    try {
      const searchRes = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/search`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          filterGroups: [{
            filters: [{ propertyName: "email", operator: "EQ", value: email }],
          }],
          properties: ["email"],
          limit: 1,
        }),
      });

      if (searchRes.ok) {
        const searchData = await searchRes.json();
        if (searchData.results?.length > 0) {
          const contactId = searchData.results[0].id;
          const updateRes = await fetch(
            `${HUBSPOT_API}/crm/v3/objects/contacts/${contactId}`,
            {
              method: "PATCH",
              headers: authHeaders,
              body: JSON.stringify({ properties }),
            }
          );
          if (updateRes.ok) {
            console.log(`create-hubspot-contact: updated existing contact ${contactId} for ${email}`);
            return jsonResponse({ success: true, id: contactId, action: "updated" }, 200, cors);
          }
        }
      }
    } catch (err) {
      console.error("create-hubspot-contact: update-on-conflict failed", err);
    }
    // Duplicate suppressed — not an error
    return jsonResponse({ success: true, action: "duplicate_suppressed" }, 200, cors);
  }

  // Step 3: Other HubSpot API errors — log but return 200 (non-fatal to caller)
  const errText = await createRes.text().catch(() => "(unreadable)");
  console.error(`create-hubspot-contact: HubSpot API error ${createRes.status}:`, errText);
  return jsonResponse({ success: false, status: createRes.status }, 200, cors);
});
