// gh-2122: unit tests for record-lead-details's request handling. handler.ts has
// no imports and is exercised directly with injected fakes -- no network, no
// database. Run: deno test --allow-read=supabase/functions supabase/functions/record-lead-details/
import { assert, assertEquals, assertMatch, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildCorsHeaders,
  buildRpcArgs,
  cleanPageUrl,
  cleanText,
  Deps,
  FUNCTION_NAME,
  getClientIp,
  handleRequest,
  ipToUuid,
  rawText,
  buildFormPayload,
  safeSlice,
  validateBody,
} from "./handler.ts";

const LEAD = "6f57d7f4-0b69-4808-9f2d-141fea785cbd";
const CONSENT_TEXT =
  "I agree that OtterQuote / Stellar Edge Services may call or text me at the number above about my roof assessment, including by autodialer or prerecorded/artificial voice. Consent is not a condition of purchase. Msg & data rates may apply.";

function goodBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lead_id: LEAD,
    funding_type: "insurance",
    property_address: "123 Main St, Indianapolis, IN 46204",
    fbc: "fb.1.1700000000.abc",
    fbp: "fb.1.1700000000.123",
    consent: { key: "arm_f_s3_consent_checkbox", given: true, text: CONSENT_TEXT },
    page_url: "https://otterquote.com/start?v=f&utm_source=fb",
    submitted_fields: ["name", "phone", "address"],
    ...over,
  };
}

