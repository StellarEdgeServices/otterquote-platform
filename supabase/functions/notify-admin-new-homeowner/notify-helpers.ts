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
 *
 * Fix round 1 (REVIEW 5707519022 on PR #2005, Ben CEO RUN 48 dispatch):
 *  - B1: index.ts's handleRouterLead() no longer builds the email from the
 *    request body. It reads only `record.id`, atomically claims the row
 *    (`UPDATE ... WHERE alerted_at IS NULL AND role IS NOT NULL AND email
 *    NOT ILIKE '%@otterquote-internal.test' RETURNING ...`), and this
 *    module's functions render ONLY that returned row. roleLabel() and
 *    partnerIndustryLabel() below now always return a value from a fixed
 *    label map -- an unrecognized value renders as "Other", it is never
 *    passed through raw -- and the subject stripCrlf()s its own output as
 *    defense-in-depth on top of that.
 *  - B2: partnerIndustryLabel() no longer declares its own
 *    re_agent/insurance_agent/home_inspector/adjuster/other label map (that
 *    was exactly the "re-introduced local label map" class gh-914's
 *    tools/agent_type_labels_check.py exists to catch). It now imports
 *    ADMIN_DROPDOWN_LABELS from the single source, react-app/app/lib/
 *    agent-types.ts -- plain TS with no framework dependency, so Deno can
 *    import it directly by relative path.
 *  - N3: buildAttributionSource() caps each utm_* value at 200 chars before
 *    it reaches Dustin's inbox (an anon insert controls these values).
 */

import { ADMIN_DROPDOWN_LABELS, type AgentType } from "../../../react-app/app/lib/agent-types.ts";

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

// gh-1994 fix round 1 (REVIEW B1): a fixed label map, no raw passthrough.
// `leads.role` is DB-CHECK-constrained to these three values in practice,
// but roleLabel() renders ANY input this way regardless -- an unrecognized
// value (which should be unreachable given the CHECK, but this function
// must not assume that) maps to "Other", never to the raw string, so it
// can never carry attacker-controlled text (e.g. CRLF) into the subject.
const ROLE_LABELS: Record<string, string> = {
  homeowner: "Homeowner",
  contractor: "Contractor",
  referral_partner: "Referral partner",
};
const UNKNOWN_LABEL = "Other";

export function roleLabel(role: unknown): string {
  const r = String(role ?? "");
  return ROLE_LABELS[r] || UNKNOWN_LABEL;
}

// gh-1994 fix round 1 (REVIEW B2): re_agent/insurance_agent/home_inspector/
// adjuster/other display strings come from the gh-914 single source
// (react-app/app/lib/agent-types.ts's ADMIN_DROPDOWN_LABELS) instead of a
// locally re-declared map -- tools/agent_type_labels_check.py (chained into
// the "Null-Byte & Size Sanity Check" CI job) fails the build on exactly
// that re-introduction. LEAD_PARTNER_INDUSTRY_KEYS is the subset of
// AgentType that leads_partner_industry_check actually allows (no
// 'customer' -- gh-1994 phase-1 migration). An unrecognized/forged value
// renders as ADMIN_DROPDOWN_LABELS.other ("Other"), same "fixed map only"
// rule as roleLabel() above.
const LEAD_PARTNER_INDUSTRY_KEYS: readonly AgentType[] = [
  "re_agent",
  "insurance_agent",
  "home_inspector",
  "adjuster",
  "other",
];

export function partnerIndustryLabel(industry: unknown): string | null {
  if (!industry) return null;
  const i = String(industry);
  if ((LEAD_PARTNER_INDUSTRY_KEYS as readonly string[]).includes(i)) {
    return ADMIN_DROPDOWN_LABELS[i as AgentType];
  }
  return ADMIN_DROPDOWN_LABELS.other;
}

// gh-1994 fix round 1 (REVIEW B1): strip CR/LF from any string that ends up
// in an email header field. Applied to the router-lead subject below.
// roleLabel() already guarantees a mapped, CRLF-free value, so this is
// belt-and-suspenders -- cheap enough to apply unconditionally rather than
// rely solely on every caller upstream staying disciplined.
export function stripCrlf(str: string): string {
  return String(str ?? "").replace(/[\r\n]+/g, " ");
}

// gh-1994: human-readable attribution summary for the admin email. Lists
// only the attribution fields actually present on the lead row (utm_*,
// fbclid, gclid) -- never invents a value -- and reports "Direct / no
// attribution" instead of an empty string when none are present.
// gh-1994 fix round 1 (REVIEW N3): each utm_* value is capped at
// UTM_MAX_LEN characters before it reaches this string -- these values
// come from an anon-writable insert (the router's Step 1) with no
// length cap at the DB layer, so an arbitrarily long value could otherwise
// land in Dustin's inbox unbounded.
export const UTM_MAX_LEN = 200;

function truncateAttr(value: string): string {
  return value.length > UTM_MAX_LEN
    ? `${value.slice(0, UTM_MAX_LEN)}...(truncated)`
    : value;
}

export function buildAttributionSource(record: Record<string, unknown>): string {
  const parts: string[] = [];
  const utmSource   = record.utm_source   as string | undefined;
  const utmMedium   = record.utm_medium   as string | undefined;
  const utmCampaign = record.utm_campaign as string | undefined;
  const utmContent  = record.utm_content  as string | undefined;
  const utmTerm     = record.utm_term     as string | undefined;
  const fbclid      = record.fbclid       as string | undefined;
  const gclid       = record.gclid        as string | undefined;

  if (utmSource)   parts.push(`utm_source=${truncateAttr(utmSource)}`);
  if (utmMedium)   parts.push(`utm_medium=${truncateAttr(utmMedium)}`);
  if (utmCampaign) parts.push(`utm_campaign=${truncateAttr(utmCampaign)}`);
  if (utmContent)  parts.push(`utm_content=${truncateAttr(utmContent)}`);
  if (utmTerm)     parts.push(`utm_term=${truncateAttr(utmTerm)}`);
  if (fbclid)       parts.push("fbclid present");
  if (gclid)        parts.push("gclid present");

  return parts.length > 0 ? parts.join(", ") : "Direct / no attribution";
}

// gh-1994 fix round 1 (REVIEW B1): router_lead is reachable ONLY with the
// service-role credential -- unlike the other three event types, which
// also accept the anon key (see index.ts's "Auth model" header comment).
// Extracted as its own pure function, and imported by index.ts rather than
// re-implemented inline, so this exact rule is what `deno test` exercises
// (an anon-keyed request cannot reach handleRouterLead at all).
export function isRouterLeadAuthorized(bearerToken: string, serviceRoleKey: string): boolean {
  return !!bearerToken && bearerToken === serviceRoleKey;
}

// gh-1994 fix round 1 (REVIEW B1, N6): the ONE function that decides what
// reaches Dustin's inbox for a router lead. Takes a database ROW -- the
// `RETURNING` result of handleRouterLead's atomic claim-and-read query, or
// anything shaped like one -- and reads ONLY the fields it names below.
// index.ts's handleRouterLead passes this function the query's returned
// row and nothing else, so an attacker-controlled request body (even one
// that reached this far, which fix round 1's auth + DB-only-claim changes
// should already prevent) has no field this function will read. Every
// string rendered into `htmlRows` is escapeHtml()'d here; `textBody` stays
// unescaped plain text, matching claim_created's own plain-text/HTML split
// convention elsewhere in this file/index.ts.
export interface RouterLeadEmail {
  subject: string;
  textBody: string;
  htmlRows: [string, string][];
  extraHtml: string;
}

export function buildRouterLeadEmail(leadRow: Record<string, unknown>): RouterLeadEmail {
  const { subject, textBody } = buildRouterLeadSubjectAndText(leadRow);
  const name        = (leadRow.name  as string) || "(no name given)";
  const email       = (leadRow.email as string) || "(no email)";
  const phone       = (leadRow.phone as string) || "(no phone)";
  const role        = roleLabel(leadRow.role);
  const industry    = partnerIndustryLabel(leadRow.partner_industry);
  const attribution = buildAttributionSource(leadRow);

  const htmlRows: [string, string][] = [
    ["Name", escapeHtml(name)],
    ["Email", escapeHtml(email)],
    ["Phone", escapeHtml(phone)],
    ["Role", escapeHtml(role)],
  ];
  if (industry) htmlRows.push(["Industry", escapeHtml(industry)]);
  htmlRows.push(["Attribution", escapeHtml(attribution)]);

  const extraHtml =
    `<p style="font-family:sans-serif;font-size:12px;color:#94A3B8;margin:0 0 16px;">Phone carries no consent — callback only.</p>`;

  return { subject, textBody, htmlRows, extraHtml };
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

  const subject = stripCrlf(`[OtterQuote] New router lead: ${role}`);
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
