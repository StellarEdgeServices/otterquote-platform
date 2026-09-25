// Deno unit tests for gh-2154 P-4 runOnboardingSweep — the injected-dependency
// executor. No Supabase, no Mailgun, no database: every guard is exercised
// with recording fakes. Includes Kevin's corrections: Q1 (opt-out gate,
// unsubscribe link) and Q3 (claim/send/mark, not stamp-before-send).
// Run: deno test supabase/functions/send-partner-onboarding/run-sweep.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { runOnboardingSweep, type LedgerRow, type RunDeps } from "./run-sweep.ts";
import { canClaimStage, DAY_MS, type LedgerStatus, type OnboardingStage, type PartnerRow, STALE_PENDING_MINUTES } from "./onboarding-stage.ts";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const MIN = 60 * 1000;

// gh-2154 P-4 fix round (ruling a, REVIEW FAIL 5833587935): the switch's
// ONLY "on" shape now requires enabled_since (see kill-switch.ts's
// parseOnboardingSwitch) — a bare `true` no longer means enabled. `ON` here
// is "on since the epoch," i.e. no partner is ever gated out by switch
// timing, matching every pre-existing test's actual intent (none of them
// are testing switch-timing behavior) — see the dedicated
// "ruling (a): switch enabled_since" tests below for the gate itself.
const ON = { enabled: true, enabled_since: new Date(0).toISOString() };

function partner(overrides: Partial<PartnerRow> = {}): PartnerRow {
  return {
    id: "p1",
    created_at: new Date(NOW).toISOString(),
    agent_type: "re_agent",
    is_test: false,
    email: "partner@example.com",
    first_name: "Pat",
    app_first_signed_in_launch_at: null,
    onboarding_opted_out_at: null,
    // Ben, DECIDED (bus 14:11:18Z, P-5 LEGAL ruling): the default fixture is
    // a REAL, accepted, active P-1-style signup — every pre-existing test in
    // this file exercises OTHER guards and doesn't care about this one, so
    // it must not gate them out. See the dedicated
    // "hasAcceptedAgreementAndIsActive" tests below for the gate itself.
    status: "active",
    partner_agreement_accepted_at: new Date(NOW - 1000).toISOString(),
    ...overrides,
  };
}

function agedIso(ageMs: number): string {
  return new Date(NOW - ageMs).toISOString();
}

interface Recorder {
  claims: { partner_id: string; stage: string }[];
  sent: { partner_id: string; stage: string; mailgun_id: string | null }[];
  failed: { partner_id: string; stage: string; error: string }[];
  skipped: { partner_id: string; stage: string; reason: string }[];
  sends: { to: string; subject: string; textBody: string; htmlBody: string; optOutUrl: string }[];
}

/** A shared in-memory ledger store, so two `deps` objects built from the
 * SAME store can model two overlapping runs racing for the same
 * (partner, stage) claim — see the "concurrent double claim" test below. */
class FakeLedgerStore {
  rows = new Map<string, { status: LedgerStatus; created_at: string }>();
  key(partnerId: string, stage: string) {
    return `${partnerId}::${stage}`;
  }
  claim(partnerId: string, stage: string, now: number): boolean {
    const k = this.key(partnerId, stage);
    const existing = this.rows.get(k);
    if (!canClaimStage(existing, now)) return false;
    this.rows.set(k, { status: "pending", created_at: new Date(now).toISOString() });
    return true;
  }
  markSent(partnerId: string, stage: string, now: number) {
    this.rows.set(this.key(partnerId, stage), { status: "sent", created_at: new Date(now).toISOString() });
  }
  markFailed(partnerId: string, stage: string, now: number) {
    this.rows.set(this.key(partnerId, stage), { status: "failed", created_at: new Date(now).toISOString() });
  }
  markSkipped(partnerId: string, stage: string, now: number) {
    const k = this.key(partnerId, stage);
    if (this.rows.has(k)) return; // 23505-equivalent no-op
    this.rows.set(k, { status: "skipped", created_at: new Date(now).toISOString() });
  }
  asLedgerRows(): LedgerRow[] {
    return [...this.rows.entries()].map(([k, v]) => {
      const [partner_id, stage] = k.split("::");
      return { partner_id, stage: stage as OnboardingStage, status: v.status, created_at: v.created_at };
    });
  }
}

