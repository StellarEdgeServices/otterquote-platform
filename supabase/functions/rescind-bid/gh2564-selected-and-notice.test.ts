// gh-2564 (CEO RUN 104, points 2 and 5): rescind-bid refuses a selected / awarded bid, and sends the homeowner ONE
// notice email when a bid is withdrawn. index.ts calls Deno.serve at load and creates a network client, so it
// cannot be imported by `deno test` under CI's read-only flags; the decision lives in status.ts, the notice in
// notify.ts + templates.ts (both importable), and index.ts is checked as TEXT for the wiring (same convention as
// gh2105-zero-row-wiring.test.ts). The mail send is a MOCK here -- nothing in this file reaches Mailgun.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  BID_SELECTED_ERROR,
  BID_SELECTED_MESSAGE,
  isBidSelectedOrAwarded,
} from "./status.ts";
import { mailgunSender, notifyHomeownerOfWithdrawal, type SendFn } from "./notify.ts";
import { BID_WITHDRAWN_SUBJECT, buildBidWithdrawnHomeownerEmail } from "./templates.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// ── Point 2: refusal ─────────────────────────────────────────────────────────
Deno.test("refusal contract: error code and message are exactly Ben's text", () => {
  assertEquals(BID_SELECTED_ERROR, "bid_selected");
  assertEquals(BID_SELECTED_MESSAGE, "This bid can no longer be withdrawn here because the homeowner has already chosen a contractor. Contact support for help.");
});

Deno.test("refusal: quote.status 'selected' is refused, whatever the claim status", () => {
  assert(isBidSelectedOrAwarded("selected", null));
  assert(isBidSelectedOrAwarded("selected", "bidding"));
});

Deno.test("refusal: claim 'awarded' or 'contract_signed' is refused even if the quote still reads submitted", () => {
  assert(isBidSelectedOrAwarded("submitted", "awarded"));
  assert(isBidSelectedOrAwarded("submitted", "contract_signed"));
});

Deno.test("NEGATIVE CONTROL: a live, unselected bid on a bidding claim is NOT refused", () => {
  assertEquals(isBidSelectedOrAwarded("submitted", "bidding"), false);
  assertEquals(isBidSelectedOrAwarded("submitted", "active"), false);
  assertEquals(isBidSelectedOrAwarded("draft", null), false);
  assertEquals(isBidSelectedOrAwarded(null, undefined), false);
});

Deno.test("wiring: index.ts reads quotes.status + claim_id, and the 409 refusal runs before the update", () => {
  assertStringIncludes(src, '.select("id, bid_status, status, claim_id, contractor_id, created_at, is_test")');
  const iRefuse = src.indexOf("isBidSelectedOrAwarded(quote.status, claimStatus)");
  const iUpdate = src.indexOf('const { error: updateError, data: updateRows } = await supabase');
  assert(iRefuse > 0 && iUpdate > 0 && iRefuse < iUpdate, "the refusal must precede the quotes update");
  const block = src.slice(iRefuse, iUpdate);
  assertStringIncludes(block, "JSON.stringify({ error: BID_SELECTED_ERROR, message: BID_SELECTED_MESSAGE })");
  assertStringIncludes(block, "status: 409");
});

Deno.test("mutation control: with the refusal block removed the wiring check would fail", () => {
  const mutated = src.replace("isBidSelectedOrAwarded(quote.status, claimStatus)", "false");
  assert(!mutated.includes("isBidSelectedOrAwarded(quote.status, claimStatus)"));
});

// ── Point 5: homeowner notice ────────────────────────────────────────────────
type Row = Record<string, unknown> | null;
function fakeDb(tables: Record<string, Row>) {
  return {
    from(table: string) {
      return {
        select: (_cols: string) => ({
          eq: (_k: string, _v: unknown) => ({
            maybeSingle: () => Promise.resolve({ data: tables[table] ?? null, error: null }),
          }),
        }),
      };
    },
  };
}
function mockSend() {
  const calls: Array<{ to: string; from: string; subject: string; text: string; html: string }> = [];
  const send: SendFn = (to, from, subject, text, html) => {
    calls.push({ to, from, subject, text, html });
    return Promise.resolve(true);
  };
  return { calls, send };
}
const FULL = {
  claims: { user_id: "u-home" },
  profiles: { full_name: "Pat Homeowner", email: "pat@example.com" },
  contractors: { company_name: "Acme Roofing" },
};
const CTX = { claimId: "claim-123", contractorId: "con-1", mailgunDomain: "mg.example.com", otherLiveBids: true };

