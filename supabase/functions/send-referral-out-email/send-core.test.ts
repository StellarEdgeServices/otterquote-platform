// Deno unit tests for gh-2019 / D-324: send-referral-out-email's decision logic.
// Run: deno test --no-check supabase/functions/send-referral-out-email/send-core.test.ts
//
// Every branch that must send NOTHING to the requester asserts that
// sendToRequester was never called.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  isPrimaryAdmin,
  NOTIF_TYPE_REFERRAL_OUT,
  PRIMARY_ADMIN_EMAIL,
  runSend,
  validateContractors,
  type LeadRow,
  type NotificationRow,
  type SendDeps,
} from "./send-core.ts";

const LEAD_ID = "22222222-2222-4222-8222-222222222222";
const THREE = [
  { name: "Acme Roofing", phone: "317-555-0101", website: "acmeroofing.example" },
  { name: "Best Gutters", phone: "317-555-0102", website: "bestgutters.example" },
  { name: "Cedar Siding Co", phone: "317-555-0103", website: "cedarsiding.example" },
];

interface Harness {
  deps: SendDeps;
  calls: string[];
  requesterMsgs: { to: string; subject: string; text: string; html: string }[];
  adminMsgs: { subject: string; text: string; html: string }[];
}

function harness(opts: {
  lead?: LeadRow | null;
  existing?: NotificationRow[];
  raceWinnerFirst?: boolean;
  mailgunOk?: boolean;
  markThrows?: boolean;
}): Harness {
  const calls: string[] = [];
  const requesterMsgs: Harness["requesterMsgs"] = [];
  const adminMsgs: Harness["adminMsgs"] = [];
  let claimed: NotificationRow | null = null;
  const lead: LeadRow | null = opts.lead === undefined
    ? { id: LEAD_ID, name: "Jane", email: "jane@example.com", variant: "e-referral-out" }
    : opts.lead;
  const deps: SendDeps = {
    getLead: async () => (calls.push("getLead"), lead),
    listSendRecords: async () => {
      calls.push("list");
      const base = [...(opts.existing ?? [])];
      if (claimed) {
        return opts.raceWinnerFirst ? [{ id: "00000000-earlier", delivered: false }, claimed] : [claimed, ...base];
      }
      return base;
    },
    insertClaim: async () => {
      calls.push("insertClaim");
      claimed = { id: "claim-1", delivered: false };
      return "claim-1";
    },
    deleteRecord: async (id) => void calls.push(`delete:${id}`),
    markDelivered: async (id, mg) => {
      calls.push(`markDelivered:${id}:${mg}`);
      if (opts.markThrows) throw new Error("db down");
    },
    sendToRequester: async (m) => {
      calls.push("sendToRequester");
      requesterMsgs.push(m);
      return opts.mailgunOk === false ? { ok: false } : { ok: true, mailgunId: "<mg-1@mail>" };
    },
    sendAdminAlert: async (m) => {
      calls.push("sendAdminAlert");
      adminMsgs.push(m);
      return true;
    },
  };
  return { deps, calls, requesterMsgs, adminMsgs };
}

Deno.test("happy path: claim, confirm, send once to the lead's email with the approved subject, mark delivered", async () => {
  const h = harness({});
  const r = await runSend({ lead_id: LEAD_ID, contractors: THREE }, h.deps);
  assertEquals(r, { status: 200, body: { sent: true, mailgun_id: "<mg-1@mail>" } });
  assertEquals(h.calls, ["getLead", "list", "insertClaim", "list", "sendToRequester", "markDelivered:claim-1:<mg-1@mail>"]);
  assertEquals(h.requesterMsgs.length, 1);
  assertEquals(h.requesterMsgs[0].to, "jane@example.com");
  assertEquals(h.requesterMsgs[0].subject, "The contractors you asked for");
  assert(h.requesterMsgs[0].text.startsWith("Hi Jane,\n\nYou asked us to send you"));
  assertEquals(h.adminMsgs.length, 0);
});

Deno.test("blank name (empty, whitespace, CR/LF-only, null): NOTHING sent to the requester; admin alert says 'no name captured'", async () => {
  for (const name of ["", "   ", "\r\n\t ", null]) {
    const h = harness({ lead: { id: LEAD_ID, name, email: "jane@example.com", variant: "e-referral-out" } });
    const r = await runSend({ lead_id: LEAD_ID, contractors: THREE }, h.deps);
    assertEquals(r, { status: 200, body: { sent: false, reason: "no name captured", admin_alerted: true } }, JSON.stringify(name));
    assertEquals(h.requesterMsgs.length, 0);
    assert(!h.calls.includes("sendToRequester"));
    assert(!h.calls.includes("insertClaim"), "a blank-name lead must not consume the send-once slot");
    assertEquals(h.adminMsgs.length, 1);
    assertEquals(h.adminMsgs[0].subject, "[OtterQuote] Referral-out request: no name captured");
    assert(h.adminMsgs[0].text.includes("no name captured"));
  }
});

Deno.test("send-once: a delivered prior send blocks a second send (409), nothing sent, no new claim", async () => {
  const h = harness({ existing: [{ id: "old", delivered: true }] });
  const r = await runSend({ lead_id: LEAD_ID, contractors: THREE }, h.deps);
  assertEquals(r, { status: 409, body: { sent: false, reason: "already sent" } });
  assertEquals(h.requesterMsgs.length, 0);
  assert(!h.calls.includes("insertClaim"));
});