function buildDeps(opts: {
  settingValue?: unknown;
  settingThrows?: boolean;
  optOutSecretConfigured?: boolean;
  partners?: PartnerRow[];
  store?: FakeLedgerStore;
  sendOk?: boolean;
  now?: number;
}): { deps: RunDeps; rec: Recorder; store: FakeLedgerStore } {
  const rec: Recorder = { claims: [], sent: [], failed: [], skipped: [], sends: [] };
  const store = opts.store ?? new FakeLedgerStore();
  const now = opts.now ?? NOW;
  const deps: RunDeps = {
    readSetting: async () => {
      if (opts.settingThrows) throw new Error("boom");
      return opts.settingValue === undefined ? null : { value: opts.settingValue };
    },
    optOutSecretConfigured: opts.optOutSecretConfigured !== false,
    fetchCandidatePartners: async () => opts.partners ?? [partner()],
    fetchLedgerForPartners: async () => store.asLedgerRows(),
    claimStage: async (partnerId, stage) => {
      rec.claims.push({ partner_id: partnerId, stage });
      return { claimed: store.claim(partnerId, stage, now) };
    },
    markSent: async (partnerId, stage, mailgunId) => {
      rec.sent.push({ partner_id: partnerId, stage, mailgun_id: mailgunId });
      store.markSent(partnerId, stage, now);
      return { error: null };
    },
    markFailed: async (partnerId, stage, error) => {
      rec.failed.push({ partner_id: partnerId, stage, error });
      store.markFailed(partnerId, stage, now);
      return { error: null };
    },
    markSkipped: async (partnerId, stage, reason) => {
      rec.skipped.push({ partner_id: partnerId, stage, reason });
      store.markSkipped(partnerId, stage, now);
      return { error: null };
    },
    buildOptOutUrl: async (partnerId) => `https://otterquote.com/functions/v1/partner-email-optout?t=fake.${partnerId}`,
    sendEmail: async (to, subject, textBody, htmlBody, optOutUrl) => {
      rec.sends.push({ to, subject, textBody, htmlBody, optOutUrl });
      return { ok: opts.sendOk !== false, mailgunId: opts.sendOk !== false ? "mg-123" : undefined, error: opts.sendOk === false ? "Mailgun 500" : undefined };
    },
    now,
  };
  return { deps, rec, store };
}

const REAL_COPY = { subject: "Welcome aboard", textBody: "Hi there.", htmlBody: "<p>Hi there.</p>" };
const REAL_UNSUB_TEMPLATE = "Stop these emails any time: {{optOutUrl}}";

function withRealCopy(deps: RunDeps): RunDeps {
  deps.getCopy = () => REAL_COPY;
  deps.getUnsubLineTemplate = () => REAL_UNSUB_TEMPLATE;
  return deps;
}

// ── kill switch ──────────────────────────────────────────────────────────

Deno.test("kill switch OFF (explicit false): 0 sends, 0 claims", async () => {
  const { deps, rec } = buildDeps({ settingValue: false });
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome, { ok: true, skipped: "disabled" });
  assertEquals(rec.sends.length, 0);
  assertEquals(rec.claims.length, 0);
});

Deno.test("kill switch UNSET: 0 sends", async () => {
  const { deps, rec } = buildDeps({ settingValue: undefined });
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome, { ok: true, skipped: "disabled" });
  assertEquals(rec.sends.length, 0);
});

Deno.test("kill switch UNREADABLE (throws): 0 sends, fails closed", async () => {
  const { deps, rec } = buildDeps({ settingThrows: true });
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome, { ok: true, skipped: "disabled" });
  assertEquals(rec.sends.length, 0);
});

// ── Kevin correction Q1: opt-out secret gate (CAN-SPAM, D-320 mirror) ──────

Deno.test("opt-out secret NOT configured: 0 sends, even with the switch ON and real copy", async () => {
  const { deps, rec } = buildDeps({ settingValue: ON, optOutSecretConfigured: false, partners: [partner()] });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome, { ok: true, skipped: "no_optout_secret" });
  assertEquals(rec.sends.length, 0);
  assertEquals(rec.claims.length, 0);
});

