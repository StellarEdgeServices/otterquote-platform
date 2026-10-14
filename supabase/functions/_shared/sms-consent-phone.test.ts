// gh-1916 / D-383: contractor SMS goes only to the phone on the account at consent.
// Run: deno test --allow-read=supabase/functions supabase/functions/_shared/sms-consent-phone.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { consentedSmsPhone, consentedSmsRecipients, phoneDigits } from "./sms-consent-phone.ts";

Deno.test("phoneDigits: NANP forms collapse to 10 digits, junk is null", () => {
  assertEquals(phoneDigits("(317) 965-3288"), "3179653288");
  assertEquals(phoneDigits("+1 317-965-3288"), "3179653288");
  assertEquals(phoneDigits("13179653288"), "3179653288");
  assertEquals(phoneDigits("965-3288"), null);
  assertEquals(phoneDigits(""), null);
  assertEquals(phoneDigits(null), null);
  assertEquals(phoneDigits(3179653288), null);
});

Deno.test("consented number is the only recipient, in E.164", () => {
  assertEquals(consentedSmsRecipients({ sms_consent_phone: "(317) 965-3288" }), ["+13179653288"]);
  assertEquals(consentedSmsPhone({ sms_consent_phone: "317.965.3288" }), "+13179653288");
});

Deno.test("NEGATIVE CONTROL: no consented number -> no recipient (fail closed), whatever else the row holds", () => {
  const legacy = { sms_opt_in: true, phone: "3175550100", notification_phones: ["3175550111"], sms_consent_phone: null };
  assertEquals(consentedSmsRecipients(legacy), []);
  assertEquals(consentedSmsRecipients({}), []);
  assertEquals(consentedSmsRecipients(null), []);
  assertEquals(consentedSmsRecipients({ sms_consent_phone: "not a phone" }), []);
});

Deno.test("a number added later (notification_phones / changed phone) is never returned", () => {
  const row = { sms_consent_phone: "3175550100", phone: "3175550222", notification_phones: ["3175550333"] };
  const out = consentedSmsRecipients(row);
  assertEquals(out, ["+13175550100"]);
  assert(!out.includes("+13175550333") && !out.includes("+13175550222"));
});
