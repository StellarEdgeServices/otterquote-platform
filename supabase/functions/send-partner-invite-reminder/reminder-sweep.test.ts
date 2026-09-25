// gh-2154 P-5 go-live (Ben, bus 22:17:42Z item 2) — reminder-sweep.ts tests.
// Run: deno test --allow-read=supabase/functions supabase/functions/send-partner-invite-reminder/

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  isReminderDue,
  isReminderEligible,
  REMINDER_DELAY_MS,
  REMINDER_STAGE,
  runReminderSweep,
  type ReminderCandidate,
  type RunDeps,
} from "./reminder-sweep.ts";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function row(overrides: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    id: "p1",
    email: "lead@example.com",
    first_name: "Jamie",
    agent_type: "re_agent",
    created_at: new Date(NOW - 49 * HOUR).toISOString(),
    partner_agreement_accepted_at: null,
    status: "pending",
    meta_lead_id: "leadgen_1",
    ...overrides,
  };
}

// ── pure eligibility/due checks ─────────────────────────────────────────────

Deno.test("isReminderEligible: pending + meta_lead_id + no acceptance is eligible", () => {
  assertEquals(isReminderEligible(row()), true);
});

Deno.test("isReminderEligible: already accepted is NOT eligible -- 'skip anyone who has already accepted'", () => {
  assertEquals(isReminderEligible(row({ partner_agreement_accepted_at: new Date(NOW).toISOString() })), false);
});

Deno.test("isReminderEligible: not a webhook-sourced row (no meta_lead_id) is not eligible", () => {
  assertEquals(isReminderEligible(row({ meta_lead_id: null })), false);
});

Deno.test("isReminderEligible: not 'pending' (e.g. already active) is not eligible", () => {
  assertEquals(isReminderEligible(row({ status: "active" })), false);
});

Deno.test("isReminderDue: exactly 48h old is due", () => {
  assertEquals(isReminderDue(new Date(NOW - REMINDER_DELAY_MS).toISOString(), NOW), true);
});

Deno.test("isReminderDue: 47h59m old is not yet due", () => {
  assertEquals(isReminderDue(new Date(NOW - REMINDER_DELAY_MS + 60_000).toISOString(), NOW), false);
});

Deno.test("isReminderDue: malformed created_at fails CLOSED (never guess due)", () => {
  assertEquals(isReminderDue("not-a-date", NOW), false);
});

// ── runReminderSweep: injected-dependency integration ───────────────────────

function buildDeps(overrides: Partial<RunDeps> & { candidates?: ReminderCandidate[] } = {}) {
  const sent: { partnerId: string; mailgunId?: string }[] = [];
  const failed: { partnerId: string; error: string; terminal: boolean }[] = [];
  const claimed = new Set<string>();
  const alerted = new Set<string>();
  const alerts: { partner_id: string; stage: string }[][] = [];

  const deps: RunDeps = {
    now: NOW,
    fetchCandidates: async () => overrides.candidates ?? [row()],
    claim: async (id) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },
    buildOptOutUrl: async (id) => `https://x.supabase.co/functions/v1/partner-email-optout?t=tok-${id}`,
    sendEmail: async () => ({ ok: true, mailgunId: "mg-1" }),
    markSent: async (partnerId, mailgunId) => {
      sent.push({ partnerId, mailgunId });
      return {};
    },
    markFailed: async (partnerId, error, terminal) => {
      failed.push({ partnerId, error, terminal });
      return {};
    },
    alreadyAlertedUncertain: async (id) => alerted.has(id),
    markUncertainAlerted: async (id) => {
      alerted.add(id);
    },
    alertAdminUncertain: async (rows) => {
      alerts.push([...rows]);
    },
    ...overrides,
  };
  return { deps, sent, failed, claimed, alerted, alerts };
}

Deno.test("a due, eligible, unclaimed row is claimed, sent, and marked sent", async () => {
  const { deps, sent, claimed } = buildDeps();
  const outcome = await runReminderSweep(deps);
  if (outcome.ok) {
    assertEquals(outcome.results[0].sent, true);
  }
  assertEquals(claimed.has("p1"), true);
  assertEquals(sent, [{ partnerId: "p1", mailgunId: "mg-1" }]);
});

Deno.test("an already-accepted row is skipped -- never claimed, never sent", async () => {
  const { deps, claimed, sent } = buildDeps({
    candidates: [row({ partner_agreement_accepted_at: new Date(NOW).toISOString() })],
  });
  const outcome = await runReminderSweep(deps);
  if (outcome.ok) {
    assertEquals(outcome.results[0].skipped_reason, "not_eligible");
  }
  assertEquals(claimed.size, 0);
  assertEquals(sent.length, 0);
});

Deno.test("a not-yet-due row (< 48h old) is skipped without claiming", async () => {
  const { deps, claimed } = buildDeps({
    candidates: [row({ created_at: new Date(NOW - 10 * HOUR).toISOString() })],
  });
  const outcome = await runReminderSweep(deps);
  if (outcome.ok) {
    assertEquals(outcome.results[0].skipped_reason, "not_due");
  }
  assertEquals(claimed.size, 0);
});