Deno.test("opted-out partner: 0 sends, no claim even attempted (permanent gate, same shape as activation)", async () => {
  const { deps, rec } = buildDeps({
    settingValue: ON,
    partners: [partner({ onboarding_opted_out_at: agedIso(1 * DAY_MS) })],
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "opted_out");
  }
  assertEquals(rec.sends.length, 0);
  assertEquals(rec.claims.length, 0);
});

Deno.test("the unsubscribe link is present in BOTH bodies of every rendered stage (real copy)", async () => {
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner()] });
  withRealCopy(deps);
  await runOnboardingSweep(deps);
  assertEquals(rec.sends.length, 1);
  const [send] = rec.sends;
  assertEquals(send.textBody.includes("partner-email-optout"), true);
  assertEquals(send.htmlBody.includes("partner-email-optout"), true);
});

// ── placeholder-copy guard ───────────────────────────────────────────────
//
// gh-2154 P-4: the real (Dustin-approved) copy has landed in ./copy.ts —
// this used to be a test that switch-ON + real opt-out secret STILL sent
// nothing because the shipped copy was an obvious `[[...]]` placeholder.
// That is no longer true (see copy.test.ts's fail-first-on-792acb33 tests
// for the approved-text assertions), so this test now asserts the inverse:
// with the switch ON, a real send happens using the DEFAULT (real, un-faked)
// copy module — i.e. runOnboardingSweep's default `getCopy` really is
// wired to the approved copy, not left on a fake in some code path.
Deno.test("real (approved) copy in place: switch ON, opt-out configured — sends using the default (non-faked) copy module", async () => {
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner()] });
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results, [{ partner_id: "p1", sent: "day0" }]);
  }
  assertEquals(rec.sends.length, 1);
  assertEquals(rec.claims.length, 1);
  const [send] = rec.sends;
  // Real subject (day0, re_agent — see copy.test.ts), not a bracket marker.
  assertEquals(send.subject, "Your Otter Quotes partner account is ready");
  assertEquals(send.subject.includes("[["), false);
});

// The mechanical placeholder-copy safety net itself must still work,
// independent of whatever real copy currently ships — proven with a faked
// getCopy that deliberately still returns a `[[...]]`-marked message.
Deno.test("placeholder-copy guard mechanism: a still-placeholder message (faked) blocks send and claim", async () => {
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner()] });
  deps.getCopy = () => ({ subject: "[[placeholder subject]]", textBody: "x", htmlBody: "<p>x</p>" });
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results, [{ partner_id: "p1", skipped_reason: "placeholder_copy" }]);
  }
  assertEquals(rec.sends.length, 0);
  assertEquals(rec.claims.length, 0, "a placeholder-blocked stage must never even be claimed");
});

// ── agent_type routing ───────────────────────────────────────────────────

Deno.test("ineligible agent_type (customer): no claim, no send", async () => {
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner({ agent_type: "customer" })] });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "ineligible_agent_type");
  }
  assertEquals(rec.claims.length, 0);
});

// ── [TEST] prefix / bot pattern ──────────────────────────────────────────

Deno.test("bot-pattern email WITHOUT is_test is skipped as bot_pattern, before any claim", async () => {
  const { deps, rec } = buildDeps({
    settingValue: ON,
    partners: [partner({ is_test: false, email: "pfw-test-partner@example.com" })],
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "bot_pattern");
  }
  assertEquals(rec.claims.length, 0);
});

Deno.test("[TEST] prefix: is_test=true partner's subject is prefixed and it still sends", async () => {
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner({ is_test: true })] });
  withRealCopy(deps);
  await runOnboardingSweep(deps);
  const optOutUrl = "https://otterquote.com/functions/v1/partner-email-optout?t=fake.p1";
  assertEquals(rec.sends, [{
    to: "partner@example.com",
    subject: "[TEST] Welcome aboard",
    textBody: `Hi there.\n\nStop these emails any time: ${optOutUrl}`,
    // Ben SHOULD (clickable unsubscribe <a>): the HTML body wraps the URL
    // in an anchor now, instead of rendering it as bare text.
    htmlBody: `<p>Hi there.</p><p>Stop these emails any time: <a href="${optOutUrl}" style="color:inherit;">${optOutUrl}</a></p>`,
    optOutUrl,
  }]);
});

