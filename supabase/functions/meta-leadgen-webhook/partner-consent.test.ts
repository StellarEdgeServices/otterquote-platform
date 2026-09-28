// gh-2313 -- partner-consent.ts unit tests (pure functions, no network, no database).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAllowlist } from "./allowlist.ts";
import {
  buildPartnerConsentArgs,
  getPartnerConsentBoxState,
  parseIsChecked,
  PARTNER_CONSENT_KEY,
} from "./partner-consent.ts";

const CFG = {
  agentType: "re_agent",
  funnelId: "meta-leadgen-re-2026",
  isTest: false,
  consentKey: "box_1",
  consentText: "TEST FIXTURE ONLY wording",
};
const FD = [
  { name: "full_name", values: ["Jamie Rivera"] },
  { name: "email", values: ["jamie@example.com"] },
  { name: "phone_number", values: ["(317) 555-1234"] },
];

Deno.test("PARTNER_CONSENT_KEY is the ruled evidence key", () => {
  assertEquals(PARTNER_CONSENT_KEY, "partner_call_text_consent");
});

Deno.test("buildPartnerConsentArgs: ticked box (matched by id) -> ok, wording taken from config, phone as typed", () => {
  const r = buildPartnerConsentArgs(
    { field_data: FD, custom_disclaimer_responses: [{ id: "box_1", is_checked: true }] }, CFG, "form_x", "lead_x",
  );
  assertEquals(r.status, "ok");
  if (r.status === "ok") {
    assertEquals(r.args.consentKey, "partner_call_text_consent");
    assertEquals(r.args.consentText, "TEST FIXTURE ONLY wording");
    assertEquals(r.args.phoneAsTyped, "(317) 555-1234");
    assertEquals(r.args.formId, "form_x");
    assertEquals(r.args.leadgenId, "lead_x");
  }
});

Deno.test("buildPartnerConsentArgs: ticked box matched by name also counts", () => {
  const r = buildPartnerConsentArgs(
    { field_data: FD, custom_disclaimer_responses: [{ name: "box_1", is_checked: true }] }, CFG, "f", "l",
  );
  assertEquals(r.status, "ok");
});

Deno.test("buildPartnerConsentArgs: Meta's REAL shape {checkbox_key, is_checked:\"1\"} -> ok, consentGiven true", () => {
  const r = buildPartnerConsentArgs(
    { field_data: FD, custom_disclaimer_responses: [{ checkbox_key: "box_1", is_checked: "1" }] }, CFG, "f", "l",
  );
  assertEquals(r.status, "ok");
  if (r.status === "ok") {
    assertEquals(r.args.consentGiven, true);
    assertEquals(r.args.disclaimerResponses, [{ checkbox_key: "box_1", is_checked: "1" }]);
  }
});

Deno.test("buildPartnerConsentArgs: Meta's real shape with is_checked \"0\" -> ok row, consentGiven FALSE (present but unticked)", () => {
  const r = buildPartnerConsentArgs(
    { field_data: FD, custom_disclaimer_responses: [{ checkbox_key: "box_1", is_checked: "0" }] }, CFG, "f", "l",
  );
  assertEquals(r.status, "ok");
  if (r.status === "ok") assertEquals(r.args.consentGiven, false);
});

Deno.test("parseIsChecked: \"1\"/true/1 are ticked; \"0\"/false/0/absent/garbage are not (negative control)", () => {
  for (const v of ["1", true, 1]) assertEquals(parseIsChecked(v), true, `v=${JSON.stringify(v)}`);
  for (const v of ["0", false, 0, undefined, null, "", "true", "yes", "on", {}, []]) {
    assertEquals(parseIsChecked(v), false, `v=${JSON.stringify(v)}`);
  }
});

Deno.test("getPartnerConsentBoxState: ticked / unticked / absent across shapes", () => {
  assertEquals(getPartnerConsentBoxState([{ checkbox_key: "k", is_checked: "1" }], "k"), "ticked");
  assertEquals(getPartnerConsentBoxState([{ checkbox_key: "k", is_checked: true }], "k"), "ticked");
  assertEquals(getPartnerConsentBoxState([{ checkbox_key: "k", is_checked: "0" }], "k"), "unticked");
  assertEquals(getPartnerConsentBoxState([{ checkbox_key: "k", is_checked: false }], "k"), "unticked");
  assertEquals(getPartnerConsentBoxState([{ checkbox_key: "k" }], "k"), "unticked");
  // negative controls: a different key, and a non-array, are ABSENT (never ticked)
  assertEquals(getPartnerConsentBoxState([{ checkbox_key: "other", is_checked: "1" }], "k"), "absent");
  for (const resp of [undefined, null, "yes", {}, []]) {
    // deno-lint-ignore no-explicit-any
    assertEquals(getPartnerConsentBoxState(resp as any, "k"), "absent", `responses=${JSON.stringify(resp)}`);
  }
});

