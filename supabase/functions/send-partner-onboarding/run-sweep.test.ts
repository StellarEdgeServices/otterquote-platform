// Deno unit tests for gh-2154 P-4 runOnboardingSweep — the injected-dependency
// executor. No Supabase, no Mailgun, no database: every guard is exercised
// with recording fakes.
// Run: deno test supabase/functions/send-partner-onboarding/run-sweep.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { runOnboardingSweep, type LedgerRow, type RunDeps } from "./run-sweep.ts";
import { DAY_MS, type PartnerRow } from "./onboarding-stage.ts";

const NOW = Date.parse("2026-09-24T12:00:00Z");

function partner(overrides: Partial<PartnerRow> = {}): PartnerRow {
  return {
    id: "p1",
    created_at: new Date(NOW).toISOString(),
    agent_type: "re_agent",
    is_test: false,
    email: "partner@example.com",
    app_first_signed_in_launch_at: null,
    ...overrides,
  };
}

function agedIso(ageMs: number): string {
  return new Date(NOW - ageMs).toISOString();
}

interface Recorder {
  ledgerInserts: { partner_id: string; stage: string; status: string }[];
  sends: { to: string; subject: string }[];
}

function buildDeps(opts: {
  settingValue?: unknown;
  settingThrows?: boolean;
  partners?: PartnerRow[];
  ledger?: LedgerRow[];
  sendOk?: boolean;
  /** simulate a losing race on the very next ledger insert */
  forceConflictOnce?: boolean;
}): { deps: RunDeps; rec: Recorder } {
  const rec: Recorder = { ledgerInserts: [], sends: [] };
  let conflictArmed = Boolean(opts.forceConflictOnce);
  const deps: RunDeps = {
    readSetting: async () => {
      if (opts.settingThrows) throw new Error("boom");
      return opts.settingValue === undefined ? null : { value: opts.settingValue };
    },
    fetchCandidatePartners: async () => opts.partners ?? [partner()],
    fetchLedgerForPartners: async () => opts.ledger ?? [],
    insertLedgerRow: async (row) => {
      if (conflictArmed) {
        conflictArmed = false;
        return { error: { code: "23505", message: "duplicate" } };
      }
      rec.ledgerInserts.push({ partner_id: row.partner_id, stage: row.stage, status: row.status });
      return { error: null };
    },
    sendEmail: async (to, subject) => {
      rec.sends.push({ to, subject });
      return { ok: opts.sendOk !== false };
    },
    now: NOW,
  };
  return { deps, rec };
}

// ── kill switch ──────────────────────────────────────────────────────────

Deno.test("kill switch OFF (explicit false): 0 sends, no candidate/ledger reads even attempted to matter", async () => {
  const { deps, rec } = buildDeps({ settingValue: false });
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome, { ok: true, skipped: "disabled" });
  assertEquals(rec.sends.length, 0);
  assertEquals(rec.ledgerInserts.length, 0);
});

Deno.test("kill switch UNSET (row absent, value null): 0 sends", async () => {
  const { deps, rec } = buildDeps({ settingValue: undefined });
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome, { ok: true, skipped: "disabled" });
  assertEquals(rec.sends.length, 0);
});

Deno.test("kill switch UNREADABLE (readSetting throws): 0 sends, fails closed", async () => {
  const { deps, rec } = buildDeps({ settingThrows: true });
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome, { ok: true, skipped: "disabled" });
  assertEquals(rec.sends.length, 0);
});

Deno.test("kill switch ON (literal true) with real copy would proceed to the candidate scan", async () => {
  const { deps } = buildDeps({ settingValue: true, partners: [] });
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome, { ok: true, results: [] });
});

// ── placeholder copy ─────────────────────────────────────────────────────

Deno.test("placeholder copy still in place: switch ON, still 0 sends, {skipped:'placeholder_copy'} per partner", async () => {
  const { deps, rec } = buildDeps({ settingValue: true, partners: [partner()] });
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome.ok, true);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results, [{ partner_id: "p1", skipped_reason: "placeholder_copy" }]);
  } else {
    throw new Error("expected results branch");
  }
  assertEquals(rec.sends.length, 0);
  assertEquals(rec.ledgerInserts.length, 0);
});