// ── backlog: at most one stage per run ───────────────────────────────────

Deno.test("9-day backlog, real copy: only day7 sends, day0/1/3 marked skipped in one call each", async () => {
  const { deps, rec } = buildDeps({
    settingValue: ON,
    partners: [partner({ created_at: agedIso(9 * DAY_MS) })],
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].sent, "day7");
    assertEquals(outcome.results[0].skipped_stages, ["day0", "day1", "day3"]);
  }
  assertEquals(rec.skipped.map((r) => r.stage), ["day0", "day1", "day3"]);
  assertEquals(rec.sends.length, 1, "exactly one send per run, even on a wide backlog");
});

// ── Kevin correction Q3: claim -> send -> mark (not stamp-before-send) ─────

Deno.test("Mailgun failure: the row is marked 'failed', NOT 'sent' — and the next tick retries it", async () => {
  const { deps, rec, store } = buildDeps({ settingValue: ON, partners: [partner()], sendOk: false });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "send_failed");
  }
  assertEquals(rec.sent.length, 0, "markSent must never be called on a failed send");
  assertEquals(rec.failed.length, 1);
  assertEquals(store.rows.get("p1::day0")?.status, "failed");

  // Next tick (same partner, same age, ledger now shows 'failed' for day0):
  // the retry actually resends, since 'failed' is not resolved.
  const { deps: deps2, rec: rec2 } = buildDeps({ settingValue: ON, partners: [partner()], store, sendOk: true, now: NOW + 1000 });
  withRealCopy(deps2);
  await runOnboardingSweep(deps2);
  assertEquals(rec2.sends.length, 1, "a later tick must retry a 'failed' stage");
  assertEquals(store.rows.get("p1::day0")?.status, "sent");
});

Deno.test("a concurrent double claim: two overlapping attempts on the SAME (partner, stage) — only the first succeeds, the second is refused, before either has sent anything", () => {
  // Models true overlap directly at the claim primitive (what the DB-level
  // conditional upsert enforces for real): both callers' claim attempts
  // race for the same row, neither has sent or marked anything yet.
  const store = new FakeLedgerStore();
  const first = store.claim("p1", "day0", NOW);
  const second = store.claim("p1", "day0", NOW); // arrives while the first is still 'pending'
  assertEquals(first, true, "the first caller must win the claim");
  assertEquals(second, false, "the second, overlapping caller must lose — it never gets to send");
});

Deno.test("a concurrent double claim, exercised through the full sweep: seeding a fresh 'pending' row (as the first caller's claim would produce) makes the second run send nothing and report already_sent", async () => {
  const store = new FakeLedgerStore();
  // This IS what deps.claimStage produced for a first, still-in-flight
  // caller — seeded directly so this test exercises the SECOND caller's
  // full runOnboardingSweep path against that state.
  store.claim("p1", "day0", NOW);
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner()], store, now: NOW + 1000 });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "already_sent");
  }
  assertEquals(rec.sends.length, 0, "the losing caller must never call sendEmail");
});

Deno.test("a fresh pending claim (within the stale window) is NOT reclaimable by a second run", async () => {
  const store = new FakeLedgerStore();
  store.rows.set("p1::day0", { status: "pending", created_at: new Date(NOW - 1 * MIN).toISOString() });
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner()], store });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "already_sent");
  }
  assertEquals(rec.sends.length, 0);
});

