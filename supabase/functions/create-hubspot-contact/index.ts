/**
 * OtterQuote Edge Function: create-hubspot-contact
 *
 * Creates or updates a HubSpot contact for homeowners (D-189) or contractors (D-210/D-218).
 *
 * Homeowner mode (default):
 *   Called fire-and-forget from get-started.html page 1.
 *   Auth: requires a valid Supabase user JWT resolved via auth.getUser()
 *   (86e1xdaxe #1 — anon-key-only bearers are rejected); input is validated
 *   and sanitized (email format, bounded lengths, control chars stripped).
 *
 * Contractor mode (D-210/D-218):
 *   Called from contractor-pre-approval.html after page 2 submission.
 *   Queries Supabase for WC and license state; sets all 4 HubSpot properties:
 *     wc_path, license_path, license_count, license_summary.
 *   Auth: requires JWT (contractor is signed in); contractor_id passed in body.
 *
 * Bootstrap mode (one-time admin):
 *   Updates HubSpot wc_path and license_path enum options to D-218 values.
 *   Protected by HS_BOOTSTRAP_KEY (Supabase Edge Function secret — see
 *   gh-435). Run once after initial deploy.
 *
 * Environment variables:
 *   HUBSPOT_PRIVATE_APP_TOKEN  — pat-na2-... private app token (scopes: contacts r/w, properties r/w)
 *   HS_BOOTSTRAP_KEY           — shared secret gating mode:"bootstrap"; fails closed (500) if unset
 *   SUPABASE_URL               — injected automatically by Supabase Edge Function runtime
 *   SUPABASE_SERVICE_ROLE_KEY  — injected automatically by Supabase Edge Function runtime
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HUBSPOT_API = "https://api.hubapi.com";

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
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

  const token = Deno.env.get("HUBSPOT_PRIVATE_APP_TOKEN");
  if (!token) {
    console.error("create-hubspot-contact: HUBSPOT_PRIVATE_APP_TOKEN not set");
    return jsonResponse({ success: false, reason: "token_not_configured" }, 200, cors);
  }

  const authHeaders = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // ── BOOTSTRAP MODE ───────────────────────────────────────────────────────────────────────────
  // One-time admin action: adds correct D-218 enum options to wc_path and
  // license_path HubSpot Contact properties. Run once after initial deploy.
  // gh-435: key moved out of source into the HS_BOOTSTRAP_KEY Supabase Edge
  // Function secret and rotated. Fails closed (500) if the secret is unset —
  // never falls back to an empty-string comparison that would accept an
  // empty bootstrap_key.
  if (body.mode === "bootstrap") {
    const expectedBootstrapKey = Deno.env.get("HS_BOOTSTRAP_KEY");
    if (!expectedBootstrapKey) {
      console.error("create-hubspot-contact (bootstrap): HS_BOOTSTRAP_KEY not set");
      return jsonResponse({ error: "bootstrap not configured" }, 500, cors);
    }
    if (typeof body.bootstrap_key !== "string" || body.bootstrap_key !== expectedBootstrapKey) {
      console.warn("create-hubspot-contact (bootstrap): unauthorized attempt");
      return jsonResponse({ error: "unauthorized" }, 401, cors);
    }

    const results: Record<string, unknown> = {};

    // Update wc_path: add wc_policy + wce1_certificate, hide legacy values
    const wcPatchRes = await fetch(
      `${HUBSPOT_API}/crm/v3/properties/contacts/wc_path`,
      {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({
          options: [
            { label: "WC Policy (COI)", value: "wc_policy", displayOrder: 0, hidden: false },
            { label: "WCE-1 Certificate", value: "wce1_certificate", displayOrder: 1, hidden: false },
            { label: "Has Workers\' Comp (legacy)", value: "has_wc", displayOrder: 2, hidden: true },
            { label: "Sole Prop Exemption (legacy)", value: "sole_prop_exemption", displayOrder: 3, hidden: true },
          ],
        }),
      }
    );
    results.wc_path = { status: wcPatchRes.status, ok: wcPatchRes.ok };
    if (!wcPatchRes.ok) {
      const errText = await wcPatchRes.text().catch(() => "(unreadable)");
      console.error("bootstrap: wc_path update failed:", errText);
      results.wc_path_error = errText;
    } else {
      console.log("bootstrap: wc_path options updated successfully");
    }

    // Update license_path: add license_uploaded, keep not_provided, hide legacy has_license
    const lpPatchRes = await fetch(
      `${HUBSPOT_API}/crm/v3/properties/contacts/license_path`,
      {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({
          options: [
            { label: "License Uploaded", value: "license_uploaded", displayOrder: 0, hidden: false },
            { label: "Not Provided", value: "not_provided", displayOrder: 1, hidden: false },
            { label: "Has License (legacy)", value: "has_license", displayOrder: 2, hidden: true },
          ],
        }),
      }
    );
    results.license_path = { status: lpPatchRes.status, ok: lpPatchRes.ok };
    if (!lpPatchRes.ok) {
      const errText = await lpPatchRes.text().catch(() => "(unreadable)");
      console.error("bootstrap: license_path update failed:", errText);
      results.license_path_error = errText;
    } else {
      console.log("bootstrap: license_path options updated successfully");
    }

    return jsonResponse({ success: true, results }, 200, cors);
  }

  // ── CONTRACTOR MODE (D-210 / D-218) ──────────────────────────────────
  // Queries Supabase for WC and license state; updates all 4 HubSpot properties.
  // Non-fatal: HubSpot failures log and continue, do not block onboarding (D-189).
  if (body.mode === "contractor") {
    const email = body.email as string | undefined;
    const contractor_id = body.contractor_id as string | undefined;

    if (!email) {
      return jsonResponse({ error: "email required for contractor mode" }, 400, cors);
    }
    if (!contractor_id) {
      return jsonResponse({ error: "contractor_id required for contractor mode" }, 400, cors);
    }

    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

      if (!supabaseUrl || !serviceKey) {
        console.error("create-hubspot-contact (contractor): Supabase env vars not set");
        // Non-fatal — fall through with defaults
        return jsonResponse({ success: false, reason: "supabase_not_configured" }, 200, cors);
      }

      const sbHeaders = {
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
        "Content-Type": "application/json",
      };

      // ── Step 1: Determine wc_path from contractors.wc_cert_file_ref ─────────
      // Derivation rules (post-Temper fix commit 42db357 — WCE-1 path now stores
      // actual file ref instead of 'WCE-1-EXEMPT' sentinel):
      //   NULL / empty              -> null   (no WC info yet; omit from HubSpot)
      //   'WCE-1-EXEMPT' (legacy)   -> 'wce1_certificate' (backward compat)
      //   contains 'wce1_cert_'     -> 'wce1_certificate' (new file-upload path)
      //   any other non-null value  -> 'wc_policy' (standard WC certificate)
      let wc_path: string | null = null;
      try {
        const contractorRes = await fetch(
          `${supabaseUrl}/rest/v1/contractors?id=eq.${encodeURIComponent(contractor_id)}&select=wc_cert_file_ref`,
          { headers: sbHeaders }
        );
        if (contractorRes.ok) {
          const rows = await contractorRes.json() as Array<{ wc_cert_file_ref: string | null }>;
          if (rows.length > 0) {
            const ref = rows[0].wc_cert_file_ref;
            if (ref === null || ref === undefined || ref === "") {
              wc_path = null;
            } else if (ref === "WCE-1-EXEMPT" || ref.includes("wce1_cert_")) {
              wc_path = "wce1_certificate";
            } else {
              wc_path = "wc_policy";
            }
          }
        } else {
          console.warn(`create-hubspot-contact (contractor): contractor query ${contractorRes.status}`);
        }
      } catch (err) {
        console.warn("create-hubspot-contact (contractor): contractor query exception", err);
      }

      // ── Step 2: Derive license_path, license_count, license_summary ───────────
      // license_uploaded = rows exist in contractor_licenses
      // not_provided     = no rows
      // license_summary  = sorted comma-separated municipality labels (NULL if zero rows)
      let license_path = "not_provided";
      let license_count = 0;
      let license_summary: string | null = null;
      try {
        const licensesRes = await fetch(
          `${supabaseUrl}/rest/v1/contractor_licenses?contractor_id=eq.${encodeURIComponent(contractor_id)}&select=municipality&order=municipality.asc`,
          { headers: sbHeaders }
        );
        if (licensesRes.ok) {
          const rows = await licensesRes.json() as Array<{ municipality: string | null }>;
          license_count = rows.length;
          if (license_count > 0) {
            license_path = "license_uploaded";
            const labels = rows
              .map((r) => r.municipality)
              .filter((m): m is string => !!m);
            license_summary = labels.length > 0 ? labels.join(", ") : null;
          }
        } else {
          console.warn(`create-hubspot-contact (contractor): licenses query ${licensesRes.status}`);
        }
      } catch (err) {
        console.warn("create-hubspot-contact (contractor): licenses query exception", err);
      }

      // ── Step 3: Find HubSpot contact by email ────────────────────
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

      if (!searchRes.ok) {
        const errText = await searchRes.text().catch(() => "(unreadable)");
        console.error(`create-hubspot-contact (contractor): search failed ${searchRes.status}:`, errText);
        return jsonResponse({ success: false, status: searchRes.status, mode: "contractor" }, 200, cors);
      }

      const searchData = await searchRes.json();
      if (!searchData.results || searchData.results.length === 0) {
        console.warn(`create-hubspot-contact (contractor): contact not found for ${email}`);
        return jsonResponse({ success: false, reason: "contact_not_found", mode: "contractor" }, 200, cors);
      }

      const contactId = searchData.results[0].id;

      // ── Step 4: PATCH all 4 properties on the HubSpot contact ──────────
      // wc_path and license_summary omitted when null (HubSpot ignores absent keys)
      const hsProps: Record<string, string | number> = {
        license_path,
        license_count,
      };
      if (wc_path !== null) {
        hsProps.wc_path = wc_path;
      }
      if (license_summary !== null) {
        hsProps.license_summary = license_summary;
      }

      const updateRes = await fetch(
        `${HUBSPOT_API}/crm/v3/objects/contacts/${contactId}`,
        {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify({ properties: hsProps }),
        }
      );

      if (updateRes.ok) {
        console.log(
          `create-hubspot-contact (contractor): updated ${contactId} for ${email} —`,
          `wc_path=${wc_path} license_path=${license_path} license_count=${license_count}`
        );
        return jsonResponse({
          success: true,
          id: contactId,
          action: "updated",
          mode: "contractor",
          wc_path,
          license_path,
          license_count,
        }, 200, cors);
      } else {
        const errText = await updateRes.text().catch(() => "(unreadable)");
        console.error(`create-hubspot-contact (contractor): update failed ${updateRes.status}:`, errText);
        return jsonResponse({ success: false, status: updateRes.status, mode: "contractor" }, 200, cors);
      }
    } catch (err) {
      console.error("create-hubspot-contact (contractor): exception", err);
      return jsonResponse({ success: false, error: "Internal server error", mode: "contractor" }, 200, cors);
    }
  }

  // ── HOMEOWNER MODE (D-189) ───────────────────────────────────────────────
  // D-211 CODE-3 hardening (86e1xdaxe #1): homeowner mode previously required only
  // a non-empty email — no JWT check, no validation → arbitrary contact creation.
  // Now requires a valid Supabase user JWT (auth.getUser() rejects anon-key-only
  // bearers) and validates/sanitizes all fields before they reach HubSpot.
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || (!supabaseAnon && !serviceRoleKey)) {
    console.error("create-hubspot-contact (homeowner): Supabase env vars not set");
    return jsonResponse({ error: "server configuration error" }, 500, cors);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, supabaseAnon || serviceRoleKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return jsonResponse({ error: "unauthorized" }, 401, cors);
  }

  // Basic input validation: strip control chars, enforce format + bounded lengths.
  const stripControl = (v: unknown): string =>
    typeof v === "string" ? v.replace(/[ -]/g, "").trim() : "";

  const email     = stripControl(body.email);
  const firstname = stripControl(body.firstname);
  const lastname  = stripControl(body.lastname);
  const phone     = stripControl(body.phone);
  const address   = stripControl(body.address);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return jsonResponse({ error: "valid email required" }, 400, cors);
  }

  const FIELD_LIMITS: Array<[string, string, number]> = [
    ["firstname", firstname, 100],
    ["lastname",  lastname,  100],
    ["phone",     phone,     30],
    ["address",   address,   200],
  ];
  for (const [name, value, max] of FIELD_LIMITS) {
    if (value.length > max) {
      return jsonResponse({ error: `${name} exceeds ${max} character limit` }, 400, cors);
    }
  }

  const properties: Record<string, string> = { email };
  if (firstname) properties.firstname = firstname;
  if (lastname)  properties.lastname  = lastname;
  if (phone)     properties.phone     = phone;
  if (address)   properties.address   = address;
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
