// gh-2543: the two approved contract-halt notices.
// Run: deno test --no-check -A supabase/functions/docusign-webhook/halt-notice.test.ts
// All rows below are test fixtures that live only in this file's in-memory stub.

import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  contractorHaltHtml,
  contractorHaltSubject,
  contractorHaltText,
  formatUsd,
  HALT_MAIL_TIMEOUT_MS,
  HALT_NOTICE_INDEX,
  maskEmail,
  maskEmails,
  HALT_NOTICE_REPLY_TO,
  HALT_NOTICE_TYPE,
  HOMEOWNER_HALT_SUBJECT,
  homeownerHaltHtml,
  homeownerHaltText,
  type HaltMail,
  mailgunSender,
  sendHaltNotices,
} from "./halt-notice.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

// ---- the approved wording, quoted from #2543 comment 6279045419 (position A per 6290513370) ----
const HOMEOWNER_APPROVED =
  "You and Acme Roofing both signed the contract for 12 Test Lane, Zionsville, IN 46077. Before a contract goes forward, Otter Quotes checks that the signed price matches the bid you accepted. These did not match: the signed contract shows $13,561.00, and the bid you accepted was $13,560.00. Because of this, the signed contract has not gone forward through Otter Quotes. Nothing has been charged. You do not need to do anything right now. We will send you a corrected contract at $13,560.00 to sign. Your earlier signed copy stays on file, marked as replaced. Questions: reply to this email.";
const CONTRACTOR_APPROVED =
  "The contract you and the homeowner signed for Job #ABCD1234 shows $13,561.00. The bid the homeowner accepted on Otter Quotes was $13,560.00. Because the two differ, the platform has halted this contract. Because of this, the signed contract has not gone forward through Otter Quotes. No platform fee has been charged. Please do not schedule or start work. A corrected contract at $13,560.00 will be sent to both parties to sign. The earlier signed copy stays on file, marked as replaced.";

Deno.test("gh-2543 wording: homeowner text is the approved text verbatim plus only the footer", () => {
  assertEquals(
    homeownerHaltText("Acme Roofing", "12 Test Lane, Zionsville, IN 46077", 13561, 13560),
    `${HOMEOWNER_APPROVED}\n\n${POSTAL_ADDRESS}`,
  );
});

Deno.test("gh-2543 wording: contractor text is the approved text verbatim plus only the footer", () => {
  assertEquals(contractorHaltText("Job #ABCD1234", 13561, 13560), `${CONTRACTOR_APPROVED}\n\n${POSTAL_ADDRESS}`);
});

Deno.test("gh-2543 wording: HTML bodies carry the same approved sentences", () => {
  assert(homeownerHaltHtml("Acme Roofing", "12 Test Lane, Zionsville, IN 46077", 13561, 13560).includes(`<p>${HOMEOWNER_APPROVED}</p>`));
  assert(contractorHaltHtml("Job #ABCD1234", 13561, 13560).includes(`<p>${CONTRACTOR_APPROVED}</p>`));
});

Deno.test("gh-2543 wording: subjects and position (A) sentence", () => {
  assertEquals(HOMEOWNER_HALT_SUBJECT, "Your roofing contract needs one more signature");
  assertEquals(contractorHaltSubject("Job #ABCD1234"), "Contract for Job #ABCD1234 halted: price does not match the accepted bid");
  assertEquals(formatUsd(13561), "$13,561.00");
  // position (B) must not appear
  assertEquals(homeownerHaltText("A", "B", 2, 1).includes("treat the signed copy as replaced"), false);
});