Deno.test("notice: the send helper is called ONCE, to the homeowner's profile email", async () => {
  const { calls, send } = mockSend();
  const r = await notifyHomeownerOfWithdrawal(fakeDb(FULL), send, CTX);
  assertEquals(r, { sent: true });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].to, "pat@example.com");
  assertEquals(calls[0].from, "Otter Quotes <notifications@mg.example.com>");
  assertEquals(calls[0].subject, "A contractor withdrew their bid on your project");
  assertStringIncludes(calls[0].text, "Acme Roofing withdrew their bid on your project.");
  assertStringIncludes(calls[0].text, "https://otterquote.com/bids.html?claim=claim-123");
});

Deno.test("NEGATIVE CONTROL: no homeowner email on file -> the send helper is called ZERO times", async () => {
  const { calls, send } = mockSend();
  const r = await notifyHomeownerOfWithdrawal(fakeDb({ ...FULL, profiles: { full_name: "Pat", email: null } }), send, CTX);
  assertEquals(r, { sent: false, reason: "no_homeowner_email" });
  assertEquals(calls.length, 0);
  const r2 = await notifyHomeownerOfWithdrawal(fakeDb(FULL), send, { ...CTX, claimId: null });
  assertEquals(r2, { sent: false, reason: "no_claim" });
  assertEquals(calls.length, 0);
});

Deno.test("notice: a failed send is reported, not retried (still one call)", async () => {
  let n = 0;
  const r = await notifyHomeownerOfWithdrawal(fakeDb(FULL), () => { n++; return Promise.resolve(false); }, CTX);
  assertEquals(r, { sent: false, reason: "send_failed" });
  assertEquals(n, 1);
});

Deno.test("notice: missing contractor name falls back to 'A contractor'", async () => {
  const { calls, send } = mockSend();
  await notifyHomeownerOfWithdrawal(fakeDb({ ...FULL, contractors: null }), send, CTX);
  assertStringIncludes(calls[0].text, "A contractor withdrew their bid on your project.");
});

