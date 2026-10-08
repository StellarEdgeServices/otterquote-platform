/**
 * create-hubspot-contact -- DISABLED (gh-2426).
 *
 * The company's paid HubSpot plan ends 2026-10-15/16, and since the homeowner payload's
 * lead_source_detail property was rejected by HubSpot (PROPERTY_DOESNT_EXIST) this function
 * has created no contact. It is kept deployed so a stale caller (an old browser tab, a cached
 * page) gets a clean answer instead of a 404, but it makes NO HubSpot call, reads NO token,
 * and reads NO body beyond the health-check flag.
 *
 * Every POST answers HTTP 200 {success:false, disabled:true, reason:"hubspot_disabled"}:
 * the old callers all treated a non-success body as non-fatal, so nothing breaks.
 *
 * The previous implementation (homeowner, contractor and bootstrap modes) is in git
 * history: supabase/functions/create-hubspot-contact/index.ts at main 6fc2b7a.
 */

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

export const DISABLED_BODY = {
  success: false,
  disabled: true,
  reason: "hubspot_disabled",
} as const;

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export async function handle(req: Request): Promise<Response> {
  const cors = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405, cors);
  }

  // Health-check shortcut (platform-health-check style pinger) keeps answering "ok".
  try {
    const body = await req.json();
    if (body && body.health_check === true) {
      return json({ status: "ok", disabled: true }, 200, cors);
    }
  } catch {
    // Unparseable or empty body: still a clean "disabled" answer, never an error.
  }

  return json(DISABLED_BODY, 200, cors);
}
