// gh-2154 P-5 / #2123 (HO-2) — homeowner-allowlist.ts tests, same convention
// as allowlist.test.ts. Run: deno test --allow-read=supabase/functions
// supabase/functions/meta-leadgen-webhook/
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseHomeownerAllowlist, lookupHomeownerForm } from "./homeowner-allowlist.ts";

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

Deno.test("parseHomeownerAllowlist: valid entry parses funnel_id and defaults is_test to false", () => {
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: { funnel_id: "ho-2" } }));
  assertEquals(out, { form_1: { funnelId: "ho-2", isTest: false } });
});

Deno.test("parseHomeownerAllowlist: is_test:true is honored", () => {
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: { funnel_id: "ho-2", is_test: true } }));
  assertEquals(out, { form_1: { funnelId: "ho-2", isTest: true } });
});

Deno.test("parseHomeownerAllowlist: entry missing funnel_id is dropped", () => {
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: { is_test: true } }));
  assertEquals(out, {});
});

Deno.test("parseHomeownerAllowlist: entry with empty-string funnel_id is dropped", () => {
  const out = parseHomeownerAllowlist(JSON.stringify({ form_1: { funnel_id: "   " } }));
  assertEquals(out, {});
});

Deno.test("lookupHomeownerForm: known form_id returns its config", () => {
  const list = parseHomeownerAllowlist(JSON.stringify({ form_1: { funnel_id: "ho-2" } }));
  assertEquals(lookupHomeownerForm(list, "form_1"), { funnelId: "ho-2", isTest: false });
});

Deno.test("lookupHomeownerForm: unknown/null/undefined form_id returns null", () => {
  const list = parseHomeownerAllowlist(JSON.stringify({ form_1: { funnel_id: "ho-2" } }));
  assertEquals(lookupHomeownerForm(list, "form_2"), null);
  assertEquals(lookupHomeownerForm(list, null), null);
  assertEquals(lookupHomeownerForm(list, undefined), null);
});
