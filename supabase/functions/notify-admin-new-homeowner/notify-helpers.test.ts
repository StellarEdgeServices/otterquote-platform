import { assert, assertEquals, assertStrictEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  ADMIN_EMAIL,
  normalizeBody,
  escapeHtml,
  isRouterLeadExcluded,
  ROUTER_LEAD_EXCLUDED_EMAIL_SUFFIX,
  roleLabel,
  partnerIndustryLabel,
  buildAttributionSource,
  buildRouterLeadSubjectAndText,
  isRouterLeadAuthorized,
  buildRouterLeadEmail,
  stripCrlf,
  UTM_MAX_LEN,
} from "./notify-helpers.ts";

// ---------------------------------------------------------------------------
// recipient unchanged (gh-1994 requirement)
// ---------------------------------------------------------------------------

Deno.test("ADMIN_EMAIL recipient is unchanged by gh-1994", () => {
  assertStrictEquals(ADMIN_EMAIL, "dustinstohler1@gmail.com");
});

// ---------------------------------------------------------------------------
// normalizeBody — existing three event types, byte-identical to pre-gh-1994
// behavior. Each case pins the EXACT expected object so any future edit that
// changes shape, not just the new router_lead branch, fails loudly here.
// ---------------------------------------------------------------------------

Deno.test("normalizeBody: claim_created — unchanged", () => {
  const record = { id: "claim-1", claim_number: "C-100", user_id: "u-1" };
  const result = normalizeBody({ event_type: "claim_created", record });
  assertEquals(result, { eventType: "claim_created", record });
});

Deno.test("normalizeBody: claim_created — missing record is rejected (unchanged)", () => {
  assertStrictEquals(normalizeBody({ event_type: "claim_created" }), null);
  assertStrictEquals(normalizeBody({ event_type: "claim_created", record: "not-an-object" }), null);
});

Deno.test("normalizeBody: signup_sweep — default min_age_minutes unchanged", () => {
  const result = normalizeBody({ event_type: "signup_sweep" });
  assertEquals(result, { eventType: "signup_sweep", minAgeMinutes: 20 });
});

Deno.test("normalizeBody: signup_sweep — explicit min_age_minutes unchanged", () => {
  const result = normalizeBody({ event_type: "signup_sweep", min_age_minutes: 45 });
  assertEquals(result, { eventType: "signup_sweep", minAgeMinutes: 45 });
});

Deno.test("normalizeBody: signup_sweep — negative min_age_minutes falls back to default (unchanged)", () => {
  const result = normalizeBody({ event_type: "signup_sweep", min_age_minutes: -5 });
  assertEquals(result, { eventType: "signup_sweep", minAgeMinutes: 20 });
});

Deno.test("normalizeBody: signup_backfill — unchanged", () => {
  const result = normalizeBody({ event_type: "signup_backfill" });
  assertEquals(result, { eventType: "signup_backfill" });
});

Deno.test("normalizeBody: native DB webhook shape (claims INSERT) — unchanged", () => {
  const record = { id: "claim-9", claim_number: "C-900" };
  const result = normalizeBody({ type: "INSERT", table: "claims", record });
  assertEquals(result, { eventType: "claim_created", record });
});

Deno.test("normalizeBody: native DB webhook shape for a DIFFERENT table is still rejected (unchanged)", () => {
  const result = normalizeBody({ type: "INSERT", table: "leads", record: { id: "l-1" } });
  assertStrictEquals(result, null);
});

// ---------------------------------------------------------------------------
// normalizeBody — new router_lead event type
// ---------------------------------------------------------------------------

Deno.test("normalizeBody: router_lead — accepts a valid record", () => {
  const record = {
    id: "lead-1",
    name: "Jane Homeowner",
    email: "jane@example.com",
    phone: "5125551234",
    role: "homeowner",
  };
  const result = normalizeBody({ event_type: "router_lead", record });
  assertEquals(result, { eventType: "router_lead", record });
});

