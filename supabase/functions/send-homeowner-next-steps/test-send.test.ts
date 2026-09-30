// gh-2069 — claim-scoped test send (path (a), CTO ruling 5869465122).
//
// Fakes for the DB and Mailgun; the delivery is the REAL deliverStage() so
// "one send through the same deliver path" is asserted against production
// code, not a stand-in. The wiring test at the bottom reads index.ts itself so
// the flag tests also fail against a main that has no flag.
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { type DeliverDeps, deliverStage, type NotificationRow } from "./deliver-stage.ts";
import { buildCandidateQuery, type CandidateQueryBuilder } from "./dry-run.ts";
import {
  isTestAliasEmail,
  parseTestSend,
  runTestSend,
  TEST_SEND_MAX_CLAIMS,
  type TestSendClaim,
  type TestSendDeps,
  type TestSendProfile,
  testSendAuthorized,
  validateRequestBody,
  ALLOWED_BODY_KEYS,
} from "./test-send.ts";

const CLAIM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ALIAS_A = "dustinstohler1+gh2069-a@gmail.com";
const ALIAS_B = "dustinstohler1+gh2069-b@gmail.com";
const NOW = Date.parse("2026-09-29T12:00:00Z");
const OLD = "2026-09-20T00:00:00Z"; // > 48h before NOW, no prior stamp -> '48h'

interface World {
  claims: TestSendClaim[];
  profiles: TestSendProfile[];
  hover?: string[];
  activity?: { user_id: string; event_type: string; metadata?: Record<string, string> | null; created_at: string }[];
  optedOut?: string[];
  mailgun?: boolean;
  /** Claims that pass the production candidate predicates. Default: all is_test claims. */
  candidates?: string[];
}

function build(w: World) {
  const writes: { table: string; row: unknown }[] = [];
  const sent: string[] = [];
  const reads: string[] = [];
  const notifications: NotificationRow[] = [];

  const deliverDeps: DeliverDeps = {
    dryRun: false,
    mailgunConfigured: w.mailgun ?? true,
    buildEmail: (name, m, c, o) => ({
      subject: "You're one step from bids",
      textBody: `Hi ${name}\n${m} ${c}\n${o}`,
      htmlBody: `<a href="${o}">stop</a>`,
    }),
    insertActivityLog: (row) => {
      writes.push({ table: "activity_log", row });
      return Promise.resolve({ error: null });
    },
    sendEmail: (to) => {
      sent.push(to);
      return Promise.resolve({ ok: true, mailgunId: "<20260929.abc@mail.otterquote.com>" });
    },
    insertNotification: (row) => {
      writes.push({ table: "notifications", row });
      notifications.push(row);
      return Promise.resolve({ error: null });
    },
  };

  const deps: TestSendDeps = {
    mailgunConfigured: w.mailgun ?? true,
    now: NOW,
    nudgeEventType: "next_steps_nudge_sent",
    optOutEventType: "homeowner_email_optout",
    fetchClaimsByIds: (ids) => {
      reads.push("claims");
      return Promise.resolve({ rows: w.claims.filter((c) => ids.includes(c.id)), error: null });
    },
    fetchProfilesByIds: (ids) => {
      reads.push("profiles");
      return Promise.resolve({ rows: w.profiles.filter((p) => ids.includes(p.id)), error: null });
    },
    fetchAuthContact: () => Promise.resolve({ email: null, name: null }),
    fetchCandidateClaims: (ids) => {
      reads.push("candidates");
      const ok = new Set(w.candidates ?? w.claims.filter((c) => c.is_test).map((c) => c.id));
      return Promise.resolve({ rows: w.claims.filter((c) => ids.includes(c.id) && ok.has(c.id)), error: null });
    },
    fetchHoverClaimIds: () => Promise.resolve({ ids: w.hover ?? [], error: null }),
    fetchActivity: () => Promise.resolve({ rows: (w.activity ?? []) as never, error: null }),
    fetchOptedOut: () => Promise.resolve({ optedOut: new Set(w.optedOut ?? []), error: null }),
    // Same real deliverStage production uses; only its I/O deps are fakes.
    deliver: ({ claim, stage, homeownerEmail, homeownerName }) =>
      deliverStage(deliverDeps, {
        claimId: claim.id,
        userId: claim.user_id,
        stage,
        homeownerEmail,
        homeownerName,
        measurementsUrl: "https://otterquote.com/help-measurements.html",
        colorUrl: `https://otterquote.com/color-selection.html?claim_id=${claim.id}`,
        optOutUrl: "https://example.invalid/optout?t=T",
      }),
  };
  return { deps, writes, sent, reads, notifications };
}