// ---- in-memory stub of the supabase calls sendHaltNotices makes ----
function makeDb(opts: { homeownerEmail?: string | null; contractorEmails?: string[]; uniqueMarker?: boolean; blindCheck?: boolean; otherUnique?: boolean; deleteError?: { code: string; message: string }; deleteNoop?: boolean } = {}) {
  const tables: Record<string, Record<string, unknown>[]> = { notifications: [], platform_alerts_log: [] };
  const hEmail = "homeownerEmail" in opts ? opts.homeownerEmail : "ho@example.test";
  const cEmails = opts.contractorEmails ?? ["ct@example.test"];
  const fixtures: Record<string, Record<string, unknown>> = {
    claims: { user_id: "u1", property_address: "12 Test Lane, Zionsville, IN 46077" },
    profiles: { email: hEmail },
    contractors: { company_name: "Acme Roofing", email: cEmails[0] ?? null, notification_emails: cEmails.slice(1) },
  };
  // deno-lint-ignore no-explicit-any
  const db: any = {
    tables,
    from(t: string) {
      const filters: [string, unknown][] = [];
      let mode: "select" | "delete" = "select";
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select() { return q; },
        eq(c: string, v: unknown) { filters.push([c, v]); return q; },
        limit() { return q; },
        delete() { mode = "delete"; return q; },
        // blindCheck: the pre-insert SELECT always sees "no marker" -- two simultaneous deliveries that both passed the check.
        maybeSingle() { const r = opts.blindCheck ? undefined : (tables[t] ?? []).find((row) => filters.every(([k, v]) => row[k] === v)); return Promise.resolve({ data: r ?? null }); },
        single() { return Promise.resolve({ data: fixtures[t] ?? null }); },
        insert(row: Record<string, unknown>) {
          // uniqueMarker: the partial unique index in migrations_drafts/gh2543_halt_notice_marker_unique.sql
          if (opts.uniqueMarker && t === "notifications" && row.notification_type === HALT_NOTICE_TYPE &&
              (tables[t] ?? []).some((r) => r.notification_type === HALT_NOTICE_TYPE && r.message_preview === row.message_preview)) {
            return Promise.resolve({ error: { code: "23505", message: `duplicate key value violates unique constraint "${HALT_NOTICE_INDEX}"`, details: "Key (message_preview)=(envelope=env-test-1;role=homeowner) already exists." } });
          }
          // otherUnique: a 23505 from some OTHER constraint (not the halt-notice index)
          if (opts.otherUnique && t === "notifications" && row.notification_type === HALT_NOTICE_TYPE) {
            return Promise.resolve({ error: { code: "23505", message: 'duplicate key value violates unique constraint "notifications_pkey"', details: "Key (id)=(1) already exists." } });
          }
          (tables[t] ??= []).push(row);
          return Promise.resolve({ error: null });
        },
        then(res: (v: unknown) => unknown) {
          if (mode !== "delete") return Promise.resolve({ error: null }).then(res);
          // delete(): an error, a silent no-op (0 rows), or the real removal returning the removed rows
          if (opts.deleteError) return Promise.resolve({ data: null, error: opts.deleteError }).then(res);
          if (opts.deleteNoop) return Promise.resolve({ data: [], error: null }).then(res);
          const match = (r: Record<string, unknown>) => filters.every(([k, x]) => r[k] === x);
          const gone = (tables[t] ?? []).filter(match);
          tables[t] = (tables[t] ?? []).filter((r) => !match(r));
          return Promise.resolve({ data: gone, error: null }).then(res);
        },
      };
      return q;
    },
  };
  return db;
}

const noSentry = () => Promise.resolve();
function base(db: unknown, sent: HaltMail[], status = 200) {
  return {
    supabase: db, claimId: "claim-test-0abcd1234", envelopeId: "env-test-1",
    contractorId: "c1", signed: 13561, accepted: 13560, reportToSentry: noSentry,
    send: (m: HaltMail) => { sent.push(m); return Promise.resolve(status); },
  };
}

