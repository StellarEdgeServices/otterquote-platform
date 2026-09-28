// gh-2313 -- partner-consent.ts unit tests (pure functions, no network, no database).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAllowlist } from "./allowlist.ts";
import { buildPartnerConsentArgs, PARTNER_CONSENT_KEY } from "./partner-consent.ts";

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

Deno.test("buildPartnerConsentArgs: missing / null / non-array responses -> not_given (fails closed)", () => {
  for (const resp of [undefined, null, "yes", {}, []]) {
    // deno-lint-ignore no-explicit-any
    const r = buildPartnerConsentArgs({ field_data: FD, custom_disclaimer_responses: resp as any }, CFG, "f", "l");
    assertEquals(r.status, "not_given", `responses=${JSON.stringify(resp)}`);
  }
});

Deno.test("buildPartnerConsentArgs: unticked, or is_checked missing -> not_given", () => {
  assertEquals(
    buildPartnerConsentArgs({ field_data: FD, custom_disclaimer_responses: [{ id: "box_1", is_checked: false }] }, CFG, "f", "l").status,
    "not_given",
  );
  assertEquals(
    buildPartnerConsentArgs({ field_data: FD, custom_disclaimer_responses: [{ id: "box_1" }] }, CFG, "f", "l").status,
    "not_given",
  );
});

Deno.test("buildPartnerConsentArgs: config without consentKey or consentText -> config_missing, even if a box is ticked", () => {
  const ticked = { field_data: FD, custom_disclaimer_responses: [{ id: "box_1", is_checked: true }] };
  assertEquals(buildPartnerConsentArgs(ticked, { ...CFG, consentKey: undefined }, "f", "l").status, "config_missing");
  assertEquals(buildPartnerConsentArgs(ticked, { ...CFG, consentText: undefined }, "f", "l").status, "config_missing");
});

Deno.test("parseAllowlist (gh-2313): consent_key + consent_text are parsed, trimmed and capped at 2000", () => {
  const long = "x".repeat(2500);
  const al = parseAllowlist(JSON.stringify({
    f1: { agent_type: "re_agent", funnel_id: "a", consent_key: "  k  ", consent_text: `  ${long}  ` },
  }));
  assertEquals(al["f1"].consentKey, "k");
  assertEquals(al["f1"].consentText?.length, 2000);
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