// Ben, DECIDED (orchestrator review, ruling c REOPENED): this test used to
// assert the stale row WAS reclaimed and resent — that assertion WAS the
// defect. "mark the stage sent-or-uncertain BEFORE calling Mailgun, never
// auto-reclaim a row whose send outcome is unknown (surface it instead)."
// This is the fail-first proof for item (iii): FAILS on head 1cbf2f8e
// (`outcome.results[0].sent` would be `undefined`, not `"day0"`, and
// `outcome.uncertain` would be `undefined` since that field doesn't exist
// on 1cbf2f8e's SweepOutcome type/runtime value at all).
Deno.test("a STALE pending claim (past the stale window) is UNCERTAIN — surfaced, NEVER auto-retried (a crash right after Mailgun accepted must not double-send)", async () => {
  const store = new FakeLedgerStore();
  const staleCreatedAt = new Date(NOW - (STALE_PENDING_MINUTES + 1) * MIN).toISOString();
  store.rows.set("p1::day0", { status: "pending", created_at: staleCreatedAt });
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner()], store });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "uncertain");
    assertEquals(outcome.uncertain, [{ partner_id: "p1", stage: "day0" }]);
  }
  assertEquals(rec.sends.length, 0, "an uncertain-outcome stage must NEVER be auto-retried — that is exactly the double-send risk being closed");
  assertEquals(rec.claims.length, 0, "claimStage must never even be called for an uncertain row");
  // The row itself is untouched — still 'pending', same created_at, exactly
  // as a human investigating it later would need to find it.
  assertEquals(store.rows.get("p1::day0"), { status: "pending", created_at: staleCreatedAt });
});

Deno.test("a STALE pending claim on one stage does not block a DIFFERENT stage for the same partner from being surfaced independently", async () => {
  // Sanity check that the uncertain lookup is keyed on (partner, stage), not
  // partner alone — a 9-day-old partner with a stale day0 pending row still
  // gets day0 reported uncertain (the LATEST unresolved stage from
  // selectStage's own view is day7 territory only once day0/1/3 resolve;
  // here day0 itself is what's selected since nothing else is due yet at
  // day0's own threshold — this test pins that shape).
  const store = new FakeLedgerStore();
  store.rows.set("p1::day0", { status: "pending", created_at: new Date(NOW - (STALE_PENDING_MINUTES + 5) * MIN).toISOString() });
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner()], store });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "uncertain");
  }
  assertEquals(rec.sends.length, 0);
});

Deno.test("negative control: partner who never activates reaches day7 eligibility and sends (real copy)", async () => {
  const store = new FakeLedgerStore();
  store.rows.set("p1::day0", { status: "sent", created_at: agedIso(29 * DAY_MS) });
  store.rows.set("p1::day1", { status: "sent", created_at: agedIso(28 * DAY_MS) });
  store.rows.set("p1::day3", { status: "sent", created_at: agedIso(26 * DAY_MS) });
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner({ created_at: agedIso(30 * DAY_MS) })], store });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].sent, "day7");
  }
  assertEquals(rec.sends.length, 1);
});

Deno.test("negative control: partner activates right after day0 gets nothing further across later runs", async () => {
  const store = new FakeLedgerStore();
  store.rows.set("p1::day0", { status: "sent", created_at: agedIso(29 * DAY_MS) });
  const p = partner({
    created_at: agedIso(30 * DAY_MS),
    app_first_signed_in_launch_at: agedIso(29 * DAY_MS),
  });
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [p], store });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "activated");
  }
  assertEquals(rec.sends.length, 0);
});

// ── Ben, DECIDED (bus 14:01:57Z, ruling a - REVIEW FAIL 5833587935):
// switch enabled_since gates partners created before the switch was turned
// on. These fail on head aae3acfc - buildDeps's ON constant there is a bare
// `true`, and selectStage has no fourth parameter at all, so turning the
// switch on sends the FULL day0-through-day7 backlog to every pre-existing
// partner (the exact defect this fix closes). ------------------------------

Deno.test("ruling (a): bare true settingValue no longer means enabled - fails closed", async () => {
  // deno-lint-ignore no-explicit-any
  const { deps, rec } = buildDeps({ settingValue: true as any, partners: [partner()] });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome, { ok: true, skipped: "disabled" });
  assertEquals(rec.sends.length, 0);
});

Deno.test("ruling (a): switch enabled_since AFTER a partner created_at - that partner never enters, even 9 days old (no day-7 blast)", async () => {
  const switchOn = { enabled: true, enabled_since: new Date(NOW).toISOString() };
  const { deps, rec } = buildDeps({
    settingValue: switchOn,
    partners: [partner({ created_at: agedIso(9 * DAY_MS) })], // signed up 9 days before the switch flipped on
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "before_switch_enabled");
  }
  assertEquals(rec.sends.length, 0, "no day0/day1/day3/day7 blast for a partner who predates the switch");
  assertEquals(rec.claims.length, 0);
  assertEquals(rec.skipped.length, 0, "a gated-out-by-switch-timing partner gets NO ledger writes at all, same shape as activated/opted_out");
});

