// gh-2543: the two approved contract-halt notices.
// Run: deno test --no-check -A supabase/functions/docusign-webhook/halt-notice.test.ts
// All rows below are test fixtures that live only in this file's in-memory stub.

import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  contractorHaltHtml,
  contractorHaltSubject,
  contractorHaltText,
  formatUsd,
  HALT_NOTICE_TYPE,
  HOMEOWNER_HALT_SUBJECT,
  homeownerHaltHtml,
  homeownerHaltText,
  type HaltMail,
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
function makeDb(opts: { homeownerEmail?: string | null; contractorEmails?: string[] } = {}) {
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
        eq(c: string, v: unknown) { filters.push([c, v]); if (mode === "delete") { tables[t] = tables[t].filter((r) => !filters.every(([k, x]) => r[k] === x)); } return q; },
        limit() { return q; },
        delete() { mode = "delete"; return q; },
        maybeSingle() { const r = (tables[t] ?? []).find((row) => filters.every(([k, v]) => row[k] === v)); return Promise.resolve({ data: r ?? null }); },
        single() { return Promise.resolve({ data: fixtures[t] ?? null }); },
        insert(row: Record<string, unknown>) { (tables[t] ??= []).push(row); return Promise.resolve({ error: null }); },
        then(res: (v: unknown) => unknown) { return Promise.resolve({ error: null }).then(res); },
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