function req(body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("https://x.supabase.co/functions/v1/record-lead-details", {
    method,
    headers: { "content-type": "application/json", origin: "https://otterquote.com", ...headers },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}

interface Calls {
  rpc: { name: string; args: Record<string, unknown> }[];
  reports: { error: unknown; ctx: { fn: string; op?: string; extra?: Record<string, unknown> } }[];
}
function fakeDeps(opts: { allowed?: boolean; rlError?: boolean; recordResult?: unknown; recordError?: boolean; recordErrorObj?: unknown } = {}): { deps: Deps; calls: Calls } {
  const calls: Calls = { rpc: [], reports: [] };
  const deps: Deps = {
    rpc: (name, args) => {
      calls.rpc.push({ name, args });
      if (name === "check_rate_limit") {
        if (opts.rlError) return Promise.resolve({ data: null, error: { message: "rl down" } });
        return Promise.resolve({ data: { allowed: opts.allowed !== false }, error: null });
      }
      if (opts.recordErrorObj) return Promise.resolve({ data: null, error: opts.recordErrorObj });
      if (opts.recordError) return Promise.resolve({ data: null, error: { message: "db down" } });
      return Promise.resolve({ data: opts.recordResult === undefined ? true : opts.recordResult, error: null });
    },
    report: (error, ctx) => {
      calls.reports.push({ error, ctx });
      return Promise.resolve();
    },
  };
  return { deps, calls };
}

// ── helpers ──────────────────────────────────────────────────────────────
Deno.test("getClientIp: cf-connecting-ip wins over x-forwarded-for; first XFF hop is the fallback; none -> null", () => {
  const both = new Request("https://x", { headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1, 10.0.0.1" } });
  assertEquals(getClientIp(both), "203.0.113.9");
  const xff = new Request("https://x", { headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" } });
  assertEquals(getClientIp(xff), "198.51.100.1");
  assertEquals(getClientIp(new Request("https://x")), null);
});

Deno.test("ipToUuid: deterministic, UUID-shaped, namespaced to this function", async () => {
  const a = await ipToUuid("203.0.113.9");
  assertEquals(a, await ipToUuid("203.0.113.9"));
  assertMatch(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assertNotEquals(a, await ipToUuid("203.0.113.10"));
  // The check-email-exists bucket for the same IP must differ (different namespace).
  const data = new TextEncoder().encode("check-email-exists:203.0.113.9");
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
  d[6] = (d[6] & 0x0f) | 0x40; d[8] = (d[8] & 0x3f) | 0x80;
  const hex = Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
  const other = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  assertNotEquals(a, other);
});

Deno.test("cleanText: strips control chars, trims, caps, non-string -> null", () => {
  assertEquals(cleanText("  a\u0000b\tc\n d  ", 50), "a b c d");
  assertEquals(cleanText("x".repeat(500), 300)?.length, 300);
  assertEquals(cleanText("   ", 10), null);
  assertEquals(cleanText(42, 10), null);
});

Deno.test("safeSlice / cleanText never leave a lone surrogate at the cut (PostgreSQL rejects it)", () => {
  const emoji = "\u{1F3E0}"; // one code point, two UTF-16 units
  const s = "a".repeat(299) + emoji + "tail";
  const cut = safeSlice(s, 300); // would split the emoji between units 299 and 300
  assertEquals(cut, "a".repeat(299));
  assert(!/[\ud800-\udbff]$/.test(cut), "no dangling high surrogate");
  assertEquals(cleanText(s, 300), "a".repeat(299));
  assertEquals(safeSlice("short", 300), "short");
  assertEquals(safeSlice("a".repeat(298) + emoji, 300), "a".repeat(298) + emoji); // fits exactly: kept whole
  // The whole result must survive a JSON round trip unchanged (a lone surrogate would not).
  assertEquals(JSON.parse(JSON.stringify(cleanText(s, 300))), "a".repeat(299));
});

Deno.test("validateBody: consent text drops NUL characters but is otherwise verbatim", () => {
  const r = validateBody(goodBody({ consent: { key: "k", given: true, text: "A\u0000B " + CONSENT_TEXT } }));
  assert(r.ok);
  if (r.ok) assertEquals(r.value.consentText, "AB " + CONSENT_TEXT);
  const clean = validateBody(goodBody());
  assert(clean.ok);
  if (clean.ok) assertEquals(clean.value.consentText, CONSENT_TEXT); // the approved string is untouched
  const emojiTail = validateBody(goodBody({ consent: { key: "k", given: true, text: "x".repeat(1999) + "\u{1F3E0}" } }));
  assert(emojiTail.ok);
  if (emojiTail.ok) assertEquals(emojiTail.value.consentText, "x".repeat(1999));
});

Deno.test("rawText keeps text AS TYPED: not trimmed, not collapsed, only NUL removed, surrogate-safe cap", () => {
  assertEquals(rawText("  (317) 255-0142 ", 100), "  (317) 255-0142 "); // spaces and punctuation exactly as typed
  assertEquals(rawText("317  255\t0142", 100), "317  255\t0142"); // internal whitespace kept
  assertEquals(rawText("31\u00007", 100), "317"); // NUL is the one thing PostgreSQL cannot store
  assertEquals(rawText("", 100), null);
  assertEquals(rawText(5, 100), null);
  assertEquals(rawText("x".repeat(500), 100)?.length, 100);
  assertEquals(rawText("a".repeat(99) + "\u{1F3E0}", 100), "a".repeat(99)); // never a lone surrogate
  // Contrast with cleanText, which is for ordinary fields and DOES normalise.
  assertEquals(cleanText("  (317) 255-0142 ", 100), "(317) 255-0142");
});

Deno.test("buildFormPayload: allow-listed submitted VALUES, as typed; junk dropped; null when empty", () => {
  const p = buildFormPayload({ name: " Jane ", phone: "(317) 255-0142", email: "Jane@Example.com", address: "123 Main St, Indianapolis, IN 46204", funding_type: " CASH ", password: "x", ssn: "1", extra: { a: 1 } });
  assertEquals(p, { name: " Jane ", phone: "(317) 255-0142", email: "Jane@Example.com", address: "123 Main St, Indianapolis, IN 46204", funding_type: "cash" });
  assertEquals(buildFormPayload({ funding_type: "lottery" }), null); // an unknown funding answer is dropped, leaving nothing
  assertEquals(buildFormPayload({ name: 5, phone: null, email: {}, address: [] }), null); // non-strings are dropped
  assertEquals(buildFormPayload([]), null);
  assertEquals(buildFormPayload("x"), null);
  assertEquals(buildFormPayload(null), null);
  assertEquals(buildFormPayload({ name: "n".repeat(999), address: "a".repeat(999) })?.name?.length, 200);
  assertEquals(buildFormPayload({ name: "n", address: "a".repeat(999) })?.address?.length, 500);
});

Deno.test("cleanPageUrl: keeps https otterquote.com URLs, drops everything else", () => {
  assertEquals(cleanPageUrl("https://otterquote.com/start?v=f"), "https://otterquote.com/start?v=f");
  assertEquals(cleanPageUrl("https://app.otterquote.com/x"), "https://app.otterquote.com/x");
  assertEquals(cleanPageUrl("http://otterquote.com/start"), null);
  assertEquals(cleanPageUrl("https://evil.com/otterquote.com"), null);
  assertEquals(cleanPageUrl("https://otterquote.com.evil.com/"), null);
  assertEquals(cleanPageUrl("javascript:alert(1)"), null);
  assertEquals(cleanPageUrl("not a url"), null);
});

Deno.test("buildCorsHeaders: allowed origin echoed, unknown origin falls back to the first allowed", () => {
  assertEquals(buildCorsHeaders(new Request("https://x", { headers: { origin: "https://app.otterquote.com" } }))["Access-Control-Allow-Origin"], "https://app.otterquote.com");
  assertEquals(buildCorsHeaders(new Request("https://x", { headers: { origin: "https://evil.example" } }))["Access-Control-Allow-Origin"], "https://otterquote.com");
});

// ── validateBody ───────────────────────────────────────────────────────────
Deno.test("validateBody: a complete body validates and normalises", () => {
  const r = validateBody(goodBody({ funding_type: "  CASH " }));
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value.leadId, LEAD);
    assertEquals(r.value.fundingType, "cash");
    assertEquals(r.value.propertyAddress, "123 Main St, Indianapolis, IN 46204");
    assertEquals(r.value.consentGiven, true);
    assertEquals(r.value.consentText, CONSENT_TEXT); // verbatim
    assertEquals(r.value.submittedFields, ["name", "phone", "address"]);
  }
});

Deno.test("validateBody: rejects what the evidence row cannot be built without", () => {
  for (
    const [label, body] of [
      ["no body", null],
      ["non-uuid lead_id", goodBody({ lead_id: "1; drop table leads" })],
      ["missing lead_id", goodBody({ lead_id: undefined })],
      ["no consent", goodBody({ consent: undefined })],
      ["consent.given not boolean", goodBody({ consent: { key: "k", given: "yes", text: CONSENT_TEXT } })],
      ["empty consent.key", goodBody({ consent: { key: " ", given: true, text: CONSENT_TEXT } })],
      ["empty consent.text", goodBody({ consent: { key: "k", given: true, text: "   " } })],
    ] as [string, unknown][]
  ) {
    assertEquals(validateBody(body).ok, false, label);
  }
});

Deno.test("validateBody: consent.given=false is VALID (the not-ticked outcome is evidence too)", () => {
  const r = validateBody(goodBody({ consent: { key: "arm_f_s3_consent_checkbox", given: false, text: CONSENT_TEXT } }));
  assert(r.ok);
  if (r.ok) assertEquals(r.value.consentGiven, false);
});

Deno.test("validateBody: optional fields degrade to null instead of rejecting", () => {
  const r = validateBody(goodBody({ funding_type: "lottery", property_address: 5, fbc: {}, fbp: null, page_url: "https://evil.com/", submitted_fields: ["name", "ssn", 7] }));
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value.fundingType, null);
    assertEquals(r.value.propertyAddress, null);
    assertEquals(r.value.fbc, null);
    assertEquals(r.value.fbp, null);
    assertEquals(r.value.pageUrl, null);
    assertEquals(r.value.submittedFields, ["name"]); // unknown / non-string names dropped
  }
});

Deno.test("validateBody: address capped at 300, fbc/fbp at 200, consent text at 2000", () => {
  const r = validateBody(goodBody({ property_address: "a".repeat(999), fbc: "b".repeat(999), fbp: "c".repeat(999), consent: { key: "k", given: true, text: "t".repeat(5000) } }));
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value.propertyAddress?.length, 300);
    assertEquals(r.value.fbc?.length, 200);
    assertEquals(r.value.fbp?.length, 200);
    assertEquals(r.value.consentText.length, 2000);
  }
});

// ── buildRpcArgs ──────────────────────────────────────────────────────────
Deno.test("validateBody / buildRpcArgs / handleRequest carry the phone as typed and the form payload to the RPC (D-299)", async () => {
  const body = goodBody({ phone_as_typed: " (317) 255-0142 ", form_payload: { name: "Jane", phone: " (317) 255-0142 ", email: "jane@example.com", address: "123 Main St, Indianapolis, IN 46204", funding_type: "insurance" } });
  const v = validateBody(body);
  assert(v.ok);
  if (!v.ok) return;
  assertEquals(v.value.phoneAsTyped, " (317) 255-0142 ");
  assertEquals(v.value.formPayload?.email, "jane@example.com");
  const args = buildRpcArgs(v.value, "203.0.113.9", "UA/1.0");
  assertEquals(args.p_phone_as_typed, " (317) 255-0142 ");
  assertEquals((args.p_form_payload as Record<string, string>).address, "123 Main St, Indianapolis, IN 46204");
  const { deps, calls } = fakeDeps();
  await handleRequest(req(body, { "cf-connecting-ip": "203.0.113.9" }), deps);
  const rec = calls.rpc.find((c) => c.name === "record_lead_details")!;
  assertEquals(rec.args.p_phone_as_typed, " (317) 255-0142 ");
  assertEquals((rec.args.p_form_payload as Record<string, string>).name, "Jane");
});

Deno.test("phone_as_typed falls back to the phone inside form_payload; both absent -> NULL, never an empty object", () => {
  const onlyPayload = validateBody(goodBody({ form_payload: { phone: "317.255.0142" } }));
  assert(onlyPayload.ok);
  if (onlyPayload.ok) assertEquals(onlyPayload.value.phoneAsTyped, "317.255.0142");
  const neither = validateBody(goodBody());
  assert(neither.ok);
  if (neither.ok) { assertEquals(neither.value.phoneAsTyped, null); assertEquals(neither.value.formPayload, null); }
  const junk = validateBody(goodBody({ form_payload: "not an object", phone_as_typed: 42 }));
  assert(junk.ok);
  if (junk.ok) { assertEquals(junk.value.phoneAsTyped, null); assertEquals(junk.value.formPayload, null); }
});

Deno.test("the typed phone and form values are never reported to Sentry or echoed in a response", async () => {
  const { deps, calls } = fakeDeps({ recordError: true });
  const res = await handleRequest(req(goodBody({ phone_as_typed: "(317) 255-0142", form_payload: { name: "Jane Q Public", email: "jane.q@example.com", phone: "(317) 255-0142" } })), deps);
  assertEquals(res.status, 500);
  const seen = JSON.stringify(calls.reports) + JSON.stringify(await res.json());
  for (const secret of ["255-0142", "Jane Q Public", "jane.q@example.com"]) assert(!seen.includes(secret), "leaked: " + secret);
});

Deno.test("buildRpcArgs: payload summary carries no PII", () => {
  const v = validateBody(goodBody());
  assert(v.ok);
  if (!v.ok) return;
  const args = buildRpcArgs(v.value, "203.0.113.9", "UA/1.0");
  const payloadJson = JSON.stringify(args.p_payload);
  assert(!payloadJson.includes("Main St"), "address must not be in the payload summary");
  assert(!payloadJson.includes("call or text"), "consent text must not be in the payload summary");
  assertEquals(args.p_payload, { source: "router-arm-f", funding_type: "insurance", submitted_fields: ["name", "phone", "address"] });
});

// ── handleRequest ─────────────────────────────────────────────────────────
Deno.test("handleRequest: OPTIONS -> 200 with CORS; non-POST -> 405; neither calls the database", async () => {
  const { deps, calls } = fakeDeps();
  const o = await handleRequest(req(null, {}, "OPTIONS"), deps);
  assertEquals(o.status, 200);
  assertEquals(o.headers.get("Access-Control-Allow-Origin"), "https://otterquote.com");
  const g = await handleRequest(req(null, {}, "GET"), deps);
  assertEquals(g.status, 405);
  assertEquals(calls.rpc.length, 0);
});

Deno.test("handleRequest: success calls record_lead_details with SERVER-OBSERVED ip and user agent", async () => {
  const { deps, calls } = fakeDeps();
  const res = await handleRequest(req(goodBody(), { "cf-connecting-ip": "203.0.113.9", "user-agent": "Mozilla/5.0 (iPhone) FBAN/FBIOS" }), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  const rec = calls.rpc.find((c) => c.name === "record_lead_details");
  assert(rec, "record_lead_details was called");
  assertEquals(rec!.args.p_lead_id, LEAD);
  assertEquals(rec!.args.p_ip, "203.0.113.9");
  assertEquals(rec!.args.p_user_agent, "Mozilla/5.0 (iPhone) FBAN/FBIOS");
  assertEquals(rec!.args.p_consent_text, CONSENT_TEXT);
  assertEquals(rec!.args.p_consent_given, true);
  assertEquals(rec!.args.p_funding_type, "insurance");
});

Deno.test("handleRequest: NEGATIVE CONTROL -- a client-supplied ip / user_agent in the body is IGNORED", async () => {
  const { deps, calls } = fakeDeps();
  await handleRequest(req(goodBody({ ip: "6.6.6.6", user_agent: "forged/1.0", p_ip: "6.6.6.6" }), { "cf-connecting-ip": "203.0.113.9", "user-agent": "real/2.0" }), deps);
  const rec = calls.rpc.find((c) => c.name === "record_lead_details")!;
  assertEquals(rec.args.p_ip, "203.0.113.9");
  assertEquals(rec.args.p_user_agent, "real/2.0");
  assert(!JSON.stringify(rec.args).includes("6.6.6.6"), "forged ip must appear nowhere in the RPC args");
  assert(!JSON.stringify(rec.args).includes("forged/1.0"), "forged user agent must appear nowhere in the RPC args");
});

Deno.test("handleRequest: rate limit denied -> 429 and record_lead_details is NEVER called", async () => {
  const { deps, calls } = fakeDeps({ allowed: false });
  const res = await handleRequest(req(goodBody(), { "cf-connecting-ip": "203.0.113.9" }), deps);
  assertEquals(res.status, 429);
  assertEquals(calls.rpc.filter((c) => c.name === "record_lead_details").length, 0);
  const rl = calls.rpc.find((c) => c.name === "check_rate_limit")!;
  assertEquals(rl.args.p_function_name, FUNCTION_NAME);
  assertEquals(rl.args.p_user_id, await ipToUuid("203.0.113.9"));
});

Deno.test("handleRequest: rate-limiter RPC error fails OPEN (an infra hiccup must not drop a consent record)", async () => {
  const { deps, calls } = fakeDeps({ rlError: true });
  const res = await handleRequest(req(goodBody(), { "cf-connecting-ip": "203.0.113.9" }), deps);
  assertEquals(res.status, 200);
  assertEquals(calls.rpc.filter((c) => c.name === "record_lead_details").length, 1);
});

Deno.test("handleRequest: invalid JSON -> 400; invalid body -> 400; neither reaches the RPC", async () => {
  const a = fakeDeps();
  assertEquals((await handleRequest(req("{not json"), a.deps)).status, 400);
  const b = fakeDeps();
  assertEquals((await handleRequest(req(goodBody({ lead_id: "nope" })), b.deps)).status, 400);
  assertEquals(a.calls.rpc.filter((c) => c.name === "record_lead_details").length, 0);
  assertEquals(b.calls.rpc.filter((c) => c.name === "record_lead_details").length, 0);
});

Deno.test("handleRequest: RPC returns false (lead out of scope) -> 200 ok:false, not a 500, nothing reported", async () => {
  const { deps, calls } = fakeDeps({ recordResult: false });
  const res = await handleRequest(req(goodBody()), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: false, reason: "lead_out_of_scope" });
  assertEquals(calls.reports.length, 0);
});

Deno.test("handleRequest: RPC error -> 500, reported to Sentry WITHOUT the address or consent text", async () => {
  const { deps, calls } = fakeDeps({ recordError: true });
  const res = await handleRequest(req(goodBody()), deps);
  assertEquals(res.status, 500);
  assertEquals(calls.reports.length, 1);
  const reported = JSON.stringify(calls.reports[0]);
  assert(!reported.includes("Main St"), "address must not be reported");
  assert(!reported.includes("autodialer"), "consent text must not be reported");
  assertEquals(calls.reports[0].ctx.extra, { lead_id: LEAD });
  const body = JSON.stringify(await res.json());
  assert(!body.includes("Main St") && !body.includes("autodialer"), "response must not echo personal data");
});

Deno.test("handleRequest: the database's own error text (message, details, hint) is never forwarded to Sentry; only a fixed message and the code", async () => {
  const leak = { message: 'duplicate key value violates unique constraint "lead_consents_lead_id_consent_key_key"', details: "Key (lead_id, consent_key)=(11111111-2222, sms_call) already exists.", hint: "secret-hint-text", code: "23505" };
  const { deps, calls } = fakeDeps({ recordErrorObj: leak });
  const res = await handleRequest(req(goodBody()), deps);
  assertEquals(res.status, 500);
  assertEquals(calls.reports.length, 1);
  const err = calls.reports[0].error as Error;
  assertEquals(err.message, "record_lead_details rpc failed (code 23505)");
  const seen = JSON.stringify(calls.reports[0]) + err.message;
  for (const s of ["duplicate key", "lead_consents_lead_id", "sms_call", "secret-hint-text", "11111111-2222"]) assert(!seen.includes(s), `must not forward: ${s}`);
  const odd = fakeDeps({ recordErrorObj: { message: "x", code: "bad code with spaces & an address 1 Main St" } });
  await handleRequest(req(goodBody()), odd.deps);
  assertEquals((odd.calls.reports[0].error as Error).message, "record_lead_details rpc failed");
});

Deno.test("handleRequest: unknown origin still gets a response (CORS falls back), never an echo of the origin", async () => {
  const { deps } = fakeDeps();
  const res = await handleRequest(req(goodBody(), { origin: "https://evil.example" }), deps);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://otterquote.com");
});
