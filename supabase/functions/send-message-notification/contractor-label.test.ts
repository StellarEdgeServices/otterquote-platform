// gh-2478 / Contractor Agreement 6.2 / D-277 -- contractor-bound message notifications must
// not identify the homeowner before the platform fee is collected. Ben's DECIDED
// (exec #2304, comment 5972464230): label the sender "the homeowner" plus the property
// address the contractor already has; first name + last initial was rejected.
//
// Drives the REAL handler with a fake supabase client and a fetch stub that CAPTURES the
// Mailgun form body (subject, html, text, from, to). NEGATIVE CONTROL: at a1e85f60 (PR #2490
// head) the "does not contain the homeowner's first or last name" test fails because the
// template receives senderProfile.full_name; at the fix head it passes.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  BASE_ENV,
  fakeSupabase,
  req,
  type Rows,
  USER_ID,
  USER_JWT,
} from "../_shared/caller-gate-test-kit.ts";
import { handler } from "./index.ts";
import { contractorBoundSenderLabel } from "./templates.ts";

const URL_ = "https://x.supabase.co/functions/v1/send-message-notification";
const MESSAGE_ID = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";
const BODY = { message_id: MESSAGE_ID };
const HOMEOWNER_FIRST = "Dana";
const HOMEOWNER_LAST = "Whitfieldson";
const HOMEOWNER_FULL = `${HOMEOWNER_FIRST} ${HOMEOWNER_LAST}`;
const ADDRESS = "4821 Maple Hollow Dr, Zionsville, IN 46077";

async function runCapturing(rows: Rows) {
  const sb = fakeSupabase(rows);
  const sent: Record<string, string>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const out: Record<string, string> = {};
    const fd = init?.body;
    if (fd instanceof FormData) for (const [k, v] of fd.entries()) out[k] = String(v);
    sent.push(out);
    return Promise.resolve(new Response(JSON.stringify({ id: "stub" }), { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await handler(req(URL_, BODY, `Bearer ${USER_JWT}`), (n) => BASE_ENV[n], sb.make);
    return { res, text: await res.text(), sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Homeowner sends; the claim has a quote at status "selected" (fee not yet collected).
const homeownerSends = (): Rows => ({
  messages: [{
    id: MESSAGE_ID,
    claim_id: "c1",
    sender_id: USER_ID,
    sender_role: "homeowner",
    body: "Can you come Tuesday?",
    created_at: "2026-10-01T00:00:00Z",
    claims: { id: "c1", user_id: "homeowner-1", property_address: ADDRESS },
    profiles: { id: USER_ID, full_name: HOMEOWNER_FULL, email: "homeowner-fixture@example.test" },
  }],
  quotes: [{ contractor_id: "k1", status: "selected", contractors: { user_id: "contractor-user-1" } }],
  profiles: [{ email: "contractor-fixture@example.test", full_name: "Casey Contractor" }],
});

Deno.test("gh-2478: contractor-bound email at quote status 'selected' does not contain the homeowner's first or last name", async () => {
  const r = await runCapturing(homeownerSends());
  assertEquals(r.res.status, 200);
  assertEquals(r.sent.length, 1, "one Mailgun call");
  const m = r.sent[0];
  assertEquals(m.to, "contractor-fixture@example.test");
  // every string that goes to the recipient: subject, html, text, from (and the JSON response)
  const everything = [m.subject, m.html, m.text, m.from, r.text].join("\n");
  for (const needle of [HOMEOWNER_FIRST, HOMEOWNER_LAST, HOMEOWNER_FULL, "homeowner-fixture@example.test"]) {
    assertFalse(everything.includes(needle), `contractor-bound email leaks "${needle}"`);
  }
});

Deno.test("gh-2478: contractor-bound email uses 'the homeowner' and the property address (Ben DECIDED 5972464230)", async () => {
  const r = await runCapturing(homeownerSends());
  const m = r.sent[0];
  assert(m.text.includes(`You have a new message from the homeowner at ${ADDRESS} regarding your project.`), m.text);
  assert(m.html.includes(`<strong>the homeowner at ${ADDRESS}</strong>`));
  assert(m.html.includes("Hi Casey Contractor,"), "greeting is the contractor's own name");
});

Deno.test("gh-2478: no first-name-plus-initial form either (rejected by Ben)", async () => {
  const r = await runCapturing(homeownerSends());
  const m = r.sent[0];
  assertFalse(/Dana\s+W\b/.test([m.html, m.text, m.subject].join("\n")));
});

Deno.test("gh-2478: missing property address falls back to plain 'the homeowner'", async () => {
  const rows = homeownerSends();
  // deno-lint-ignore no-explicit-any
  (rows.messages as any)[0].claims.property_address = null;
  const r = await runCapturing(rows);
  const m = r.sent[0];
  assert(m.text.includes("a new message from the homeowner regarding your project."), m.text);
  assertFalse([m.html, m.text].join("\n").includes(HOMEOWNER_FIRST));
  assertEquals(contractorBoundSenderLabel(undefined), "the homeowner");
  assertEquals(contractorBoundSenderLabel("  "), "the homeowner");
});

Deno.test("gh-2478: homeowner-bound direction unchanged -- contractor sender is still named", async () => {
  const rows: Rows = {
    messages: [{
      id: MESSAGE_ID,
      claim_id: "c1",
      sender_id: USER_ID,
      sender_role: "contractor",
      body: "See you Tuesday",
      created_at: "2026-10-01T00:00:00Z",
      claims: { id: "c1", user_id: "homeowner-1", property_address: ADDRESS },
      profiles: { id: USER_ID, full_name: "Acme Roofing", email: "sender-fixture@example.test" },
    }],
    profiles: [{ email: "homeowner-fixture@example.test", full_name: HOMEOWNER_FULL }],
  };
  const r = await runCapturing(rows);
  const m = r.sent[0];
  assertEquals(m.to, "homeowner-fixture@example.test");
  assert(m.text.includes("You have a new message from Acme Roofing regarding your project."), m.text);
  assert(m.html.includes(`Hi ${HOMEOWNER_FULL},`));
  assertFalse(m.text.includes("the homeowner at"));
});