Deno.test("normalizeBody: router_lead — rejects malformed payloads", () => {
  assertStrictEquals(normalizeBody({ event_type: "router_lead" }), null, "missing record");
  assertStrictEquals(normalizeBody({ event_type: "router_lead", record: null }), null, "null record");
  assertStrictEquals(normalizeBody({ event_type: "router_lead", record: "lead-1" }), null, "string record");
  assertStrictEquals(normalizeBody({ event_type: "router_lead", record: 42 }), null, "numeric record");
});

Deno.test("normalizeBody: router_lead — an array record passes the same shape rule claim_created already used (typeof array === 'object', unchanged rule, not a new hole)", () => {
  // Documents existing behavior rather than asserting a new restriction:
  // claim_created's own guard (`typeof body.record !== "object"`) has always
  // accepted an array too — router_lead reuses that exact guard rather than
  // inventing a stricter one, so this is not a gh-1994 regression.
  const result = normalizeBody({ event_type: "router_lead", record: [] as unknown as Record<string, unknown> });
  assertEquals(result, { eventType: "router_lead", record: [] as unknown as Record<string, unknown> });
});

Deno.test("normalizeBody: rejects null/non-object/unknown-event-type bodies (unchanged + covers router_lead)", () => {
  assertStrictEquals(normalizeBody(null), null);
  assertStrictEquals(normalizeBody(undefined), null);
  assertStrictEquals(normalizeBody("router_lead"), null);
  assertStrictEquals(normalizeBody({}), null);
  assertStrictEquals(normalizeBody({ event_type: "totally_unknown" }), null);
  assertStrictEquals(normalizeBody({ event_type: "router_leadd", record: {} }), null, "near-miss event_type string is not fuzzy-matched");
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

Deno.test("escapeHtml: escapes &, <, >, \"", () => {
  assertStrictEquals(escapeHtml(`&<>"`), "&amp;&lt;&gt;&quot;");
});

Deno.test("escapeHtml: neutralizes an XSS-shaped router-lead name", () => {
  const malicious = `<script>alert("pwn")</script>`;
  const escaped = escapeHtml(malicious);
  assert(!escaped.includes("<script>"), "raw <script> tag must not survive escaping");
  assertStrictEquals(escaped, "&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;");
});

Deno.test("escapeHtml: null/undefined/number-ish input do not throw", () => {
  assertStrictEquals(escapeHtml(null as unknown as string), "");
  assertStrictEquals(escapeHtml(undefined as unknown as string), "");
});

// ---------------------------------------------------------------------------
// isRouterLeadExcluded
// ---------------------------------------------------------------------------

Deno.test("isRouterLeadExcluded: excludes the reserved internal-test suffix", () => {
  assert(isRouterLeadExcluded("probe@otterquote-internal.test"));
  assert(isRouterLeadExcluded("Probe@OTTERQUOTE-INTERNAL.TEST"), "case-insensitive");
  assertStrictEquals(ROUTER_LEAD_EXCLUDED_EMAIL_SUFFIX, "@otterquote-internal.test");
});

Deno.test("isRouterLeadExcluded: negative control — a real address is never excluded", () => {
  assertStrictEquals(isRouterLeadExcluded("jane@example.com"), false);
  assertStrictEquals(isRouterLeadExcluded("dustinstohler1@gmail.com"), false);
  // Must not match on mere substring/prefix confusion.
  assertStrictEquals(isRouterLeadExcluded("otterquote-internal.test@gmail.com"), false);
  assertStrictEquals(isRouterLeadExcluded("person@otterquote-internal.test.evil.com"), false);
  assertStrictEquals(isRouterLeadExcluded(""), false);
  assertStrictEquals(isRouterLeadExcluded(undefined), false);
});

// ---------------------------------------------------------------------------
// roleLabel / partnerIndustryLabel / buildAttributionSource
// ---------------------------------------------------------------------------

// gh-1994 fix round 1 (REVIEW B1): fixed map only, no raw passthrough --
// an unrecognized value (which the DB CHECK should prevent, but this
// function must not assume that) renders as "Other", never as the raw
// string, so it can never carry attacker-controlled text into the subject.
Deno.test("roleLabel: known roles map to display labels; unknown/missing renders as Other, never raw", () => {
  assertStrictEquals(roleLabel("homeowner"), "Homeowner");
  assertStrictEquals(roleLabel("contractor"), "Contractor");
  assertStrictEquals(roleLabel("referral_partner"), "Referral partner");
  assertStrictEquals(roleLabel("something_new"), "Other", "unrecognized value must not pass through raw");
  assertStrictEquals(roleLabel(null), "Other");
  assertStrictEquals(roleLabel(undefined), "Other");
});

Deno.test("roleLabel: a CRLF/header-injection-shaped forged value is neutralized to the fixed label, not passed through", () => {
  const forged = "homeowner\r\nBcc: victim@example.com";
  assertStrictEquals(roleLabel(forged), "Other", "must not echo the forged value back");
});

// gh-1994 fix round 1 (REVIEW B2): sourced from the gh-914 single source
// (react-app/app/lib/agent-types.ts's ADMIN_DROPDOWN_LABELS), not a local
// re-declaration -- and an unrecognized/forged value renders as "Other",
// same rule as roleLabel() above.
Deno.test("partnerIndustryLabel: known industries map from the gh-914 single source, absent industry is null", () => {
  assertStrictEquals(partnerIndustryLabel("re_agent"), "Real Estate Agent");
  assertStrictEquals(partnerIndustryLabel("insurance_agent"), "Insurance Agent");
  assertStrictEquals(partnerIndustryLabel("home_inspector"), "Home Inspector");
  assertStrictEquals(partnerIndustryLabel("adjuster"), "Insurance Adjuster");
  assertStrictEquals(partnerIndustryLabel("other"), "Other");
  assertStrictEquals(partnerIndustryLabel(null), null);
  assertStrictEquals(partnerIndustryLabel(undefined), null);
});

Deno.test("partnerIndustryLabel: an unrecognized/forged value (incl. 'customer', which leads_partner_industry_check disallows) renders as Other, never raw", () => {
  assertStrictEquals(partnerIndustryLabel("customer"), "Other");
  assertStrictEquals(partnerIndustryLabel("<script>alert(1)</script>"), "Other");
  assertStrictEquals(partnerIndustryLabel("re_agent\r\nBcc: victim@example.com"), "Other");
});

// ---------------------------------------------------------------------------
// stripCrlf / isRouterLeadAuthorized (gh-1994 fix round 1, REVIEW B1)
// ---------------------------------------------------------------------------

Deno.test("stripCrlf: removes CR and LF, collapsing them to a space", () => {
  assertStrictEquals(stripCrlf("homeowner\r\nBcc: victim@example.com"), "homeowner Bcc: victim@example.com");
  assertStrictEquals(stripCrlf("a\nb\rc\r\nd"), "a b c d");
  assertStrictEquals(stripCrlf("clean"), "clean");
  assertStrictEquals(stripCrlf(null as unknown as string), "");
});

Deno.test("isRouterLeadAuthorized: only the exact service-role key authorizes; anon does not", () => {
  const SERVICE = "service-role-secret";
  const ANON = "anon-public-key";
  assertStrictEquals(isRouterLeadAuthorized(SERVICE, SERVICE), true);
  assertStrictEquals(isRouterLeadAuthorized(ANON, SERVICE), false, "anon key must be rejected (401)");
  assertStrictEquals(isRouterLeadAuthorized("", SERVICE), false, "no bearer token must be rejected");
  assertStrictEquals(isRouterLeadAuthorized(SERVICE, ""), false, "an empty configured service key must never match");
});

Deno.test("buildAttributionSource: lists only present fields", () => {
  const source = buildAttributionSource({
    utm_source: "fb",
    utm_campaign: "roofsale",
    fbclid: "abc123",
  });
  assertStrictEquals(source, "utm_source=fb, utm_campaign=roofsale, fbclid present");
});

Deno.test("buildAttributionSource: no attribution present -> explicit direct label, never empty string", () => {
  assertStrictEquals(buildAttributionSource({}), "Direct / no attribution");
});

// ---------------------------------------------------------------------------
// buildRouterLeadSubjectAndText
// ---------------------------------------------------------------------------

Deno.test("buildRouterLeadSubjectAndText: subject names the role", () => {
  const { subject } = buildRouterLeadSubjectAndText({ role: "homeowner" });
  assertStrictEquals(subject, "[OtterQuote] New router lead: Homeowner");

  const { subject: subject2 } = buildRouterLeadSubjectAndText({ role: "referral_partner" });
  assertStrictEquals(subject2, "[OtterQuote] New router lead: Referral partner");
});

Deno.test("buildRouterLeadSubjectAndText: phone is shown AS-IS, never masked", () => {
  const { textBody } = buildRouterLeadSubjectAndText({
    name: "Jane Homeowner",
    email: "jane@example.com",
    phone: "5125551234",
    role: "homeowner",
  });
  assert(textBody.includes("5125551234"), "raw phone digits must appear verbatim");
  assert(!textBody.includes("***"), "phone must not be masked like maskEmail() masks email elsewhere in this file");
  assert(textBody.includes("callback only"), "must state phone carries no consent, per Dustin's GO comment scope limit");
});

Deno.test("buildRouterLeadSubjectAndText: includes partner industry only when present", () => {
  const withIndustry = buildRouterLeadSubjectAndText({ role: "referral_partner", partner_industry: "re_agent" });
  assert(withIndustry.textBody.includes("Industry"));
  assert(withIndustry.textBody.includes("Real Estate Agent"));

  const withoutIndustry = buildRouterLeadSubjectAndText({ role: "homeowner" });
  assert(!withoutIndustry.textBody.includes("Industry"));
});

Deno.test("buildRouterLeadSubjectAndText: missing fields fall back to explicit placeholders, never throw", () => {
  const { textBody } = buildRouterLeadSubjectAndText({});
  assert(textBody.includes("(no name given)"));
  assert(textBody.includes("(no email)"));
  assert(textBody.includes("(no phone)"));
  assert(textBody.includes("Role       : Other"), "a missing role must render the fixed 'Other' label, not a placeholder string");
});

Deno.test("buildRouterLeadSubjectAndText: CRLF injection in role is neutralized in the subject (REVIEW B1 repro)", () => {
  // Reproduces the exact attack string from REVIEW 5707519022 B1's evidence.
  // Even though leads_role_check should make this DB-unreachable, this
  // function must not assume that -- it renders directly from whatever
  // object it is given.
  const forgedRole = "homeowner\r\nBcc: victim@example.com";
  const { subject } = buildRouterLeadSubjectAndText({ role: forgedRole });
  assert(!subject.includes("\r") && !subject.includes("\n"), "subject must contain no CR/LF");
  assert(!subject.includes("Bcc:"), "forged header must not survive into the subject");
  assertStrictEquals(subject, "[OtterQuote] New router lead: Other");
});

// ---------------------------------------------------------------------------
// buildAttributionSource — utm_* length cap (gh-1994 fix round 1, REVIEW N3)
// ---------------------------------------------------------------------------

Deno.test("buildAttributionSource: caps each utm_* value at UTM_MAX_LEN characters", () => {
  const longValue = "x".repeat(UTM_MAX_LEN + 50);
  const source = buildAttributionSource({ utm_source: longValue });
  const utmPart = source.split(", ").find((p) => p.startsWith("utm_source="))!;
  const rendered = utmPart.slice("utm_source=".length);
  assert(rendered.length < longValue.length, "long utm value must be truncated");
  assert(rendered.startsWith("x".repeat(UTM_MAX_LEN)), "must keep the first UTM_MAX_LEN characters");
  assert(rendered.includes("truncated"), "truncation must be visibly marked, not silent");
});

Deno.test("buildAttributionSource: a value at or under UTM_MAX_LEN is not touched", () => {
  const exact = "x".repeat(UTM_MAX_LEN);
  const source = buildAttributionSource({ utm_source: exact });
  assertStrictEquals(source, `utm_source=${exact}`);
});

// ---------------------------------------------------------------------------
// buildRouterLeadEmail — renders ONLY from the row it is given (gh-1994 fix
// round 1, REVIEW B1/N6): the closest a pure-function test can get to
// proving "forged request-body fields are ignored", since the actual
// enforcement (index.ts's handleRouterLead reads only `record.id` from the
// request and passes this function the database RETURNING row, never the
// request body) lives in index.ts, which cannot be imported under
// `deno test` (see file header). This test proves the render step itself:
// given a row shaped exactly like the claim query's RETURNING result, only
// those named fields are read.
// ---------------------------------------------------------------------------

Deno.test("buildRouterLeadEmail: renders name/email/phone/role/industry/attribution from the row, HTML-escaped", () => {
  const leadRow = {
    name: `<script>alert(1)</script>`,
    email: "jane@example.com",
    phone: "5125551234",
    role: "referral_partner",
    partner_industry: "re_agent",
    utm_source: "fb",
  };
  const result = buildRouterLeadEmail(leadRow);
  assertStrictEquals(result.subject, "[OtterQuote] New router lead: Referral partner");
  assert(result.textBody.includes("5125551234"), "phone must appear unmasked in the plain-text body");

  const nameRow = result.htmlRows.find(([label]) => label === "Name");
  assert(nameRow, "Name row must be present");
  assert(!nameRow![1].includes("<script>"), "raw <script> must not survive into the HTML row");
  assert(nameRow![1].includes("&lt;script&gt;"), "must be HTML-escaped");

  const industryRow = result.htmlRows.find(([label]) => label === "Industry");
  assertStrictEquals(industryRow?.[1], "Real Estate Agent");
});

Deno.test("buildRouterLeadEmail: extra/unknown keys on the row (a stand-in for forged request-body fields) are ignored", () => {
  const leadRow = {
    name: "Jane Homeowner",
    email: "jane@example.com",
    phone: "5125551234",
    role: "homeowner",
    // Fields that only exist in an attacker-controlled request body, never
    // in the claim query's RETURNING list -- must have no effect on output.
    id: "attacker-supplied-id",
    subject_override: "FREE MONEY",
    admin_dashboard_url: "http://phish.example",
  };
  const result = buildRouterLeadEmail(leadRow);
  assertStrictEquals(result.subject, "[OtterQuote] New router lead: Homeowner");
  assert(!result.textBody.includes("FREE MONEY"));
  assert(!result.textBody.includes("phish.example"));
  assert(!result.htmlRows.some(([, v]) => v.includes("phish.example")));
});

Deno.test("buildRouterLeadEmail: a CRLF-shaped forged role does not reach the subject (REVIEW B1 repro, end to end)", () => {
  const leadRow = { role: "homeowner\r\nBcc: victim@example.com", email: "x@example.com" };
  const result = buildRouterLeadEmail(leadRow);
  assert(!result.subject.includes("\r") && !result.subject.includes("\n"));
  assert(!result.subject.includes("Bcc:"));
});

Deno.test("buildRouterLeadSubjectAndText: is pure — identical input produces identical output", () => {
  const record = { name: "Jane", email: "jane@example.com", phone: "5125551234", role: "homeowner" };
  const a = buildRouterLeadSubjectAndText(record);
  const b = buildRouterLeadSubjectAndText(record);
  assertEquals(a, b);
});