Deno.test("ruling (a): a partner created AFTER enabled_since enters normally", async () => {
  const switchOn = { enabled: true, enabled_since: new Date(NOW - 1 * DAY_MS).toISOString() };
  const { deps, rec } = buildDeps({
    settingValue: switchOn,
    partners: [partner({ created_at: agedIso(0) })], // signed up after the switch was already on
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].sent, "day0");
  }
  assertEquals(rec.sends.length, 1);
});

Deno.test("ruling (a): malformed enabled_since (unparsable date) fails closed as disabled", async () => {
  const { deps, rec } = buildDeps({
    settingValue: { enabled: true, enabled_since: "not-a-date" },
    partners: [partner()],
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome, { ok: true, skipped: "disabled" });
  assertEquals(rec.sends.length, 0);
});

Deno.test("ruling (a): enabled true with NO enabled_since fails closed as disabled", async () => {
  const { deps, rec } = buildDeps({ settingValue: { enabled: true }, partners: [partner()] });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome, { ok: true, skipped: "disabled" });
  assertEquals(rec.sends.length, 0);
});

// ── Ben, DECIDED (ruling b): otterquote-internal.test / founder / .invalid
// / .test addresses are excluded UNCONDITIONALLY, even when is_test=true -
// these fail on head aae3acfc, which has no isAlwaysExcludedAddress check at
// all (only the non-is_test-only bot-pattern check), so an is_test=true row
// on otterquote-internal.test would send (with the [TEST] prefix) instead
// of being skipped. -----------------------------------------------------

Deno.test("ruling (b): otterquote-internal.test address is skipped even when is_test=true", async () => {
  const { deps, rec } = buildDeps({
    settingValue: ON,
    partners: [partner({ is_test: true, email: "pfw-walker-7@otterquote-internal.test" })],
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "internal_test_domain");
  }
  assertEquals(rec.sends.length, 0);
  assertEquals(rec.claims.length, 0);
});

Deno.test("ruling (b): a founder (stohler) address is skipped even when is_test=false", async () => {
  const { deps, rec } = buildDeps({
    settingValue: ON,
    partners: [partner({ is_test: false, email: "dustinstohler1@gmail.com" })],
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "internal_test_domain");
  }
  assertEquals(rec.sends.length, 0);
});

Deno.test("ruling (b): a generic .invalid domain is skipped unconditionally", async () => {
  const { deps, rec } = buildDeps({
    settingValue: ON,
    partners: [partner({ is_test: false, email: "someone@example.invalid" })],
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "internal_test_domain");
  }
  assertEquals(rec.sends.length, 0);
});

Deno.test("ruling (b): a REAL human partner (not matching any excluded pattern) still sends normally", async () => {
  const { deps, rec } = buildDeps({
    settingValue: ON,
    partners: [partner({ is_test: false, email: "realtor@remax.com" })],
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].sent, "day0");
  }
  assertEquals(rec.sends.length, 1);
});

// ── Ben SHOULD: a missing MAILGUN_API_KEY must NOT record sent -----------
// index.ts's own sendEmail wiring is what changed (this test proves the
// CONTRACT run-sweep.ts depends on: a sendEmail that reports ok:false
// routes to markFailed, never markSent) - see the build report for why
// there is no dedicated index.ts test harness in this directory (index.ts
// is exercised only by wiring, per this function's own file header); the
// contract is proven here at the run-sweep level, which is what actually
// decides sent-vs-failed.

Deno.test("Ben SHOULD: sendEmail reporting ok:false (mirrors a missing MAILGUN_API_KEY) records failed, never sent", async () => {
  const { deps, rec, store } = buildDeps({ settingValue: ON, partners: [partner()] });
  withRealCopy(deps);
  deps.sendEmail = async () => ({ ok: false, error: "MAILGUN_API_KEY not configured" });
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "send_failed");
  }
  assertEquals(rec.sent.length, 0, "markSent must never be called when sendEmail reports ok:false");
  assertEquals(store.rows.get("p1::day0")?.status, "failed");
});