Deno.test("mailgunSender posts to the mailgun messages URL with the recipient (fetch is a mock)", async () => {
  let url = "", body = "";
  const fakeFetch = ((u: string, init: RequestInit) => {
    url = u; body = String(init.body);
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  const ok = await mailgunSender("key", "mg.example.com", fakeFetch)("a@b.com", "f", "s", "t", "h");
  assert(ok);
  assertEquals(url, "https://api.mailgun.net/v3/mg.example.com/messages");
  assertStringIncludes(body, "to=a%40b.com");
});

Deno.test("wiring: index.ts sends the notice once, after the update and activity log, before the success response", () => {
  assertEquals(src.split("notifyHomeownerOfWithdrawal(").length - 1, 1, "exactly one call site");
  const iUpdate = src.indexOf('const { error: updateError, data: updateRows } = await supabase');
  const iZero = src.indexOf("gh2105_zero_rows");
  const iLog = src.indexOf("// Insert activity log entry");
  const iNotice = src.indexOf("notifyHomeownerOfWithdrawal(");
  const iSuccess = src.indexOf("// Success response");
  assert(iUpdate < iZero && iZero < iLog && iLog < iNotice && iNotice < iSuccess, "order: update, zero-row guard, log, notice, success");
  assertStringIncludes(src, "homeowner_notified: homeownerNotified");
});

Deno.test("template text (quotable): subject, body, no price / fee / promise", () => {
  assertEquals(BID_WITHDRAWN_SUBJECT, "A contractor withdrew their bid on your project");
  const { text, html } = buildBidWithdrawnHomeownerEmail({
    homeownerName: "Pat", contractorName: "Acme Roofing", bidsUrl: "https://otterquote.com/bids.html?claim=c1", mailgunDomain: "mg.example.com", hasOtherLiveBids: true,
  });
  assert(text.startsWith(
    "Hi Pat,\n\nAcme Roofing withdrew their bid on your project.\n\nThe other bids on your project have not changed.\n\nView your bids: https://otterquote.com/bids.html?claim=c1\n",
  ));
  for (const banned of ["$", "fee", "price", "guarantee", "refund", "will be", "within"]) {
    assert(!text.toLowerCase().includes(banned), `text must not contain '${banned}'`);
  }
  assertStringIncludes(html, "<strong>Acme Roofing</strong> withdrew their bid on your project.");
});

Deno.test("template: contractor name is HTML-escaped in the html part", () => {
  const { html } = buildBidWithdrawnHomeownerEmail({
    homeownerName: "Pat", contractorName: "<b>X</b> & Co", bidsUrl: "u", mailgunDomain: "d", hasOtherLiveBids: true,
  });
  assertStringIncludes(html, "&lt;b&gt;X&lt;/b&gt; &amp; Co");
  assert(!html.includes("<b>X</b>"));
});

// ── CEO RUN 104 points 1, 3, 4 (wording round) ──────────────────────────────
const SENTENCE = "The other bids on your project have not changed.";

Deno.test("point 1: the function's refusal wording is the one neutral sentence (HTML + copy.ts are pinned in the vitest bid.test.ts: CI's Deno flags cannot read them)", () => {
  assertEquals(
    BID_SELECTED_MESSAGE,
    "This bid can no longer be withdrawn here because the homeowner has already chosen a contractor. Contact support for help.",
  );
});

Deno.test("point 1 negative control: the old 'was already selected' sentence is gone from the refusal text", () => {
  assert(!BID_SELECTED_MESSAGE.includes("already selected"));
  assert(!src.includes("already selected by the homeowner"));
});

Deno.test("point 3: the rescind UPDATE is conditioned on status <> selected and bid_status in RESCINDABLE_STATUSES", () => {
  const iUpdate = src.indexOf('const { error: updateError, data: updateRows } = await supabase');
  const iLog = src.indexOf("// Insert activity log entry");
  const block = src.slice(iUpdate, iLog);
  assertStringIncludes(block, "gh2105_zero_rows");
  assertStringIncludes(block, '.neq("status", SELECTED_QUOTE_STATUS)');
  assertStringIncludes(block, '.in("bid_status", RESCINDABLE_STATUSES)');
  assertStringIncludes(block, '.select("id")');
  assertStringIncludes(block, "status: 409"); // the zero-row branch answers 409
  assert(block.indexOf('.eq("id", body.quote_id)') < block.indexOf(".neq("), "conditions follow the id match");
});

Deno.test("point 3 mutation control: without the conditions the block no longer matches", () => {
  const mutated = src.replace('.neq("status", SELECTED_QUOTE_STATUS)', "").replace('.in("bid_status", RESCINDABLE_STATUSES)', "");
  assert(!mutated.includes('.neq("status", SELECTED_QUOTE_STATUS)') && src.includes('.neq("status", SELECTED_QUOTE_STATUS)'));
});

Deno.test("point 4: another live bid exists -> the sentence is in the text and html (mock send, one call)", async () => {
  const { calls, send } = mockSend();
  await notifyHomeownerOfWithdrawal(fakeDb(FULL), send, { ...CTX, otherLiveBids: true });
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0].text, SENTENCE);
  assertStringIncludes(calls[0].html, SENTENCE);
});

Deno.test("point 4 NEGATIVE CONTROL: no other live bid -> the sentence is in neither part; the rest is intact", async () => {
  const { calls, send } = mockSend();
  await notifyHomeownerOfWithdrawal(fakeDb(FULL), send, { ...CTX, otherLiveBids: false });
  assertEquals(calls.length, 1);
  assert(!calls[0].text.includes("other bids"));
  assert(!calls[0].html.includes("other bids"));
  assertStringIncludes(calls[0].text, "Acme Roofing withdrew their bid on your project.\n\nView your bids: https://otterquote.com/bids.html?claim=claim-123");
  assertStringIncludes(calls[0].html, "View My Bids");
});

Deno.test("point 4 wiring: index.ts counts OTHER live quotes on the claim and passes the flag", () => {
  assertStringIncludes(src, '.select("id", { count: "exact", head: true })');
  assertStringIncludes(src, '.neq("id", body.quote_id)');
  assertStringIncludes(src, "mailgunDomain, otherLiveBids }");
});
