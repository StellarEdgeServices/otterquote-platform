// Deno unit test for gh-1824 footer-batch-6 (platform-health-check): pins every rendered email body
// with exact-equality goldens (REVIEW: FAIL 5881354201 on PR #2331; same bar as
// batches 2-5, HOLD 5870481359 / FAIL 5870472283). A `.includes(POSTAL_ADDRESS)`-only
// test lets a one-word change to the body ship undetected, so each golden below is
// the FULL rendered text or HTML. Every golden was captured by executing the
// ORIGINAL, pre-extraction code (verbatim slices of index.ts at fd6255c1) with the
// fixed inputs used here, BEFORE the bodies were moved into templates.ts, so the
// goldens prove the extraction changed no byte. Goldens are the text/plain part as SENT: alertEmailText(message), exactly as sendMailgunAlert() composes it. The checked-at stamp is passed in, so output is deterministic.
// Run: deno test --no-check -A supabase/functions/platform-health-check/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  alertEmailText,
  cronErrorAlert,
  cronStalenessAlert,
  efSilentFailureAlert,
  publicPathFailureAlert,
  registerPartnerBudgetMessage,
  smsUndeliveredAlert,
} from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

const CHECKED_AT = "2026-09-28 14:15:00 UTC (10:15:00 AM EDT)";
const sent = (a: { message: string }) => alertEmailText(a.message);
const SMS_RES = { alarmed: true, consecutiveCount: 3, streak: [
  { sid: "SM111", to: "+13175550101", status: "undelivered", error_code: 30032, date_created: "2026-09-28T13:00:00Z" },
  { sid: "SM222", to: "+13175550102", status: "failed", error_code: null, date_created: "2026-09-28T13:05:00Z" },
  { sid: "SM333", to: "+13175550103", status: "undelivered", error_code: 30032, date_created: "2026-09-28T13:10:00Z" },
] };

Deno.test("gh-1824 platform-health-check: 2nd-strike EF failure (with HTTP status + error) SUBJECT matches the pinned golden", () => {
  assertEquals(efSilentFailureAlert({ functionName: "send-sms", status: "timeout", httpStatus: 503, error: "upstream 503" }, CHECKED_AT).subject, "OtterQuote Health Alert — send-sms is not responding (2 consecutive failures)");
});