Deno.test("gh-2543 send: a halt sends exactly one homeowner notice and one contractor notice", async () => {
  const db = makeDb();
  const sent: HaltMail[] = [];
  const r = await sendHaltNotices(base(db, sent));
  assertEquals(r, { homeowner: "sent", contractor: "sent" });
  assertEquals(sent.length, 2);
  assertEquals(sent[0].to, "ho@example.test");
  assertEquals(sent[0].subject, HOMEOWNER_HALT_SUBJECT);
  assertMatch(sent[0].text, /^You and Acme Roofing both signed the contract for 12 Test Lane/);
  assertEquals(sent[1].to, "ct@example.test");
  assertMatch(sent[1].subject, /^Contract for Job #[0-9A-F]{8} halted: price does not match the accepted bid$/);
  assertEquals(db.tables.notifications.filter((n: Record<string, unknown>) => n.notification_type === HALT_NOTICE_TYPE).length, 2);
});

Deno.test("gh-2543 idempotent: the same halt event delivered again sends nothing more", async () => {
  const db = makeDb();
  const sent: HaltMail[] = [];
  await sendHaltNotices(base(db, sent));
  const again = await sendHaltNotices(base(db, sent));
  assertEquals(again, { homeowner: "already_sent", contractor: "already_sent" });
  assertEquals(sent.length, 2, "still exactly two mails after a second event");
});

Deno.test("gh-2543 idempotent: a different envelope is a different halt and is notified", async () => {
  const db = makeDb();
  const sent: HaltMail[] = [];
  await sendHaltNotices(base(db, sent));
  await sendHaltNotices({ ...base(db, sent), envelopeId: "env-test-2" });
  assertEquals(sent.length, 4);
});

Deno.test("gh-2543 failure: provider refusal removes the marker (retry possible) and raises an alert", async () => {
  const db = makeDb();
  const sent: HaltMail[] = [];
  const r = await sendHaltNotices(base(db, sent, 500));
  assertEquals(r, { homeowner: "failed", contractor: "failed" });
  assertEquals(db.tables.notifications.length, 0);
  assertEquals(db.tables.platform_alerts_log.length, 2);
  const retry = await sendHaltNotices(base(db, [], 200));
  assertEquals(retry, { homeowner: "sent", contractor: "sent" });
});

Deno.test("gh-2543 recipients: a party with no email is skipped without blocking the other", async () => {
  const db = makeDb({ homeownerEmail: null });
  const sent: HaltMail[] = [];
  const r = await sendHaltNotices(base(db, sent));
  assertEquals(r, { homeowner: "no_recipient", contractor: "sent" });
  assertEquals(sent.length, 1);
});

Deno.test("gh-2543 recipients: contractor notification_emails also receive it", async () => {
  const db = makeDb({ contractorEmails: ["a@example.test", "b@example.test"] });
  const sent: HaltMail[] = [];
  await sendHaltNotices(base(db, sent));
  assertEquals(sent.filter((m) => m.subject.startsWith("Contract for")).map((m) => m.to), ["a@example.test", "b@example.test"]);
});

// ---- gh-2543 REVIEW 6301123534 / Ben RETURNED 6301145200 fixes ----
Deno.test("gh-2543 reply-to: both notices carry the Reply-To, a read inbox on the apex (not the noreply sender)", async () => {
  const db = makeDb();
  const sent: HaltMail[] = [];
  await sendHaltNotices(base(db, sent));
  assertEquals(sent.length, 2);
  for (const m of sent) assertEquals(m.replyTo, HALT_NOTICE_REPLY_TO);
  assertEquals(HALT_NOTICE_REPLY_TO, "marty@otterquote.com");
  assert(!/noreply|no-reply|@mail\./i.test(HALT_NOTICE_REPLY_TO));
});

Deno.test("gh-2543 reply-to: the production sender puts h:Reply-To on the Mailgun request and a timeout signal", async () => {
  const realFetch = globalThis.fetch;
  let seen: { fd: FormData; signal: AbortSignal | null | undefined } | null = null;
  globalThis.fetch = ((_u: unknown, init: RequestInit) => {
    seen = { fd: init.body as FormData, signal: init.signal };
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    const status = await mailgunSender("key-test")({ to: "ho@example.test", subject: "s", text: "t", html: "<p>t</p>", replyTo: HALT_NOTICE_REPLY_TO });
    assertEquals(status, 200);
    assert(seen !== null);
    const s2 = seen as { fd: FormData; signal: AbortSignal | null | undefined };
    assertEquals(s2.fd.get("h:Reply-To"), HALT_NOTICE_REPLY_TO);
    assertEquals(s2.fd.get("from"), "Otter Quotes <noreply@mail.otterquote.com>");
    assert(s2.signal instanceof AbortSignal, "the Mailgun call must carry an abort signal (review point 5)");
    assert(HALT_MAIL_TIMEOUT_MS > 0 && HALT_MAIL_TIMEOUT_MS <= 10000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("gh-2543 send-once race: two simultaneous deliveries of one halt send each notice once (the second insert loses)", async () => {
  const db = makeDb({ uniqueMarker: true, blindCheck: true });
  const sent: HaltMail[] = [];
  const [a, b] = await Promise.all([sendHaltNotices(base(db, sent)), sendHaltNotices(base(db, sent))]);
  assertEquals(sent.length, 2, "exactly one homeowner and one contractor mail across both deliveries");
  const results = [a, b];
  assertEquals(results.filter((r) => r.homeowner === "sent").length, 1);
  assertEquals(results.filter((r) => r.homeowner === "already_sent").length, 1);
  assertEquals(results.filter((r) => r.contractor === "sent").length, 1);
  assertEquals(results.filter((r) => r.contractor === "already_sent").length, 1);
  assertEquals(db.tables.notifications.filter((n: Record<string, unknown>) => n.notification_type === HALT_NOTICE_TYPE).length, 2, "both markers survive; the loser does not delete the winner's marker");
  assertEquals(db.tables.platform_alerts_log.length, 0, "losing the race is not an alert");
});

Deno.test("gh-2543 send-once race: sequential duplicate with the index and a blind check still sends once", async () => {
  const db = makeDb({ uniqueMarker: true, blindCheck: true });
  const sent: HaltMail[] = [];
  await sendHaltNotices(base(db, sent));
  const again = await sendHaltNotices(base(db, sent));
  assertEquals(again, { homeowner: "already_sent", contractor: "already_sent" });
  assertEquals(sent.length, 2);
});

Deno.test("gh-2543 several addresses: one refused address does not re-send to the others on retry (marker kept, partial alert)", async () => {
  const db = makeDb({ contractorEmails: ["a@example.test", "b@example.test"] });
  const sent: HaltMail[] = [];
  const send = (m: HaltMail) => { sent.push(m); return Promise.resolve(m.to === "b@example.test" ? 500 : 200); };
  const r = await sendHaltNotices({ ...base(db, sent), send });
  assertEquals(r.contractor, "sent");
  assertEquals(db.tables.platform_alerts_log.filter((a: Record<string, unknown>) => a.alert_type === "contract_halt_notice_partial").length, 1);
  const before = sent.length;
  const again = await sendHaltNotices({ ...base(db, sent), send });
  assertEquals(again.contractor, "already_sent");
  assertEquals(sent.length, before, "a repeated event sends nothing to a or b");
});

Deno.test("gh-2543 several addresses: a thrown send to one address does not stop the others", async () => {
  const db = makeDb({ contractorEmails: ["a@example.test", "b@example.test"] });
  const sent: HaltMail[] = [];
  const send = (m: HaltMail) => { if (m.to === "a@example.test") return Promise.reject(new Error("timeout")); sent.push(m); return Promise.resolve(200); };
  const r = await sendHaltNotices({ ...base(db, sent), send });
  assertEquals(r.contractor, "sent");
  assertEquals(sent.filter((m) => m.to === "b@example.test").length, 1);
});

// ---- gh-2543 PR #2959 RETURNED (Ben, CEO RUN 116): PII out of Sentry, checked delete, 23505 index match ----
function spyBase(db: unknown, sent: HaltMail[], seen: { errs: unknown[]; ctx: unknown[] }, send?: (m: HaltMail) => Promise<number>) {
  return {
    ...base(db, sent),
    reportToSentry: (e: unknown, c: unknown) => { seen.errs.push(e); seen.ctx.push(c); return Promise.resolve(); },
    ...(send ? { send } : {}),
  };
}
// every sink a halt-notice failure can reach: the Error handed to Sentry (message, name, stack), its context, console, the alerts rows
async function sinks(run: () => Promise<unknown>, db: { tables: Record<string, unknown[]> }, seen: { errs: unknown[]; ctx: unknown[] }) {
  const logged: string[] = [];
  const oe = console.error, ol = console.log, ow = console.warn;
  const grab = (...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}\n${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.error = grab; console.log = grab; console.warn = grab;
  try { await run(); } finally { console.error = oe; console.log = ol; console.warn = ow; }
  const errs = seen.errs.map((e) => (e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)));
  return JSON.stringify({ logged, errs, ctx: seen.ctx, alerts: db.tables.platform_alerts_log });
}
const PII = ["ho@example.test", "ct@example.test", "a@example.test", "b@example.test", "12 Test Lane", "Acme Roofing", "13,561", "13,560", "13561", "13560", "Zionsville"];

Deno.test("gh-2543 PII: a refused send puts no address, name, street or price into Sentry, console or the alert row", async () => {
  const db = makeDb({ contractorEmails: ["a@example.test", "b@example.test"] });
  const seen = { errs: [] as unknown[], ctx: [] as unknown[] };
  const out = await sinks(() => sendHaltNotices(spyBase(db, [], seen, () => Promise.resolve(500))), db, seen);
  assert(seen.errs.length >= 2, "Sentry was reached");
  for (const p of PII) assertEquals(out.includes(p), false, `leaked: ${p}`);
  assertEquals(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(out), false, "no full e-mail address anywhere");
  assert(out.includes("status 500"), "the failure is still diagnosable");
});

Deno.test("gh-2543 PII: a thrown send error that echoes the address is masked before Sentry, console and the alert row", async () => {
  const db = makeDb();
  const seen = { errs: [] as unknown[], ctx: [] as unknown[] };
  const out = await sinks(() => sendHaltNotices(spyBase(db, [], seen, (m) => Promise.reject(new Error(`connect failed for ${m.to}`)))), db, seen);
  for (const p of PII) assertEquals(out.includes(p), false, `leaked: ${p}`);
  assert(out.includes("h***@example.test") || out.includes("c***@example.test"), "masked form kept for follow-up");
});

Deno.test("gh-2543 PII: a partial send alerts with positions and masked addresses only", async () => {
  const db = makeDb({ contractorEmails: ["a@example.test", "b@example.test"] });
  const seen = { errs: [] as unknown[], ctx: [] as unknown[] };
  const send = (m: HaltMail) => Promise.resolve(m.to === "b@example.test" ? 500 : 200);
  const out = await sinks(() => sendHaltNotices(spyBase(db, [], seen, send)), db, seen);
  assert(db.tables.platform_alerts_log.some((a: Record<string, unknown>) => a.alert_type === "contract_halt_notice_partial"));
  for (const p of PII) assertEquals(out.includes(p), false, `leaked: ${p}`);
  assert(out.includes("address 2 of 2"));
});

Deno.test("gh-2543 PII: the Sentry context carries ids only", async () => {
  const db = makeDb();
  const seen = { errs: [] as unknown[], ctx: [] as unknown[] };
  await sendHaltNotices(spyBase(db, [], seen, () => Promise.resolve(500)));
  for (const c of seen.ctx as { extra?: Record<string, unknown> }[]) {
    assertEquals(Object.keys(c.extra ?? {}).sort(), ["claim_id", "envelope_id", "role"]);
  }
});

Deno.test("gh-2543 PII: maskEmail / maskEmails", () => {
  assertEquals(maskEmail("alice@example.test"), "a***@example.test");
  assertEquals(maskEmail("nonsense"), "***");
  assertEquals(maskEmails("x alice@example.test and bob.k@mail.example.org y"), "x a***@example.test and b***@mail.example.org y");
});

Deno.test("gh-2543 delete check: a failed marker delete is reported as 'Marker NOT removed; a repeated event will not retry'", async () => {
  const db = makeDb({ deleteError: { code: "42501", message: "permission denied for table notifications" } });
  const r = await sendHaltNotices(base(db, [], 500));
  assertEquals(r, { homeowner: "failed", contractor: "failed" });
  const alerts = db.tables.platform_alerts_log.filter((a: Record<string, unknown>) => a.alert_type === "contract_halt_notice_failed");
  assertEquals(alerts.length, 2);
  for (const a of alerts) {
    assert(String(a.message).includes("Marker NOT removed; a repeated event will not retry."));
    assertEquals(String(a.message).includes("Marker removed"), false);
  }
});

Deno.test("gh-2543 delete check: a delete that removes no row (silent no-op) is not reported as removed", async () => {
  const db = makeDb({ deleteNoop: true });
  await sendHaltNotices(base(db, [], 500));
  for (const a of db.tables.platform_alerts_log) assert(String((a as Record<string, unknown>).message).includes("Marker NOT removed; a repeated event will not retry."));
});

Deno.test("gh-2543 delete check: a delete that removes the inserted row says 'Marker removed' and a retry sends", async () => {
  const db = makeDb();
  await sendHaltNotices(base(db, [], 500));
  for (const a of db.tables.platform_alerts_log) assert(String((a as Record<string, unknown>).message).includes("Marker removed; a repeated event may retry."));
  assertEquals(db.tables.notifications.length, 0);
  assertEquals(await sendHaltNotices(base(db, [], 200)), { homeowner: "sent", contractor: "sent" });
});

Deno.test("gh-2543 delete check: a delete that throws is not reported as removed", async () => {
  const db = makeDb();
  const real = db.from.bind(db);
  db.from = (t: string) => { const q = real(t); if (t === "notifications") { const d = q.delete.bind(q); q.delete = () => { d(); q.then = (_ok: unknown, bad: (e: unknown) => unknown) => bad(new Error("socket hang up")); return q; }; } return q; };
  await sendHaltNotices(base(db, [], 500));
  for (const a of db.tables.platform_alerts_log) assert(String((a as Record<string, unknown>).message).includes("Marker NOT removed; a repeated event will not retry."));
});

Deno.test("gh-2543 23505: a unique violation from a DIFFERENT constraint is not 'already sent' (no send, failure alerted)", async () => {
  const db = makeDb({ otherUnique: true });
  const sent: HaltMail[] = [];
  const r = await sendHaltNotices(base(db, sent));
  assertEquals(r, { homeowner: "failed", contractor: "failed" });
  assertEquals(sent.length, 0, "no marker, no send");
  assertEquals(db.tables.platform_alerts_log.length, 2);
});

Deno.test("gh-2543 23505: the halt-notice index named in message or details IS 'already sent'", async () => {
  for (const err of [
    { code: "23505", message: `duplicate key value violates unique constraint "${HALT_NOTICE_INDEX}"` },
    { code: "23505", message: "duplicate key", details: `index ${HALT_NOTICE_INDEX}` },
  ]) {
    const db = makeDb();
    const real = db.from.bind(db);
    db.from = (t: string) => { const q = real(t); if (t === "notifications") q.insert = () => Promise.resolve({ error: err }); return q; };
    const sent: HaltMail[] = [];
    assertEquals(await sendHaltNotices(base(db, sent)), { homeowner: "already_sent", contractor: "already_sent" });
    assertEquals(sent.length, 0);
  }
});

Deno.test("gh-2543 23505: the index name in code equals the one in the migration draft and its rollback", async () => {
  assertEquals(HALT_NOTICE_INDEX, "notifications_contract_halt_notice_once_idx");
  const dir = new URL("../../migrations_drafts/", import.meta.url);
  const fwd = await Deno.readTextFile(new URL("gh2543_halt_notice_marker_unique.sql", dir));
  const rb = await Deno.readTextFile(new URL("gh2543_halt_notice_marker_unique_rollback.sql", dir));
  assert(fwd.includes(`CREATE UNIQUE INDEX IF NOT EXISTS ${HALT_NOTICE_INDEX}`));
  assert(rb.includes(HALT_NOTICE_INDEX));
});

// ---- wiring: index.ts sends only from the mismatch halt branch (negative control for "no halt") ----
const idx = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const code = idx.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

Deno.test("gh-2543 wiring: sendHaltNotices is called exactly once in index.ts, inside the mismatch halt branch", () => {
  assertEquals(code.split("sendHaltNotices(").length - 1, 1);
  const mismatchStart = code.indexOf('disposition === "halt" && verdict.state === "mismatch"');
  const reconciledStart = code.indexOf('disposition === "proceed" && verdict.state === "reconciled"');
  const call = code.indexOf("sendHaltNotices(");
  assert(mismatchStart > 0 && reconciledStart > mismatchStart);
  assert(call > mismatchStart && call < reconciledStart, "call must sit between the mismatch branch and the reconciled branch");
});

Deno.test("gh-2543 wiring: NO halt (reconciled / unverified / decking gate) never reaches the sender", () => {
  const mismatchStart = code.indexOf('disposition === "halt" && verdict.state === "mismatch"');
  const reconciledStart = code.indexOf('disposition === "proceed" && verdict.state === "reconciled"');
  const outside = code.slice(0, mismatchStart) + code.slice(reconciledStart);
  assertEquals(outside.includes("sendHaltNotices("), false);
  assertEquals(outside.includes("mailgunSender("), false);
  const decking = await_decking();
  assertEquals(decking.includes("sendHaltNotices"), false);
});

function await_decking(): string {
  return Deno.readTextFileSync(new URL("./decking-gate.ts", import.meta.url));
}

Deno.test("gh-2543 wiring: the send happens before the 200 mismatch response, which is unchanged", () => {
  const call = code.indexOf("sendHaltNotices(");
  const resp = code.indexOf('defect: "contract_price_mismatch"');
  assert(call > 0 && resp > call);
});