Deno.test("never double-sends: a second sweep for the same already-claimed-and-sent partner does not re-send (claim refuses)", async () => {
  const claimed = new Set<string>(["p1"]); // simulates an already-'sent' ledger row: claim() refuses
  const { deps, sent } = buildDeps({ claim: async (id) => !claimed.has(id) });
  const outcome = await runReminderSweep(deps);
  if (outcome.ok) {
    assertEquals(outcome.results[0].skipped_reason, "not_claimed");
  }
  assertEquals(sent.length, 0, "must never send when the claim was refused");
});

Deno.test("a thrown/timeout send (uncertain outcome) is NEVER marked failed or sent, and triggers exactly one admin alert -- P-4/#2191 posture", async () => {
  const { deps, sent, failed, alerts, alerted } = buildDeps({
    sendEmail: async () => {
      throw new Error("network timeout");
    },
  });
  const outcome = await runReminderSweep(deps);
  if (outcome.ok) {
    assertEquals(outcome.uncertain, [{ partner_id: "p1" }]);
  }
  assertEquals(sent.length, 0, "never markSent on an uncertain outcome");
  assertEquals(failed.length, 0, "never markFailed on an uncertain outcome -- that would make it wrongly retryable");
  assertEquals(alerts, [[{ partner_id: "p1", stage: "invite_reminder" }]]);
  assertEquals(alerted.has("p1"), true);
});

Deno.test("a stale-uncertain row (claim refused, not yet alerted) is surfaced and alerted exactly once, then not re-alerted on a later run", async () => {
  const claimSet = new Set<string>(["p1"]); // simulates a stuck 'pending' row: never reclaimable
  const alertedSet = new Set<string>();
  const alertsLog: unknown[] = [];
  const { deps: deps1 } = buildDeps({
    claim: async (id) => !claimSet.has(id),
    alreadyAlertedUncertain: async (id) => alertedSet.has(id),
    markUncertainAlerted: async (id) => {
      alertedSet.add(id);
    },
    alertAdminUncertain: async (rows) => {
      alertsLog.push([...rows]);
    },
  });
  const outcome1 = await runReminderSweep(deps1);
  if (outcome1.ok) assertEquals(outcome1.uncertain, [{ partner_id: "p1" }]);
  assertEquals(alertsLog.length, 1, "first run alerts once");

  // Second run: still stuck, but already alerted -- must not alert again.
  const { deps: deps2 } = buildDeps({
    claim: async (id) => !claimSet.has(id),
    alreadyAlertedUncertain: async (id) => alertedSet.has(id),
    markUncertainAlerted: async (id) => {
      alertedSet.add(id);
    },
    alertAdminUncertain: async (rows) => {
      alertsLog.push([...rows]);
    },
  });
  const outcome2 = await runReminderSweep(deps2);
  if (outcome2.ok) assertEquals(outcome2.uncertain, [{ partner_id: "p1" }]);
  assertEquals(alertsLog.length, 1, "second run must NOT re-alert an already-alerted stuck row");
});

Deno.test("a definite (500-shaped) rejection is markFailed with terminal=false (retryable)", async () => {
  const { deps, failed, sent } = buildDeps({
    sendEmail: async () => ({ ok: false, error: "Mailgun 500", permanent: false }),
  });
  const outcome = await runReminderSweep(deps);
  if (outcome.ok) assertEquals(outcome.results[0].skipped_reason, "send_failed");
  assertEquals(sent.length, 0);
  assertEquals(failed, [{ partnerId: "p1", error: "Mailgun 500", terminal: false }]);
});

Deno.test("a permanent (4xx-not-429) rejection is markFailed with terminal=true (never retried)", async () => {
  const { deps, failed } = buildDeps({
    sendEmail: async () => ({ ok: false, error: "Mailgun 400", permanent: true }),
  });
  await runReminderSweep(deps);
  assertEquals(failed, [{ partnerId: "p1", error: "Mailgun 400", terminal: true }]);
});

Deno.test("a row with no email is skipped without claiming", async () => {
  const { deps, claimed } = buildDeps({ candidates: [row({ email: null })] });
  const outcome = await runReminderSweep(deps);
  if (outcome.ok) assertEquals(outcome.results[0].skipped_reason, "no_email");
  assertEquals(claimed.size, 0);
});

Deno.test("REMINDER_STAGE is the exact stage string the migration widens the CHECK constraint for", () => {
  assertEquals(REMINDER_STAGE, "invite_reminder");
});

Deno.test("fetchCandidates throwing surfaces as a top-level failure, not a crash", async () => {
  const { deps } = buildDeps({
    fetchCandidates: async () => {
      throw new Error("db down");
    },
  });
  const outcome = await runReminderSweep(deps);
  assertEquals(outcome.ok, false);
});
