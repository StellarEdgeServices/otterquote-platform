// #2123 HO-2 fix round (REVIEW FAIL 5849223003 defect 4, D-299) —
// homeowner-consent.ts tests. Run: deno test --allow-read=supabase/functions
// supabase/functions/meta-leadgen-webhook/
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildHomeownerConsentArgs, getConsentGiven } from "./homeowner-consent.ts";

const CONSENT_KEY = "ho2_call_consent";
const CONSENT_TEXT = "By checking this box I agree Otter Quotes and a matched contractor may call/text me.";

Deno.test("getConsentGiven: matching id with is_checked:true -> true", () => {
  assertEquals(getConsentGiven([{ id: CONSENT_KEY, is_checked: true }], CONSENT_KEY), true);
});

Deno.test("getConsentGiven: matching id with is_checked:false -> false (still evidence, not dropped)", () => {
  assertEquals(getConsentGiven([{ id: CONSENT_KEY, is_checked: false }], CONSENT_KEY), false);
});

Deno.test("getConsentGiven: matching by name instead of id also works", () => {
  assertEquals(getConsentGiven([{ name: CONSENT_KEY, is_checked: true }], CONSENT_KEY), true);
});

Deno.test("getConsentGiven: no matching entry -> false (fails closed)", () => {
  assertEquals(getConsentGiven([{ id: "some_other_checkbox", is_checked: true }], CONSENT_KEY), false);
});

Deno.test("getConsentGiven: missing custom_disclaimer_responses entirely -> false", () => {
  assertEquals(getConsentGiven(undefined, CONSENT_KEY), false);
  assertEquals(getConsentGiven(null, CONSENT_KEY), false);
});

Deno.test("getConsentGiven: is_checked absent or unrecognised -> false", () => {
  assertEquals(getConsentGiven([{ id: CONSENT_KEY }], CONSENT_KEY), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(getConsentGiven([{ id: CONSENT_KEY, is_checked: "yes" as any }], CONSENT_KEY), false);
});

// #2325: real Meta shape. Key text is the HO-2 checkbox key, identical on forms
// 1078244861764331 and 1714389966848447 (In Flight/reports/ceo78 archives). The
// {checkbox_key, is_checked:"1"} shape is from the Graph read of the live lead
// (leadgen custom_disclaimer_responses, CEO78 ho2form report section 5).
const META_KEY = "i_agree_that_otterquote_/_stellar_edge_services_may_call_or_text_me_at_the_number_above_about_my_roof_assessment,_including_by_autodialer_or_prerecorded/artificial_voice._consent_is_not_a_condition_of_purchase._msg_&_data_rates_may_apply.";
const META_TICKED = [{ checkbox_key: META_KEY, is_checked: "1" }];
const META_UNTICKED = [{ checkbox_key: META_KEY, is_checked: "0" }];

Deno.test("#2325 getConsentGiven: real Meta payload, ticked (checkbox_key + is_checked \"1\") -> true", () => {
  assertEquals(getConsentGiven(META_TICKED, META_KEY), true);
});

Deno.test("#2325 getConsentGiven: real Meta payload, unticked (is_checked \"0\") -> false", () => {
  assertEquals(getConsentGiven(META_UNTICKED, META_KEY), false);
  assertEquals(getConsentGiven([{ checkbox_key: META_KEY, is_checked: false }], META_KEY), false);
});

Deno.test("#2325 getConsentGiven: real Meta payload, checkbox absent from responses -> false", () => {
  assertEquals(getConsentGiven([], META_KEY), false);
  assertEquals(getConsentGiven([{ checkbox_key: "some_other_box", is_checked: "1" }], META_KEY), false);
  assertEquals(getConsentGiven([{ checkbox_key: META_KEY }], META_KEY), false);
});

Deno.test("#2325 getConsentGiven: boolean true and \"true\" also count as ticked", () => {
  assertEquals(getConsentGiven([{ checkbox_key: META_KEY, is_checked: true }], META_KEY), true);
  assertEquals(getConsentGiven([{ checkbox_key: META_KEY, is_checked: "true" }], META_KEY), true);
});

Deno.test("#2325 buildHomeownerConsentArgs: ticked Meta fixture -> consentGiven true", () => {
  const args = buildHomeownerConsentArgs(
    { field_data: [], custom_disclaimer_responses: META_TICKED },
    { consentKey: META_KEY, consentText: CONSENT_TEXT },
    "1714389966848447",
  );
  assertEquals(args.consentGiven, true);
});

Deno.test("buildHomeownerConsentArgs: assembles all fields from the Graph fetch + config", () => {
  const args = buildHomeownerConsentArgs(
    {
      field_data: [
        { name: "full_name", values: ["Pat Homeowner"] },
        { name: "phone_number", values: ["+1 (317) 555-9999"] },
      ],
      custom_disclaimer_responses: [{ id: CONSENT_KEY, is_checked: true }],
      created_time: "2026-09-26T12:00:00+0000",
      ad_id: "ad_1",
      campaign_id: "campaign_1",
    },
    { consentKey: CONSENT_KEY, consentText: CONSENT_TEXT },
    "form_ho2_789",
  );
  assertEquals(args.consentKey, CONSENT_KEY);
  assertEquals(args.consentGiven, true);
  assertEquals(args.consentText, CONSENT_TEXT);
  assertEquals(args.formId, "form_ho2_789");
  assertEquals(args.phoneAsTyped, "+1 (317) 555-9999");
  assertEquals(args.formPayload, { full_name: "Pat Homeowner", phone_number: "+1 (317) 555-9999" });
  assertEquals(args.adId, "ad_1");
  assertEquals(args.campaignId, "campaign_1");
  assertEquals(args.createdTime, "2026-09-26T12:00:00+0000");
});

Deno.test("buildHomeownerConsentArgs: missing ad_id/campaign_id/created_time become null, not undefined", () => {
  const args = buildHomeownerConsentArgs(
    { field_data: [] },
    { consentKey: CONSENT_KEY, consentText: CONSENT_TEXT },
    "form_ho2_789",
  );
  assertEquals(args.adId, null);
  assertEquals(args.campaignId, null);
  assertEquals(args.createdTime, null);
  assertEquals(args.consentGiven, false);
  assertEquals(args.phoneAsTyped, null);
});
