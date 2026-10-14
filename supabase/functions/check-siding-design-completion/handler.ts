/**
 * check-siding-design-completion -- DISABLED (gh-1873, Hover retirement).
 *
 * The measurement vendor (Hover) is retired (Dustin: "Retire them now. We aren't using hover", #2382). This function no
 * longer talks to Hover: it reads NO secret (no HOVER_* name, no Deno.env.get), makes NO outbound call and NO database
 * call. Today's callers: pg_cron job 6 (every 30 minutes) until the unschedule draft is applied, and hover-webhook.
 *
 * It stays deployed (instead of being deleted) so a stale caller gets a clean answer instead of a 404; deletion is a
 * separate step after seven quiet days (gh-1873 plan, step 3). The previous implementation is in git history:
 * supabase/functions/check-siding-design-completion/index.ts at main 4f331d4.
 */

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

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

export const DISABLED_BODY = {
  success: false,
  disabled: true,
  reason: "hover_disabled",
} as const;

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/** Every POST answers HTTP 200 {success:false, disabled:true, reason:"hover_disabled"}; the body is never read beyond the health-check flag. */
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