Deno.test("send-once: an interrupted (delivered=false) prior claim also blocks -- fail closed", async () => {
  const h = harness({ existing: [{ id: "stuck", delivered: false }] });
  const r = await runSend({ lead_id: LEAD_ID, contractors: THREE }, h.deps);
  assertEquals(r.status, 409);
  assertEquals(h.requesterMsgs.length, 0);
});

Deno.test("claim race: if another claim sorts first, our claim is removed and nothing is sent", async () => {
  const h = harness({ raceWinnerFirst: true });
  const r = await runSend({ lead_id: LEAD_ID, contractors: THREE }, h.deps);
  assertEquals(r.status, 409);
  assertEquals(h.requesterMsgs.length, 0);
  assert(h.calls.includes("delete:claim-1"));
});

Deno.test("Mailgun refusal: 502, claim removed so a retry is possible, no delivered mark", async () => {
  const h = harness({ mailgunOk: false });
  const r = await runSend({ lead_id: LEAD_ID, contractors: THREE }, h.deps);
  assertEquals(r.status, 502);
  assertEquals(r.body.sent, false);
  assert(h.calls.includes("delete:claim-1"));
  assert(!h.calls.some((c) => c.startsWith("markDelivered")));
});

Deno.test("sent but the delivered-mark failed: reports sent + record_incomplete, and does NOT delete the blocking claim", async () => {
  const h = harness({ markThrows: true });
  const r = await runSend({ lead_id: LEAD_ID, contractors: THREE }, h.deps);
  assertEquals(r, { status: 200, body: { sent: true, mailgun_id: "<mg-1@mail>", record_incomplete: true } });
  assert(!h.calls.includes("delete:claim-1"));
});

Deno.test("only referral-out leads are eligible; missing lead 404; no email 422 -- nothing sent", async () => {
  let h = harness({ lead: { id: LEAD_ID, name: "Jane", email: "jane@example.com", variant: "e" } });
  assertEquals((await runSend({ lead_id: LEAD_ID, contractors: THREE }, h.deps)).status, 409);
  assertEquals(h.requesterMsgs.length, 0);
  h = harness({ lead: null });
  assertEquals((await runSend({ lead_id: LEAD_ID, contractors: THREE }, h.deps)).status, 404);
  h = harness({ lead: { id: LEAD_ID, name: "Jane", email: "  ", variant: "e-referral-out" } });
  assertEquals((await runSend({ lead_id: LEAD_ID, contractors: THREE }, h.deps)).status, 422);
  assertEquals(h.requesterMsgs.length, 0);
});

Deno.test("input validation: bad lead_id and anything but exactly three complete contractors are 400s with no DB read", async () => {
  const bad: unknown[] = [
    undefined, null, "x", [THREE[0]], [...THREE, THREE[0]],
    [THREE[0], THREE[1], { name: "C", phone: "1", website: "" }],
    [THREE[0], THREE[1], { name: "C", phone: "1" }],
    [THREE[0], THREE[1], { name: "   ", phone: "1", website: "w" }],
    [THREE[0], THREE[1], { name: "C", phone: "1", website: "w".repeat(201) }],
    [THREE[0], THREE[1], "Cedar"],
  ];
  for (const contractors of bad) {
    const h = harness({});
    const r = await runSend({ lead_id: LEAD_ID, contractors }, h.deps);
    assertEquals(r.status, 400, JSON.stringify(contractors));
    assertEquals(h.calls.length, 0);
  }
  const h = harness({});
  assertEquals((await runSend({ lead_id: "not-a-uuid", contractors: THREE }, h.deps)).status, 400);
  assertEquals(h.calls.length, 0);
});

Deno.test("validateContractors strips CR/LF and trims", () => {
  const v = validateContractors([{ name: " A\r\nB ", phone: "1", website: "w" }, THREE[1], THREE[2]]);
  assertEquals(v?.[0], { name: "AB", phone: "1", website: "w" });
});

Deno.test("admin gate: only the primary admin identity passes (same single-identity gate as admin-contractor-action)", () => {
  assertEquals(PRIMARY_ADMIN_EMAIL, "dustinstohler1@gmail.com");
  assertEquals(isPrimaryAdmin("dustinstohler1@gmail.com"), true);
  for (const e of ["dustin@otterquote.com", "Dustinstohler1@gmail.com", "someone@example.com", "", null, undefined]) {
    assertEquals(isPrimaryAdmin(e), false, String(e));
  }
});

Deno.test("wiring: index.ts gates on the verified admin BEFORE any read/write", async () => {
  const idx = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const gate = idx.indexOf("isPrimaryAdmin(user?.user?.email)");
  assert(gate > 0, "in-handler admin gate present");
  assert(idx.indexOf("auth.getUser(token)") > 0 && idx.indexOf("auth.getUser(token)") < gate);
  assert(gate < idx.indexOf("runSend("), "gate precedes runSend");
  assert(gate < idx.indexOf('.from("leads")'), "gate precedes the first DB read");
  assert(idx.includes("NOTIF_TYPE_REFERRAL_OUT") && idx.includes("PRIMARY_ADMIN_EMAIL"));
  assertEquals(NOTIF_TYPE_REFERRAL_OUT, "referral_out_contact_info");

  // supabase/config.toml (the verify_jwt pin) is outside CI's deno --allow-read
  // scope; it is asserted in tests/gh2019-arme-referral-out.mjs.
});

Deno.test("PRIMARY_ADMIN_EMAIL stays in sync with _shared/admin.ts", async () => {
  const shared = await Deno.readTextFile(new URL("../_shared/admin.ts", import.meta.url));
  assert(shared.includes(`export const PRIMARY_ADMIN_EMAIL = "${PRIMARY_ADMIN_EMAIL}";`));
});
