// gh-1933 review fix (D1) — integration-shaped tests for the digest executor,
// porting ./deliver-stage.test.ts's PROPERTY / NEGATIVE CONTROL shape onto
// fakes for runAdminDigest, plus the D2 preview properties.
//
// CTO RUN 31 review (cto31-pr1957-review-20260915.md) proved this coverage
// was missing by mutating index.ts three ways and getting 81/81 green each
// time. Those three mutants are ported below against THIS file's fakes; see
// the "MUTANT" comments for exactly which one-line change each corresponds
// to and how to reproduce it against the real source for proof.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  type AdminDigestDeps,
  isDigestCandidate,
  parseAdminDigestPreview,
  runAdminDigest,
} from "./admin-digest-executor.ts";
import { ADMIN_DIGEST_EMAIL, ADMIN_DIGEST_NOTIFICATION_TYPE, type StalledCandidate } from "./admin-digest.ts";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const SITE_URL = "https://otterquote.com";

function candidate(over: Partial<StalledCandidate> = {}): StalledCandidate {
  return {
    claimId: "claim-1",
    userId: "user-1",
    email: "nick@example.com",
    createdAtIso: "2026-09-12T12:00:00.000Z",
    ...over,
  };
}

function fakes(opts: {
  alreadyDigested?: ReadonlySet<string>;
  fetchError?: string;
  sendOk?: boolean;
  mailgun?: boolean;
  insertError?: string | null;
} = {}) {
  const sentCalls: { subject: string; textBody: string; htmlBody: string }[] = [];
  const insertedRows: Record<string, unknown>[][] = [];
  const fetchCalls: { claimIds: string[]; todayStartIso: string }[] = [];

  const deps: AdminDigestDeps = {
    fetchAlreadyDigestedToday: (claimIds, todayStartIso) => {
      fetchCalls.push({ claimIds: [...claimIds], todayStartIso });
      if (opts.fetchError) return Promise.resolve({ claimIds: new Set(), error: opts.fetchError });
      return Promise.resolve({ claimIds: opts.alreadyDigested ?? new Set() });
    },
    sendAdminDigestMail: (subject, textBody, htmlBody) => {
      sentCalls.push({ subject, textBody, htmlBody });
      if (opts.sendOk === false) return Promise.resolve({ ok: false, error: "Mailgun 500" });
      return Promise.resolve({ ok: true, mailgunId: "mg-1" });
    },
    insertNotificationRows: (rows) => {
      insertedRows.push(rows);
      return Promise.resolve({ error: opts.insertError ?? null });
    },
    mailgunConfigured: opts.mailgun ?? true,
    now: NOW,
  };
  return { deps, sentCalls, insertedRows, fetchCalls };
}

// ─── isDigestCandidate (D1/D3) ──────────────────────────────────────────────

Deno.test("isDigestCandidate: only '48h' is a digest candidate", () => {
  assertEquals(isDigestCandidate("48h"), true);
  assertEquals(isDigestCandidate("2h"), false);
  assertEquals(isDigestCandidate(null), false);
});

// ─── parseAdminDigestPreview ────────────────────────────────────────────────

Deno.test("parseAdminDigestPreview: literal true only, never coerced", () => {
  assertEquals(parseAdminDigestPreview({ admin_digest_preview: true }), true);
  assertEquals(parseAdminDigestPreview({ admin_digest_preview: "true" }), false);
  assertEquals(parseAdminDigestPreview({ admin_digest_preview: 1 }), false);
  assertEquals(parseAdminDigestPreview({}), false);
  assertEquals(parseAdminDigestPreview(null), false);
  assertEquals(parseAdminDigestPreview(undefined), false);
});

// ─── PROPERTY: a dry run (no preview) makes ZERO Mailgun calls and ZERO
// notification inserts ────────────────────────────────────────────────────

