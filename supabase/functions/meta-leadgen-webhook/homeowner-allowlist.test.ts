// gh-2154 P-5 / #2123 (HO-2) — homeowner-allowlist.ts tests, same convention
// as allowlist.test.ts. Run: deno test --allow-read=supabase/functions
// supabase/functions/meta-leadgen-webhook/
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseHomeownerAllowlist, lookupHomeownerForm } from "./homeowner-allowlist.ts";

const CONSENT = {
  consent_key: "ho2_call_consent",
  consent_text: "By checking this box I agree Otter Quotes and a matched contractor may call/text me.",
  privacy_url: "https://otterquote.com/privacy.html",
};

function withConsent(extra: Record<string, unknown> = {}) {
  return { funnel_id: "ho-2", ...CONSENT, ...extra };
}

Deno.test("parseHomeownerAllowlist: undefined/empty -> {}", () => {
  assertEquals(parseHomeownerAllowlist(undefined), {});
  assertEquals(parseHomeownerAllowlist(""), {});
});

Deno.test("parseHomeownerAllowlist: malformed JSON -> {} (fails closed, never throws)", () => {
  assertEquals(parseHomeownerAllowlist("{not json"), {});
});

Deno.test("parseHomeownerAllowlist: non-object top level -> {}", () => {
  assertEquals(parseHomeownerAllowlist("[1,2,3]"), {});
  assertEquals(parseHomeownerAllowlist('"a string"'), {});
});

Deno.test("parseHomeownerAllowlist: valid entry parses funnel_id + consent fields, defaults is_test to false", () => {
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: withConsent() }));
  assertEquals(out, {
    form_1: {
      funnelId: "ho-2",
      isTest: false,
      consentKey: CONSENT.consent_key,
      consentText: CONSENT.consent_text,
      privacyUrl: CONSENT.privacy_url,
    },
  });
});

Deno.test("parseHomeownerAllowlist: is_test:true is honored", () => {
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: withConsent({ is_test: true }) }));
  assertEquals(out.form_1.isTest, true);
});

Deno.test("parseHomeownerAllowlist: entry missing funnel_id is dropped", () => {
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: { ...CONSENT } }));
  assertEquals(out, {});
});

Deno.test("parseHomeownerAllowlist: entry with empty-string funnel_id is dropped", () => {
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: withConsent({ funnel_id: "   " }) }));
  assertEquals(out, {});
});

// REVIEW FAIL 5849223003 defect 4/5 — D-299/D-332 config contract.

Deno.test("parseHomeownerAllowlist: entry missing consent_key is dropped and logged as a config error", () => {
  const logs: string[] = [];
  const { consent_key: _drop, ...rest } = withConsent();
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: rest }), (m) => logs.push(m));
  assertEquals(out, {});
  assertEquals(logs.length, 1);
  assertEquals(logs[0].includes("form_1"), true);
});

Deno.test("parseHomeownerAllowlist: entry missing consent_text is dropped", () => {
  const { consent_text: _drop, ...rest } = withConsent();
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: rest }));
  assertEquals(out, {});
});

Deno.test("parseHomeownerAllowlist: entry missing privacy_url is dropped", () => {
  const { privacy_url: _drop, ...rest } = withConsent();
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: rest }));
  assertEquals(out, {});
});

Deno.test("parseHomeownerAllowlist: entry with blank consent_text is dropped", () => {
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: withConsent({ consent_text: "   " }) }));
  assertEquals(out, {});
});

Deno.test("parseHomeownerAllowlist: a fully valid entry produces no log calls", () => {
  const logs: string[] = [];
  parseHomeownerAllowlist(JSON.stringify({ form_1: withConsent() }), (m) => logs.push(m));
  assertEquals(logs.length, 0);
});

Deno.test("lookupHomeownerForm: known form_id returns its config", () => {
  const list = parseHomeownerAllowlist(JSON.stringify({ form_1: withConsent() }));
  assertEquals(lookupHomeownerForm(list, "form_1")?.funnelId, "ho-2");
});

Deno.test("lookupHomeownerForm: unknown/null/undefined form_id returns null", () => {
  const list = parseHomeownerAllowlist(JSON.stringify({ form_1: withConsent() }));
  assertEquals(lookupHomeownerForm(list, "form_2"), null);
  assertEquals(lookupHomeownerForm(list, null), null);
  assertEquals(lookupHomeownerForm(list, undefined), null);
});
