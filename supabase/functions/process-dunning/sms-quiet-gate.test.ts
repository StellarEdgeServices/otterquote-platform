// gh-3762 (child of gate #3726 item 5): process-dunning quiet-hours gate (08:00 <= local < 20:00, Ben's ruling on PR #3774)
// and the pending-text expiry rules. Handler-level behaviour is in sms-quiet-pending.test.ts.
// Run: deno test --allow-read=supabase/functions supabase/functions/process-dunning/sms-quiet-gate.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { pendingTextExpiry, quietHoursPhones } from "./sms-quiet-gate.ts";

const ET = { timezone: "America/New_York", state: "OH" };
const PHONES = ["+13175550123", "+13175550124"];

Deno.test("NEGATIVE CONTROL: at 21:00 local the phone list is emptied and held=true; at 10:00 local it is untouched", () => {
  const logs: string[] = [];
  const closed = quietHoursPhones(PHONES, ET, { now: new Date("2026-11-16T03:00:00Z"), contractorId: "c1", log: (l) => logs.push(l) }); // 22:00 EST
  assertEquals(closed, { phones: [], held: true });
  assertEquals(logs.length, 1);
  assert(logs[0].includes("sms_quiet_hours_held") && logs[0].includes("2026-11-16T13:00:00.000Z"));
  assert(!logs[0].includes("5550123")); // no phone numbers in the log
  assertEquals(quietHoursPhones(PHONES, ET, { now: new Date("2026-11-15T15:00:00Z"), log: (l) => logs.push(l) }), { phones: PHONES, held: false }); // 10:00 EST
  assertEquals(logs.length, 1);
});

Deno.test("an empty list is never 'held' (no number, nothing to defer); a missing timezone/state uses the restrictive window", () => {
  const logs: string[] = [];
  assertEquals(quietHoursPhones([], ET, { now: new Date("2026-11-16T03:00:00Z"), log: (l) => logs.push(l) }), { phones: [], held: false });
  assertEquals(logs.length, 0);
  assertEquals(quietHoursPhones(PHONES, {}, { now: new Date("2026-11-15T15:00:00Z"), log: () => {} }).held, true);   // 10:00 ET
  assertEquals(quietHoursPhones(PHONES, {}, { now: new Date("2026-11-15T19:00:00Z"), log: () => {} }).held, false);  // 14:00 ET
});

const T = (iso: string) => new Date(iso);
const REM = { dunning_status: "active", sms_pending_kind: "reminder", sms_pending_since: "2026-11-16T11:00:00Z", warning_at: "2026-11-17T13:00:00Z", next_reminder_at: "2026-11-16T14:30:00Z", homeowner_notify_at: "2026-11-17T15:00:00Z" };
const WARN = { dunning_status: "warning_sent", sms_pending_kind: "warning", sms_pending_since: "2026-11-16T13:00:00Z", warning_at: "2026-11-16T13:00:00Z", next_reminder_at: null, homeowner_notify_at: "2026-11-16T15:00:00Z" };

Deno.test("pendingTextExpiry: a live reminder and a live warning may still go", () => {
  assertEquals(pendingTextExpiry(REM, T("2026-11-16T14:00:00Z")), null);
  assertEquals(pendingTextExpiry(WARN, T("2026-11-16T14:00:00Z")), null);
});

Deno.test("pendingTextExpiry: 4 hours exactly expires, 3h59m does not", () => {
  assertEquals(pendingTextExpiry({ ...WARN, sms_pending_since: "2026-11-16T10:00:00Z" }, T("2026-11-16T14:00:00Z")), "stale_4h");
  assertEquals(pendingTextExpiry({ ...WARN, sms_pending_since: "2026-11-16T10:01:00Z" }, T("2026-11-16T14:00:00Z")), null);
});

Deno.test("pendingTextExpiry: a reminder dies when the warning is due, the next reminder is due, or the row left 'active'", () => {
  assertEquals(pendingTextExpiry(REM, T("2026-11-16T14:30:00Z")), "next_step");
  assertEquals(pendingTextExpiry({ ...REM, warning_at: "2026-11-16T13:59:00Z" }, T("2026-11-16T14:00:00Z")), "next_step");
  assertEquals(pendingTextExpiry({ ...REM, dunning_status: "warning_sent" }, T("2026-11-16T14:00:00Z")), "next_step");
});

Deno.test("pendingTextExpiry: a warning dies when the homeowner notice is due or the row left 'warning_sent'", () => {
  assertEquals(pendingTextExpiry(WARN, T("2026-11-16T15:00:00Z")), "next_step");
  assertEquals(pendingTextExpiry({ ...WARN, dunning_status: "homeowner_notified" }, T("2026-11-16T14:00:00Z")), "next_step");
});

Deno.test("pendingTextExpiry fails closed: unknown kind or unusable timestamp expires", () => {
  assertEquals(pendingTextExpiry({ ...WARN, sms_pending_kind: "proceed" }, T("2026-11-16T14:00:00Z")), "unknown_kind");
  assertEquals(pendingTextExpiry({ ...WARN, sms_pending_since: null }, T("2026-11-16T14:00:00Z")), "no_since");
  assertEquals(pendingTextExpiry({ ...WARN, sms_pending_since: "garbage" }, T("2026-11-16T14:00:00Z")), "no_since");
  assertEquals(pendingTextExpiry({ ...WARN, homeowner_notify_at: null }, T("2026-11-16T14:00:00Z")), "next_step");
});

Deno.test("source pin: gate in getContractorContacts after the lookup; drain runs before PASS 1; marker rides the state-advance updates", async () => {
  const raw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
  const look = src.indexOf("resolveContractorTextableNumbers(supabase");
  const gate = src.indexOf("const quiet = quietHoursPhones(phones,");
  const ret = src.indexOf("return { emails, phones: quiet.phones, quietHeld: quiet.held };", gate);
  assert(look > 0 && gate > look && ret > gate, `order ${look} ${gate} ${ret}`);
  assert(/quietHoursPhones\(phones,\s*\{\s*timezone: contractor\.timezone \?\? null,\s*state: contractor\.address_state \?\? null\s*\}/.test(src));
  assert(/contractors:contractor_id \(id, company_name, email, notification_emails, user_id, is_test, timezone, address_state\)/.test(src));
  const drain = src.indexOf("await drainPendingDunningSms(supabase, now);");
  assert(drain > 0 && drain < src.indexOf('.eq("dunning_status", "active")', drain), "drain must run before the PASS 1 active-records query");
  assertEquals((src.match(/pendingMarker\(contacts\.quietHeld === true/g) ?? []).length, 2);
  assertEquals((src.match(/await updateFailureWithMarker\(/g) ?? []).length, 3, "all three marker-carrying state advances go through the fail-safe helper");
});
