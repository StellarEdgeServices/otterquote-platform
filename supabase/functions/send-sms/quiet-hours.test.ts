// gh-3762 (child of gate #3726 item 5): send-sms wiring pins for the quiet-hours guard.
// Run: deno test --allow-read=supabase/functions supabase/functions/send-sms/quiet-hours.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { OWNER_ALERT_NUMBER_E164 } from "../_shared/sms-quiet-hours.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

Deno.test("send-sms checks quiet hours after the suppression check and BEFORE the rate limit and the Twilio request", async () => {
  const src = await read("./index.ts");
  const supp = src.indexOf("smsSuppressionRefusal(");
  const quiet = src.indexOf("quietHoursRefusal(");
  const rate = src.indexOf('"check_rate_limit"');
  const twilio = src.indexOf("api.twilio.com/2010-04-01/Accounts/");
  assert(supp > 0 && quiet > supp && rate > quiet && twilio > rate, `order ${supp} ${quiet} ${rate} ${twilio}`);
  assert(/if \(quietRefusal\) return quietRefusal;/.test(src));
  // No request field can bypass: the handler destructures only to / message / notification_id.
  assert(src.includes("const { to, message, notification_id } = await req.json();"));
});

Deno.test("the owner exemption constant matches the owner-alert literal in send-contractor-nudge", async () => {
  const nudge = await read("../send-contractor-nudge/index.ts");
  const m = nudge.match(/const DUSTIN_ALERT_PHONE = "([^"]+)";/);
  assert(m);
  assertEquals(m![1], OWNER_ALERT_NUMBER_E164);
});

Deno.test("the owner number is not hard-coded anywhere else in send-sms / the quiet-hours module (one named constant)", async () => {
  const mod = await read("../_shared/sms-quiet-hours.ts");
  assertEquals((mod.match(/\+13175019215/g) ?? []).length, 1); // the constant only
  const sms = await read("./index.ts");
  assert(!sms.includes("3175019215"));
});