const testClaim = (id: string, user: string, is_test: boolean | null = true): TestSendClaim => ({
  id, user_id: user, status: "documents_needed", created_at: OLD, is_test,
});
const profile = (id: string, email: string | null, is_test: boolean | null = true): TestSendProfile => ({
  id, email, full_name: "Test Homeowner", is_test,
});

function assertRefused(res: { status: number; body: Record<string, unknown> }, h: ReturnType<typeof build>) {
  assertEquals(res.status, 400);
  assertEquals(res.body.ok, false);
  assertEquals(h.sent.length, 0, "no email may be sent");
  assertEquals(h.writes.length, 0, "nothing may be written (no notifications row, no stamp)");
  assert(!h.reads.includes("candidates"), "a refused request must not even reach the production scan");
}

// ── the cases in the brief ───────────────────────────────────────────────────

Deno.test("real (is_test=false) claim id -> 400, zero sends, zero writes", async () => {
  const h = build({ claims: [testClaim(CLAIM_A, USER_A, false)], profiles: [profile(USER_A, ALIAS_A)] });
  assertRefused(await runTestSend(h.deps, [CLAIM_A]), h);
});

Deno.test("is_test claim whose owner email is a non-alias -> 400", async () => {
  for (const email of [
    "dustinstohler1@gmail.com", // the bare address, not a plus-alias
    "someone.real@gmail.com",
    "dustinstohler1+a@gmail.com.evil.example",
    "xdustinstohler1+a@gmail.com",
    "dustinstohler1+A@gmail.com", // case-sensitive: fail closed
    "dustinstohler1+a@gmail.com\n",
    "dustinstohler1+@gmail.com",
    null,
  ]) {
    const h = build({ claims: [testClaim(CLAIM_A, USER_A)], profiles: [profile(USER_A, email)] });
    assertRefused(await runTestSend(h.deps, [CLAIM_A]), h);
  }
});

Deno.test("is_test claim + alias -> exactly one send, through the real deliverStage, real notifications row", async () => {
  const h = build({ claims: [testClaim(CLAIM_A, USER_A)], profiles: [profile(USER_A, ALIAS_A)] });
  const res = await runTestSend(h.deps, [CLAIM_A]);
  assertEquals(res.status, 200);
  assertEquals(res.body.processed, 1);
  assertEquals(h.sent, [ALIAS_A]);
  assertEquals(h.notifications.length, 1);
  assertEquals(h.notifications[0].notification_type, "homeowner_next_steps_48h");
  assertEquals(h.notifications[0].claim_id, CLAIM_A);
  assertEquals(h.notifications[0].recipient, ALIAS_A);
  assertEquals(h.notifications[0].delivered, true);
  assertEquals(h.notifications[0].mailgun_id, "<20260929.abc@mail.otterquote.com>");
  // deliverStage's own idempotency stamp is the only other write
  assertEquals(h.writes.map((w) => w.table).sort(), ["activity_log", "notifications"]);
  // the response never echoes a recipient address
  assert(!JSON.stringify(res.body).includes("@"));
});

