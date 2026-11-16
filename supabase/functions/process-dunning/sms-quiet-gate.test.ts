// gh-3762 (child of gate #3726 item 5): process-dunning (cron, every 30 min) skips contractor SMS outside 08:00-21:00 local.
// Run: deno test --allow-read=supabase/functions supabase/functions/process-dunning/sms-quiet-gate.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { quietHoursPhones } from "./sms-quiet-gate.ts";

const ET = { timezone: "America/New_York", state: "OH" };
const PHONES = ["+13175550123", "+13175550124"];

Deno.test("NEGATIVE CONTROL: at 22:00 local the phone list is emptied (nothing reaches Twilio); at 10:00 local it is untouched", () => {
  const logs: string[] = [];
  assertEquals(quietHoursPhones(PHONES, ET, { now: new Date("2026-11-16T03:00:00Z"), contractorId: "c1", log: (l) => logs.push(l) }), []); // 22:00 EST
  assertEquals(logs.length, 1);
  assert(logs[0].includes("sms_quiet_hours_skipped") && logs[0].includes("2026-11-16T13:00:00.000Z") && logs[0].includes("not retried"));
  assert(!logs[0].includes("5550123")); // no phone numbers in the log
  assertEquals(quietHoursPhones(PHONES, ET, { now: new Date("2026-11-15T15:00:00Z"), log: (l) => logs.push(l) }), PHONES); // 10:00 EST
  assertEquals(logs.length, 1);
});

Deno.test("skip-until-window holds for the */30 cron: across one day of runs the list is non-empty exactly 08:00..20:30 local (26 runs)", () => {
  let open = 0;
  for (let m = 0; m < 24 * 60; m += 30) {
    const now = new Date(Date.UTC(2026, 10, 15, 5, m)); // 00:00 EST onward, every 30 minutes
    if (quietHoursPhones(PHONES, ET, { now, log: () => {} }).length > 0) open++;
  }
  assertEquals(open, 26);
});

Deno.test("an empty list stays empty without logging; a missing timezone/state uses the restrictive window", () => {
  const logs: string[] = [];
  assertEquals(quietHoursPhones([], ET, { now: new Date("2026-11-16T03:00:00Z"), log: (l) => logs.push(l) }), []);
  assertEquals(logs.length, 0);
  assertEquals(quietHoursPhones(PHONES, {}, { now: new Date("2026-11-15T15:00:00Z"), log: () => {} }), []);   // 10:00 ET
  assertEquals(quietHoursPhones(PHONES, {}, { now: new Date("2026-11-15T19:00:00Z"), log: () => {} }), PHONES); // 14:00 ET
});

Deno.test("source pin: the gate sits in getContractorContacts after the lookup, uses the contractor's own timezone + state, and the joined selects carry them", async () => {
  const raw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
  const look = src.indexOf("resolveContractorTextableNumbers(supabase");
  const gate = src.indexOf("phones = quietHoursPhones(phones,");
  const ret = src.indexOf("return { emails, phones };", gate);
  assert(look > 0 && gate > look && ret > gate, `order ${look} ${gate} ${ret}`);
  assert(/quietHoursPhones\(phones,\s*\{\s*timezone: contractor\.timezone \?\? null,\s*state: contractor\.address_state \?\? null\s*\}/.test(src));
  assert(/contractors:contractor_id \(id, company_name, email, notification_emails, user_id, is_test, timezone, address_state\)/.test(src));
  assert(/user_id, timezone, address_state, is_test/.test(src));
});