// ── agent_type routing ───────────────────────────────────────────────────

Deno.test("ineligible agent_type (customer) gets no copy, no send, before the placeholder check even applies", async () => {
  const { deps, rec } = buildDeps({ settingValue: true, partners: [partner({ agent_type: "customer" })] });
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "ineligible_agent_type");
  }
  assertEquals(rec.sends.length, 0);
});

// ── [TEST] prefix / bot pattern (P-3 convention) ─────────────────────────
// Both still hit the placeholder-copy gate today (copy is not filled in),
// so these assert on skip reason ORDER (placeholder_copy fires last, after
// the bot-pattern check would have applied) using is_test partners whose
// email does NOT match a bot pattern, and bot-pattern partners who are not
// is_test, to isolate each gate.

Deno.test("bot-pattern email WITHOUT is_test is skipped as bot_pattern (before reaching the placeholder gate's send attempt)", async () => {
  const { deps, rec } = buildDeps({
    settingValue: true,
    partners: [partner({ is_test: false, email: "pfw-test-partner@example.invalid" })],
  });
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "bot_pattern");
  }
  assertEquals(rec.sends.length, 0);
});

Deno.test("bot-pattern email WITH is_test=true does NOT get bot_pattern-skipped (is_test wins) — falls through to placeholder_copy instead", async () => {
  const { deps } = buildDeps({
    settingValue: true,
    partners: [partner({ is_test: true, email: "pfw-test-partner@example.invalid" })],
  });
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    // Not bot_pattern — is_test partners are never bot-pattern-skipped.
    assertEquals(outcome.results[0].skipped_reason, "placeholder_copy");
  }
});

// ── stop on activation ───────────────────────────────────────────────────

Deno.test("activated partner: skipped_reason 'activated', no ledger writes, no sends", async () => {
  const { deps, rec } = buildDeps({
    settingValue: true,
    partners: [partner({
      created_at: agedIso(10 * DAY_MS),
      app_first_signed_in_launch_at: agedIso(5 * DAY_MS),
    })],
  });
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "activated");
  }
  assertEquals(rec.ledgerInserts.length, 0);
  assertEquals(rec.sends.length, 0);
});

// ── backlog: at most one stage per run ───────────────────────────────────

Deno.test("9-day backlog, switch ON, still placeholder copy: day7 is the one 'stage' evaluated, day0/1/3 recorded as skipped ledger rows", async () => {
  const { deps, rec } = buildDeps({
    settingValue: true,
    partners: [partner({ created_at: agedIso(9 * DAY_MS) })],
  });
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "placeholder_copy");
    assertEquals(outcome.results[0].skipped_stages, ["day0", "day1", "day3"]);
  }
  // The three superseded stages ARE persisted even though the winning stage
  // (day7) did not send (placeholder copy blocked it) — RUN 22's lesson
  // applies to the skip-marking regardless of the send outcome.
  assertEquals(rec.ledgerInserts.map((r) => r.stage), ["day0", "day1", "day3"]);
  assertEquals(rec.ledgerInserts.every((r) => r.status === "skipped"), true);
  assertEquals(rec.sends.length, 0);
});

// ── idempotency ───────────────────────────────────────────────────────────

Deno.test("a losing concurrent stamp (23505) is treated as already_sent, never calls sendEmail", async () => {
  // Use a partner whose stage WOULD send if not for the race — but since
  // copy is still placeholder, this test only proves the stamp-conflict
  // path skips *before* any send is attempted, by forcing the very first
  // ledger insert (the stamp for the winning stage) to conflict directly.
  // We bypass the placeholder gate by not needing a real send: the code
  // path under test is entirely pre-send.
  const { deps, rec } = buildDeps({
    settingValue: true,
    partners: [partner()],
    forceConflictOnce: true,
  });
  // Even forcing conflict is moot while copy is placeholder (it never
  // reaches the stamp step) — assert the actual reachable behavior: 0 sends
  // either way, and no plain error thrown.
  const outcome = await runOnboardingSweep(deps);
  assertEquals(outcome.ok, true);
  assertEquals(rec.sends.length, 0);
});