Deno.test("no / wrong / absent CRON_SECRET -> not authorized (including the permissive unset-secret branch)", () => {
  const svc = "service-role-key";
  assertEquals(testSendAuthorized({ cronSecret: "s3cret", incomingCronSecret: null, authHeader: "", serviceRoleKey: svc }), false);
  assertEquals(testSendAuthorized({ cronSecret: "s3cret", incomingCronSecret: "nope", authHeader: "", serviceRoleKey: svc }), false);
  assertEquals(testSendAuthorized({ cronSecret: "s3cret", incomingCronSecret: null, authHeader: "Bearer other", serviceRoleKey: svc }), false);
  // CRON_SECRET unset: the batch gate fails OPEN; the test send must not.
  assertEquals(testSendAuthorized({ cronSecret: undefined, incomingCronSecret: null, authHeader: "", serviceRoleKey: svc }), false);
  assertEquals(testSendAuthorized({ cronSecret: "s3cret", incomingCronSecret: "s3cret", authHeader: "", serviceRoleKey: svc }), true);
  assertEquals(testSendAuthorized({ cronSecret: "s3cret", incomingCronSecret: null, authHeader: `Bearer ${svc}`, serviceRoleKey: svc }), true);
});

Deno.test("mixed list (one bad) -> 400, nothing sent, nothing written, the good claim is NOT sent", async () => {
  const h = build({
    claims: [testClaim(CLAIM_A, USER_A), testClaim(CLAIM_B, USER_B, false)],
    profiles: [profile(USER_A, ALIAS_A), profile(USER_B, ALIAS_B)],
  });
  assertRefused(await runTestSend(h.deps, [CLAIM_A, CLAIM_B]), h);
  // and with the bad one being the recipient rather than the claim flag
  const h2 = build({
    claims: [testClaim(CLAIM_A, USER_A), testClaim(CLAIM_B, USER_B)],
    profiles: [profile(USER_A, ALIAS_A), profile(USER_B, "real.person@gmail.com")],
  });
  assertRefused(await runTestSend(h2.deps, [CLAIM_A, CLAIM_B]), h2);
});

Deno.test("claim is_test but OWNER profile is not is_test -> 400", async () => {
  for (const flag of [false, null]) {
    const h = build({ claims: [testClaim(CLAIM_A, USER_A)], profiles: [profile(USER_A, ALIAS_A, flag)] });
    assertRefused(await runTestSend(h.deps, [CLAIM_A]), h);
  }
});

Deno.test("claim with is_test null (unknown) -> 400", async () => {
  const h = build({ claims: [testClaim(CLAIM_A, USER_A, null)], profiles: [profile(USER_A, ALIAS_A)] });
  assertRefused(await runTestSend(h.deps, [CLAIM_A]), h);
});

Deno.test("missing claim / missing owner profile -> 400", async () => {
  const h = build({ claims: [], profiles: [] });
  assertRefused(await runTestSend(h.deps, [CLAIM_A]), h);
  const h2 = build({ claims: [testClaim(CLAIM_A, USER_A)], profiles: [] });
  assertRefused(await runTestSend(h2.deps, [CLAIM_A]), h2);
});

Deno.test("Mailgun not configured -> refused, nothing written (deliverStage would otherwise record a 'sent' that never left)", async () => {
  const h = build({ claims: [testClaim(CLAIM_A, USER_A)], profiles: [profile(USER_A, ALIAS_A)], mailgun: false });
  const res = await runTestSend(h.deps, [CLAIM_A]);
  assertEquals(res.status, 409);
  assertEquals(h.sent.length, 0);
  assertEquals(h.writes.length, 0);
});

Deno.test("a valid test claim that fails the production screen sends nothing (opted out / hover order / real activity / not a candidate)", async () => {
  const base = { claims: [testClaim(CLAIM_A, USER_A)], profiles: [profile(USER_A, ALIAS_A)] };
  const cases: [string, Partial<World>][] = [
    ["opted_out", { optedOut: [CLAIM_A] }],
    ["has_hover_order", { hover: [CLAIM_A] }],
    ["real_activity_since_created", { activity: [{ user_id: USER_A, event_type: "login", created_at: "2026-09-25T00:00:00Z" }] }],
    ["not_a_candidate", { candidates: [] }],
  ];
  for (const [reason, extra] of cases) {
    const h = build({ ...base, ...extra });
    const res = await runTestSend(h.deps, [CLAIM_A]);
    assertEquals(res.status, 200, reason);
    assertEquals(h.sent.length, 0, reason);
    assertEquals(h.writes.length, 0, reason);
    assertEquals((res.body.results as { skipped_reason?: string }[])[0].skipped_reason, reason);
  }
});