Deno.test("PROPERTY — dry run without preview: zero Mailgun calls, zero notification inserts", async () => {
  const { deps, sentCalls, insertedRows, fetchCalls } = fakes();
  const result = await runAdminDigest(deps, {
    dryRun: true,
    previewSend: false,
    candidates: [candidate()],
    siteUrl: SITE_URL,
  });
  assertEquals(sentCalls.length, 0);
  assertEquals(insertedRows.length, 0);
  assertEquals(fetchCalls.length, 0);
  assertEquals(result.sent, 0);
  assert(result.wouldDigest);
  assertEquals(result.wouldDigest!.length, 1);
  assertEquals(result.wouldDigest![0].claim_id, "claim-1");
  assertEquals(result.wouldDigest![0].masked_email, "n***@example.com");
});

Deno.test("would_digest never carries the real email address", async () => {
  const { deps } = fakes();
  const result = await runAdminDigest(deps, {
    dryRun: true,
    previewSend: false,
    candidates: [candidate({ email: "george@hotmail.com" })],
    siteUrl: SITE_URL,
  });
  const serialized = JSON.stringify(result.wouldDigest);
  assertEquals(serialized.includes("george@hotmail.com"), false);
});

// ─── PROPERTY: a real run with candidates sends exactly one admin digest and
// inserts one notifications row per claim; a failed send inserts nothing ───

Deno.test("PROPERTY — real run: exactly one digest send, one notification row per claim", async () => {
  const { deps, sentCalls, insertedRows } = fakes();
  const result = await runAdminDigest(deps, {
    dryRun: false,
    previewSend: false,
    candidates: [candidate({ claimId: "c1" }), candidate({ claimId: "c2" })],
    siteUrl: SITE_URL,
  });
  assertEquals(sentCalls.length, 1);
  assertEquals(insertedRows.length, 1);
  assertEquals(insertedRows[0].length, 2);
  assertEquals(result.sent, 2);
  assert(!sentCalls[0].subject.startsWith("[DRY RUN PREVIEW]"));
});

Deno.test("PROPERTY — real run: a failed send inserts nothing", async () => {
  const { deps, insertedRows } = fakes({ sendOk: false });
  const result = await runAdminDigest(deps, {
    dryRun: false,
    previewSend: false,
    candidates: [candidate()],
    siteUrl: SITE_URL,
  });
  assertEquals(insertedRows.length, 0);
  assertEquals(result.sent, 0);
  assertEquals(result.error, "Mailgun 500");
});

// ─── PROPERTY: a claim already digested today is not re-sent ──────────────

Deno.test("PROPERTY — dedup read honoured: a claim already digested today is excluded", async () => {
  const { deps, sentCalls, insertedRows } = fakes({ alreadyDigested: new Set(["c1"]) });
  const result = await runAdminDigest(deps, {
    dryRun: false,
    previewSend: false,
    candidates: [candidate({ claimId: "c1" }), candidate({ claimId: "c2" })],
    siteUrl: SITE_URL,
  });
  assertEquals(sentCalls.length, 1);
  assertEquals(insertedRows[0].length, 1);
  assertEquals((insertedRows[0][0] as { claim_id: string }).claim_id, "c2");
  assertEquals(result.sent, 1);
});

Deno.test("NEGATIVE CONTROL — every candidate already digested today: no send, no insert", async () => {
  const { deps, sentCalls, insertedRows } = fakes({ alreadyDigested: new Set(["c1"]) });
  const result = await runAdminDigest(deps, {
    dryRun: false,
    previewSend: false,
    candidates: [candidate({ claimId: "c1" })],
    siteUrl: SITE_URL,
  });
  assertEquals(sentCalls.length, 0);
  assertEquals(insertedRows.length, 0);
  assertEquals(result.sent, 0);
});

// ─── NEGATIVE CONTROL: a real run with zero candidates sends nothing ───────

Deno.test("NEGATIVE CONTROL — real run with zero candidates: no dedup read, no send, no insert", async () => {
  const { deps, sentCalls, insertedRows, fetchCalls } = fakes();
  const result = await runAdminDigest(deps, {
    dryRun: false,
    previewSend: false,
    candidates: [],
    siteUrl: SITE_URL,
  });
  assertEquals(fetchCalls.length, 0);
  assertEquals(sentCalls.length, 0);
  assertEquals(insertedRows.length, 0);
  assertEquals(result.sent, 0);
});

