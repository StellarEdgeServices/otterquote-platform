/**
 * OtterQuote Edge Function: notify-admin-new-homeowner
 *
 * Sends an admin notification email to Dustin whenever a real homeowner
 * creates a claim (claims insert), AND runs a deferred "signup sweep" every
 * 15 minutes (pg_cron -> this EF in `signup_sweep` mode) so a homeowner who
 * signs up but never files a claim still surfaces. Filed for gh-1932.
 *
 * History (see PR #1934 / issue #1932 comments for full evidence):
 *  - Pass 1: alerted on both profiles-insert (role='homeowner') and claims-insert.
 *  - Rework 1 (refuter FAIL): profiles.role defaults to 'homeowner' for EVERY
 *    new auth user (no signup-time signal distinguishes homeowner from
 *    contractor — confirmed by reading js/auth.js signUpWithPassword, which
 *    never sets options.data), so the profiles trigger false-positived on
 *    every contractor signup. Dropped the profiles-insert trigger; claims-only.
 *  - Rework 2 (refuter-2 FAIL on SCOPE, CEO-ratified per issue #1932 comment
 *    5670873022): claims-only silently drops the "someone is IN the system"
 *    half of the deliverable Dustin asked for — 18 live role='homeowner'
 *    profiles have zero claims and would never alert. CEO ruling: keep
 *    claims-only trigger AND add a DEFERRED SWEEP (this rework) that finds
 *    homeowner profiles 20min-7d old with no contractors row (the real,
 *    verified signal a contractor signup creates: trg_sync_contractor_profile_role
 *    fires AFTER INSERT ON public.contractors, keyed by contractors.user_id =
 *    profiles.id — confirmed via information_schema), not excluded, and not
 *    yet alerted -> alerts once each. The sweep's FIRST EVER run sends one
 *    digest (not N individual emails) for the pre-existing backlog, then
 *    marks each as alerted so later runs only see genuinely new signups.
 *    Also: the exclusion filter was an unanchored `.includes("test")`,
 *    which silently dropped real homeowners whose address merely contains
 *    "test" (5 confirmed live, e.g. "protest..."/"greatest..."-shaped local
 *    parts) — replaced with an anchored pattern in this rework (see
 *    isExcludedEmail below): local part exactly "test", local part starting
 *    "test" + [0-9+._-], "+test" anywhere, or domain in
 *    example.com/example.org/test.local. is_test=true is still excluded
 *    unconditionally, as are the admin/internal domains.
 *
 * Trigger sources:
 *  1. trg_notify_admin_new_claim (AFTER INSERT ON claims) -> pg_net ->
 *     POSTs {event_type:"claim_created", record}.
 *  2. pg_cron job "gh1932-homeowner-signup-sweep" (every 15 minutes) -> pg_net ->
 *     POSTs {event_type:"signup_sweep"} with no record; this EF does its own
 *     candidate selection with the service-role client.
 *  3. trg_notify_admin_new_router_lead (AFTER UPDATE ON leads, role NULL ->
 *     non-NULL) -> pg_net -> POSTs {event_type:"router_lead", record}. Filed
 *     for gh-1994 (Dustin's GO, issue #1994 comment 5706456515). See
 *     notify-helpers.ts's doc header for the full design rationale.
 *
 * Auth model: accepts the Supabase service role key as bearer token
 * (both trigger and cron paths). ALSO accepts the anon key — a deliberate,
 * documented extension so manual/test invocations never need to handle the
 * service-role secret.
 *
 * Exception (gh-1994 fix round 1, REVIEW 5707519022 B1): event_type=
 * router_lead does NOT accept the anon key. It is reachable only from the
 * trg_notify_admin_new_router_lead trigger, which authenticates with the
 * service-role key resolved from vault -- the anon key is public, and
 * router_lead's own dedupe stamp (alerted_at) lives on a table the anon
 * role can insert into, so accepting anon here would let anyone name an
 * existing (or self-inserted) lead id and trigger a send. Checked at the
 * event_type dispatch site below, in addition to (not instead of) the
 * general authorized gate above -- claim_created/signup_sweep/
 * signup_backfill are unaffected and still accept either key.
 *
 * Idempotency (notifications table, plus a dedicated column for router_lead):
 *   claim_created -> skips if notification_type=admin_new_claim already
 *                    exists for claim_id = record.id
 *   signup_sweep, per-profile -> skips a profile if notification_type=
 *                    admin_new_homeowner already exists for user_id = profile.id
 *   signup_sweep, digest gate -> the one-time backlog digest is sent only if
 *                    no notification_type=admin_homeowner_signup_digest row
 *                    exists yet (any row, checked without a user_id filter).
 *   router_lead -> skips unless an atomic `UPDATE leads SET alerted_at = now()
 *                    WHERE id = $1 AND alerted_at IS NULL AND role IS NOT NULL
 *                    AND email NOT ILIKE '%@otterquote-internal.test'
 *                    RETURNING ...` actually touches a row (see
 *                    handleRouterLead; gh-1994 fix round 1, REVIEW B1) -- a
 *                    `leads` row has no claim_id/user_id to key the
 *                    notifications table on before it converts, so the
 *                    dedupe AND the eligibility check both live on the row
 *                    itself, in one query, per gh-1994's own instruction.
 *
 * Test / internal-account filter (gh-1932 rework 2, anchored):
 *   is_test = true (unconditional), OR email matches (case-insensitive):
 *     local part exactly "test"        e.g. test@x.com
 *     local part "test" + [0-9+._-]    e.g. test1@, test+x@, test.x@, test-x@
 *     "+test" anywhere in local part   e.g. dustin+test@gmail.com
 *     domain in example.com / example.org / test.local
 *     @otterquote.com / @tryotterquote.com / @stellaredgeservices.com
 *     email contains "stohler" (internal/founder accounts)
 *   A real address that merely CONTAINS "test" (e.g. a "greatestates@" or
 *   "protest@" style local part) is NOT excluded by this pattern.
 *   router_lead uses a SEPARATE, narrower exclusion (gh-1994): `leads` has
 *   no is_test column, so only a reserved email suffix
 *   (@otterquote-internal.test) is excluded -- enforced directly in
 *   handleRouterLead's claim query (gh-1994 fix round 1, REVIEW B1;
 *   ROUTER_LEAD_EXCLUDED_EMAIL_SUFFIX in notify-helpers.ts is the single
 *   source for the literal suffix, also used by notify-helpers.test.ts and
 *   the exported isRouterLeadExcluded() helper it tests).
 *
 * Environment variables (all already set in Supabase secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 *
 * Refs #1932, #1994
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { appendPostalFooterHtml, appendPostalFooterText } from "./footer-append.ts"; // gh-1824 D-237
import {
  ADMIN_EMAIL,
  normalizeBody,
  ROUTER_LEAD_EXCLUDED_EMAIL_SUFFIX,
  roleLabel,
  isRouterLeadAuthorized,
  buildRouterLeadEmail,
} from "./notify-helpers.ts";
import {
  backfillDigestHtml,
  backfillDigestText,
  backlogDigestHtml,
  backlogDigestText,
  locationOf,
  maskEmail,
  newClaimHtml,
  newClaimText,
  newHomeownerHtml,
  newHomeownerText,
  routerLeadHtml,
} from "./templates.ts"; // gh-1824 email bodies (pinned by templates.test.ts)

const NOTIF_TYPE_HOMEOWNER   = "admin_new_homeowner";
const NOTIF_TYPE_CLAIM       = "admin_new_claim";
const NOTIF_TYPE_DIGEST      = "admin_homeowner_signup_digest";
const NOTIF_TYPE_BACKFILL    = "admin_homeowner_signup_backfill";
const NOTIF_TYPE_ROUTER_LEAD = "admin_router_lead";

const DEFAULT_MIN_AGE_MINUTES = 20;
const MAX_AGE_DAYS            = 7;

// CORS — origin-allowlisted per project standard (Session 254), copied
// from notify-admin-new-contractor.
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
    "Vary": "Origin",
  };
}

// gh-1932 rework 2: anchored exclusion filter (see doc header for the exact
// spec). Deliberately does NOT match a real address that merely contains
// "test" as a substring.
function isExcludedEmail(email: string): boolean {
  const lower = (email || "").toLowerCase().trim();
  if (!lower || lower.indexOf("@") <= 0) return true; // no usable address
  const at = lower.indexOf("@");
  const local  = lower.slice(0, at);
  const domain = lower.slice(at + 1);

  if (local === "test") return true;
  if (/^test[0-9+._-]/.test(local)) return true;
  if (local.includes("+test")) return true;
  if (["example.com", "example.org", "test.local"].includes(domain)) return true;
  if (domain === "otterquote.com" || domain === "tryotterquote.com" || domain === "stellaredgeservices.com") return true;
  if (lower.includes("stohler")) return true;

  return false;
}


serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const anonKey         = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const supabaseUrl     = Deno.env.get("SUPABASE_URL") || "";
    const mailgunKey      = Deno.env.get("MAILGUN_API_KEY") || "";
    const mailgunDomain   = Deno.env.get("MAILGUN_DOMAIN") || "";

    if (!serviceRoleKey || !supabaseUrl || !mailgunKey || !mailgunDomain) {
      throw new Error("Missing required environment variables");
    }

    const authHeader  = req.headers.get("Authorization") || "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
    const authorized =
      !!bearerToken && (bearerToken === serviceRoleKey || (!!anonKey && bearerToken === anonKey));
    if (!authorized) {
      console.error("notify-admin-new-homeowner: unauthorized");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const rawBody = await req.json().catch(() => ({}));
    const normalized = normalizeBody(rawBody);
    if (!normalized) {
      return new Response(
        JSON.stringify({ error: "Missing or unrecognized event_type/record payload" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const sb = createClient(supabaseUrl, serviceRoleKey);

    if (normalized.eventType === "signup_sweep") {
      return await handleSignupSweep(sb, normalized.minAgeMinutes, mailgunDomain, mailgunKey, corsHeaders);
    }

    if (normalized.eventType === "signup_backfill") {
      return await handleSignupBackfill(sb, mailgunDomain, mailgunKey, corsHeaders);
    }

    if (normalized.eventType === "router_lead") {
      // gh-1994 fix round 1 (REVIEW B1): stricter than the general
      // `authorized` gate above -- router_lead requires the service-role
      // credential specifically, never the anon key.
      if (!isRouterLeadAuthorized(bearerToken, serviceRoleKey)) {
        console.error("notify-admin-new-homeowner: router_lead requires the service-role credential");
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return await handleRouterLead(sb, normalized.record, mailgunDomain, mailgunKey, corsHeaders);
    }

    // eventType === "claim_created"
    const { record } = normalized;
    const claimId = record.id as string | undefined;
    const userId  = record.user_id as string | undefined;
    if (!claimId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: record.id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let email = "";
    let profileIsTest = false;
    let profileFullName = "";
    if (userId) {
      const { data: profile } = await sb
        .from("profiles")
        .select("email, is_test, full_name")
        .eq("id", userId)
        .maybeSingle();
      email           = profile?.email || "";
      profileIsTest   = profile?.is_test === true;
      profileFullName = profile?.full_name || "";
    }

    const claimIsTest = record.is_test === true;

    if (claimIsTest || profileIsTest || isExcludedEmail(email)) {
      console.log(`notify-admin-new-homeowner: skipping test/excluded claim ${claimId} (${email})`);
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "test_account" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: existing } = await sb
      .from("notifications")
      .select("id")
      .eq("claim_id", claimId)
      .eq("notification_type", NOTIF_TYPE_CLAIM)
      .eq("channel", "email")
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`notify-admin-new-homeowner: already sent for claim_id=${claimId}`);
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "already_notified" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const claimNumber = (record.claim_number as string) || claimId;
    const homeownerName = (record.homeowner_name as string) || profileFullName || "(no name given)";
    const propertyAddrParts = [record.property_address, record.property_state]
      .filter(Boolean)
      .join(", ");
    const propertyAddr = propertyAddrParts || "location not yet provided";
    const createdTs = record.created_at
      ? new Date(record.created_at as string).toLocaleString("en-US", { timeZone: "America/Chicago" })
      : new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
    const maskedEmail = maskEmail(email);

    const subject  = `[OtterQuote] New claim #${claimNumber} from ${maskedEmail}`;
    const textBody = newClaimText(claimNumber, homeownerName, maskedEmail, createdTs, propertyAddr);
    const htmlBody = newClaimHtml(claimNumber, homeownerName, maskedEmail, createdTs, propertyAddr);

    const mgData = await sendMail(mailgunDomain, mailgunKey, subject, textBody, htmlBody);

    await sb.from("notifications").insert({
      user_id:           userId || null,
      claim_id:          claimId,
      channel:           "email",
      notification_type: NOTIF_TYPE_CLAIM,
      recipient:         ADMIN_EMAIL,
      message_preview:   `New claim #${claimNumber} from ${maskedEmail}`,
      sent_at:           new Date().toISOString(),
      delivered:         true,
      mailgun_id:        mgData.id,
    }).then(({ error }) => {
      if (error) console.warn(`notify-admin-new-homeowner: failed to log notification for claim_id=${claimId}:`, error);
    });

    return new Response(
      JSON.stringify({ success: true, mailgun_id: mgData.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err) {
    console.error("notify-admin-new-homeowner error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// gh-1994: alert for a router lead that just picked a role (Step 2/2a,
// set_lead_role() success -> trg_notify_admin_new_router_lead -> here).
// Dedupe is atomic and lives on the leads row itself (see doc header):
// only the caller whose UPDATE actually flips alerted_at from NULL sends
// the email. No customer-facing copy, no SMS -- admin-only, per Dustin's
// GO comment (#1994 comment 5706456515).
// gh-1994 fix round 1 (REVIEW 5707519022, B1): the request body's `record`
// is untrusted -- only `record.id` is read from it, and only to pick which
// row this one atomic query targets. Every value that ends up in the email
// (name/email/phone/role/partner_industry/utm_*) comes from that query's
// RETURNING clause, never from the request body. Eligibility (not yet
// alerted, role actually set, not the excluded test suffix) is enforced IN
// the same query's WHERE clause -- one round trip, one place the decision
// is made. If zero rows come back, no email is sent, and the response does
// not distinguish which of those reasons (or a nonexistent id) it was.
async function handleRouterLead(
  sb: ReturnType<typeof createClient>,
  record: Record<string, unknown>,
  mailgunDomain: string,
  mailgunKey: string,
  corsHeaders: Record<string, string>,
) {
  const leadId = record?.id as string | undefined;
  if (!leadId) {
    return new Response(
      JSON.stringify({ error: "Missing required field: record.id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { data: claimedRows, error: claimErr } = await sb
    .from("leads")
    .update({ alerted_at: new Date().toISOString() })
    .eq("id", leadId)
    .is("alerted_at", null)
    .not("role", "is", null)
    .not("email", "ilike", `%${ROUTER_LEAD_EXCLUDED_EMAIL_SUFFIX}`)
    .select(
      "name, email, phone, role, partner_industry, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid",
    );

  if (claimErr) {
    console.error(`notify-admin-new-homeowner: alerted_at claim failed for lead_id=${leadId}:`, claimErr);
    return new Response(
      JSON.stringify({ error: "failed to claim lead for alert" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const leadRow = claimedRows?.[0] as Record<string, unknown> | undefined;
  if (!leadRow) {
    console.log(
      `notify-admin-new-homeowner: router lead ${leadId} not eligible to alert (already sent / no role / excluded / not found)`,
    );
    return new Response(
      JSON.stringify({ success: true, skipped: true, reason: "not_eligible" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // gh-1994 fix round 1 (REVIEW B1, N6): buildRouterLeadEmail() reads only
  // `leadRow` -- the query's RETURNING result above -- never the request
  // body. See its doc comment in notify-helpers.ts.
  const { subject, textBody, htmlRows, extraHtml } = buildRouterLeadEmail(leadRow);
  const htmlBody = routerLeadHtml(htmlRows, extraHtml);

  let mgData: { id: string };
  try {
    mgData = await sendMail(mailgunDomain, mailgunKey, subject, textBody, htmlBody);
  } catch (mailErr) {
    // gh-1994 fix round 1 (REVIEW N1): the row is already stamped
    // alerted_at from the claim above. If the send itself throws, revert
    // the stamp so a retry (the trigger's own delivery retry, or a manual
    // re-POST) can claim and send again, instead of the alert being lost
    // for good on a row that looks "already alerted" but never sent.
    console.error(`notify-admin-new-homeowner: mailgun send failed for lead_id=${leadId}, reverting alerted_at:`, mailErr);
    const { error: revertErr } = await sb
      .from("leads")
      .update({ alerted_at: null })
      .eq("id", leadId);
    if (revertErr) {
      console.error(
        `notify-admin-new-homeowner: failed to revert alerted_at for lead_id=${leadId} after mailgun failure:`,
        revertErr,
      );
    }
    return new Response(
      JSON.stringify({ error: "failed to send router lead alert email" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  await sb.from("notifications").insert({
    user_id:           null,
    claim_id:          null,
    channel:           "email",
    notification_type: NOTIF_TYPE_ROUTER_LEAD,
    recipient:         ADMIN_EMAIL,
    message_preview:   `New router lead (${roleLabel(leadRow.role)}): ${(leadRow.name as string) || "(no name given)"}`,
    sent_at:           new Date().toISOString(),
    delivered:         true,
    mailgun_id:        mgData.id,
  }).then(({ error }) => {
    if (error) console.warn(`notify-admin-new-homeowner: failed to log notification for lead_id=${leadId}:`, error);
  });

  return new Response(
    JSON.stringify({ success: true, mailgun_id: mgData.id }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

// gh-1932 rework 2: deferred signup sweep. Selects role='homeowner' profiles
// between minAgeMinutes and MAX_AGE_DAYS old, with no matching contractors
// row, not excluded/is_test, and not yet alerted. First-ever run (no
// NOTIF_TYPE_DIGEST row exists) sends ONE digest for the whole backlog
// instead of one email per profile. Every subsequent run alerts newly
// eligible profiles individually (normally 0 or 1 per run).
async function handleSignupSweep(
  sb: ReturnType<typeof createClient>,
  minAgeMinutes: number,
  mailgunDomain: string,
  mailgunKey: string,
  corsHeaders: Record<string, string>,
) {
  const now = Date.now();
  const upperBound = new Date(now - minAgeMinutes * 60_000).toISOString();       // created_at <= this (old enough)
  const lowerBound = new Date(now - MAX_AGE_DAYS * 24 * 60 * 60_000).toISOString(); // created_at >= this (not stale)

  const { data: candidates, error: candErr } = await sb
    .from("profiles")
    .select("id, email, full_name, address_city, address_state, address_zip, created_at, is_test")
    .eq("role", "homeowner")
    .gte("created_at", lowerBound)
    .lte("created_at", upperBound);

  if (candErr) {
    console.error("notify-admin-new-homeowner: sweep candidate query failed:", candErr);
    return new Response(
      JSON.stringify({ error: "sweep candidate query failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const ids = (candidates || []).map((c: any) => c.id);
  let contractorIds = new Set<string>();
  if (ids.length > 0) {
    const { data: contractorRows } = await sb.from("contractors").select("user_id").in("user_id", ids);
    contractorIds = new Set((contractorRows || []).map((r: any) => r.user_id));
  }

  // anchored exclusion filter (SQL-equivalent pattern, applied here in TS
  // over the already-narrowed candidate set — see isExcludedEmail doc header)
  const eligible = (candidates || []).filter(
    (c: any) => !contractorIds.has(c.id) && c.is_test !== true && !isExcludedEmail(c.email || ""),
  );

  let alreadyAlertedIds = new Set<string>();
  if (eligible.length > 0) {
    const { data: alertedRows } = await sb
      .from("notifications")
      .select("user_id")
      .eq("notification_type", NOTIF_TYPE_HOMEOWNER)
      .in("user_id", eligible.map((e: any) => e.id));
    alreadyAlertedIds = new Set((alertedRows || []).map((r: any) => r.user_id));
  }

  const toAlert = eligible.filter((e: any) => !alreadyAlertedIds.has(e.id));

  const { data: digestRows } = await sb
    .from("notifications")
    .select("id")
    .eq("notification_type", NOTIF_TYPE_DIGEST)
    .limit(1);
  const digestAlreadySent = !!digestRows && digestRows.length > 0;

  if (toAlert.length === 0) {
    return new Response(
      JSON.stringify({ success: true, sweep: true, alerted: 0, digest_sent: digestAlreadySent }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!digestAlreadySent) {
    // ONE digest email listing every backlog profile, then mark all alerted.
    const subject  = `[OtterQuote] Homeowner signup backlog digest: ${toAlert.length} existing homeowner(s)`;
    const textBody = backlogDigestText(toAlert);
    const htmlBody = backlogDigestHtml(toAlert);

    const mgData = await sendMail(mailgunDomain, mailgunKey, subject, textBody, htmlBody);

    await sb.from("notifications").insert({
      user_id: null, claim_id: null, channel: "email",
      notification_type: NOTIF_TYPE_DIGEST, recipient: ADMIN_EMAIL,
      message_preview: `Backlog digest: ${toAlert.length} homeowner(s)`,
      sent_at: new Date().toISOString(), delivered: true, mailgun_id: mgData.id,
    });

    // mark every backlog profile as alerted (no individual email for these)
    const markRows = toAlert.map((p: any) => ({
      user_id: p.id, claim_id: null, channel: "email",
      notification_type: NOTIF_TYPE_HOMEOWNER, recipient: ADMIN_EMAIL,
      message_preview: `Included in backlog digest`,
      sent_at: new Date().toISOString(), delivered: true, mailgun_id: mgData.id,
    }));
    if (markRows.length > 0) {
      const { error: markErr } = await sb.from("notifications").insert(markRows);
      if (markErr) console.warn("notify-admin-new-homeowner: failed to mark backlog as alerted:", markErr);
    }

    return new Response(
      JSON.stringify({ success: true, sweep: true, digest: true, count: toAlert.length, mailgun_id: mgData.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Steady state: individual email per newly-eligible profile.
  let lastMailgunId = "";
  for (const p of toAlert) {
    const maskedEmail = maskEmail(p.email || "");
    const location = locationOf(p);
    const subject  = `[OtterQuote] New homeowner: ${maskedEmail} — ${location}`;
    const textBody = newHomeownerText(p);
    const htmlBody = newHomeownerHtml(p);

    const mgData = await sendMail(mailgunDomain, mailgunKey, subject, textBody, htmlBody);
    lastMailgunId = mgData.id;

    await sb.from("notifications").insert({
      user_id: p.id, claim_id: null, channel: "email",
      notification_type: NOTIF_TYPE_HOMEOWNER, recipient: ADMIN_EMAIL,
      message_preview: `New homeowner signup: ${maskedEmail}`,
      sent_at: new Date().toISOString(), delivered: true, mailgun_id: mgData.id,
    }).then(({ error }) => {
      if (error) console.warn(`notify-admin-new-homeowner: failed to log sweep notification for user_id=${p.id}:`, error);
    });
  }

  return new Response(
    JSON.stringify({ success: true, sweep: true, alerted: toAlert.length, mailgun_id: lastMailgunId }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

// gh-1932 rework 3: one-time backlog catch-up, no age cap. The recurring
// sweep is capped at MAX_AGE_DAYS=7, so its first run only covered 1 of the
// 19 pre-existing zero-claim homeowners. This covers the rest (any
// role='homeowner' profile with no claims row, no contractors row, not
// excluded/is_test, not yet in NOTIF_TYPE_HOMEOWNER) in ONE digest email,
// then marks them alerted the same way the recurring digest does. Gated by
// NOTIF_TYPE_BACKFILL so it can only ever send once, independent of the
// recurring sweep's own digest gate (which already fired).
async function handleSignupBackfill(
  sb: ReturnType<typeof createClient>,
  mailgunDomain: string,
  mailgunKey: string,
  corsHeaders: Record<string, string>,
) {
  const { data: backfillRows } = await sb
    .from("notifications")
    .select("id")
    .eq("notification_type", NOTIF_TYPE_BACKFILL)
    .limit(1);
  if (backfillRows && backfillRows.length > 0) {
    return new Response(
      JSON.stringify({ success: true, backfill: true, already_ran: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { data: candidates, error: candErr } = await sb
    .from("profiles")
    .select("id, email, full_name, address_city, address_state, address_zip, created_at, is_test")
    .eq("role", "homeowner");

  if (candErr) {
    console.error("notify-admin-new-homeowner: backfill candidate query failed:", candErr);
    return new Response(
      JSON.stringify({ error: "backfill candidate query failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const ids = (candidates || []).map((c: any) => c.id);
  let contractorIds = new Set<string>();
  let claimedIds = new Set<string>();
  if (ids.length > 0) {
    const [{ data: contractorRows }, { data: claimRows }] = await Promise.all([
      sb.from("contractors").select("user_id").in("user_id", ids),
      sb.from("claims").select("user_id").in("user_id", ids),
    ]);
    contractorIds = new Set((contractorRows || []).map((r: any) => r.user_id));
    claimedIds = new Set((claimRows || []).map((r: any) => r.user_id));
  }

  const eligible = (candidates || []).filter(
    (c: any) =>
      !contractorIds.has(c.id) &&
      !claimedIds.has(c.id) &&
      c.is_test !== true &&
      !isExcludedEmail(c.email || ""),
  );

  let alreadyAlertedIds = new Set<string>();
  if (eligible.length > 0) {
    const { data: alertedRows } = await sb
      .from("notifications")
      .select("user_id")
      .eq("notification_type", NOTIF_TYPE_HOMEOWNER)
      .in("user_id", eligible.map((e: any) => e.id));
    alreadyAlertedIds = new Set((alertedRows || []).map((r: any) => r.user_id));
  }

  const toAlert = eligible.filter((e: any) => !alreadyAlertedIds.has(e.id));

  const subject  = `[OtterQuote] Homeowner signup backlog catch-up digest: ${toAlert.length} homeowner(s)`;
  const textBody = backfillDigestText(toAlert);
  const htmlBody = backfillDigestHtml(toAlert);

  const mgData = await sendMail(mailgunDomain, mailgunKey, subject, textBody, htmlBody);

  await sb.from("notifications").insert({
    user_id: null, claim_id: null, channel: "email",
    notification_type: NOTIF_TYPE_BACKFILL, recipient: ADMIN_EMAIL,
    message_preview: `Backfill digest: ${toAlert.length} homeowner(s)`,
    sent_at: new Date().toISOString(), delivered: true, mailgun_id: mgData.id,
  });

  const markRows = toAlert.map((p: any) => ({
    user_id: p.id, claim_id: null, channel: "email",
    notification_type: NOTIF_TYPE_HOMEOWNER, recipient: ADMIN_EMAIL,
    message_preview: `Included in backfill digest`,
    sent_at: new Date().toISOString(), delivered: true, mailgun_id: mgData.id,
  }));
  if (markRows.length > 0) {
    const { error: markErr } = await sb.from("notifications").insert(markRows);
    if (markErr) console.warn("notify-admin-new-homeowner: failed to mark backfill as alerted:", markErr);
  }

  return new Response(
    JSON.stringify({ success: true, backfill: true, count: toAlert.length, mailgun_id: mgData.id }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function sendMail(
  mailgunDomain: string,
  mailgunKey: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): Promise<{ id: string }> {
  const formData = new FormData();
  formData.append("from",    `Otter Quotes <notifications@${mailgunDomain}>`);
  formData.append("to",      ADMIN_EMAIL);
  formData.append("subject", subject);
  formData.append("text",    appendPostalFooterText(textBody));
  formData.append("html",    appendPostalFooterHtml(htmlBody));

  const mgRes = await fetch(
    `https://api.mailgun.net/v3/${mailgunDomain}/messages`,
    {
      method:  "POST",
      headers: { Authorization: `Basic ${btoa(`api:${mailgunKey}`)}` },
      body:    formData,
    },
  );

  if (!mgRes.ok) {
    const errText = await mgRes.text();
    throw new Error(`Mailgun error ${mgRes.status}: ${errText}`);
  }

  return await mgRes.json();
}