// ── Ben SHOULD: List-Unsubscribe headers / clickable HTML anchor ---------
// (the header-append mechanics live in index.ts's real sendMailgunEmail,
// exercised there only by wiring - see that file; this proves run-sweep.ts
// actually PASSES optOutUrl through to sendEmail, which is the prerequisite
// for index.ts being able to attach the header at all.)

Deno.test("Ben SHOULD: runOnboardingSweep passes optOutUrl to sendEmail (prerequisite for List-Unsubscribe headers)", async () => {
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner()] });
  withRealCopy(deps);
  await runOnboardingSweep(deps);
  assertEquals(rec.sends[0].optOutUrl, "https://otterquote.com/functions/v1/partner-email-optout?t=fake.p1");
});

Deno.test("Ben SHOULD: the rendered HTML unsubscribe line is a clickable a-href anchor, not bare text", async () => {
  const { deps, rec } = buildDeps({ settingValue: ON, partners: [partner()] });
  withRealCopy(deps);
  await runOnboardingSweep(deps);
  const [send] = rec.sends;
  assertEquals(
    send.htmlBody.includes(`<a href="${send.optOutUrl}"`),
    true,
    `expected a clickable anchor for ${send.optOutUrl} in: ${send.htmlBody}`,
  );
});

// -- Ben, DECIDED (bus 14:11:18Z, P-5 LEGAL ruling): P-5's Meta webhook will
// create partner rows NOT active / with no recorded agreement acceptance
// until the real signup/accept step completes -- those rows must NEVER
// enter the onboarding sequence. These fail on head 1cbf2f8e, where
// PartnerRow has no status/partner_agreement_accepted_at fields and
// run-sweep.ts has no gate for either at all -- a P-5 webhook-created row
// would reach day0 and send "your account is ready" to a partner who never
// agreed to anything. --------------------------------------------------

Deno.test("P-5 ruling: a partner with NO recorded agreement acceptance (what the Meta webhook creates) is skipped with a clear reason, never sent", async () => {
  const { deps, rec } = buildDeps({
    settingValue: ON,
    partners: [partner({ status: "active", partner_agreement_accepted_at: null })],
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "agreement_not_accepted");
  }
  assertEquals(rec.sends.length, 0);
  assertEquals(rec.claims.length, 0, "an unaccepted partner must never even reach the claim step");
});

Deno.test("P-5 ruling: a partner with an acceptance recorded but a non-'active' status (e.g. still 'pending') is also skipped", async () => {
  const { deps, rec } = buildDeps({
    settingValue: ON,
    partners: [partner({ status: "pending", partner_agreement_accepted_at: new Date(NOW - 1000).toISOString() })],
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "agreement_not_accepted");
  }
  assertEquals(rec.sends.length, 0);
});

Deno.test("P-5 ruling: this gate is robust to whatever exact status string P-5 uses -- any non-'active' value with no acceptance is skipped the same way", async () => {
  for (const status of ["invited", "meta_lead", "unverified", "awaiting_acceptance"]) {
    const { deps, rec } = buildDeps({
      settingValue: ON,
      partners: [partner({ status, partner_agreement_accepted_at: null })],
    });
    withRealCopy(deps);
    const outcome = await runOnboardingSweep(deps);
    if (outcome.ok && "results" in outcome) {
      assertEquals(outcome.results[0].skipped_reason, "agreement_not_accepted", `status=${status} should be skipped`);
    }
    assertEquals(rec.sends.length, 0, `status=${status} must not send`);
  }
});

Deno.test("P-5 ruling: an active, accepted partner (real P-1 signup) still sends normally -- the gate isn't overbroad", async () => {
  const { deps, rec } = buildDeps({
    settingValue: ON,
    partners: [partner({ status: "active", partner_agreement_accepted_at: new Date(NOW - 1000).toISOString() })],
  });
  withRealCopy(deps);
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].sent, "day0");
  }
  assertEquals(rec.sends.length, 1);
});