Deno.test("buildPartnerConsentArgs: missing / null / non-array responses, or a different box -> no_box (register, no row)", () => {
  for (const resp of [undefined, null, "yes", {}, [], [{ checkbox_key: "other", is_checked: "1" }]]) {
    // deno-lint-ignore no-explicit-any
    const r = buildPartnerConsentArgs({ field_data: FD, custom_disclaimer_responses: resp as any }, CFG, "f", "l");
    assertEquals(r.status, "no_box", `responses=${JSON.stringify(resp)}`);
  }
});

Deno.test("buildPartnerConsentArgs: unticked box (false, \"0\", or is_checked missing) -> ok with consentGiven false", () => {
  for (const entry of [{ id: "box_1", is_checked: false }, { checkbox_key: "box_1", is_checked: "0" }, { id: "box_1" }]) {
    const r = buildPartnerConsentArgs({ field_data: FD, custom_disclaimer_responses: [entry] }, CFG, "f", "l");
    assertEquals(r.status, "ok");
    if (r.status === "ok") assertEquals(r.args.consentGiven, false);
  }
});

Deno.test("buildPartnerConsentArgs: consent text over 2000 chars -> text_too_long, never truncated", () => {
  const long = "x".repeat(2001);
  const ticked = { field_data: FD, custom_disclaimer_responses: [{ checkbox_key: "box_1", is_checked: "1" }] };
  const r = buildPartnerConsentArgs(ticked, { ...CFG, consentText: long }, "f", "l");
  assertEquals(r.status, "text_too_long");
  // exactly 2000 is fine (boundary negative control)
  assertEquals(buildPartnerConsentArgs(ticked, { ...CFG, consentText: "x".repeat(2000) }, "f", "l").status, "ok");
});

Deno.test("buildPartnerConsentArgs: config without consentKey or consentText -> config_missing, even if a box is ticked", () => {
  const ticked = { field_data: FD, custom_disclaimer_responses: [{ id: "box_1", is_checked: true }] };
  assertEquals(buildPartnerConsentArgs(ticked, { ...CFG, consentKey: undefined }, "f", "l").status, "config_missing");
  assertEquals(buildPartnerConsentArgs(ticked, { ...CFG, consentText: undefined }, "f", "l").status, "config_missing");
});

Deno.test("parseAllowlist (gh-2313): consent_key + consent_text are parsed and trimmed; exactly 2000 chars is kept whole", () => {
  const exact = "x".repeat(2000);
  const al = parseAllowlist(JSON.stringify({
    f1: { agent_type: "re_agent", funnel_id: "a", consent_key: "  k  ", consent_text: `  ${exact}  ` },
  }));
  assertEquals(al["f1"].consentKey, "k");
  assertEquals(al["f1"].consentText, exact);
  assertEquals(al["f1"].consentTextTooLong, undefined);
});

Deno.test("parseAllowlist (gh-2313): consent_text over 2000 chars is REJECTED (flagged, no wording kept), not truncated; entry still parses", () => {
  const al = parseAllowlist(JSON.stringify({
    f1: { agent_type: "re_agent", funnel_id: "a", consent_key: "k", consent_text: "x".repeat(2001) },
  }));
  assert(al["f1"], "the form itself must still register partners");
  assertEquals(al["f1"].consentTextTooLong, 2001);
  assertEquals(al["f1"].consentText, undefined, "over-long wording must not be stored, sliced or otherwise");
  assertEquals(al["f1"].consentKey, undefined);
});

Deno.test("parseAllowlist (gh-2313): a half-configured entry (key without text) carries NO consent config; the entry still parses", () => {
  const al = parseAllowlist(JSON.stringify({
    f1: { agent_type: "re_agent", funnel_id: "a", consent_key: "k" },
    f2: { agent_type: "re_agent", funnel_id: "a", consent_text: "t" },
  }));
  assert(al["f1"] && al["f2"]);
  assertEquals(al["f1"].consentKey, undefined);
  assertEquals(al["f2"].consentText, undefined);
});
