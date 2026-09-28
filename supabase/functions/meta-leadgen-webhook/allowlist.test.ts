// gh-2154 P-5 — allowlist.ts tests.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { lookupForm, parseAllowlist } from "./allowlist.ts";

const RAW = JSON.stringify({
  "form_real_123": { agent_type: "re_agent", funnel_id: "meta-leadgen-re-2026" },
  "form_test_456": { agent_type: "insurance_agent", funnel_id: "meta-leadgen-test", is_test: true },
  "form_bad_agent_type": { agent_type: "not_a_real_type", funnel_id: "x" },
  "form_missing_funnel": { agent_type: "re_agent" },
});

Deno.test("parseAllowlist: valid entries parse with is_test defaulting false", () => {
  const al = parseAllowlist(RAW);
  assertEquals(al["form_real_123"], { agentType: "re_agent", funnelId: "meta-leadgen-re-2026", isTest: false });
});

Deno.test("parseAllowlist: is_test:true entries are preserved", () => {
  const al = parseAllowlist(RAW);
  assertEquals(al["form_test_456"], { agentType: "insurance_agent", funnelId: "meta-leadgen-test", isTest: true });
});

Deno.test("parseAllowlist: an invalid agent_type entry is dropped", () => {
  const al = parseAllowlist(RAW);
  assertEquals(al["form_bad_agent_type"], undefined);
});

Deno.test("parseAllowlist: an entry missing funnel_id is dropped", () => {
  const al = parseAllowlist(RAW);
  assertEquals(al["form_missing_funnel"], undefined);
});

Deno.test("parseAllowlist: unset env var yields an empty allowlist", () => {
  assertEquals(parseAllowlist(undefined), {});
});

Deno.test("parseAllowlist: malformed JSON yields an empty allowlist, does not throw", () => {
  assertEquals(parseAllowlist("{not json"), {});
});

Deno.test("parseAllowlist: a JSON array (not an object) yields an empty allowlist", () => {
  assertEquals(parseAllowlist("[1,2,3]"), {});
});

Deno.test("lookupForm: a non-allowlisted form_id returns null (the homeowner-path / #2123 case)", () => {
  const al = parseAllowlist(RAW);
  assertEquals(lookupForm(al, "some_homeowner_form_999"), null);
});

Deno.test("lookupForm: a null/undefined form_id returns null", () => {
  const al = parseAllowlist(RAW);
  assertEquals(lookupForm(al, null), null);
  assertEquals(lookupForm(al, undefined), null);
});
