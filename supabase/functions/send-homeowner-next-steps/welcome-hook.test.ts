// gh-2069 (e) — homeowner first-touch welcome email: the gate must default
// closed, and a real send must both call Mailgun and write a notifications
// row (or write a failure row and nothing else).
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  buildWelcomeEmailContent,
  deliverWelcome,
  HOMEOWNER_WELCOME_FRESHNESS_MS,
  HOMEOWNER_WELCOME_TEMPLATE,
  isProfileFreshEnough,
  isWelcomeEnabled,
  type WelcomeDeps,
} from "./welcome-hook.ts";

const CANDIDATE = { userId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", email: "new-homeowner@example.invalid", name: "Jamie Homeowner" };
const DASHBOARD_URL = "https://otterquote.com/dashboard.html";

function fakes(opts: { enabled: boolean; mailgun?: boolean; sendOk?: boolean; mailgunId?: string }) {
  const sent: string[] = [];
  const notifications: import("./welcome-hook.ts").WelcomeNotificationRow[] = [];
  const deps: WelcomeDeps = {
    enabled: opts.enabled,
    mailgunConfigured: opts.mailgun ?? true,
    sendEmail: (to) => {
      sent.push(to);
      return Promise.resolve(
        opts.sendOk === false
          ? { ok: false, error: "Mailgun 500" }
          : { ok: true, mailgunId: opts.mailgunId ?? "<welcome-1@mail.otterquote.com>" },
      );
    },
    insertNotification: (row) => {
      notifications.push(row);
      return Promise.resolve({ error: null });
    },
  };
  return { deps, sent, notifications };
}

// ── Gate default: OFF ────────────────────────────────────────────────────

Deno.test("isWelcomeEnabled: only a literal `true` value enables the send", () => {
  assertEquals(isWelcomeEnabled(true), true);
  assertEquals(isWelcomeEnabled(false), false);
  assertEquals(isWelcomeEnabled(null), false);
  assertEquals(isWelcomeEnabled(undefined), false);
  assertEquals(isWelcomeEnabled("true"), false);
  assertEquals(isWelcomeEnabled(1), false);
});

Deno.test("gh-2069 NEGATIVE CONTROL — gated OFF (the shipped default): no Mailgun call, no notifications row", async () => {
  const { deps, sent, notifications } = fakes({ enabled: false });
  const outcome = await deliverWelcome(deps, CANDIDATE, DASHBOARD_URL);
  assertEquals(outcome.kind, "disabled");
  assertEquals(sent.length, 0);
  assertEquals(notifications.length, 0);
});

Deno.test("gated ON, Mailgun accepts: exactly one send and one delivered=true notifications row with the mailgun id", async () => {
  const { deps, sent, notifications } = fakes({ enabled: true, mailgunId: "<welcome-xyz@mail.otterquote.com>" });
  const outcome = await deliverWelcome(deps, CANDIDATE, DASHBOARD_URL);
  assertEquals(outcome.kind, "sent");
  assertEquals(sent, [CANDIDATE.email]);
  assertEquals(notifications.length, 1);
  assertEquals(notifications[0].delivered, true);
  assertEquals(notifications[0].mailgun_id, "<welcome-xyz@mail.otterquote.com>");
  assertEquals(notifications[0].notification_type, HOMEOWNER_WELCOME_TEMPLATE);
  assertEquals(notifications[0].recipient, CANDIDATE.email);
  assertEquals(notifications[0].claim_id, null);
});

Deno.test("gated ON, Mailgun rejects: send is attempted, notifications row is delivered=false with the error, no crash", async () => {
  const { deps, sent, notifications } = fakes({ enabled: true, sendOk: false });
  const outcome = await deliverWelcome(deps, CANDIDATE, DASHBOARD_URL);
  assertEquals(outcome.kind, "send_failed");
  assertEquals(sent.length, 1);
  assertEquals(notifications.length, 1);
  assertEquals(notifications[0].delivered, false);
  assertEquals(notifications[0].mailgun_id, null);
  assertEquals((notifications[0].message_preview as string).includes("Mailgun 500"), true);
});

Deno.test("gated ON but MAILGUN_API_KEY unset: no send attempted, no notifications row", async () => {
  const { deps, sent, notifications } = fakes({ enabled: true, mailgun: false });
  const outcome = await deliverWelcome(deps, CANDIDATE, DASHBOARD_URL);
  assertEquals(outcome.kind, "not_configured");
  assertEquals(sent.length, 0);
  assertEquals(notifications.length, 0);
});

// ── Freshness window ─────────────────────────────────────────────────────

Deno.test("isProfileFreshEnough: true just under 15 minutes, false at/after, false for a future timestamp", () => {
  const now = Date.parse("2026-09-21T18:00:00Z");
  assertEquals(isProfileFreshEnough(new Date(now - 1).toISOString(), now), true);
  assertEquals(isProfileFreshEnough(new Date(now - (HOMEOWNER_WELCOME_FRESHNESS_MS - 1000)).toISOString(), now), true);
  assertEquals(isProfileFreshEnough(new Date(now - HOMEOWNER_WELCOME_FRESHNESS_MS).toISOString(), now), false);
  assertEquals(isProfileFreshEnough(new Date(now - HOMEOWNER_WELCOME_FRESHNESS_MS - 1000).toISOString(), now), false);
  // Clock-skewed "future" created_at must not be treated as eligible.
  assertEquals(isProfileFreshEnough(new Date(now + 60000).toISOString(), now), false);
  assertEquals(isProfileFreshEnough("not-a-date", now), false);
});

// ── Draft copy sanity (not a design review — just "it renders, it has the
// required elements, it makes no promises") ─────────────────────────────

Deno.test("draft copy: thanks the homeowner, names both actions, one dashboard link, signed 'The OtterQuote team'", () => {
  const { subject, textBody, htmlBody } = buildWelcomeEmailContent(CANDIDATE.name, DASHBOARD_URL);
  assert(subject.length > 0);
  assert(textBody.toLowerCase().includes("thanks"));
  assert(textBody.toLowerCase().includes("loss sheet"));
  assert(textBody.includes("$15"));
  assert(textBody.includes(DASHBOARD_URL));
  assert(textBody.includes("The OtterQuote team"));
  assert(htmlBody.includes(DASHBOARD_URL));
  // No coverage / bid / savings / timeline promises anywhere in the copy.
  for (const forbidden of ["guarantee", "approved", "will save", "days to", "% off"]) {
    assertEquals(textBody.toLowerCase().includes(forbidden), false);
  }
});