Deno.test("gh-1824 platform-health-check: 2nd-strike EF failure (with HTTP status + error) TEXT as sent matches the pinned golden", () => {
  assertEquals(sent(efSilentFailureAlert({ functionName: "send-sms", status: "timeout", httpStatus: 503, error: "upstream 503" }, CHECKED_AT)), "Edge Function: send-sms\nStatus: timeout\nHTTP Status: 503\nError: upstream 503\nChecked at: 2026-09-28 14:15:00 UTC (10:15:00 AM EDT)\nTwo consecutive failures across two cron runs (~15 min apart) — first failure was suppressed by the 2-strikes gate; this is the second.\nThis is an automated alert from OtterQuote platform monitoring.\nResolve this alert at: https://otterquote.com/admin-contractors.html\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 platform-health-check: 2nd-strike EF failure (minimal) SUBJECT matches the pinned golden", () => {
  assertEquals(efSilentFailureAlert({ functionName: "send-sms", status: "timeout" }, CHECKED_AT).subject, "OtterQuote Health Alert — send-sms is not responding (2 consecutive failures)");
});

Deno.test("gh-1824 platform-health-check: 2nd-strike EF failure (minimal) TEXT as sent matches the pinned golden", () => {
  assertEquals(sent(efSilentFailureAlert({ functionName: "send-sms", status: "timeout" }, CHECKED_AT)), "Edge Function: send-sms\nStatus: timeout\nChecked at: 2026-09-28 14:15:00 UTC (10:15:00 AM EDT)\nTwo consecutive failures across two cron runs (~15 min apart) — first failure was suppressed by the 2-strikes gate; this is the second.\nThis is an automated alert from OtterQuote platform monitoring.\nResolve this alert at: https://otterquote.com/admin-contractors.html\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 platform-health-check: cron error (with error text) SUBJECT matches the pinned golden", () => {
  assertEquals(cronErrorAlert("process-dunning", "2026-09-28T13:00:00Z", "boom", CHECKED_AT).subject, "OtterQuote Health Alert — cron job \"process-dunning\" last run failed (2 consecutive failures)");
});

Deno.test("gh-1824 platform-health-check: cron error (with error text) TEXT as sent matches the pinned golden", () => {
  assertEquals(sent(cronErrorAlert("process-dunning", "2026-09-28T13:00:00Z", "boom", CHECKED_AT)), "Cron Job: process-dunning\nLast Run: 2026-09-28T13:00:00Z\nStatus: ERROR\nError: boom\nChecked at: 2026-09-28 14:15:00 UTC (10:15:00 AM EDT)\nTwo consecutive failed runs across two cron ticks (~15 min apart) — first failure was suppressed by the 2-strikes gate; this is the second.\nThis is an automated alert from OtterQuote platform monitoring.\nResolve this alert at: https://otterquote.com/admin-contractors.html\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 platform-health-check: cron error (no error text) SUBJECT matches the pinned golden", () => {
  assertEquals(cronErrorAlert("process-dunning", "2026-09-28T13:00:00Z", null, CHECKED_AT).subject, "OtterQuote Health Alert — cron job \"process-dunning\" last run failed (2 consecutive failures)");
});

Deno.test("gh-1824 platform-health-check: cron error (no error text) TEXT as sent matches the pinned golden", () => {
  assertEquals(sent(cronErrorAlert("process-dunning", "2026-09-28T13:00:00Z", null, CHECKED_AT)), "Cron Job: process-dunning\nLast Run: 2026-09-28T13:00:00Z\nStatus: ERROR\nChecked at: 2026-09-28 14:15:00 UTC (10:15:00 AM EDT)\nTwo consecutive failed runs across two cron ticks (~15 min apart) — first failure was suppressed by the 2-strikes gate; this is the second.\nThis is an automated alert from OtterQuote platform monitoring.\nResolve this alert at: https://otterquote.com/admin-contractors.html\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 platform-health-check: cron staleness SUBJECT matches the pinned golden", () => {
  assertEquals(cronStalenessAlert("process-dunning", "2026-09-28T09:00:00Z", 5 * 3600000, "3 hours", CHECKED_AT).subject, "OtterQuote Health Alert — cron job \"process-dunning\" is stale (2 consecutive ticks)");
});

Deno.test("gh-1824 platform-health-check: cron staleness TEXT as sent matches the pinned golden", () => {
  assertEquals(sent(cronStalenessAlert("process-dunning", "2026-09-28T09:00:00Z", 5 * 3600000, "3 hours", CHECKED_AT)), "Cron Job: process-dunning\nLast Run: 2026-09-28T09:00:00Z\nAge: 300 minutes (threshold: 3 hours)\nChecked at: 2026-09-28 14:15:00 UTC (10:15:00 AM EDT)\n\nThis cron job has not run within its expected window across two consecutive checks (~15 min apart) — first miss was suppressed by the 2-strikes gate; this is the second.\nThis is an automated alert from OtterQuote platform monitoring.\nResolve this alert at: https://otterquote.com/admin-contractors.html\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 platform-health-check: cron staleness (never ran) SUBJECT matches the pinned golden", () => {
  assertEquals(cronStalenessAlert("process-dunning", undefined, 5 * 3600000, "3 hours", CHECKED_AT).subject, "OtterQuote Health Alert — cron job \"process-dunning\" is stale (2 consecutive ticks)");
});

Deno.test("gh-1824 platform-health-check: cron staleness (never ran) TEXT as sent matches the pinned golden", () => {
  assertEquals(sent(cronStalenessAlert("process-dunning", undefined, 5 * 3600000, "3 hours", CHECKED_AT)), "Cron Job: process-dunning\nLast Run: never\nAge: 300 minutes (threshold: 3 hours)\nChecked at: 2026-09-28 14:15:00 UTC (10:15:00 AM EDT)\n\nThis cron job has not run within its expected window across two consecutive checks (~15 min apart) — first miss was suppressed by the 2-strikes gate; this is the second.\nThis is an automated alert from OtterQuote platform monitoring.\nResolve this alert at: https://otterquote.com/admin-contractors.html\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 platform-health-check: public path failure (with error) SUBJECT matches the pinned golden", () => {
  assertEquals(publicPathFailureAlert({ path: "/get-started", jobName: "public_path_get_started", status: "http_500", error: "HTTP 500" }, CHECKED_AT).subject, "OtterQuote Health Alert — public path unavailable: /get-started");
});

Deno.test("gh-1824 platform-health-check: public path failure (with error) TEXT as sent matches the pinned golden", () => {
  assertEquals(sent(publicPathFailureAlert({ path: "/get-started", jobName: "public_path_get_started", status: "http_500", error: "HTTP 500" }, CHECKED_AT)), "Public Path: /get-started\nJob: public_path_get_started\nStatus: http_500\nError: HTTP 500\nChecked at: 2026-09-28 14:15:00 UTC (10:15:00 AM EDT)\nThis failure survived one in-run retry (~5s later) before being recorded.\nThe OtterQuote public site may be unreachable or serving incorrect content.\nThis is an automated alert from OtterQuote platform monitoring.\nResolve this alert at: https://otterquote.com/admin-contractors.html\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 platform-health-check: public path failure (no error) SUBJECT matches the pinned golden", () => {
  assertEquals(publicPathFailureAlert({ path: "/get-started", jobName: "public_path_get_started", status: "body_mismatch" }, CHECKED_AT).subject, "OtterQuote Health Alert — public path unavailable: /get-started");
});

Deno.test("gh-1824 platform-health-check: public path failure (no error) TEXT as sent matches the pinned golden", () => {
  assertEquals(sent(publicPathFailureAlert({ path: "/get-started", jobName: "public_path_get_started", status: "body_mismatch" }, CHECKED_AT)), "Public Path: /get-started\nJob: public_path_get_started\nStatus: body_mismatch\nChecked at: 2026-09-28 14:15:00 UTC (10:15:00 AM EDT)\nThis failure survived one in-run retry (~5s later) before being recorded.\nThe OtterQuote public site may be unreachable or serving incorrect content.\nThis is an automated alert from OtterQuote platform monitoring.\nResolve this alert at: https://otterquote.com/admin-contractors.html\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 platform-health-check: undelivered SMS (gh-1825) SUBJECT matches the pinned golden", () => {
  assertEquals(smsUndeliveredAlert(SMS_RES, 3, CHECKED_AT).subject, "OtterQuote Health Alert — 3 consecutive undelivered SMS sends");
});

Deno.test("gh-1824 platform-health-check: undelivered SMS (gh-1825) TEXT as sent matches the pinned golden", () => {
  assertEquals(sent(smsUndeliveredAlert(SMS_RES, 3, CHECKED_AT)), "SMS delivery alarm: 3 consecutive undelivered sends to real (non-555) recipients (threshold 3).\nsend-sms reports \"sent\" on Twilio API acceptance only and does not see this — see gh-1825.\n\n  SM111 -> ...0101 status=undelivered error_code=30032 at 2026-09-28T13:00:00Z\n  SM222 -> ...0102 status=failed error_code=(none) at 2026-09-28T13:05:00Z\n  SM333 -> ...0103 status=undelivered error_code=30032 at 2026-09-28T13:10:00Z\n\nChecked at: 2026-09-28 14:15:00 UTC (10:15:00 AM EDT)\nThis is an automated alert from OtterQuote platform monitoring (gh-1825).\nResolve this alert at: https://otterquote.com/admin-contractors.html\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 platform-health-check: register_partner budget alert TEXT as sent matches the pinned golden", () => {
  assertEquals(alertEmailText(registerPartnerBudgetMessage("register_partner_global at 40/50 real partner signups in the last 24h (80% warning threshold, rolling window).", CHECKED_AT)), "register_partner_global at 40/50 real partner signups in the last 24h (80% warning threshold, rolling window).\nChecked at: 2026-09-28 14:15:00 UTC (10:15:00 AM EDT)\nThis is an automated alert from OtterQuote platform monitoring (gh-2154/gh-2223).\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 platform-health-check: goldens still contain the D-237 postal address (sanity check on the goldens themselves)", () => {
  assertEquals(alertEmailText("x").includes(POSTAL_ADDRESS), true);
  assertEquals(sent(cronStalenessAlert("j", undefined, 0, "1 minutes", CHECKED_AT)).includes(POSTAL_ADDRESS), true);
});