Deno.test("two valid test claims -> exactly two sends, one per claim, each to its own alias", async () => {
  const h = build({
    claims: [testClaim(CLAIM_A, USER_A), testClaim(CLAIM_B, USER_B)],
    profiles: [profile(USER_A, ALIAS_A), profile(USER_B, ALIAS_B)],
  });
  const res = await runTestSend(h.deps, [CLAIM_A, CLAIM_B]);
  assertEquals(res.status, 200);
  assertEquals(h.sent.sort(), [ALIAS_A, ALIAS_B]);
});

// ── request parsing ─────────────────────────────────────────────────────────

Deno.test("parseTestSend: empty / non-array / non-uuid / duplicate / over-cap -> invalid", () => {
  const over = Array.from({ length: TEST_SEND_MAX_CLAIMS + 1 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`);
  for (const v of [[], "x", null, undefined, {}, 7, ["not-a-uuid"], [CLAIM_A, CLAIM_A], [CLAIM_A, 5], over]) {
    assertEquals(parseTestSend({ test_send_claim_ids: v }).kind, "invalid", JSON.stringify(v));
  }
  assertEquals(parseTestSend({ test_send_claim_ids: [CLAIM_A, CLAIM_B] }), { kind: "ok", claimIds: [CLAIM_A, CLAIM_B] });
  assertEquals(parseTestSend({ test_send_claim_ids: [CLAIM_A.toUpperCase()] }), { kind: "ok", claimIds: [CLAIM_A] });
});

Deno.test("alias regex is exactly the ruling's", () => {
  assert(isTestAliasEmail("dustinstohler1+gh-2069@gmail.com"));
  assert(!isTestAliasEmail("dustinstohler1@gmail.com"));
  assert(!isTestAliasEmail(""));
  assert(!isTestAliasEmail(undefined));
});

// ── regression: the normal cron path is unchanged ───────────────────────────

Deno.test("REGRESSION: normal cron / dry-run bodies parse to 'absent' (flag inert without the key)", () => {
  for (const body of [{}, null, undefined, "", [], { dry_run: true }, { dry_run: false }, { admin_digest_preview: true }, { health_check: true }]) {
    assertEquals(parseTestSend(body).kind, "absent", JSON.stringify(body));
  }
});

Deno.test("REGRESSION: the production candidate scan is byte-for-byte the same calls (is_test=false, no id filter)", () => {
  const calls: [string, unknown[]][] = [];
  const b: CandidateQueryBuilder = new Proxy({} as CandidateQueryBuilder, {
    get: (_t, name: string) => (...args: unknown[]) => {
      calls.push([name, args]);
      return b;
    },
  });
  buildCandidateQuery(b, {
    scanIsTest: false, eligibleStatus: "documents_needed", excludedStatus: "draft", cutoffIso: "C", limit: 200,
  });
  assertEquals(calls, [
    ["select", ["id, user_id, status, created_at, is_test"]],
    ["eq", ["is_test", false]],
    ["eq", ["status", "documents_needed"]],
    ["neq", ["status", "draft"]],
    ["eq", ["ready_for_bids", false]],
    ["eq", ["has_measurements", false]],
    ["lte", ["created_at", "C"]],
    ["limit", [200]],
  ]);
});

// ── wiring: index.ts itself (fails against a main with no flag) ─────────────

Deno.test("WIRING: index.ts gates the flag behind auth, refuses before any side effect, and shares one deliverStage dep object", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert(i >= 0, `index.ts must contain: ${needle}`);
    return i;
  };
  const authGate = at('return jsonResponse({ ok: false, error: "Unauthorized" }');
  const parse = at("parseTestSend(requestBody)");
  const positiveAuth = at("testSendAuthorized(");
  const optOutGate = at("canSendWithOptOut(optOutSecret)");
  const run = at("runTestSend(");
  const welcome = at("homeowner_welcome first-touch hook");
  const digest = at("const stalledForDigest");
  assert(authGate < parse && parse < positiveAuth, "flag is parsed only after the CRON_SECRET gate, then positively authorized");
  assert(positiveAuth < optOutGate && optOutGate < run, "runs after the opt-out-secret gate");
  assert(run < welcome && run < digest, "test-send returns before welcome / checklist / digest");
  // one deliverStage dep object for cron and test send
  assertEquals(src.split("buildNudgeDeliverDeps(").length - 1, 2, "called by the cron loop and by the test send (definition is `= (`)");
  assertEquals(src.split("await deliverStage(").length - 1, 1, "only the cron loop awaits deliverStage directly");
  // the test-send candidate scan is the production one, pinned to is_test=true
  assert(src.includes("scanIsTest: true"));
});

Deno.test("BODY KEYS: unknown key -> 400 (no run), including typos of test_send_claim_ids", () => {
  const typos = ["test_send_claim_id", "testSendClaimIds", "Test_Send_Claim_Ids", "test_send_claim_ids ", "test-send-claim-ids", "dryrun", "dry_run_", "foo"];
  for (const k of typos) {
    const r = validateRequestBody(JSON.stringify({ [k]: ["x"] }));
    assertEquals(r.ok, false, `key ${JSON.stringify(k)} must be rejected`);
  }
  // one legitimate key does not launder an unknown one
  assertEquals(validateRequestBody(JSON.stringify({ dry_run: true, extra: 1 })).ok, false);
  assertEquals(validateRequestBody(JSON.stringify({ test_send_claim_ids: ["a"], test_send_claim_id: ["b"] })).ok, false);
});

Deno.test("BODY KEYS: every legitimate caller body still passes (v113 cron sends '{}')", () => {
  const legit = [
    "{}",
    "",
    "   ",
    "null",
    '{"dry_run":true}',
    '{"dry_run":true,"admin_digest_preview":true}',
    '{"health_check":true}',
    '{"test_send_claim_ids":["11111111-1111-4111-8111-111111111111"]}',
  ];
  for (const t of legit) assertEquals(validateRequestBody(t).ok, true, `must pass: ${JSON.stringify(t)}`);
  assertEquals([...ALLOWED_BODY_KEYS].sort(), ["admin_digest_preview", "dry_run", "health_check", "test_send_claim_ids"]);
});

Deno.test("BODY KEYS: empty body is the normal cron run (parses to absent, flags off)", () => {
  const r = validateRequestBody("");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(parseTestSend(r.body), { kind: "absent" });
});

Deno.test("BODY KEYS: malformed JSON and non-object bodies are refused, not run as cron", () => {
  for (const t of ['{"test_send_claim_ids": ["a"]', "[1]", '"x"', "7", "not json"]) {
    assertEquals(validateRequestBody(t).ok, false, `must reject: ${t}`);
  }
});

Deno.test("WIRING: index.ts validates the body right after the auth gate, before any flag or side effect", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert(i >= 0, `index.ts must contain: ${needle}`);
    return i;
  };
  const authGate = at('return jsonResponse({ ok: false, error: "Unauthorized" }');
  const validate = at("validateRequestBody(");
  const dryParse = at("parseDryRun(requestBody)");
  const testParse = at("parseTestSend(requestBody)");
  assert(authGate < validate && validate < dryParse && validate < testParse, "body validated after auth, before any flag is parsed");
  assertEquals(src.split("req.clone().json()").length - 1, 1, "only the health_check peek still parses the body loosely");
});
