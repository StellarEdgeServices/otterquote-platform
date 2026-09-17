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

Deno.test("roleLabel: known roles map to display labels; unknown passes through", () => {
  assertStrictEquals(roleLabel("homeowner"), "Homeowner");
  assertStrictEquals(roleLabel("contractor"), "Contractor");
  assertStrictEquals(roleLabel("referral_partner"), "Referral partner");
  assertStrictEquals(roleLabel("something_new"), "something_new");
  assertStrictEquals(roleLabel(null), "(no role)");
});

Deno.test("partnerIndustryLabel: known industries map, absent industry is null", () => {
  assertStrictEquals(partnerIndustryLabel("re_agent"), "Real estate agent");
  assertStrictEquals(partnerIndustryLabel("adjuster"), "Insurance adjuster");
  assertStrictEquals(partnerIndustryLabel(null), null);
  assertStrictEquals(partnerIndustryLabel(undefined), null);
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
  assert(withIndustry.textBody.includes("Real estate agent"));

  const withoutIndustry = buildRouterLeadSubjectAndText({ role: "homeowner" });
  assert(!withoutIndustry.textBody.includes("Industry"));
});

Deno.test("buildRouterLeadSubjectAndText: missing fields fall back to explicit placeholders, never throw", () => {
  const { textBody } = buildRouterLeadSubjectAndText({});
  assert(textBody.includes("(no name given)"));
  assert(textBody.includes("(no email)"));
  assert(textBody.includes("(no phone)"));
  assert(textBody.includes("(no role)"));
});

Deno.test("buildRouterLeadSubjectAndText: is pure — identical input produces identical output", () => {
  const record = { name: "Jane", email: "jane@example.com", phone: "5125551234", role: "homeowner" };
  const a = buildRouterLeadSubjectAndText(record);
  const b = buildRouterLeadSubjectAndText(record);
  assertEquals(a, b);
});
