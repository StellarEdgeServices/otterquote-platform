/**
 * OtterQuote Edge Function: hover-oauth-callback
 * Receives the OAuth authorization code from Hover after user consent,
 * exchanges it for access + refresh tokens, and stores them in Supabase.
 *
 * This is the redirect_uri registered with Hover's OAuth app.
 *
 * Environment variables:
 *   HOVER_CLIENT_ID
 *   HOVER_CLIENT_SECRET
 *   HOVER_REDIRECT_URI
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      console.error("Hover OAuth error:", error);
      return new Response(
        generateHTML(
          "Authorization Failed",
          `Hover returned an error: ${error}. Please try again.`,
          false
        ),
        { status: 400, headers: { "Content-Type": "text/html" } }
      );
    }

    if (!code) {
      return new Response(
        generateHTML(
          "Missing Authorization Code",
          "No authorization code received from Hover. Please try again.",
          false
        ),
        { status: 400, headers: { "Content-Type": "text/html" } }
      );
    }

    const HOVER_CLIENT_ID = Deno.env.get("HOVER_CLIENT_ID")!;
    const HOVER_CLIENT_SECRET = Deno.env.get("HOVER_CLIENT_SECRET")!;
    const HOVER_REDIRECT_URI = Deno.env.get("HOVER_REDIRECT_URI")!;

    // Exchange authorization code for tokens
    const tokenResponse = await fetch("https://hover.to/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: code,
        client_id: HOVER_CLIENT_ID,
        client_secret: HOVER_CLIENT_SECRET,
        redirect_uri: HOVER_REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      console.error("Token exchange failed:", tokenResponse.status, errBody);
      return new Response(
        generateHTML(
          "Token Exchange Failed",
          `Failed to exchange authorization code for tokens (HTTP ${tokenResponse.status}). Please try again.`,
          false
        ),
        { status: 500, headers: { "Content-Type": "text/html" } }
      );
    }

    const tokenData = await tokenResponse.json();
    /*
     * tokenData shape:
     * {
     *   access_token: "eyJ...",
     *   token_type: "Bearer",
     *   expires_in: 7200,
     *   refresh_token: "q90aLQ...",
     *   scope: "all",
     *   created_at: 1750191095,
     *   owner_id: 785,
     *   owner_type: "orgs"
     * }
     */

    // Calculate expiration timestamp
    const expiresAt = new Date(
      Date.now() + (tokenData.expires_in || 7200) * 1000
    ).toISOString();

    // Store tokens in Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Upsert: delete any existing tokens, insert the new ones
    // (We only keep one active token set — org-level auth)
    await supabase.from("hover_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    const { error: insertError } = await supabase
      .from("hover_tokens")
      .insert({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type || "Bearer",
        expires_at: expiresAt,
        scope: tokenData.scope || "all",
        owner_id: tokenData.owner_id || null,
        owner_type: tokenData.owner_type || null,
      });

    if (insertError) {
      console.error("Failed to store tokens:", insertError);
      return new Response(
        generateHTML(
          "Storage Error",
          "Tokens received from Hover but failed to store. Check Supabase logs.",
          false
        ),
        { status: 500, headers: { "Content-Type": "text/html" } }
      );
    }

    console.log("Hover OAuth tokens stored successfully. Expires:", expiresAt);

    // Now register the webhook for job-state-changed events
    try {
      const webhookUrl = `${supabaseUrl}/functions/v1/hover-webhook`;
      const webhookResponse = await fetch(
        "https://hover.to/api/v2/webhooks",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            webhook: {
              url: webhookUrl,
              "content-type": "json",
            },
          }),
        }
      );

      if (webhookResponse.ok) {
        console.log("Hover webhook registered at:", webhookUrl);
      } else {
        const whErr = await webhookResponse.text();
        console.warn(
          "Webhook registration failed (non-blocking):",
          webhookResponse.status,
          whErr
        );
      }
    } catch (whError) {
      console.warn("Webhook registration error (non-blocking):", whError);
    }

    return new Response(
      generateHTML(
        "Hover Connected!",
        "OtterQuote is now connected to Hover. You can close this window and return to the platform.",
        true
      ),
      { status: 200, headers: { "Content-Type": "text/html" } }
    );
  } catch (error) {
    console.error("hover-oauth-callback error:", error);
    return new Response(
      generateHTML(
        "Unexpected Error",
        `Something went wrong: ${error.message}`,
        false
      ),
      { status: 500, headers: { "Content-Type": "text/html" } }
    );
  }
});

function generateHTML(title: string, message: string, success: boolean): string {
  const color = success ? "#14B8A6" : "#EF4444";
  const icon = success ? "&#10003;" : "&#10007;";
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title} — OtterQuote</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f8fafc; }
    .card { background: white; border-radius: 12px; padding: 48px; text-align: center; max-width: 480px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .icon { font-size: 48px; color: ${color}; margin-bottom: 16px; }
    h1 { color: #0A1E2C; margin: 0 0 12px; font-size: 24px; }
    p { color: #64748b; line-height: 1.6; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}
