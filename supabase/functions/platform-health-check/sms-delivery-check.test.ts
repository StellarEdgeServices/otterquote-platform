// Deno unit tests for gh-1825's consecutive-undelivered SMS alarm rule.
// Run: deno test supabase/functions/platform-health-check/sms-delivery-check.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  isFictional555,
  findConsecutiveUndelivered,
  buildSmsAlertMessage,
  type TwilioMessageRow,
} from "./sms-delivery-check.ts";

function msg(sid: string, to: string, status: string, error_code: number | null = null): TwilioMessageRow {
  return { sid, to, status, error_code, date_created: "2026-09-08T00:00:00Z", direction: "outbound-api" };
}

Deno.test("isFictional555: matches the reserved 555 exchange code, not any other digits", () => {
  assertEquals(isFictional555("+15555550100"), true); // 555 exchange
  assertEquals(isFictional555("+15551234567"), false); // 555 is the AREA CODE here, not the exchange -> real
  assertEquals(isFictional555("+13175019215"), false); // gh-1825's real recipient
  assertEquals(isFictional555("not-a-number"), false);
});

Deno.test("findConsecutiveUndelivered: counts only real recipients, 555 rows never break or extend the streak", () => {
  // Interleaved: newest-first, a 555 row sitting between two real undelivered rows
  // must not break the streak and must not count toward it.
  const messages: TwilioMessageRow[] = [
    msg("SM3", "+13175019215", "undelivered", 30032),
    msg("SM2", "+15555550100", "undelivered", 30006), // fictional noise, skipped
    msg("SM1", "+13175019215", "undelivered", 30032),
  ];
  const result = findConsecutiveUndelivered(messages, 2);
  assertEquals(result.consecutiveCount, 2);
  assertEquals(result.fictionalExcluded, 1);
  assertEquals(result.alarmed, true);
  assertEquals(result.streak.map((m) => m.sid), ["SM3", "SM1"]);
});

Deno.test("findConsecutiveUndelivered: streak stops at the first real delivered message", () => {
  const messages: TwilioMessageRow[] = [
    msg("SM3", "+13175019215", "undelivered", 30032),
    msg("SM2", "+13175019215", "delivered", null), // breaks the streak
    msg("SM1", "+13175019215", "undelivered", 30032),
  ];
  const result = findConsecutiveUndelivered(messages, 2);
  assertEquals(result.consecutiveCount, 1);
  assertEquals(result.alarmed, false);
});

Deno.test("findConsecutiveUndelivered: below threshold does not alarm", () => {
  const messages: TwilioMessageRow[] = [
    msg("SM1", "+13175019215", "undelivered", 30032),
  ];
  const result = findConsecutiveUndelivered(messages, 3);
  assertEquals(result.alarmed, false);
  assertEquals(result.consecutiveCount, 1);
});

Deno.test("findConsecutiveUndelivered: an all-555 history alarms nobody (regression guard for the naive implementation)", () => {
  // This is the case a naive "count consecutive undelivered, full stop" rule gets wrong:
  // 23/30 of the account's lifetime history is 555 noise (error 30006). A rule that does
  // not exclude 555 would alarm on synthetic/verification traffic, not real delivery health.
  const messages: TwilioMessageRow[] = [
    msg("SM3", "+15555550100", "undelivered", 30006),
    msg("SM2", "+15555550101", "undelivered", 30006),
    msg("SM1", "+15555550102", "undelivered", 30006),
  ];
  const result = findConsecutiveUndelivered(messages, 3);
  assertEquals(result.consecutiveCount, 0);
  assertEquals(result.fictionalExcluded, 3);
  assertEquals(result.alarmed, false);
});

Deno.test("buildSmsAlertMessage: includes SID, last-4, status, error_code per streak row", () => {
  const messages: TwilioMessageRow[] = [msg("SMabc123", "+13175019215", "undelivered", 30032)];
  const result = findConsecutiveUndelivered(messages, 1);
  const text = buildSmsAlertMessage(result, 1);
  assertEquals(text.includes("SMabc123"), true);
  assertEquals(text.includes("...9215"), true);
  assertEquals(text.includes("30032"), true);
  assertEquals(text.includes("+13175019215"), false); // full number redacted to last 4
});
