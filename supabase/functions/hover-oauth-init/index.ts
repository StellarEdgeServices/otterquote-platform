/**
 * OtterQuote Edge Function: hover-oauth-init
 * Initiates the Hover OAuth 2.0 Authorization Code flow.
 * Redirects the user's browser to Hover's authorization page.
 *
 * Call this from the admin/settings page when connecting Hover.
 * After the user authorizes, Hover redirects to hover-oauth-callback.
 *
 * Environment variables:
 *   HOVER_CLIENT_ID
 *   HOVER_REDIRECT_URI
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

// CORS tightened (Session 254): origin-allowlisted instead of wildcard.
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
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const HOVER_CLIENT_ID = Deno.env.get("HOVER_CLIENT_ID");
    const HOVER_REDIRECT_URI = Deno.env.get("HOVER_REDIRECT_URI");

    if (!HOVER_CLIENT_ID || !HOVER_REDIRECT_URI) {
      throw new Error(
        "Missing HOVER_CLIENT_ID or HOVER_REDIRECT_URI environment variables"
      );
    }

    // Generate a random state parameter for CSRF protection
    const state = crypto.randomUUID();

    // Build the Hover authorization URL
    const authUrl = new URL("https://hover.to/oauth/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", HOVER_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", HOVER_REDIRECT_URI);
    authUrl.searchParams.set("state", state);

    // Redirect the browser to Hover's auth page
    return new Response(null, {
      status: 302,
      headers: {
        ...corsHeaders,
        Location: authUrl.toString(),
        // Store state in a cookie for CSRF validation in the callback
        "Set-Cookie": `hover_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    });
  } catch (error) {
    console.error("hover-oauth-init error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