// ─── D2 — preview properties ────────────────────────────────────────────────

Deno.test("D2 PROPERTY — preview sends exactly one call to the admin, subject prefixed [DRY RUN PREVIEW]", async () => {
  const { deps, sentCalls } = fakes();
  const result = await runAdminDigest(deps, {
    dryRun: true,
    previewSend: true,
    candidates: [candidate({ claimId: "is-test-1" })],
    siteUrl: SITE_URL,
  });
  assertEquals(sentCalls.length, 1);
  assert(sentCalls[0].subject.startsWith("[DRY RUN PREVIEW] "));
  assertEquals(result.sent, 1);
  // Recipient is fixed at ADMIN_DIGEST_EMAIL inside sendAdminDigestMail's real
  // wiring (index.ts) — asserted here structurally via the constant this repo
  // uses everywhere else for the same recipient.
  assertEquals(ADMIN_DIGEST_EMAIL, "dustinstohler1@gmail.com");
});

Deno.test("D2 PROPERTY — preview writes zero notification rows", async () => {
  const { deps, insertedRows } = fakes();
  await runAdminDigest(deps, {
    dryRun: true,
    previewSend: true,
    candidates: [candidate()],
    siteUrl: SITE_URL,
  });
  assertEquals(insertedRows.length, 0);
});

Deno.test("D2 NEGATIVE CONTROL — preview with zero candidates sends nothing", async () => {
  const { deps, sentCalls, insertedRows } = fakes();
  const result = await runAdminDigest(deps, {
    dryRun: true,
    previewSend: true,
    candidates: [],
    siteUrl: SITE_URL,
  });
  assertEquals(sentCalls.length, 0);
  assertEquals(insertedRows.length, 0);
  assertEquals(result.sent, 0);
});

Deno.test("D2 PROPERTY — previewSend on a real run (dryRun=false) changes nothing", async () => {
  const { deps: depsPreview, sentCalls: sentPreview, insertedRows: insertedPreview } = fakes();
  const { deps: depsNoPreview, sentCalls: sentNoPreview, insertedRows: insertedNoPreview } = fakes();
  const resultPreview = await runAdminDigest(depsPreview, {
    dryRun: false,
    previewSend: true,
    candidates: [candidate({ claimId: "c1" })],
    siteUrl: SITE_URL,
  });
  const resultNoPreview = await runAdminDigest(depsNoPreview, {
    dryRun: false,
    previewSend: false,
    candidates: [candidate({ claimId: "c1" })],
    siteUrl: SITE_URL,
  });
  assertEquals(resultPreview.sent, resultNoPreview.sent);
  assertEquals(sentPreview.length, sentNoPreview.length);
  assertEquals(insertedPreview.length, insertedNoPreview.length);
  assert(!sentPreview[0].subject.startsWith("[DRY RUN PREVIEW]"));
});

// ─── MUTANT PROOFS (documentation of what CTO RUN 31 tried against index.ts;
// these three tests are what must go RED when the corresponding one-line
// mutant is applied to admin-digest-executor.ts — see the work order's
// pre-push mutant runs for the literal command output) ─────────────────────
//
// MUTANT A: remove the `if (input.dryRun) { ... }` gate (or change it to
//   `if (false)`) so a dry run falls through to the real-send branch below.
//   The test that catches this is "PROPERTY — dry run without preview: zero
//   Mailgun calls, zero notification inserts" above — it fails because a
//   dry run would then call sendAdminDigestMail and insertNotificationRows.
//
// MUTANT B: change `isDigestCandidate` to `return true;`. The test that
//   catches this is "isDigestCandidate: only '48h' is a digest candidate"
//   above — `isDigestCandidate("2h")` would then be `true`.
//
// MUTANT C: remove the `await deps.insertNotificationRows(markRows);` call
//   (and its error handling) in runAdminDigest's real-run branch. The tests
//   that catch this are "PROPERTY — real run: exactly one digest send, one
//   notification row per claim" (insertedRows.length would be 0, not 1) and
//   "PROPERTY — dedup read honoured" (a second run would re-send a claim
//   this run should have marked digested).
