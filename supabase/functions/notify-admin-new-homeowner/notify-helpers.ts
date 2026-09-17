/**
 * Pure, testable helpers for notify-admin-new-homeowner/index.ts.
 *
 * Extracted (gh-1994) so `deno test` can exercise normalizeBody(),
 * escapeHtml() and the new router_lead email-building logic directly,
 * without importing index.ts itself -- index.ts calls serve() at module
 * load and requires live env vars, so importing it under `deno test` would
 * hang / throw. Same pattern already used elsewhere in this repo:
 * docusign-webhook/payload-parser.ts + ack-verify.ts + price-verify.ts,
 * notify-contractors/test-exclusion.ts -- logic lives in a plain module,
 * index.ts imports it, a sibling *.test.ts imports the same module.
 *
 * Refs #1994. Dustin's GO recorded verbatim on issue #1994 comment
 * 5706456515: "GO on the new-lead alert email." Scope per that comment:
 * an admin-only internal email to Dustin when a router lead picks a role
 * (name, email, phone, role, partner industry, attribution source) -- no
 * customer-facing copy, no SMS, phone carries no consent (manual callback
 * only).
 */

// Single source of truth for the admin recipient -- index.ts imports this
// instead of declaring its own copy, so "the recipient is unchanged" is a
// property of one constant, not something that could drift between the
// pre-existing event types and this one.
export const ADMIN_EMAIL = "dustinstohler1@gmail.com";

export type NormalizedEvent =
  | { eventType: "claim_created"; record: Record<string, unknown> }
  | { eventType: "signup_sweep"; minAgeMinutes: number }
  | { eventType: "signup_backfill" }
  | { eventType: "router_lead"; record: Record<string, unknown> };

const DEFAULT_MIN_AGE_MINUTES = 20;

// Unchanged for the first three branches (byte-identical to the pre-gh-1994
// implementation in index.ts -- verified by notify-helpers.test.ts's
// "existing event types" suite against payload shapes that predate this
// change). Only the new `router_lead` branch (and its doc comment) is new.
export function normalizeBody(body: any): NormalizedEvent | null {
  if (!body || typeof body !== "object") return null;

  if (body.event_type === "claim_created") {
    if (!body.record || typeof body.record !== "object") return null;
    return { eventType: "claim_created", record: body.record };
  }

  if (body.event_type === "signup_sweep") {
    const minAgeMinutes =
      typeof body.min_age_minutes === "number" && body.min_age_minutes >= 0
        ? body.min_age_minutes
        : DEFAULT_MIN_AGE_MINUTES;
    return { eventType: "signup_sweep", minAgeMinutes };
  }

  // gh-1932 rework 3: one-time, manually-invoked catch-up for the backlog
  // that predates MAX_AGE_DAYS=7 (the recurring sweep's window). Runs once
  // ever, gated by NOTIF_TYPE_BACKFILL, independent of the recurring
  // sweep's own NOTIF_TYPE_DIGEST gate. Not on the cron schedule.
  if (body.event_type === "signup_backfill") {
    return { eventType: "signup_backfill" };
  }

  // gh-1994: router lead picked a role at Step 2/2a (set_lead_role
  // succeeded) -- carries the full `leads` row so the alert can show
  // name/email/phone/role/partner_industry/attribution. Same shape rule as
  // claim_created: a record object is required, or this returns null (400).
  if (body.event_type === "router_lead") {
    if (!body.record || typeof body.record !== "object") return null;
    return { eventType: "router_lead", record: body.record };
  }

  // Supabase native database-webhook shape: {type:"INSERT", table, record}
  if (body.type === "INSERT" && body.record && typeof body.record === "object" && body.table === "claims") {
    return { eventType: "claim_created", record: body.record };
  }

  return null;
}

// Unchanged (byte-identical) from the pre-gh-1994 implementation.
export function escapeHtml(str: string): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// gh-1994: never alert for a synthetic/internal test lead. `leads` has no
// is_test column (confirmed live 2026-09-16 against
// information_schema.columns -- see the gh-1994 phase-1 migration's own
// header comment), so rather than adding one, this dispatch's own
// simplification is a single reserved email suffix no real visitor's
// address can end in.
export const ROUTER_LEAD_EXCLUDED_EMAIL_SUFFIX = "@otterquote-internal.test";