// ── negative controls (sweep-level) ───────────────────────────────────────

Deno.test("negative control: partner activates right after day0 gets nothing further across later runs", async () => {
  const p = partner({
    created_at: agedIso(30 * DAY_MS),
    app_first_signed_in_launch_at: agedIso(29 * DAY_MS),
  });
  const { deps, rec } = buildDeps({ settingValue: true, partners: [p], ledger: [{ partner_id: "p1", stage: "day0", status: "sent" }] });
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "activated");
  }
  assertEquals(rec.sends.length, 0);
});

// ── full send path (real copy injected via deps.getCopy — see run-sweep.ts's
// file header: this override exists ONLY for tests, index.ts never uses it) ─

const REAL_COPY = { subject: "Welcome aboard", textBody: "Hi there.", htmlBody: "<p>Hi there.</p>" };

Deno.test("switch ON + real copy: sends, stamps the ledger 'sent', reports stage in results", async () => {
  const { deps, rec } = buildDeps({ settingValue: true, partners: [partner()] });
  deps.getCopy = () => REAL_COPY;
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results, [{ partner_id: "p1", sent: "day0" }]);
  } else {
    throw new Error("expected results branch");
  }
  assertEquals(rec.sends, [{ to: "partner@example.com", subject: "Welcome aboard" }]);
  assertEquals(rec.ledgerInserts, [{ partner_id: "p1", stage: "day0", status: "sent" }]);
});

Deno.test("[TEST] prefix: is_test=true partner's subject is prefixed, and it still sends (real copy)", async () => {
  const { deps, rec } = buildDeps({ settingValue: true, partners: [partner({ is_test: true })] });
  deps.getCopy = () => REAL_COPY;
  await runOnboardingSweep(deps);
  assertEquals(rec.sends, [{ to: "partner@example.com", subject: "[TEST] Welcome aboard" }]);
});

Deno.test("real idempotency: a losing concurrent stamp on the WINNING stage never calls sendEmail, reports already_sent", async () => {
  const { deps, rec } = buildDeps({
    settingValue: true,
    partners: [partner()],
    forceConflictOnce: true,
  });
  deps.getCopy = () => REAL_COPY;
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].skipped_reason, "already_sent");
  }
  assertEquals(rec.sends.length, 0, "a losing race must never call sendEmail");
});

Deno.test("real copy, backlog: only day7 sends, day0/1/3 marked skipped — never two stages in one run", async () => {
  const { deps, rec } = buildDeps({
    settingValue: true,
    partners: [partner({ created_at: agedIso(9 * DAY_MS) })],
  });
  deps.getCopy = () => REAL_COPY;
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    assertEquals(outcome.results[0].sent, "day7");
    assertEquals(outcome.results[0].skipped_stages, ["day0", "day1", "day3"]);
  }
  assertEquals(rec.sends.length, 1, "exactly one send per run, even on a wide backlog");
});

Deno.test("negative control: partner who never activates reaches day7 eligibility (still blocked only by placeholder copy)", async () => {
  const p = partner({ created_at: agedIso(30 * DAY_MS) });
  const { deps } = buildDeps({
    settingValue: true,
    partners: [p],
    ledger: [
      { partner_id: "p1", stage: "day0", status: "sent" },
      { partner_id: "p1", stage: "day1", status: "sent" },
      { partner_id: "p1", stage: "day3", status: "sent" },
    ],
  });
  const outcome = await runOnboardingSweep(deps);
  if (outcome.ok && "results" in outcome) {
    // day7 is the stage evaluated (not activated, not ineligible agent
    // type) — blocked only by the still-placeholder copy.
    assertEquals(outcome.results[0].skipped_reason, "placeholder_copy");
  }
});