export function isRouterLeadExcluded(email: unknown): boolean {
  const lower = String(email ?? "").toLowerCase().trim();
  return lower.endsWith(ROUTER_LEAD_EXCLUDED_EMAIL_SUFFIX);
}

const ROLE_LABELS: Record<string, string> = {
  homeowner: "Homeowner",
  contractor: "Contractor",
  referral_partner: "Referral partner",
};

// Mirrors js/agent-types.js's CHOOSER_LABELS keys (gh-914 single source),
// same five values leads_partner_industry_check restricts partner_industry
// to (gh-1994 phase-1 migration).
const PARTNER_INDUSTRY_LABELS: Record<string, string> = {
  re_agent: "Real estate agent",
  insurance_agent: "Insurance agent",
  home_inspector: "Home inspector",
  adjuster: "Insurance adjuster",
  other: "Other",
};

export function roleLabel(role: unknown): string {
  const r = String(role ?? "");
  return ROLE_LABELS[r] || r || "(no role)";
}

export function partnerIndustryLabel(industry: unknown): string | null {
  if (!industry) return null;
  const i = String(industry);
  return PARTNER_INDUSTRY_LABELS[i] || i;
}

// gh-1994: human-readable attribution summary for the admin email. Lists
// only the attribution fields actually present on the lead row (utm_*,
// fbclid, gclid) -- never invents a value -- and reports "Direct / no
// attribution" instead of an empty string when none are present.
export function buildAttributionSource(record: Record<string, unknown>): string {
  const parts: string[] = [];
  const utmSource   = record.utm_source   as string | undefined;
  const utmMedium   = record.utm_medium   as string | undefined;
  const utmCampaign = record.utm_campaign as string | undefined;
  const utmContent  = record.utm_content  as string | undefined;
  const utmTerm     = record.utm_term     as string | undefined;
  const fbclid      = record.fbclid       as string | undefined;
  const gclid       = record.gclid        as string | undefined;

  if (utmSource)   parts.push(`utm_source=${utmSource}`);
  if (utmMedium)   parts.push(`utm_medium=${utmMedium}`);
  if (utmCampaign) parts.push(`utm_campaign=${utmCampaign}`);
  if (utmContent)  parts.push(`utm_content=${utmContent}`);
  if (utmTerm)     parts.push(`utm_term=${utmTerm}`);
  if (fbclid)       parts.push("fbclid present");
  if (gclid)        parts.push("gclid present");

  return parts.length > 0 ? parts.join(", ") : "Direct / no attribution";
}

// gh-1994: subject + plain-text body for the router-lead admin email. Pure
// (no Date.now(), no I/O) -- the same record always produces the same
// output. Phone is shown AS-IS (Dustin's GO comment: "for manual callback
// only" -- unmasked, unlike claim_created/signup_sweep's maskEmail(), since
// this alert must be directly actionable). index.ts builds the HTML rows
// separately, escaping each value with escapeHtml() before rendering, same
// as every other event type in that file already does.
export function buildRouterLeadSubjectAndText(record: Record<string, unknown>): { subject: string; textBody: string } {
  const name  = (record.name  as string) || "(no name given)";
  const email = (record.email as string) || "(no email)";
  const phone = (record.phone as string) || "(no phone)";
  const role  = roleLabel(record.role);
  const industry = partnerIndustryLabel(record.partner_industry);
  const attribution = buildAttributionSource(record);

  const subject = `[OtterQuote] New router lead: ${role}`;
  const lines = [
    `A new lead came through the front-door router on Otter Quotes.`,
    `Name       : ${name}`,
    `Email      : ${email}`,
    `Phone      : ${phone}`,
    `Role       : ${role}`,
  ];
  if (industry) lines.push(`Industry   : ${industry}`);
  lines.push(`Attribution: ${attribution}`, ``, `Phone carries no consent -- callback only.`);

  return { subject, textBody: lines.join("\n") };
}
